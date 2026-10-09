import { useLocation, useRoute } from 'wouter';
import { SectionHeader } from '@/components/SectionHeader';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { decodeRouteParam, type EvalsTab, evalsPath, routePatterns } from '@/lib/routing';
import { DatasetsTab } from '@/views/evals/DatasetsTab';
import { GatesTab } from '@/views/evals/GatesTab';
import { GradersTab } from '@/views/evals/GradersTab';
import { RunsTab } from '@/views/evals/RunsTab';
import { SessionsTab } from '@/views/evals/SessionsTab';

const TABS = ['runs', 'datasets', 'graders', 'gates', 'sessions'] as const satisfies ReadonlyArray<EvalsTab>;

const toEvalsTab = (value: string | undefined): EvalsTab => TABS.find((tab) => tab === value) ?? 'runs';

/**
 * Evals shell. Datasets hold the tasks, graders score the answers, runs send
 * every task to an agent or workflow and grade what comes back, gates rerun a
 * dataset whenever an agent changes, and sessions are where real
 * conversations become new tasks. The tab and the selected
 * item live in the route so both are deep-linkable.
 */
export function EvalsView() {
  const [, navigate] = useLocation();
  const [, params] = useRoute(routePatterns.evals);
  const tab = toEvalsTab(params?.tab);
  const itemId = decodeRouteParam(params?.itemId);
  const select = (next: EvalsTab) => (id: string | null) => navigate(evalsPath(next, id));

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SectionHeader
        title="Evals"
        description="Measure agents and workflows on datasets of tasks, with code checks, LLM judges and human review."
        actions={
          <Tabs value={tab} onValueChange={(next) => navigate(evalsPath(toEvalsTab(next)))}>
            <TabsList>
              <TabsTrigger value="runs">Runs</TabsTrigger>
              <TabsTrigger value="datasets">Datasets</TabsTrigger>
              <TabsTrigger value="graders">Graders</TabsTrigger>
              <TabsTrigger value="gates">Gates</TabsTrigger>
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'runs' ? (
          <RunsTab runId={itemId} onSelectRun={select('runs')} />
        ) : tab === 'datasets' ? (
          <DatasetsTab
            datasetId={itemId}
            onSelectDataset={select('datasets')}
            onRunStarted={(runId) => navigate(evalsPath('runs', runId))}
          />
        ) : tab === 'graders' ? (
          <GradersTab graderId={itemId} onSelectGrader={select('graders')} />
        ) : tab === 'gates' ? (
          <GatesTab onOpenRun={(runId) => navigate(evalsPath('runs', runId))} />
        ) : (
          <SessionsTab />
        )}
      </div>
    </div>
  );
}
