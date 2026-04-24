"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { apiGet } from "../../../../lib/api";

type AdminStatus = {
  currentWeek: {
    id: string;
    status: string;
  } | null;
};

type ReactiveTxDetails = {
  found: boolean;
  from: string | null;
  to: string | null;
  blockNumber: number | null;
  status: number | null;
  methodSelector: string | null;
  targetContractAddress: string | null;
  targetContractLabel: string | null;
  logAddress: string | null;
  error: string | null;
};

type ReactiveTxRow = {
  id: string;
  opKey: string;
  weekId: string;
  operation: string;
  status: string;
  reactiveTxHash: string | null;
  reactiveTxUrl: string | null;
  createdAt: string;
  updatedAt: string;
  reactiveTx: ReactiveTxDetails | null;
};

type ReactiveTxFeed = {
  network: {
    chainId: number | null;
    rpcConfigured: boolean;
    explorerBase: string;
    dispatcherAddress: string | null;
    callbackSenderAddress: string | null;
  };
  events: ReactiveTxRow[];
};

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const shortHash = (value?: string | null) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "--";
  if (raw.length <= 18) return raw;
  return `${raw.slice(0, 10)}...${raw.slice(-8)}`;
};

export default function OpsReactiveTxPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [feed, setFeed] = useState<ReactiveTxFeed | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [onlyCurrentWeek, setOnlyCurrentWeek] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const nextStatus = await apiGet<AdminStatus>("/admin/status");
      const params = new URLSearchParams();
      params.set("limit", "60");
      if (onlyCurrentWeek && nextStatus.currentWeek?.id) {
        params.set("weekId", nextStatus.currentWeek.id);
      }
      const nextFeed = await apiGet<ReactiveTxFeed>(`/admin/reactive-txs?${params.toString()}`);
      setStatus(nextStatus);
      setFeed(nextFeed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load reactive tx feed");
    } finally {
      setLoading(false);
    }
  }, [onlyCurrentWeek]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => feed?.events ?? [], [feed]);

  return (
    <div className="grid gap-8">
      <section className="arena-panel rounded-[28px] p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2">
            <span className="arena-chip">Ops Console</span>
            <h1 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">
              Reactive TX Feed
            </h1>
            <p className="text-sm text-[color:var(--arena-muted)] md:text-base">
              Only reactive network transactions, with contract-level origin details.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/ops"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Back to Ops
            </Link>
            <Button
              variant="outline"
              onClick={() => setOnlyCurrentWeek((prev) => !prev)}
              disabled={loading}
            >
              {onlyCurrentWeek ? "Current Week Only" : "All Weeks"}
            </Button>
            <Button variant="glow" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </div>
        {message ? <p className="mt-4 text-sm text-[color:var(--arena-danger)]">{message}</p> : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Current Week</p>
            <CardTitle>{status?.currentWeek?.id ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">
            Status: {status?.currentWeek?.status ?? "--"}
          </CardContent>
        </Card>

        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Reactive Chain ID</p>
            <CardTitle>{feed?.network.chainId ?? "--"}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">
            RPC configured: {feed?.network.rpcConfigured ? "yes" : "no"}
          </CardContent>
        </Card>

        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Dispatcher</p>
            <CardTitle className="text-sm">{shortHash(feed?.network.dispatcherAddress)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">
            {feed?.network.dispatcherAddress ?? "--"}
          </CardContent>
        </Card>

        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Callback Sender</p>
            <CardTitle className="text-sm">{shortHash(feed?.network.callbackSenderAddress)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">
            {feed?.network.callbackSenderAddress ?? "--"}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Reactive Transactions</h2>
        <div className="grid gap-4">
          {rows.length === 0 ? (
            <p className="text-sm text-[color:var(--arena-muted)]">
              No reactive tx found for this filter.
            </p>
          ) : (
            rows.map((row) => (
              <Card key={row.id} className="arena-panel-strong">
                <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{row.operation}</CardTitle>
                    <p className="text-xs text-[color:var(--arena-muted)]">
                      Week {row.weekId} • intent {row.opKey}
                    </p>
                  </div>
                  <Badge variant={row.status === "completed" ? "cool" : "default"}>
                    {row.status}
                  </Badge>
                </CardHeader>
                <CardContent className="grid gap-3 text-xs">
                  <div className="grid gap-1 text-[color:var(--arena-muted)]">
                    <div className="flex items-center justify-between">
                      <span>Updated</span>
                      <span className="font-semibold">{formatDate(row.updatedAt)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Reactive TX</span>
                      {row.reactiveTxHash && row.reactiveTxUrl ? (
                        <a
                          href={row.reactiveTxUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-[color:var(--arena-gold)] hover:underline"
                        >
                          {shortHash(row.reactiveTxHash)}
                        </a>
                      ) : (
                        <span className="font-semibold">--</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Contract</span>
                      <span className="font-semibold">
                        {row.reactiveTx?.targetContractLabel ?? "--"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>To</span>
                      <span className="font-semibold">{shortHash(row.reactiveTx?.to)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>From</span>
                      <span className="font-semibold">{shortHash(row.reactiveTx?.from)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Block</span>
                      <span className="font-semibold">
                        {row.reactiveTx?.blockNumber ?? "--"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Selector</span>
                      <span className="font-semibold">
                        {row.reactiveTx?.methodSelector ?? "--"}
                      </span>
                    </div>
                  </div>
                  {row.reactiveTx?.error ? (
                    <div className="rounded-xl border border-[color:var(--arena-danger)] bg-[rgba(255,78,78,0.08)] p-3 text-[color:var(--arena-danger)]">
                      {row.reactiveTx.error}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

