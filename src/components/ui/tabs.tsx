"use client";

import { Tabs as T } from "radix-ui";
import type { ReactNode } from "react";

export function Tabs({ tabs, defaultValue }: { tabs: Array<{ value: string; label: ReactNode; content: ReactNode }>; defaultValue?: string }) {
  return (
    <T.Root defaultValue={defaultValue ?? tabs[0]?.value}>
      <T.List className="-mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-border px-4 md:mx-0 md:px-0" aria-label="Seções">
        {tabs.map((t) => (
          <T.Trigger key={t.value} value={t.value}
            className="relative -mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-subtle transition-colors hover:text-foreground data-[state=active]:border-brand data-[state=active]:text-foreground">
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      {tabs.map((t) => (
        <T.Content key={t.value} value={t.value} className="focus:outline-none">{t.content}</T.Content>
      ))}
    </T.Root>
  );
}
