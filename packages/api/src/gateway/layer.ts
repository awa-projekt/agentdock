import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as LibsqlClient from '@effect/sql-libsql/LibsqlClient';
import { type GatewayCoreServices, type GatewayStoreError, gatewayCoreLayer } from '@integragents/gateway-core';
import { BlobStore, createEncryption, type StorageError } from '@integragents/host';
import { Database, SecretCipherKey, SecretCipherKeyLive } from 'db';
import * as Config from 'effect/Config';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import type * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import { ServerConfig } from '../config';

const defaultBlobDirectory = 'agentdock-blobs';

/**
 * The integrations gateway embedded on the platform's own database: catalog,
 * connections, credentials, policy, approvals and audit as Effect services.
 * The gateway applies its own migrations on start, so the platform's Drizzle
 * pipeline never has to know its tables.
 */
export const GatewayLive: Layer.Layer<
  GatewayCoreServices,
  Config.ConfigError | GatewayStoreError | StorageError,
  Context.Service.Identifier<typeof Database> | Context.Service.Identifier<typeof ServerConfig> | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Database;
    const { key } = yield* SecretCipherKey;
    const server = yield* ServerConfig;
    const blobDirectory = yield* Config.String('AGENTDOCK_GATEWAY_BLOB_DIR').pipe(
      Config.orElse(() => Config.succeed(defaultBlobDirectory)),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.orDie(fs.makeDirectory(blobDirectory, { recursive: true }));
    return gatewayCoreLayer({
      encryption: createEncryption(key),
      blobs: BlobStore.fileLayer(blobDirectory),
      publicUrlOf: () => server.apiBaseUrl,
    }).pipe(Layer.provide(Layer.mergeAll(LibsqlClient.layer({ liveClient: database.client }), NodeCrypto.layer)));
  }),
).pipe(Layer.provide(Layer.mergeAll(Layer.orDie(SecretCipherKeyLive), NodeFileSystem.layer)));
