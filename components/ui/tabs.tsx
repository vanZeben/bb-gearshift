import * as React from "react";

import { cn } from "../../lib/utils";

export interface TabItem {
  id: string;
  label: string;
  /** Small marker after the label (an error count, a dot for "has changes"). */
  badge?: React.ReactNode;
}

/**
 * Tab strip with roving focus and arrow-key navigation. The caller renders the panel
 * (give it `role="tabpanel"` and `aria-labelledby={tabDomId(idPrefix, value)}`).
 */
export function Tabs({
  tabs,
  value,
  onValueChange,
  idPrefix,
  label,
}: {
  tabs: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  idPrefix: string;
  label: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (from: number, delta: number) => {
    const next = tabs[(from + delta + tabs.length) % tabs.length];
    if (!next) return;
    onValueChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            id={tabDomId(idPrefix, tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                move(index, 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                move(index, -1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0, 0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(tabs.length - 1, 0);
              }
            }}
            className={cn(
              "-mb-px inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              selected
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

export function tabDomId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}
