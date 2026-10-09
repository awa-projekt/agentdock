import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { PostStatus } from '../lib/types';

export const cn = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
};

const BUTTON_STYLES = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-white text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50',
} satisfies Record<NonNullable<ButtonProps['variant']>, string>;

export const Button = ({ variant = 'primary', className, ...props }: ButtonProps) => {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-70',
        BUTTON_STYLES[variant],
        className,
      )}
      {...props}
    />
  );
};

const STATUS = {
  drafting: { label: 'Drafting', className: 'bg-amber-100 text-amber-700' },
  'awaiting-review': { label: 'Needs review', className: 'bg-indigo-100 text-indigo-700' },
  'awaiting-approval': { label: 'Needs approval', className: 'bg-violet-100 text-violet-700' },
  revising: { label: 'Revising', className: 'bg-amber-100 text-amber-700' },
  publishing: { label: 'Publishing', className: 'bg-sky-100 text-sky-700' },
  published: { label: 'Published', className: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: 'Rejected', className: 'bg-slate-200 text-slate-600' },
  failed: { label: 'Failed', className: 'bg-rose-100 text-rose-700' },
  canceled: { label: 'Canceled', className: 'bg-slate-200 text-slate-600' },
} satisfies Record<PostStatus, { label: string; className: string }>;

export const StatusBadge = ({ status }: { status: PostStatus }) => {
  const s = STATUS[status];
  return <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', s.className)}>{s.label}</span>;
};

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70', className)}>{children}</div>
);

export const Spinner = ({ className }: { className?: string }) => (
  <span
    className={cn(
      'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
      className,
    )}
  />
);
