import { coerceJson, isJsonObject, type JsonObject } from 'agentdock-sdk/schemas';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import { withHttpRootSpan } from '../tracing';
import { TriggerDispatcher } from './dispatch';
import { TriggerRegistry } from './service';

const json = (status: number, body: JsonObject) => HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Inbound webhook endpoint. A request authenticates with the trigger's secret in
 * the `x-trigger-secret` header; the JSON body becomes the event payload the
 * task template renders against (`{{payload}}` is the whole body).
 */
const WebhookRoute = HttpRouter.add(
  'POST',
  '/triggers/:triggerId/webhook',
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const triggerId = params.triggerId;
    yield* Effect.annotateCurrentSpan({ 'trigger.id': triggerId ?? 'unknown' });

    if (!triggerId) {
      return json(404, { error: 'Trigger not found' });
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const registry = yield* TriggerRegistry;
    const trigger = yield* registry.getById(triggerId);

    if (!trigger || trigger.spec.type !== 'webhook') {
      return json(404, { error: 'Webhook trigger not found' });
    }

    if (!trigger.enabled) {
      return json(409, { error: 'Trigger is disabled' });
    }

    const provided = request.headers['x-trigger-secret'];
    if (provided !== trigger.spec.secret) {
      return json(401, { error: 'Invalid trigger secret' });
    }

    const body = coerceJson(yield* request.json.pipe(Effect.catch(() => Effect.succeed({}))));
    const payload = isJsonObject(body) ? body : { value: body };
    const dispatcher = yield* TriggerDispatcher;
    const result = yield* dispatcher.dispatch(trigger, payload, 'webhook');

    return json(202, { taskId: result.taskId });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(json(500, { error: error instanceof Error ? error.message : 'Trigger webhook failed' })),
    ),
    Effect.withSpan('agentdock.triggers.webhook'),
    withHttpRootSpan('agentdock.http.request.triggers.webhook'),
  ),
);

export const TriggerRoutes = Layer.mergeAll(WebhookRoute);
