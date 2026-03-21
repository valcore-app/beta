"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../utils";

interface DialogContextValue {
  open: boolean;
  setOpen: (value: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
  children: React.ReactNode;
}) {
  const [internal, setInternal] = React.useState(false);
  const current = open ?? internal;
  const setOpen = (value: boolean) => {
    setInternal(value);
    onOpenChange?.(value);
  };

  return (
    <DialogContext.Provider value={{ open: current, setOpen }}>
      {children}
    </DialogContext.Provider>
  );
}

export function DialogTrigger({ children }: { children: React.ReactNode }) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return null;
  return (
    <button type="button" onClick={() => ctx.setOpen(true)}>
      {children}
    </button>
  );
}

export function DialogContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(DialogContext);
  if (!ctx || !ctx.open) return null;

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div
        className={cn(
          "w-full max-h-[85vh] max-w-md overflow-y-auto rounded-3xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] p-6 text-[color:var(--arena-ink)] shadow-[0_30px_80px_-50px_rgba(0,0,0,0.9)] translate-y-4",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}

export function DialogClose({ children }: { children: React.ReactNode }) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return null;
  return (
    <button type="button" onClick={() => ctx.setOpen(false)}>
      {children}
    </button>
  );
}
