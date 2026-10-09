import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { ResolvedModel } from './loop';
import type { ModelRuntimeConfig } from './providers';
import { SUPPORTED_LLM_PROVIDERS } from './providers';

export class ModelProviderError extends Schema.TaggedError<ModelProviderError>()('ModelProviderError', {
  message: Schema.String,
  error: Schema.Defect(),
}) {}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** A `provider:model` reference split into its parts. */
export type ModelReference = {
  readonly provider: string;
  readonly modelId: string;
};

export const parseModelString = (model: string): ModelReference => {
  const separatorIndex = model.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`Invalid model '${model}'. Expected provider:model.`);
  }

  const provider = model.slice(0, separatorIndex).trim();
  const providerModel = model.slice(separatorIndex + 1).trim();

  if (provider.length === 0 || providerModel.length === 0) {
    throw new Error(`Invalid model '${model}'. Expected provider:model.`);
  }

  return { provider, modelId: providerModel };
};

export class ModelProvider extends Context.Service<
  ModelProvider,
  {
    readonly resolve: (model: string) => Effect.Effect<ResolvedModel, ModelProviderError>;
  }
>()('agentdock-sdk/agents/model-provider/ModelProvider') {
  /** Reads standard provider API-key env vars directly; no DB, no host services. */
  static readonly fromEnv = Layer.effect(
    ModelProvider,
    Effect.gen(function* () {
      const apiKeys = new Map<string, string>();
      for (const [providerId, envVar] of SUPPORTED_PROVIDER_ENV_VARS) {
        const value = yield* Config.option(Config.String(envVar));
        if (Option.isSome(value)) apiKeys.set(providerId, value.value);
      }

      return ModelProvider.of({
        resolve: (model) =>
          Effect.try({
            try: () => {
              const { provider, modelId } = parseModelString(model);
              const apiKey = apiKeys.get(provider);
              const config: ModelRuntimeConfig | undefined = apiKey === undefined ? undefined : { apiKey };
              return { model, provider, modelId, config };
            },
            catch: (error) => new ModelProviderError({ message: errorMessage(error), error }),
          }),
      });
    }),
  );
}

const SUPPORTED_PROVIDER_ENV_VARS: ReadonlyArray<readonly [string, string]> = SUPPORTED_LLM_PROVIDERS.map((p) => [
  p.id,
  p.envVar,
]);
