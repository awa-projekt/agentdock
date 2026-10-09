import type { RegisteredWorkflow, WorkflowArtifactFile } from 'agentdock-sdk/schemas';
import { DEFAULT_WORKFLOW_GRAPH, workflowGraphHasTopology } from 'agentdock-sdk/schemas';
import { FolderCode, Loader2, Trash2, TriangleAlert, Upload, Waypoints, X } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { WorkflowGraphCanvas } from '@/components/graph/workflow-graph';
import { ListSkeleton } from '@/components/Loading';
import { ErrorBanner } from '@/components/StatusMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toErrorMessage } from '@/lib/format';
import { useRegisterWorkflow, useRemoveWorkflow, useWorkflows } from '@/lib/queries';

const SKIPPED_FOLDERS = ['node_modules/', '.git/', 'dist/', '.agentdock/'];

const artifactPath = (file: File): string | null => {
  const relative = file.webkitRelativePath || file.name;
  const path = relative.slice(relative.indexOf('/') + 1);
  return path && !SKIPPED_FOLDERS.some((folder) => path.includes(folder)) ? path : null;
};

const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const readArtifactFiles = async (files: FileList): Promise<Array<WorkflowArtifactFile>> => {
  const kept = Array.from(files).flatMap((file) => {
    const path = artifactPath(file);
    return path ? [{ file, path }] : [];
  });
  return Promise.all(
    kept.map(async ({ file, path }) => ({ path, content: base64Of(new Uint8Array(await file.arrayBuffer())) })),
  );
};

/**
 * Why a workflow has no graph to show, or `null` when it has one. Never
 * captured and nothing to capture are different problems with different fixes,
 * so they say different things.
 */
const missingGraphReason = (workflow: RegisteredWorkflow): string | null => {
  if (workflowGraphHasTopology(workflow.graph)) return null;
  return workflow.graph.nodes.length === 0
    ? 'No graph captured — register the folder again to read it off the compiled graph.'
    : 'No graph to draw: this workflow builds its shape as it runs, so only its steps are recorded.';
};

/**
 * The registry side of the workflows tab. Workflows are uploaded artifact
 * folders, so there is nothing to edit here — the uploaded source is the
 * truth. This view uploads a folder, shows what the manifest declares and
 * which registered targets its names were bound to.
 */
export function WorkflowRegistryView() {
  const workflowsQuery = useWorkflows();
  const workflows = workflowsQuery.data ?? [];
  const registerWorkflow = useRegisterWorkflow();
  const removeWorkflow = useRemoveWorkflow();
  const [error, setError] = useState<string | null>(null);
  const [graphOf, setGraphOf] = useState<RegisteredWorkflow | null>(null);
  const [reading, setReading] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const busy = reading || registerWorkflow.isPending || removeWorkflow.isPending;

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    if (!input.files || input.files.length === 0) return;
    setReading(true);
    setError(null);
    try {
      const files = await readArtifactFiles(input.files);
      if (files.length === 0) {
        throw new Error('The selected folder has no files to upload.');
      }
      registerWorkflow.mutate(
        { files },
        { onError: (cause) => setError(toErrorMessage(cause, 'Could not register the workflow.')) },
      );
    } catch (cause) {
      setError(toErrorMessage(cause, 'Could not register the workflow.'));
    } finally {
      input.value = '';
      setReading(false);
    }
  };

  const remove = (workflowId: string) => {
    setError(null);
    removeWorkflow.mutate(workflowId, {
      onError: (cause) => setError(toErrorMessage(cause, 'Could not remove the workflow.')),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto">
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Upload a workflow artifact</h2>
          <p className="text-xs text-muted-foreground">
            A workflow is a folder with <code className="font-mono">agentdock.workflow.json</code>,{' '}
            <code className="font-mono">package.json</code>, <code className="font-mono">bun.lock</code> and the graph
            module. The manifest's agent names are bound to registered agents by name; uploading a manifest name again
            bumps its revision. The usual way to deploy is <code className="font-mono">agentdock push</code> from the
            CLI.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={(element) => {
              folderInput.current = element;
              element?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => void upload(event)}
          />
          <Button type="button" onClick={() => folderInput.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Choose folder
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Registered {workflowsQuery.isPending ? '' : `(${workflows.length})`}</h2>
        {workflowsQuery.isPending ? (
          <ListSkeleton />
        ) : workflowsQuery.isError ? (
          <ErrorBanner>{toErrorMessage(workflowsQuery.error, 'Could not load workflows.')}</ErrorBanner>
        ) : workflows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No workflows registered. Agents cover most work on their own; register a workflow when you need code-level
            control over how they are orchestrated.
          </p>
        ) : (
          <ul className="space-y-3">
            {workflows.map((workflow) => {
              const noGraph = missingGraphReason(workflow);
              return (
                <li key={workflow.id} className="rounded-xl border bg-card p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <FolderCode className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{workflow.manifest.name}</span>
                        <Badge variant="secondary">v{workflow.manifest.version}</Badge>
                        <Badge variant="secondary">rev {workflow.revision}</Badge>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {workflow.manifest.graph ?? DEFAULT_WORKFLOW_GRAPH}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{workflow.manifest.description}</p>
                      <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">{workflow.source}</p>
                      {noGraph ? <p className="mt-2 text-[11px] text-muted-foreground">{noGraph}</p> : null}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {workflow.id}
                        </Badge>
                        {Object.entries(workflow.bindings).map(([name, target]) => (
                          <Badge key={name} variant="secondary" className="font-mono text-[10px]">
                            {name} → {target.kind}:{target.id}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {noGraph ? null : (
                        <Button type="button" variant="outline" size="sm" onClick={() => setGraphOf(workflow)}>
                          <Waypoints className="size-4" />
                          View graph
                        </Button>
                      )}
                      <ConfirmButton
                        variant="destructiveGhost"
                        size="icon"
                        disabled={busy}
                        onConfirm={() => remove(workflow.id)}
                        title={`Remove ${workflow.manifest.name}?`}
                        description="This deletes the registered workflow and its uploaded code."
                      >
                        <Trash2 className="size-4" />
                      </ConfirmButton>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Uploaded workflow code runs in the server process with its privileges. Uploading a folder is deploying code —
          only upload folders you trust.
        </span>
      </p>

      {graphOf ? <WorkflowGraphDialog workflow={graphOf} onClose={() => setGraphOf(null)} /> : null}
    </div>
  );
}

/**
 * The registered topology, read-only. It is a picture of what was uploaded,
 * not something to edit: the graph refreshes when the folder is uploaded again.
 */
function WorkflowGraphDialog({ workflow, onClose }: { workflow: RegisteredWorkflow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{workflow.manifest.name}</h2>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{workflow.source}</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <WorkflowGraphCanvas graph={workflow.graph} />
        </div>
      </div>
    </div>
  );
}
