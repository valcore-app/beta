import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]",
  {
    variants: {
      variant: {
        default:
          "border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-ink)]",
        accent:
          "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]",
        cool:
          "border-[color:var(--arena-teal)] bg-[color:var(--arena-teal-soft)] text-[color:var(--arena-teal)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = "Badge";

export { Badge, badgeVariants };
