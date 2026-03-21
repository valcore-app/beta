import * as React from "react";
import { cn } from "../utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "h-11 w-full rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-4 text-sm text-[color:var(--arena-ink)] placeholder:text-[color:var(--arena-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--arena-accent)]",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
