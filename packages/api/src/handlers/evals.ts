import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { getSessionUser } from '../auth-middleware';
import { EvalGates } from '../evals/gates';
import { EvalService } from '../evals/service';
import { withHttpRootSpan } from '../tracing';

/** Who reviewed a trial: the signed-in user, or nobody in particular when auth is off. */
const reviewer = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const user = yield* getSessionUser(request);
  return user?.email ?? user?.id;
});

export const evalsHandler = HttpApiBuilder.group(AgentdockApi, 'evals', (handlers) =>
  handlers
    .handle('listEvalDatasets', () =>
      EvalService.use((evals) => evals.listDatasets()).pipe(
        withHttpRootSpan('agentdock.http.request.evals.datasets.list'),
      ),
    )
    .handle('createEvalDataset', ({ payload }) =>
      EvalService.use((evals) => evals.createDataset(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.datasets.create'),
      ),
    )
    .handle('getEvalDataset', ({ params }) =>
      EvalService.use((evals) => evals.getDataset(params.datasetId)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.datasets.get'),
      ),
    )
    .handle('updateEvalDataset', ({ params, payload }) =>
      EvalService.use((evals) => evals.updateDataset(params.datasetId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.datasets.update'),
      ),
    )
    .handle('removeEvalDataset', ({ params }) =>
      EvalService.use((evals) => evals.removeDataset(params.datasetId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.evals.datasets.remove'),
      ),
    )
    .handle('addEvalCases', ({ params, payload }) =>
      EvalService.use((evals) => evals.addCases(params.datasetId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.cases.add'),
      ),
    )
    .handle('updateEvalCase', ({ params, payload }) =>
      EvalService.use((evals) => evals.updateCase(params.datasetId, params.caseId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.cases.update'),
      ),
    )
    .handle('removeEvalCases', ({ params, payload }) =>
      EvalService.use((evals) => evals.removeCases(params.datasetId, payload.caseIds)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.evals.cases.remove'),
      ),
    )
    .handle('listEvalGraders', () =>
      EvalService.use((evals) => evals.listGraders()).pipe(
        withHttpRootSpan('agentdock.http.request.evals.graders.list'),
      ),
    )
    .handle('createEvalGrader', ({ payload }) =>
      EvalService.use((evals) => evals.createGrader(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.graders.create'),
      ),
    )
    .handle('testEvalGrader', ({ payload }) =>
      EvalService.use((evals) => evals.testGrader(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.graders.test'),
      ),
    )
    .handle('updateEvalGrader', ({ params, payload }) =>
      EvalService.use((evals) => evals.updateGrader(params.graderId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.graders.update'),
      ),
    )
    .handle('removeEvalGrader', ({ params }) =>
      EvalService.use((evals) => evals.removeGrader(params.graderId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.evals.graders.remove'),
      ),
    )
    .handle('listEvalRuns', () =>
      EvalService.use((evals) => evals.listRuns()).pipe(withHttpRootSpan('agentdock.http.request.evals.runs.list')),
    )
    .handle('startEvalRun', ({ payload }) =>
      EvalService.use((evals) => evals.startRun(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.runs.start'),
      ),
    )
    .handle('getEvalRun', ({ params }) =>
      EvalService.use((evals) => evals.getRun(params.runId)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.runs.get'),
      ),
    )
    .handle('cancelEvalRun', ({ params }) =>
      EvalService.use((evals) => evals.cancelRun(params.runId)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.runs.cancel'),
      ),
    )
    .handle('regradeEvalRun', ({ params, payload }) =>
      EvalService.use((evals) => evals.regradeRun(params.runId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.runs.regrade'),
      ),
    )
    .handle('removeEvalRun', ({ params }) =>
      EvalService.use((evals) => evals.removeRun(params.runId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.evals.runs.remove'),
      ),
    )
    .handle('setEvalReview', ({ params, payload }) =>
      Effect.gen(function* () {
        const reviewedBy = yield* reviewer;
        return yield* EvalService.use((evals) => evals.setReview(params.runId, params.trialId, payload, reviewedBy));
      }).pipe(withHttpRootSpan('agentdock.http.request.evals.trials.review')),
    )
    .handle('listEvalGates', () =>
      EvalGates.use((gates) => gates.list()).pipe(withHttpRootSpan('agentdock.http.request.evals.gates.list')),
    )
    .handle('createEvalGate', ({ payload }) =>
      EvalGates.use((gates) => gates.create(payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.gates.create'),
      ),
    )
    .handle('updateEvalGate', ({ params, payload }) =>
      EvalGates.use((gates) => gates.update(params.gateId, payload)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.gates.update'),
      ),
    )
    .handle('removeEvalGate', ({ params }) =>
      EvalGates.use((gates) => gates.remove(params.gateId)).pipe(
        Effect.map((removed) => ({ removed })),
        withHttpRootSpan('agentdock.http.request.evals.gates.remove'),
      ),
    )
    .handle('runEvalGate', ({ params }) =>
      EvalGates.use((gates) => gates.run(params.gateId)).pipe(
        withHttpRootSpan('agentdock.http.request.evals.gates.run'),
      ),
    ),
);
