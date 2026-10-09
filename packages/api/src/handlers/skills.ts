import { causeMessage } from 'db';
import * as Effect from 'effect/Effect';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Predicate from 'effect/Predicate';
import { AgentdockApi } from '../api';
import type { SkillParseError } from '../skills/parser';
import { SkillRegistry, type SkillRegistryError } from '../skills/service';
import { withHttpRootSpan } from '../tracing';

const jsonResponse = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status });

const failureText = (cause: unknown): string =>
  cause instanceof Error || Predicate.isString(cause) ? causeMessage(cause) : '';

const toErrorMessage = (error: SkillParseError | SkillRegistryError, fallback: string): string => {
  const message = error._tag === 'SkillParseError' ? error.message : failureText(error.cause);
  return message.trim().length > 0 ? message : fallback;
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
    ),
);
