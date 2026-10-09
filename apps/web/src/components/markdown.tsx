import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { type ComponentProps, memo } from 'react';
import { type Components, Streamdown } from 'streamdown';
import { cn } from '@/lib/utils';

const plugins = { cjk, code, math, mermaid };

export type MarkdownProps = ComponentProps<typeof Streamdown>;

/** Streaming-aware markdown renderer for every agent-authored text in the dashboard. */
export const Markdown = memo(
  ({ className, ...props }: MarkdownProps) => (
    <Streamdown
      className={cn('min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      plugins={plugins}
      {...props}
    />
  ),
  (previous, next) => previous.children === next.children && previous.isAnimating === next.isAnimating,
);

Markdown.displayName = 'Markdown';

const previewComponents: Components = {
  a: ({ children }) => <span className="underline underline-offset-2">{children}</span>,
};

/** Flattened, non-interactive markdown for list cards and snippets, cut off after `lines` lines. */
export function MarkdownPreview({
  className,
  lines,
  children,
}: {
  className?: string;
  lines?: number;
  children: string;
}) {
  return (
    <div
      className={cn('min-w-0 overflow-hidden', className)}
      style={
        lines === undefined
          ? undefined
          : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, maxHeight: `${lines}lh` }
      }
    >
      <Markdown
        className="[&_*]:!m-0 [&_*]:!rounded-none [&_*]:!border-0 [&_*]:!bg-transparent [&_*]:!p-0 [&_*]:!text-[length:inherit] [&_*]:!shadow-none [&_:is(ol,ul)]:!pl-4 [&_:is(th,td)]:!pr-3 [&_pre]:!whitespace-pre-wrap"
        components={previewComponents}
        controls={false}
        mode="static"
      >
        {children}
      </Markdown>
    </div>
  );
}
