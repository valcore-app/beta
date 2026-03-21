import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-full text-sm font-semibold tracking-[0.08em] uppercase transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--arena-accent)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-ink)] hover:border-[color:var(--arena-stroke-strong)]",
        outline:
          "border border-[color:var(--arena-stroke-strong)] text-[color:var(--arena-ink)] hover:bg-[color:var(--arena-panel-strong)]",
        glow:
          "bg-[color:var(--arena-accent)] text-[color:var(--arena-bg)] shadow-[0_8px_32px_var(--arena-accent-glow)] hover:shadow-[0_12px_40px_var(--arena-accent-glow)] hover:brightness-110",
      },
      size: {
        default: "h-10 px-6",
        sm: "h-8 px-4 text-xs",
        lg: "h-12 px-8 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
