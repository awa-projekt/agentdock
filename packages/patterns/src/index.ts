/**
 * Graph-level multi-agent patterns for agentdock workflows. The agents are
 * platform agents (`contextAgent`), the models platform models
 * (`contextModel`); a pattern wires them into a LangGraph graph whose nodes
 * are named after the participants' roles, so the workflow graph view shows
 * who does what. Every factory returns a compiled graph that speaks the agent
 * contract (`{ messages }` in, `{ messages, structuredResponse? }` out), so
 * patterns nest and embed as subgraphs.
 *
 * | Pattern              | Factory                                                                        |
 * | -------------------- | ------------------------------------------------------------------------------ |
 * | Sequential pipeline  | `createPipeline` + `llmStep` / `structuredStep` / `agentStep` / `functionStep` |
 * | Router               | `createRouter`                                                                 |
 * | Parallelization      | `createParallel`, `createVoting`, `createMapReduce`                            |
 * | Orchestrator-workers | `createOrchestrator`                                                           |
 * | Evaluator-optimizer  | `createEvaluatorOptimizer`, `Evaluation`                                       |
 *
 * Test helpers: `agentdock-patterns/testing`.
 */
export {
  type Agent,
  type AgentInput,
  type AgentOutput,
  type AgentResult,
  agentAsNode,
  agentGraph,
  type Checkpointer,
  contextAgent,
  Evaluation,
  finalText,
  invokeAgent,
  type Participant,
  type RetryPolicy,
  resultsBlock,
  type StepPolicies,
  type StepTimeout,
  type Subgraph,
  WorkResult,
} from './core.ts';
export {
  type AgentJudge,
  type Candidate,
  type CarryOver,
  createEvaluatorOptimizer,
  type EvaluatorOptimizerOptions,
  type Judge,
  type ModelJudge,
  type ReviewState,
} from './evaluator-optimizer.ts';
export { createMapReduce, type Mapper } from './map-reduce.ts';
export { ContextModel, contextModel, type ModelLike, type StructuredOutputMethod, structuredLlm } from './models.ts';
export { createOrchestrator, WorkResults } from './orchestrator.ts';
export { type BranchResults, createParallel, type ParallelOptions, type RerunState } from './parallel.ts';
export {
  agentStep,
  createPipeline,
  defaultPrompt,
  functionStep,
  llmStep,
  type PipelineState,
  type PipelineStep,
  type StepOutput,
  structuredStep,
} from './pipeline.ts';
export { createRouter, type RouteTask } from './router.ts';
export { createVoting } from './voting.ts';
