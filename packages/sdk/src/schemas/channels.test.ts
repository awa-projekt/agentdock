import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { CreateChannelAccountInput } from './channels';

const decode = Schema.decodeUnknownEffect(CreateChannelAccountInput);

describe('CreateChannelAccountInput', () => {
  it.effect('accepts multi-tenant and single-tenant Microsoft Teams credentials', () =>
    Effect.gen(function* () {
      const multiTenant = yield* decode({
        name: 'Teams bot',
        platform: 'teams',
        enabled: true,
        credentials: {
          appId: 'app-id',
          appPassword: 'secret',
          appType: 'MultiTenant',
        },
      });
      const singleTenant = yield* decode({
        name: 'Teams bot',
        platform: 'teams',
        enabled: true,
        credentials: {
          appId: 'app-id',
          appPassword: 'secret',
          appType: 'SingleTenant',
          tenantId: 'tenant-id',
        },
      });

      expect(multiTenant).toMatchObject({ platform: 'teams', credentials: { appType: 'MultiTenant' } });
      expect(singleTenant).toMatchObject({
        platform: 'teams',
        credentials: { appType: 'SingleTenant', tenantId: 'tenant-id' },
      });
    }),
  );

  it.effect('rejects single-tenant Teams credentials without a tenant ID', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decode({
          name: 'Teams bot',
          platform: 'teams',
          enabled: true,
          credentials: {
            appId: 'app-id',
            appPassword: 'secret',
            appType: 'SingleTenant',
          },
        }),
      );

      expect(error).toBeDefined();
    }),
  );

  it.effect('rejects credentials from a different platform', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decode({
          name: 'Discord bot',
          platform: 'discord',
          enabled: true,
          credentials: {
            appId: 'app-id',
            appPassword: 'secret',
            appType: 'MultiTenant',
          },
        }),
      );

      expect(error).toBeDefined();
    }),
  );
});
