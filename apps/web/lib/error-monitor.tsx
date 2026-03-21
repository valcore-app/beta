"use client";

import { useEffect } from "react";
import { reportClientError } from "./error-report";

const formatUnknown = (value: unknown) => {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (typeof value === "string") {
    return {
      message: value,
      name: "UnhandledRejection",
      stack: undefined,
    };
  }
  return {
    message: "Unhandled rejection",
    name: "UnhandledRejection",
    stack: undefined,
  };
};

export function ErrorMonitor() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const name = event.error instanceof Error ? event.error.name : "WindowError";
      const stack = event.error instanceof Error ? event.error.stack : undefined;
      const message =
        String(event.message ?? "").trim() ||
        (event.error instanceof Error ? event.error.message : "Unhandled window error");

      void reportClientError({
        source: "web-client",
        severity: "error",
        category: "window-error",
        message,
        errorName: name,
        stack,
        fingerprint: [message, event.filename ?? "", event.lineno ?? 0, event.colno ?? 0].join("|"),
        path: window.location.pathname,
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const normalized = formatUnknown(event.reason);
      void reportClientError({
        source: "web-client",
        severity: "error",
        category: "unhandled-rejection",
        message: normalized.message,
        errorName: normalized.name,
        stack: normalized.stack,
        fingerprint: `${normalized.name}|${normalized.message}`,
        path: window.location.pathname,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}