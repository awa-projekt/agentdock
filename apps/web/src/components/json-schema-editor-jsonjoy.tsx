import { InferSchemaDialog, type JsonSchema, SchemaFieldsEditor, ValidateJsonDialog } from 'jsonjoy-builder';
import { useState } from 'react';

import { JsonTextarea } from '@/components/json-textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type EditorMode = 'visual' | 'json';

const formatSchema = (schema: JsonSchema): string => JSON.stringify(schema, null, 2);

export function JsonJoySchemaEditor({
  id,
  value,
  schema,
  onChange,
  className,
}: {
  id: string;
  value: string;
  schema: JsonSchema;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [mode, setMode] = useState<EditorMode>('visual');
  const [inferOpen, setInferOpen] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);

  return (
    <div id={id} className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
          <Button
            type="button"
            variant={mode === 'visual' ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setMode('visual')}
          >
            Visual
          </Button>
          <Button
            type="button"
            variant={mode === 'json' ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setMode('json')}
          >
            Advanced JSON
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setInferOpen(true)}>
            Infer from JSON
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setValidateOpen(true)}>
            Test JSON
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
            Clear
          </Button>
        </div>
      </div>

      {mode === 'visual' ? (
        <div className="agentdock-schema-editor overflow-hidden rounded-lg border border-border bg-muted/10">
          <SchemaFieldsEditor value={schema} onChange={(next) => onChange(formatSchema(next))} />
        </div>
      ) : (
        <JsonTextarea value={value} onChange={onChange} className="min-h-40 text-xs" />
      )}

      <InferSchemaDialog
        open={inferOpen}
        onOpenChange={setInferOpen}
        onInfer={(next) => onChange(formatSchema(next))}
      />
      <ValidateJsonDialog open={validateOpen} onOpenChange={setValidateOpen} schema={schema} />
    </div>
  );
}
