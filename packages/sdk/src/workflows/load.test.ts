import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import type { JsonObject } from '../schemas/json';
import { importWorkflowGraph, loadWorkflowManifest } from './load';
import { artifactFixture, artifactJson, writeArtifactFile } from './test-artifact';

// Fixture modules are written as `.mjs` so a plain dynamic import needs no
// transform step.
const artifact = (files: Readonly<Record<string, string>>) => artifactFixture('.tmp-load-test-', files);

const manifest = (overrides: JsonObject = {}): string =>
  artifactJson({
    name: 'Fixture',
    description: 'A fixture workflow.',
    version: '1.0.0',
    graph: './workflow.mjs:default',
    ...overrides,
  });

const PACKAGE = artifactJson({ name: 'fixture', type: 'module', peerDependencies: { '@langchain/langgraph': '^1' } });

const GRAPH = `
import { entrypoint } from '@langchain/langgraph';
export default entrypoint('fixture', async (input) => input);
export const factory = () => entrypoint('fixture', async (input) => input);
`;

describe('loadWorkflowManifest', () => {
  it.effect('reads the manifest, package and graph location, and hashes the folder', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest(),
        'package.json': PACKAGE,
        'workflow.mjs': GRAPH,
      });

      const loaded = yield* loadWorkflowManifest(folder);

      expect(loaded.manifest.name).toBe('Fixture');
      expect(loaded.graph).toEqual({ module: './workflow.mjs', exportName: 'default' });
      expect(loaded.package.peerDependencies['@langchain/langgraph']).toBe('^1');
      expect(loaded.package.hasLockfile).toBe(false);
      expect(loaded.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    }),
  );

  it.effect('defaults the graph to ./workflow.ts:default when the manifest omits it', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': artifactJson({ name: 'F', description: 'd', version: '1.0.0' }),
        'package.json': PACKAGE,
        'workflow.ts': GRAPH,
      });

      const loaded = yield* loadWorkflowManifest(folder);

      expect(loaded.graph).toEqual({ module: './workflow.ts', exportName: 'default' });
    }),
  );

  it.effect('fails when the manifest is missing', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({ 'package.json': PACKAGE, 'workflow.mjs': GRAPH });

      const failure = yield* Effect.flip(loadWorkflowManifest(folder));

      expect(failure._tag).toBe('WorkflowArtifactReadError');
    }),
  );

  it.effect('fails when the manifest does not satisfy the contract', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': artifactJson({ name: 'F' }),
        'package.json': PACKAGE,
        'workflow.mjs': GRAPH,
      });

      const failure = yield* Effect.flip(loadWorkflowManifest(folder));

      expect(failure._tag).toBe('WorkflowArtifactDecodeError');
    }),
  );

  it.effect('fails when the graph module does not exist', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest({ graph: './nope.mjs:default' }),
        'package.json': PACKAGE,
      });

      const failure = yield* Effect.flip(loadWorkflowManifest(folder));

      expect(failure._tag).toBe('WorkflowArtifactValidationError');
    }),
  );

  it.effect('fails when the artifact has no package.json', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({ 'agentdock.workflow.json': manifest(), 'workflow.mjs': GRAPH });

      const failure = yield* Effect.flip(loadWorkflowManifest(folder));

      expect(failure._tag).toBe('WorkflowArtifactValidationError');
      expect(failure.message).toContain('package.json');
    }),
  );

  it.effect('rejects an artifact that installs a host-provided package itself', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest(),
        'package.json': artifactJson({ name: 'f', dependencies: { '@langchain/langgraph': '^1' } }),
        'workflow.mjs': GRAPH,
      });

      const failure = yield* Effect.flip(loadWorkflowManifest(folder));

      expect(failure.message).toContain('peerDependency');
    }),
  );

  // The hash is what makes artifact drift visible, so it has to cover files the
  // graph module merely imports — not just the module itself.
  it.effect('changes the source hash when an imported helper changes', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest(),
        'package.json': PACKAGE,
        'workflow.mjs': "export { default } from './helper.mjs';\n",
        'helper.mjs': 'export default () => 1;\n',
      });
      const before = yield* loadWorkflowManifest(folder);

      yield* writeArtifactFile(folder, 'helper.mjs', 'export default () => 2;\n');
      const after = yield* loadWorkflowManifest(folder);

      expect(after.sourceHash).not.toBe(before.sourceHash);
    }),
  );
});

describe('importWorkflowGraph', () => {
  it.effect('returns the compiled graph the manifest points at', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest(),
        'package.json': PACKAGE,
        'workflow.mjs': GRAPH,
      });
      const loaded = yield* loadWorkflowManifest(folder);

      const compiled = yield* importWorkflowGraph(loaded);

      expect(compiled.stream).toBeTypeOf('function');
      expect(compiled.checkpointer).toBeUndefined();
    }),
  );

  it.effect('calls a factory export and accepts the graph it returns', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest({ graph: './workflow.mjs:factory' }),
        'package.json': PACKAGE,
        'workflow.mjs': GRAPH,
      });
      const loaded = yield* loadWorkflowManifest(folder);

      const compiled = yield* importWorkflowGraph(loaded);

      expect(compiled.getGraphAsync).toBeTypeOf('function');
    }),
  );

  it.effect('fails when the export is missing or is not a compiled graph', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest({ graph: './workflow.mjs:nope' }),
        'package.json': PACKAGE,
        'workflow.mjs': 'export const other = 1;\n',
      });
      const loaded = yield* loadWorkflowManifest(folder);

      const missing = yield* Effect.flip(importWorkflowGraph(loaded));
      expect(missing.message).toContain("no export named 'nope'");

      const notGraph = yield* Effect.flip(
        importWorkflowGraph({ ...loaded, graph: { module: './workflow.mjs', exportName: 'other' } }),
      );
      expect(notGraph.message).toContain('not a compiled LangGraph');
    }),
  );

  it.effect('rejects a graph compiled with its own checkpointer', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest(),
        'package.json': PACKAGE,
        'workflow.mjs': `
          import { entrypoint, MemorySaver } from '@langchain/langgraph';
          export default entrypoint({ name: 'own', checkpointer: new MemorySaver() }, async (input) => input);
        `,
      });
      const loaded = yield* loadWorkflowManifest(folder);

      const failure = yield* Effect.flip(importWorkflowGraph(loaded));

      expect(failure.message).toContain('without a checkpointer');
    }),
  );

  it.effect('fails with the module error when the module throws on import', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': manifest(),
        'package.json': PACKAGE,
        'workflow.mjs': "throw new Error('boom at import time');\n",
      });
      const loaded = yield* loadWorkflowManifest(folder);

      const failure = yield* Effect.flip(importWorkflowGraph(loaded));

      expect(failure.message).toContain('boom at import time');
    }),
  );
});
