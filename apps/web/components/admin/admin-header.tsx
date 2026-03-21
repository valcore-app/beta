"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useRuntimeProfile } from "../../lib/runtime-profile";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const resolveChainIcon = (nativeSymbol: string) => {
  const symbol = String(nativeSymbol || "").trim().toUpperCase();
  if (symbol === "AVAX") {
    return "/coins/avax.png";
  }
  if (symbol === "ETH") {
    return "/coins/eth.png";
  }
  return "/favicon-32.png";
};

export function AdminHeader() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { profile, isLoading } = useRuntimeProfile();
  const isLoginRoute = pathname === "/ops/login";
  const chainLabel = profile?.label || profile?.networkKey || "Unknown Chain";
  const chainIcon = resolveChainIcon(profile?.nativeSymbol ?? "");

  return (
    <header className="sticky top-0 z-40 border-b border-[color:var(--arena-stroke)] bg-[rgba(11,17,24,0.85)] px-6 py-4 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/ops" className="flex items-center gap-3">
          <Image
            src="/brand/logo.png"
            alt="Valcore"
            width={180}
            height={48}
            className="h-9 w-auto"
            priority
          />
          <span className="text-xs font-semibold uppercase tracking-[0.3em] text-[color:var(--arena-muted)]">
            Ops Console
          </span>
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          {!isLoginRoute ? (
            <Badge
              variant="accent"
              className="normal-case tracking-[0.08em] text-[11px] px-2.5 py-1 flex items-center gap-2"
              title={profile?.networkKey ?? "active network"}
            >
              <Image
                src={chainIcon}
                alt={chainLabel}
                width={16}
                height={16}
                className="h-4 w-4 rounded-full"
              />
              <span>{isLoading ? "Loading chain..." : chainLabel}</span>
            </Badge>
          ) : null}

          {!isLoginRoute && session?.user?.email ? (
            <Badge variant="cool">{session.user.email}</Badge>
          ) : null}

          {!isLoginRoute ? (
            <Button variant="outline" onClick={() => window.location.reload()}>
              Refresh
            </Button>
          ) : null}

          {!isLoginRoute && session?.user ? (
            <Button variant="outline" onClick={() => void signOut({ callbackUrl: "/ops/login" })}>
              Logout
            </Button>
          ) : null}

          <span className="text-xs uppercase tracking-[0.24em] text-[color:var(--arena-muted)]">
            Authorized Only
          </span>
        </div>
      </div>
    </header>
  );
}
