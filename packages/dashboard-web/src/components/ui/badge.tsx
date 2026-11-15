import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", {
  variants: {
    tone: {
      neutral: "bg-muted text-foreground",
      good: "border-success/40 bg-success/10 text-success",
      warn: "border-warning/40 bg-warning/10 text-warning",
      bad: "border-destructive/40 bg-destructive/10 text-destructive",
      info: "border-primary/40 bg-primary/10 text-primary",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...p} />;
}
