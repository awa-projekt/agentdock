import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { IntegrationCatalog, type IntegrationCatalogService } from './catalog';

/**
 * Deciding one frozen tool call, on its own. The workflow run store needs
 * exactly this when a human answers a pending approval, and nothing else the
 * catalog offers.
 */
export type ToolApprovalDeciderService = Pick<IntegrationCatalogService, 'decideApproval'>;

export const ToolApprovalDecider = Context.Service<ToolApprovalDeciderService>('@agentdock/api/ToolApprovalDecider');

export const ToolApprovalDeciderLive = Layer.effect(
  ToolApprovalDecider,
  Effect.gen(function* () {
    const catalog = yield* IntegrationCatalog;
    return ToolApprovalDecider.of({ decideApproval: catalog.decideApproval });
  }),
);
