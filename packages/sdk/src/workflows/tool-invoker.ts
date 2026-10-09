import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import type { IntegrationOverrides, Json } from '../schemas';

export class WorkflowToolInvokeError extends Schema.TaggedError<WorkflowToolInvokeError>()('WorkflowToolInvokeError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

export type WorkflowToolInvokeOptions = {
  /** Integrations the run reaches somewhere else than registered. */
  readonly integrations?: IntegrationOverrides | undefined;
};

export type WorkflowToolInvoke = (
  toolId: string,
  input: Json,
  options: WorkflowToolInvokeOptions,
) => Effect.Effect<Json, WorkflowToolInvokeError>;

/**
 * Runs a bound integration tool by its catalog id. The platform wires it to
 * its executor; a local run points it at a platform over HTTP or at fixed
 * functions. The workflow code only ever sees the LangChain tool built on top.
 */
export class WorkflowToolInvoker extends Context.Service<
  WorkflowToolInvoker,
  {
    readonly invoke: WorkflowToolInvoke;
  }
>()('agentdock-sdk/workflows/tool-invoker/WorkflowToolInvoker') {
  static readonly make = (invoke: WorkflowToolInvoke): Layer.Layer<WorkflowToolInvoker> =>
    Layer.succeed(WorkflowToolInvoker, WorkflowToolInvoker.of({ invoke }));

  /** Resolves each tool id to a plain function; anything else fails at call time. */
  static readonly fromFunctions = (
    tools: Readonly<Record<string, (input: Json) => Promise<Json>>>,
  ): Layer.Layer<WorkflowToolInvoker> =>
    WorkflowToolInvoker.make((toolId, input) => {
      const run = tools[toolId];
      return run
        ? Effect.tryPromise({
            try: () => run(input),
            catch: (error) =>
              new WorkflowToolInvokeError({
                message: error instanceof Error ? error.message : String(error),
                error,
              }),
          })
        : Effect.fail(new WorkflowToolInvokeError({ message: `No tool '${toolId}' is available.`, error: null }));
    });

  static readonly none: Layer.Layer<WorkflowToolInvoker> = WorkflowToolInvoker.fromFunctions({});
}
