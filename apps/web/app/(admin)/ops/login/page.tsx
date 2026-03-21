"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import type { ClientSafeProvider } from "next-auth/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "../../../../components/ui/button";

type ProviderMap = Record<string, ClientSafeProvider>;

const sanitizeInternalPath = (value: string | null | undefined) => {
  if (!value) return "/ops";
  if (!value.startsWith("/")) return "/ops";
  if (value.startsWith("//")) return "/ops";
  return value;
};

function OpsLoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [providers, setProviders] = useState<ProviderMap | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const nextPath = useMemo(() => {
    return sanitizeInternalPath(searchParams.get("next"));
  }, [searchParams]);
  const error = useMemo(() => searchParams.get("error"), [searchParams]);

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch("/api/auth/providers");
        const data = (await res.json()) as ProviderMap;
        setProviders(data);
      } catch {
        setProviders({});
      }
    };
    loadProviders();
  }, []);

  useEffect(() => {
    if (!error) return;
    setMessage("Login failed. Please try again.");
  }, [error]);

  useEffect(() => {
    if (!error) return;
    const params = new URLSearchParams();
    const callbackUrl = searchParams.get("callbackUrl");
    if (callbackUrl) {
      try {
        const url = new URL(callbackUrl);
        const mergedPath = `${url.pathname || ""}${url.search || ""}`;
        params.set("next", sanitizeInternalPath(mergedPath));
      } catch {
        params.set("next", "/ops");
      }
    } else {
      params.set("next", sanitizeInternalPath(searchParams.get("next")));
    }
    const query = params.toString();
    const target = query ? `${pathname}?${query}` : pathname;
    router.replace(target);
  }, [error, pathname, router, searchParams]);

  const providerList = providers
    ? Object.values(providers).filter((provider) => provider.id !== "wallet")
    : [];

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-md space-y-4 rounded-3xl border border-[color:var(--arena-stroke)] bg-[rgba(9,12,16,0.85)] p-8">
        <div className="space-y-2 text-center">
          <span className="arena-chip">Ops Access</span>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Operator Sign In</h1>
          <p className="text-sm text-[color:var(--arena-muted)]">
            Sign in with your approved account to access ops.
          </p>
        </div>
        {message ? <p className="text-sm text-[color:var(--arena-danger)]">{message}</p> : null}
        <div className="grid gap-3">
          {providerList.length ? (
            providerList.map((provider) => (
              <Button
                key={provider.id}
                variant="glow"
                onClick={() => signIn(provider.id, { callbackUrl: nextPath })}
              >
                Continue with {provider.name}
              </Button>
            ))
          ) : (
            <p className="text-sm text-[color:var(--arena-muted)]">
              No auth providers are configured.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OpsLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-[70vh]" />}>
      <OpsLoginContent />
    </Suspense>
  );
}
