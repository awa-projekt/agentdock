import { useLocation, useRoute } from 'wouter';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { decodeRouteParam, routePatterns, type WorkflowMode, workflowsPath } from '@/lib/routing';
import { WorkflowRegistryView } from '@/views/WorkflowRegistryView';
import { WorkflowRunsView } from '@/views/WorkflowRunsView';

const toWorkflowMode = (value: string): WorkflowMode => (value === 'runs' ? 'runs' : 'registry');

/**
 * Workflows tab shell: a Registry | Runs toggle. There is no build mode —
 * workflows are code in a folder, authored in an editor and registered by path.
 * Both modes are driven by the route so they are deep-linkable and survive
 * reloads.
 */
export function WorkflowsView() {
  const [, navigate] = useLocation();
  const [isRuns, runsParams] = useRoute(routePatterns.workflowRuns);
  const mode: WorkflowMode = isRuns ? 'runs' : 'registry';
  const runId = decodeRouteParam(runsParams?.runId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Tabs value={mode} onValueChange={(value) => navigate(workflowsPath(toWorkflowMode(value)))} className="shrink-0">
        <TabsList>
          <TabsTrigger value="registry">Registry</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="min-h-0 flex-1">
        {mode === 'runs' ? (
          <WorkflowRunsView
            selectedRunId={runId}
            onSelectRun={(nextRunId) => navigate(workflowsPath('runs', nextRunId))}
          />
        ) : (
          <WorkflowRegistryView />
        )}
      </div>
    </div>
  );
}
