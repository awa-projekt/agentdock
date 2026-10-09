import { assert, describe } from '@effect/vitest';

import { oxlintRuleHarness } from '../test/harness.ts';

const rule = oxlintRuleHarness('agentdock/namespace-node-imports');

describe('agentdock/namespace-node-imports', () => {
  rule.valid(
    'allows canonical Node namespaces',
    `
      import * as NodeFS from 'node:fs';
      import * as NodeFSP from 'node:fs/promises';
      import * as NodeAssert from 'node:assert/strict';
      import * as NodeChildProcess from 'node:child_process';
      import * as NodeReadlinePromises from 'node:readline/promises';
      import * as NodeAsyncHooks from 'node:async_hooks';
      import type * as NodeStream from 'node:stream';

      NodeAssert.ok(NodeChildProcess.spawn && NodeReadlinePromises.createInterface && NodeAsyncHooks.AsyncLocalStorage);
      export const read = NodeFS.readFileSync;
      export const readAsync = NodeFSP.readFile;
      export type Input = NodeStream.Readable;
    `,
  );

  rule.valid(
    'does not apply to non-Node packages',
    `
      import { Effect } from 'effect';
      export const ok = Effect.void;
    `,
  );

  rule.invalid(
    'reports named imports',
    `
      import { readFile } from 'node:fs/promises';
      export const read = readFile;
    `,
    (output) => {
      assert.match(output, /namespace named NodeFSP/);
    },
  );

  rule.invalid(
    'reports default imports',
    `
      import path from 'node:path';
      export const join = path.join;
    `,
    (output) => {
      assert.match(output, /namespace named NodePath/);
    },
  );

  rule.invalid(
    'reports non-canonical namespace aliases',
    `
      import * as Crypto from 'node:crypto';
      import * as NodeOs from 'node:os';
      export const ids = [Crypto.randomUUID(), NodeOs.tmpdir()];
    `,
    (output) => {
      assert.match(output, /namespace named NodeCrypto/);
      assert.match(output, /namespace named NodeOS/);
    },
  );
});
