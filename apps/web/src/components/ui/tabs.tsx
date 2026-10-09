import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';

import { cn } from '@/lib/utils';

type TabsProps<Value extends string> = Omit<TabsPrimitive.Root.Props, 'value' | 'defaultValue' | 'onValueChange'> & {
  value: Value;
  onValueChange: (value: Value) => void;
};

function Tabs<Value extends string>({ className, value, onValueChange, ...props }: TabsProps<Value>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-4', className)}
      value={value}
      onValueChange={(next: Value) => onValueChange(next)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('inline-flex h-9 w-fit items-center rounded-lg bg-muted p-1 text-muted-foreground', className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex h-7 items-center justify-center rounded-md px-3 text-xs/relaxed font-medium transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-active:bg-background data-active:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn('outline-none', className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
