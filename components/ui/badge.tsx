import * as React from "react";

import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "outline" | "destructive";

const VARIANTS: Record<BadgeVariant, string> = {
  default: "bg-secondary text-secondary-foreground",
  outline: "border border-border text-muted-foreground",
  destructive: "bg-destructive text-destructive-foreground",
};

export function Badge({
  variant = "default",
  className,
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
