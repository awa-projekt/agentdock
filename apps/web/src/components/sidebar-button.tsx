import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export function SidebarButton({
  collapsed,
  icon,
  label,
  onClick,
}: {
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        'flex items-center rounded-md text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
        collapsed ? 'size-10 justify-center' : 'h-9 gap-2 px-2',
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      {collapsed ? null : <span>{label}</span>}
    </button>
  );
}
