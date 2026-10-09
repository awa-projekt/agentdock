import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AgentIcon({
  color,
  className,
  iconClassName,
}: {
  color: string;
  className: string;
  iconClassName: string;
}) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center', className)}
      style={{ backgroundColor: `${color}20`, color }}
    >
      <Bot className={iconClassName} />
    </span>
  );
}
