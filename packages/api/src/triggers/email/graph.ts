import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { EmailGraphConfig, EmailGraphConfigLive } from '../../config';
import { EmailSource, EmailSourceError, type NormalizedEmail } from './source';

/**
 * Microsoft Graph email source (app-only / client-credentials). Reads inbound
 * mail by polling a mailbox's inbox; the app must hold the `Mail.Read`
 * application permission, scoped to the monitored (typically shared) mailboxes
 * via an Application Access Policy. Configured through env:
 *   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET
 * When any is missing the source reports `enabled: false` and the scheduler
 * skips email work.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,subject,from,receivedDateTime,bodyPreview,body';
const TOP = 25;

const GraphTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
});

const GraphMessage = Schema.Struct({
  id: Schema.String,
  subject: Schema.optional(Schema.String),
  from: Schema.optional(
    Schema.Struct({ emailAddress: Schema.optional(Schema.Struct({ address: Schema.optional(Schema.String) })) }),
  ),
  receivedDateTime: Schema.String,
  bodyPreview: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.String) })),
});

/** The `GET /messages` collection Graph returns for a mailbox poll. */
export const GraphMessagesResponse = Schema.Struct({
  value: Schema.Array(GraphMessage),
});

const decodeGraphTokenResponse = Schema.decodeUnknownEffect(GraphTokenResponse);
const decodeGraphMessagesResponse = Schema.decodeUnknownEffect(GraphMessagesResponse);

type TokenCache = { token: string; expiresAtMs: number };

const fail = (message: string, cause: unknown): EmailSourceError => new EmailSourceError({ message, cause });

export const EmailSourceLive = Layer.effect(
  EmailSource,
  Effect.gen(function* () {
    const { config } = yield* EmailGraphConfig;

    if (!config) {
      return EmailSource.of({
        enabled: false,
        fetchSince: () => Effect.succeed([]),
      });
    }

    // Outbound Graph calls go through the injected HttpClient instance (captured
    // here at layer build) so the network dependency is explicit in the layer's
    // requirements while EmailSource's methods stay requirement-free.
    const client = yield* HttpClient.HttpClient;
    let cache: TokenCache | null = null;

    const acquireToken = Effect.fn('EmailSource.acquireToken')(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (cache && cache.expiresAtMs - 60_000 > now) {
        return cache.token;
      }

      const request = HttpClientRequest.post(
        `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
      ).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: config.clientId,
          client_secret: Redacted.value(config.clientSecret),
          grant_type: 'client_credentials',
          scope: 'https://graph.microsoft.com/.default',
        }),
      );

      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((cause) => fail('Graph token request failed', cause)));

      if (response.status < 200 || response.status >= 300) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
        return yield* new EmailSourceError({
          message: `Graph token request returned ${response.status}: ${text}`,
          cause: null,
        });
      }

      const json = yield* response.json.pipe(
        Effect.flatMap(decodeGraphTokenResponse),
        Effect.mapError((cause) => fail('Graph token response was not a token document', cause)),
      );

      cache = { token: json.access_token, expiresAtMs: (yield* Clock.currentTimeMillis) + json.expires_in * 1000 };
      return cache.token;
    });

    const fetchSince = Effect.fn('EmailSource.fetchSince')(function* (mailbox: string, sinceIso: string) {
      const token = yield* acquireToken();
      const query = new URLSearchParams({
        $select: SELECT,
        $orderby: 'receivedDateTime asc',
        $top: String(TOP),
        $filter: `receivedDateTime gt ${sinceIso}`,
      });
      const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${query.toString()}`;

      const response = yield* client
        .get(url, {
          headers: {
            authorization: `Bearer ${token}`,
            // Ask Graph for plain-text bodies rather than HTML.
            Prefer: 'outlook.body-content-type="text"',
          },
        })
        .pipe(Effect.mapError((cause) => fail(`Graph message fetch failed for ${mailbox}`, cause)));

      if (response.status < 200 || response.status >= 300) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
        return yield* new EmailSourceError({
          message: `Graph returned ${response.status} for ${mailbox}: ${text}`,
          cause: null,
        });
      }

      const json = yield* response.json.pipe(
        Effect.flatMap(decodeGraphMessagesResponse),
        Effect.mapError((cause) => fail('Graph message response was not a message collection', cause)),
      );

      return json.value.map(
        (message): NormalizedEmail => ({
          id: message.id,
          mailbox,
          subject: message.subject ?? '',
          from: message.from?.emailAddress?.address ?? '',
          receivedDateTime: message.receivedDateTime,
          bodyPreview: message.bodyPreview ?? '',
          body: message.body?.content ?? '',
        }),
      );
    });

    return EmailSource.of({ enabled: true, fetchSince });
  }),
).pipe(Layer.provide(EmailGraphConfigLive));
