import { HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Effect } from 'effect';
import { AgentdockApi } from '../api';
import { SkillRegistry } from '../skills/service';
import { withHttpRootSpan } from '../tracing';

const jsonResponse = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });
const toErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
    if (typeof cause === 'string' && cause.trim().length > 0) return cause;
  }
  return fallback;
};

export const skillsHandler = HttpApiBuilder.group(AgentdockApi, 'skills', (handlers) =>
  handlers
    .handle('listSkills', () =>
      SkillRegistry.use((registry) => registry.list()).pipe(
        withHttpRootSpan('agentdock.http.request.skills.list'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to list skills')))),
      ),
    )
    .handle('addSkill', ({ payload }) =>
      SkillRegistry.use((registry) => registry.add(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.skills.add'),
        Effect.catch((error) => Effect.succeed(jsonResponse(400, toErrorMessage(error, 'Failed to add skill')))),
      ),
    )
    .handle('pullSkills', ({ payload }) =>
      SkillRegistry.use((registry) => registry.pull(payload)).pipe(
        Effect.map((skills) => ({ skills })),
        withHttpRootSpan('agentdock.http.request.skills.pull'),
        Effect.catch((error) => Effect.succeed(jsonResponse(400, toErrorMessage(error, 'Failed to pull skills')))),
      ),
    )
    .handle('removeSkill', ({ params }) =>
      SkillRegistry.use((registry) => registry.remove(params.skillId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.skills.remove'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to remove skill')))),
      ),
    )
    .handle('assignAgentSkills', ({ params, payload }) =>
      SkillRegistry.use((registry) => registry.assignToAgent(params.agentId, payload.skillIds)).pipe(
        Effect.map((updated) => ({ updated })),
        withHttpRootSpan('agentdock.http.request.skills.assign'),
        Effect.catch((error) => Effect.succeed(jsonResponse(400, toErrorMessage(error, 'Failed to assign skills')))),
      ),
    )
    .handle('loadAgentSkill', ({ params }) =>
      Effect.gen(function* () {
        const registry = yield* SkillRegistry;
        const skill = yield* registry.loadForAgent(params.agentId, params.skillId);
        return skill ? { skill } : jsonResponse(404, 'Skill not found for agent');
      }).pipe(
        withHttpRootSpan('agentdock.http.request.skills.load'),
        Effect.catch((error) => Effect.succeed(jsonResponse(500, toErrorMessage(error, 'Failed to load skill')))),
      ),
    ),
);
