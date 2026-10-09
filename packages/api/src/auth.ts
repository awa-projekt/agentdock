import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { admin, bearer, deviceAuthorization } from 'better-auth/plugins';
import {
  authAccountTable,
  authDeviceCodeTable,
  authSessionTable,
  authUserTable,
  authVerificationTable,
  Database,
  type DatabaseClient,
  DatabaseLive,
} from 'db';
import { count } from 'drizzle-orm';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { AuthConfig, AuthConfigLive, type AuthConfigService } from './config';

const trustedOriginsForRequest =
  (trustedOrigins: ReadonlyArray<string>) =>
  (request?: Request): Array<string> => {
    const origin = request?.headers.get('origin');
    return origin ? [...trustedOrigins, origin] : [...trustedOrigins];
  };

const makeAuth = (db: DatabaseClient, config: AuthConfigService) =>
  betterAuth({
    baseURL: config.baseUrl,
    secret: Redacted.value(config.secret),
    trustedOrigins: config.allowAllDevOrigins
      ? trustedOriginsForRequest(config.trustedOrigins)
      : [...config.trustedOrigins],
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: authUserTable,
        session: authSessionTable,
        account: authAccountTable,
        verification: authVerificationTable,
        deviceCode: authDeviceCodeTable,
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const [existing] = await db.select({ total: count() }).from(authUserTable).all();
            return {
              data: {
                ...user,
                role: existing?.total === 0 ? 'admin' : 'user',
              },
            };
          },
        },
      },
    },
    plugins: [
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      // CLI login: the CLI requests a device code, the user approves it in the
      // web app, and the CLI polls for a session token it then sends as a
      // bearer header.
      deviceAuthorization({ verificationUri: `${config.webOrigin}/device`, schema: {} }),
      bearer(),
    ],
  });

declare const auth: ReturnType<typeof makeAuth>;
export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = AuthSession['user'];

export type AuthService = { readonly auth: ReturnType<typeof makeAuth> };
export const Auth = Context.Service<AuthService>('@agentdock/api/Auth');
export const AuthLive = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const { db } = yield* Database;
    const config = yield* AuthConfig;
    return Auth.of({ auth: makeAuth(db, config) });
  }),
).pipe(Layer.provideMerge(AuthConfigLive), Layer.provide(DatabaseLive));
