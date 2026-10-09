import { createDiscordAdapter, type DiscordAdapter } from '@chat-adapter/discord';
import { createTeamsAdapter, type TeamsAdapter } from '@chat-adapter/teams';
import type { ChannelAccount, ChannelAccountStatus, ChannelBinding } from 'agentdock-sdk/schemas';
import { type ActionEvent, type Adapter, Chat, ConsoleLogger, type Message, type Thread } from 'chat';
import { Database } from 'db';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { ChangeFeed, ChangeFeedLive } from '../events/service';
import { ACCEPT_ACTION, ChannelDispatcher, type ChannelTurn, DECLINE_ACTION, turnFromMessage } from './dispatch';
import { type ConversationFacts, resolveBinding } from './routing';
import { ChannelRegistry } from './service';
import { DrizzleChannelStateAdapter } from './state-adapter';

const LISTENER_DURATION_MS = 6 * 60 * 60 * 1000;
const RECONCILE_INTERVAL = Duration.seconds(10);
const DISCORD_API = 'https://discord.com/api/v10';

export class ChannelGatewayError extends Schema.TaggedError<ChannelGatewayError>()('ChannelGatewayError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type ChannelGatewayService = {
  readonly statuses: () => Effect.Effect<ReadonlyArray<ChannelAccountStatus>>;
  readonly handleWebhook: (accountId: string, request: Request) => Effect.Effect<Response>;
};

export const ChannelGateway = Context.Service<ChannelGatewayService>('@agentdock/api/ChannelGateway');

type RunningAccount = {
  readonly fingerprint: string;
  readonly fiber: Fiber.Fiber<void, never>;
};

type ChannelThread = Thread<unknown>;
type MessageFacts = (thread: ChannelThread, message: Message) => ConversationFacts;
type ActionFacts = (event: ActionEvent) => ConversationFacts | undefined;
type ChannelChat = Chat<Record<string, Adapter>, unknown>;

const fingerprintOf = (account: ChannelAccount): string => `${account.updatedAt}:${account.enabled}`;

const DiscordUser = Schema.Struct({ username: Schema.String });

const TeamsActivity = Schema.Struct({
  conversation: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String) })),
  channelData: Schema.optional(
    Schema.Struct({
      team: Schema.optional(Schema.Struct({ id: Schema.String })),
      channel: Schema.optional(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

const decodeTeamsActivity = Schema.decodeUnknownOption(TeamsActivity);
type TeamsActivity = typeof TeamsActivity.Type;

const discordMessageFacts =
  (adapter: DiscordAdapter): MessageFacts =>
  (thread, message) => {
    const decoded = adapter.decodeThreadId(thread.id);
    return {
      isDM: thread.isDM,
      workspaceId: thread.isDM ? undefined : decoded.guildId,
      channelId: decoded.channelId,
      userId: message.author.userId,
      isMention: message.isMention === true,
      isSubscribed: false,
    };
  };

const discordActionFacts =
  (adapter: DiscordAdapter): ActionFacts =>
  (event) => {
    if (!event.thread) return undefined;
    const decoded = adapter.decodeThreadId(event.thread.id);
    return {
      isDM: event.thread.isDM,
      workspaceId: event.thread.isDM ? undefined : decoded.guildId,
      channelId: decoded.channelId,
      userId: event.user.userId,
      isMention: true,
      isSubscribed: true,
    };
  };

const teamsFacts = (
  adapter: TeamsAdapter,
  thread: ChannelThread,
  userId: string,
  isMention: boolean,
  activity: TeamsActivity | undefined,
): ConversationFacts => {
  const decodedThread = adapter.decodeThreadId(thread.id);
  return {
    isDM: thread.isDM,
    workspaceId: activity?.channelData?.team?.id,
    channelId: activity?.channelData?.channel?.id ?? activity?.conversation?.id ?? decodedThread.conversationId,
    userId,
    isMention,
    isSubscribed: false,
  };
};
const decodeDiscordUser = Schema.decodeUnknownOption(DiscordUser);

const teamsMessageFacts =
  (adapter: TeamsAdapter): MessageFacts =>
  (thread, message) => {
    const activity = decodeTeamsActivity(message.raw);
    return teamsFacts(
      adapter,
      thread,
      message.author.userId,
      message.isMention === true,
      Option.getOrUndefined(activity),
    );
  };

const teamsActionFacts =
  (adapter: TeamsAdapter): ActionFacts =>
  (event) => {
    if (!event.thread) return undefined;
    const activity = decodeTeamsActivity(event.raw);
    return teamsFacts(adapter, event.thread, event.user.userId, true, Option.getOrUndefined(activity));
  };

const asChatAdapter = (adapter: DiscordAdapter | TeamsAdapter): Adapter => {
  // SAFETY: both official adapters implement Adapter. Their botUserId getter is
  // `string | undefined`, which TypeScript distinguishes from an optional property.
  return adapter as Adapter;
};

const jsonResponse = (status: number, error: string): Response => Response.json({ error }, { status });

const externalCall = <A>(message: string, run: () => Promise<A>): Effect.Effect<A, ChannelGatewayError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ChannelGatewayError({ message, cause }),
  });

export const ChannelGatewayLive = Layer.effect(
  ChannelGateway,
  Effect.gen(function* () {
    const registry = yield* ChannelRegistry;
    const dispatcher = yield* ChannelDispatcher;
    const { db } = yield* Database;
    const changes = yield* ChangeFeed;
    const http = yield* HttpClient.HttpClient;
    const context = yield* Effect.context<never>();
    const running = new Map<string, RunningAccount>();
    const webhooks = new Map<string, (request: Request) => Promise<Response>>();
    const statuses = new Map<string, ChannelAccountStatus>();
    const runFork = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromiseWith(context)(effect);

    const setStatus = (account: ChannelAccount, status: Omit<ChannelAccountStatus, 'accountId' | 'since'>) =>
      Effect.clockWith((clock) =>
        Effect.sync(() => {
          statuses.set(account.id, { accountId: account.id, since: clock.currentTimeMillisUnsafe(), ...status });
        }),
      ).pipe(Effect.andThen(changes.publish('channels')));

    const botUserName = (botToken: string): Effect.Effect<string, ChannelGatewayError> =>
      Effect.gen(function* () {
        const response = yield* http.get(`${DISCORD_API}/users/@me`, {
          headers: { authorization: `Bot ${botToken}` },
        });
        if (response.status !== 200) {
          return yield* new ChannelGatewayError({
            message: `Discord rejected the bot token (HTTP ${response.status})`,
          });
        }
        const body = yield* response.json;
        const decoded = decodeDiscordUser(body);
        return decoded._tag === 'Some' ? decoded.value.username : 'unknown';
      }).pipe(
        Effect.catchTag('HttpClientError', (error) =>
          Effect.fail(new ChannelGatewayError({ message: `Could not reach Discord: ${error.message}` })),
        ),
      );

    const accountCredentials = (account: ChannelAccount) =>
      registry
        .getAccountCredentials(account.id)
        .pipe(
          Effect.mapError(
            () => new ChannelGatewayError({ message: `Could not load ${account.platform} account credentials.` }),
          ),
        );

    const handleInbound = (
      account: ChannelAccount,
      factsFor: MessageFacts,
      thread: ChannelThread,
      message: Message,
      isSubscribed: boolean,
    ) =>
      Effect.gen(function* () {
        if (message.author.isMe || message.author.isBot === true) return;
        const bindings = yield* registry.listBindingsForAccount(account.id);
        const decision = resolveBinding(bindings, { ...factsFor(thread, message), isSubscribed });
        if (decision.kind === 'ignore') {
          yield* Effect.logDebug(`channel ${account.id}: ignoring message in ${thread.id} (${decision.reason})`);
          return;
        }
        if (!thread.isDM) yield* externalCall('Could not subscribe to the channel thread.', () => thread.subscribe());
        yield* dispatcher.dispatch(account, decision.binding, thread, turnFromMessage(message));
      }).pipe(
        Effect.catch((error) => Effect.logError(`channel ${account.id}: inbound handling failed`, error)),
        Effect.withSpan('agentdock.channels.inbound', {
          attributes: { 'channel.account.id': account.id, 'channel.platform': account.platform },
        }),
      );

    const handleAction = (account: ChannelAccount, factsFor: ActionFacts, event: ActionEvent) =>
      Effect.gen(function* () {
        const thread = event.thread;
        if (!thread) return;
        if (event.actionId !== ACCEPT_ACTION && event.actionId !== DECLINE_ACTION) return;
        const facts = factsFor(event);
        if (!facts) return;
        const bindings = yield* registry.listBindingsForAccount(account.id);
        const decision = resolveBinding(bindings, facts);
        if (decision.kind === 'ignore') return;
        const record = yield* registry.getThread(account.id, thread.id);
        if (!record?.pendingTaskId) {
          yield* externalCall('Could not post the action response.', () =>
            thread.post({ markdown: 'Nothing is waiting for a decision here.' }),
          );
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const turn: ChannelTurn = {
          kind: 'response',
          messageId: `${event.messageId}:${event.actionId}:${now}`,
          response: { action: event.actionId === ACCEPT_ACTION ? 'accept' : 'decline' },
        };
        yield* dispatcher.dispatch(account, decision.binding, thread, turn);
      }).pipe(Effect.catch((error) => Effect.logError(`channel ${account.id}: action handling failed`, error)));

    const makeChat = (account: ChannelAccount, adapter: Adapter): ChannelChat =>
      new Chat<Record<string, Adapter>, unknown>({
        userName: account.name,
        adapters: { [account.platform]: adapter },
        state: new DrizzleChannelStateAdapter(db, account.id),
        concurrency: 'queue',
        logger: 'warn',
      });

    const wireChat = (
      account: ChannelAccount,
      chat: ChannelChat,
      messageFacts: MessageFacts,
      actionFacts: ActionFacts,
    ) => {
      const inbound = (isSubscribed: boolean) => (thread: ChannelThread, message: Message) =>
        runFork(handleInbound(account, messageFacts, thread, message, isSubscribed));
      chat.onDirectMessage(inbound(false));
      chat.onSubscribedMessage(inbound(true));
      chat.onNewMention(inbound(false));
      chat.onNewMessage(/[\s\S]*/, inbound(false));
      chat.onAction([ACCEPT_ACTION, DECLINE_ACTION], (event) => runFork(handleAction(account, actionFacts, event)));
    };

    const runDiscord = (account: ChannelAccount): Effect.Effect<never, ChannelGatewayError> =>
      Effect.gen(function* () {
        const stored = yield* accountCredentials(account);
        if (stored?.platform !== 'discord') {
          return yield* new ChannelGatewayError({ message: 'Discord credentials are unavailable.' });
        }
        yield* setStatus(account, { state: 'connecting' });
        const userName = yield* botUserName(stored.credentials.botToken);
        const adapter = createDiscordAdapter({
          botToken: stored.credentials.botToken,
          applicationId: stored.credentials.applicationId,
          userName,
          ...(stored.credentials.publicKey
            ? { publicKey: stored.credentials.publicKey }
            : {
                webhookVerifier: () => {
                  throw new Error('HTTP interactions are not enabled for this account.');
                },
              }),
          logger: new ConsoleLogger('warn'),
        });
        const chat = makeChat(account, asChatAdapter(adapter));
        wireChat(account, chat, discordMessageFacts(adapter), discordActionFacts(adapter));
        yield* externalCall('Could not initialize the Discord adapter.', () => chat.initialize());
        yield* Effect.addFinalizer(() =>
          externalCall('Could not shut down the Discord adapter.', () => chat.shutdown()).pipe(Effect.ignore),
        );

        const listen = Effect.gen(function* () {
          const abort = new AbortController();
          yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
          const background: Array<Promise<unknown>> = [];
          yield* externalCall('Could not start the Discord gateway listener.', () =>
            adapter.startGatewayListener(
              {
                waitUntil: (task) => {
                  background.push(task);
                },
              },
              LISTENER_DURATION_MS,
              abort.signal,
            ),
          );
          yield* setStatus(account, { state: 'connected', botUserName: userName });
          yield* Effect.logInfo(`channel ${account.id}: discord gateway listening as ${userName}`);
          yield* externalCall('The Discord gateway listener stopped.', () => Promise.all(background));
        });
        return yield* listen.pipe(Effect.scoped, Effect.forever);
      }).pipe(Effect.scoped);

    const runTeams = (account: ChannelAccount): Effect.Effect<never, ChannelGatewayError> =>
      Effect.gen(function* () {
        const stored = yield* accountCredentials(account);
        if (stored?.platform !== 'teams') {
          return yield* new ChannelGatewayError({ message: 'Microsoft Teams credentials are unavailable.' });
        }
        yield* setStatus(account, { state: 'connecting' });
        const adapterConfig = {
          appId: stored.credentials.appId,
          appPassword: stored.credentials.appPassword,
          userName: account.name,
          logger: new ConsoleLogger('warn'),
        };
        const adapter =
          stored.credentials.appType === 'SingleTenant'
            ? createTeamsAdapter({
                ...adapterConfig,
                appType: 'SingleTenant',
                appTenantId: stored.credentials.tenantId,
              })
            : createTeamsAdapter({ ...adapterConfig, appType: 'MultiTenant' });
        const chat = makeChat(account, asChatAdapter(adapter));
        wireChat(account, chat, teamsMessageFacts(adapter), teamsActionFacts(adapter));
        yield* externalCall('Could not initialize the Microsoft Teams adapter.', () => chat.initialize());
        const webhook = chat.webhooks.teams;
        if (!webhook) {
          return yield* new ChannelGatewayError({ message: 'Microsoft Teams webhook was not registered.' });
        }
        yield* Effect.addFinalizer(() =>
          externalCall('Could not shut down the Microsoft Teams adapter.', () => chat.shutdown()).pipe(Effect.ignore),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => webhooks.set(account.id, webhook)),
          () => Effect.sync(() => webhooks.delete(account.id)),
        );
        yield* setStatus(account, { state: 'connected', botUserName: account.name });
        yield* Effect.logInfo(`channel ${account.id}: Microsoft Teams webhook ready`);
        return yield* Effect.never;
      }).pipe(Effect.scoped);

    const runAccountAttempt = (account: ChannelAccount): Effect.Effect<never, ChannelGatewayError> =>
      account.platform === 'discord' ? runDiscord(account) : runTeams(account);

    const runAccount = (account: ChannelAccount): Effect.Effect<void> =>
      runAccountAttempt(account).pipe(
        Effect.catch((error) =>
          setStatus(account, { state: 'error', error: error.message }).pipe(
            Effect.andThen(Effect.logWarning(`channel ${account.id}: ${error.message}`)),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
        Effect.retry(Schedule.min([Schedule.exponential(Duration.seconds(5)), Schedule.spaced(Duration.minutes(5))])),
        Effect.catch((error) => Effect.logError(`channel ${account.id}: gave up`, error)),
        Effect.onInterrupt(() => setStatus(account, { state: 'disconnected' })),
      );

    const stop = (accountId: string) =>
      Effect.gen(function* () {
        const current = running.get(accountId);
        if (!current) return;
        running.delete(accountId);
        yield* Fiber.interrupt(current.fiber);
      });

    const reconcile = Effect.gen(function* () {
      const accounts = yield* registry.listAccounts();
      const wanted = new Map<string, ChannelAccount>(
        accounts.filter((account) => account.enabled).map((account) => [account.id, account]),
      );
      for (const accountId of [...running.keys()]) {
        const account = wanted.get(accountId);
        if (!account || running.get(accountId)?.fingerprint !== fingerprintOf(account)) {
          yield* stop(accountId);
          if (!account && statuses.delete(accountId)) yield* changes.publish('channels');
        }
      }
      for (const account of wanted.values()) {
        if (running.has(account.id)) continue;
        const fiber = yield* Effect.forkScoped(runAccount(account));
        running.set(account.id, { fingerprint: fingerprintOf(account), fiber });
      }
    }).pipe(Effect.catch((error) => Effect.logError('channel gateway: reconcile failed', error)));

    yield* Effect.forkScoped(reconcile.pipe(Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL))));

    return ChannelGateway.of({
      statuses: () => Effect.sync(() => [...statuses.values()]),
      handleWebhook: Effect.fn('ChannelGateway.handleWebhook')((accountId, request) => {
        const handler = webhooks.get(accountId);
        if (!handler) {
          return Effect.succeed(jsonResponse(404, 'Microsoft Teams channel account not found or not connected.'));
        }
        return Effect.tryPromise({
          try: () => handler(request),
          catch: (cause) => new ChannelGatewayError({ message: 'Microsoft Teams webhook failed.', cause }),
        }).pipe(
          Effect.catch((error) =>
            Effect.logError(error).pipe(Effect.as(jsonResponse(500, 'Microsoft Teams webhook failed.'))),
          ),
        );
      }),
    });
  }),
).pipe(Layer.provide(ChangeFeedLive));

export type { ChannelBinding };
