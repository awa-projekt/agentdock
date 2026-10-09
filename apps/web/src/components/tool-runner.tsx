import {
  type CatalogTool,
  coerceJson,
  type InvocationOutcome,
  isJsonString,
  type Json,
  jsonString,
} from 'agentdock-sdk/schemas';
import { Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import { JsonSchemaForm } from '@/components/json-schema-form';
import { ErrorBanner } from '@/components/StatusMessage';
import { Button } from '@/components/ui/button';
import { executeTool } from '@/lib/api';

const formatResult = (result: Json): string => (isJsonString(result) ? result : JSON.stringify(result, null, 2));

const describeOutcome = (outcome: Exclude<InvocationOutcome, { status: 'succeeded' | 'pending' }>): string => {
  switch (outcome.status) {
    case 'denied':
      return `The call was denied: ${outcome.reason}`;
    case 'failed':
      return outcome.message;
    case 'invalid':
      return [outcome.message, ...outcome.issues.map((issue) => `${issue.path}: ${issue.message}`)].join('\n');
    case 'authorization-required':
      return `${outcome.integration} acts for each user; connect your own account first.`;
  }
};

export function ToolRunner({ tool }: { tool: CatalogTool }) {
  const [input, setInput] = useState<Json | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Json>(null);
  const [hasResult, setHasResult] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setHasResult(false);
    try {
      const outcome = await executeTool({ toolId: tool.id, input: input ?? {} });
      if (outcome.status === 'pending') {
        setError(`This tool needs approval. Decide it under Approvals, then run it again.`);
        return;
      }
      if (outcome.status !== 'succeeded') {
        setError(describeOutcome(outcome));
        return;
      }
      setResult(outcome.result);
      setHasResult(true);
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : jsonString(coerceJson(runError), 'message');
      setError(message || 'Failed to run tool.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-3">
      <JsonSchemaForm schema={tool.inputSchema} value={input} onChange={setInput} />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" onClick={run} disabled={running}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {running ? 'Running…' : 'Run'}
        </Button>
      </div>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {hasResult ? (
        <div className="overflow-hidden rounded-md border border-border/60 bg-background/60">
          <div className="border-b border-border/40 bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Result
          </div>
          <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug text-foreground whitespace-pre-wrap break-words">
            {formatResult(result)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
