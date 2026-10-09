import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import { AgentLoopFactory } from '../agents/loop';
import { ModelProvider } from '../agents/model-provider';
import { AgentRunStore } from '../agents/run-store';
import { AgentToolResolver } from '../agents/tool-resolver';
import type { WorkflowRunEvent } from '../schemas';
import { WorkflowRunStore } from '../workflows/run-store';
import { artifactFixture, artifactJson } from '../workflows/test-artifact';
import { WorkflowToolInvoker } from '../workflows/tool-invoker';
import { runWorkflowLocally } from './run-workflow';

const artifact = (files: Readonly<Record<string, string>>) => artifactFixture('.tmp-run-workflow-test-', files);

const MANIFEST = artifactJson({
  name: 'Review gate',
  description: 'Pauses on interrupt and echoes the answer.',
  version: '1.0.0',
  graph: './workflow.mjs:default',
});
const PACKAGE = artifactJson({
  name: 'review-gate',
  type: 'module',
  peerDependencies: { '@langchain/langgraph': '^1' },
});
const GRAPH = `
import { entrypoint, interrupt, task } from '@langchain/langgraph';
const done = task('done', async (answer) => 'decision: ' + answer.decision);
export default entrypoint('review', async (input) => done(interrupt({ title: 'Approve?', input })));
`;

const layer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(AgentLoopFactory, AgentLoopFactory.of({ create: () => Effect.die('no agents in this workflow') })),
  Layer.succeed(ModelProvider, ModelProvider.of({ resolve: () => Effect.die('no models in this workflow') })),
  AgentToolResolver.static([]),
  AgentRunStore.inMemory,
  WorkflowRunStore.inMemory,
  WorkflowToolInvoker.none,
);

describe('runWorkflowLocally', () => {
  it.effect('leaves an unanswered interrupt as input-required with the request attached', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': MANIFEST,
        'package.json': PACKAGE,
        'workflow.mjs': GRAPH,
      });

      const result = yield* runWorkflowLocally({ artifact: folder, bindings: [], input: 'draft' });

      expect(result.status).toBe('input-required');
      expect(result.pending?.title).toBe('Approve?');
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect('resumes from the checkpoint when onInputRequired answers', () =>
    Effect.gen(function* () {
      const folder = yield* artifact({
        'agentdock.workflow.json': MANIFEST,
        'package.json': PACKAGE,
        'workflow.mjs': GRAPH,
      });
      const events: Array<WorkflowRunEvent['type']> = [];

      const result = yield* runWorkflowLocally({
        artifact: folder,
        bindings: [],
        input: 'draft',
        onEvent: (event) => events.push(event.type),
        onInputRequired: () => Effect.succeed({ decision: 'approve' }),
      });

      expect(result.status).toBe('completed');
      expect(result.text).toBe('decision: approve');
      expect(result.pending).toBeUndefined();
      expect(events).toContain('human-input-requested');
      expect(events).toContain('human-input-resolved');
      expect(events.at(-1)).toBe('run-completed');
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
