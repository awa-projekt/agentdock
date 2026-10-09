import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import { Api } from '../api';
import { removeToken, writeToken } from '../credentials';
import { cliError } from '../errors';
import { describeSession, getSession, requestDeviceCode, requestDeviceToken } from '../remote';

const openBrowser = (url: string): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    yield* spawner.exitCode(ChildProcess.make(opener, [url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }));
  }).pipe(Effect.ignore);

const pollForToken = (deviceCode: string, intervalSeconds: number, expiresInSeconds: number) =>
  Effect.gen(function* () {
    let interval = intervalSeconds;
    let remaining = expiresInSeconds;
    while (remaining > 0) {
      yield* Effect.sleep(Duration.seconds(interval));
      remaining -= interval;
      const result = yield* requestDeviceToken(deviceCode);
      if ('access_token' in result) return result.access_token;
      switch (result.error) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          interval += 5;
          break;
        case 'expired_token':
          return yield* cliError('The device code expired before it was approved. Run login again.');
        case 'access_denied':
          return yield* cliError('Login was denied in the browser.');
        default:
          return yield* cliError(`Login failed: ${result.error}`);
      }
    }
    return yield* cliError('The device code expired before it was approved. Run login again.');
  });

const login = Effect.gen(function* () {
  const api = yield* Api;
  const code = yield* requestDeviceCode;
  yield* Console.log(`Open ${code.verification_uri_complete}`);
  yield* Console.log(`and confirm the code ${code.user_code} to log in to ${api.baseUrl}.`);
  yield* openBrowser(code.verification_uri_complete);
  const token = yield* pollForToken(code.device_code, code.interval, code.expires_in);
  yield* writeToken(api.baseUrl, token);
  const session = yield* getSession;
  yield* Console.log(`Logged in as ${describeSession(session)}.`);
});

export const loginCommand = Command.make('login', {}, () => login).pipe(
  Command.withDescription('Log in to the agentdock server through the browser'),
);

export const logoutCommand = Command.make('logout', {}, () =>
  Effect.gen(function* () {
    const api = yield* Api;
    const removed = yield* removeToken(api.baseUrl);
    yield* Console.log(removed ? `Logged out of ${api.baseUrl}.` : `No stored login for ${api.baseUrl}.`);
  }),
).pipe(Command.withDescription('Remove the stored login token'));

export const whoamiCommand = Command.make('whoami', {}, () =>
  Effect.gen(function* () {
    const api = yield* Api;
    const session = yield* getSession;
    yield* Console.log(`${describeSession(session)} (${api.baseUrl})`);
  }),
).pipe(Command.withDescription('Show the logged-in user'));
