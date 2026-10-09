import type React from 'react';

import { cn } from '@/lib/utils';

type SpinnerProps = React.ComponentProps<'span'>;

function Spinner({ className, ...props }: SpinnerProps) {
  return (
    <span
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent',
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
