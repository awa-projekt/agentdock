import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { WORKFLOW_MANIFEST_FILENAME } from '../schemas';
import { extractWorkflowGraph } from './graph';
import { importWorkflowGraph, loadWorkflowManifest } from './load';

/** The example artifacts, which resolve the host-provided packages from the repository root. */
const examplesRoot = Effect.map(Effect.service(Path.Path), (path) =>
  path.resolve(import.meta.dirname, '../../../../apps/examples/workflows'),
);

const exampleFolders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* examplesRoot;
  const folders = (yield* fs.readDirectory(root)).map((entry) => path.join(root, entry));
  return yield* Effect.filter(folders, (folder) => fs.exists(path.join(folder, WORKFLOW_MANIFEST_FILENAME)));
}).pipe(Effect.provide(NodeServices.layer));

const exampleGraph = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const loaded = yield* loadWorkflowManifest(path.join(yield* examplesRoot, name));
    return yield* extractWorkflowGraph(yield* importWorkflowGraph(loaded), loaded.manifest.name);
  }).pipe(Effect.provide(NodeServices.layer));

describe('example workflows', () => {
  it.effect('import in place and expose a graph, as registration does', () =>
    Effect.gen(function* () {
      const folders = yield* exampleFolders;
      expect(folders.length).toBeGreaterThan(0);
      for (const folder of folders) {
        const loaded = yield* loadWorkflowManifest(folder);
        const compiled = yield* importWorkflowGraph(loaded);
        const graph = yield* extractWorkflowGraph(compiled, loaded.manifest.name);
        expect(graph.nodes.length, loaded.manifest.name).toBeGreaterThan(0);
      }
    }),
  );

  it.effect("draws the support desk's roles: the desk's router and its specialists, and the review looping back", () =>
    Effect.gen(function* () {
      const graph = yield* exampleGraph('support-desk');
      const steps = graph.nodes.flatMap((node) => (node.kind === 'step' ? [node.id] : []));
      const edges = graph.edges.map((edge) => `${edge.source} ${edge.conditional ? '-.->' : '-->'} ${edge.target}`);

      expect(steps).toEqual([
        'prepare',
        'support:desk:route',
        'support:desk:billing',
        'support:desk:tech',
        'support:desk:synthesize',
        'support:review',
        'respond',
      ]);
      // The bound specialists run on the platform: each is a single step.
      expect(edges).toEqual(
        expect.arrayContaining([
          'prepare --> support:__start__',
          'support:__start__ --> support:desk:route',
          'support:desk:route -.-> support:desk:billing',
          'support:desk:route -.-> support:desk:tech',
          'support:desk:billing --> support:desk:synthesize',
          'support:desk:synthesize --> support:review',
          'support:review -.-> support:desk:route',
          'support:review -.-> support:__end__',
          'support:__end__ --> respond',
        ]),
      );
    }),
  );
});
