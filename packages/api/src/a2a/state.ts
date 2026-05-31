import type { TaskStore } from '@a2a-js/sdk/server';
import { Context, Effect, Layer } from 'effect';
import type { ContextHistoryStore } from 'agentdock-sdk';
import { AgentA2aSessionStore } from './session-store';

type AgentA2aStateService = {
  readonly getTaskStore: (agentId: string) => Effect.Effect<TaskStore, unknown>;
  readonly getContextHistoryStore: (agentId: string) => Effect.Effect<ContextHistoryStore, unknown>;
};

export const AgentA2aState = Context.Service<AgentA2aStateService>('@agentdock/api/AgentA2aState');

export const AgentA2aStateLive = Layer.effect(
  AgentA2aState,
  Effect.gen(function* () {
    const sessionStore = yield* AgentA2aSessionStore;

    return AgentA2aState.of({
      getTaskStore: sessionStore.getTaskStore,
      getContextHistoryStore: sessionStore.getContextHistoryStore,
    });
  }),
);
