"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { apiGet, apiPost } from "../../../../lib/api";

type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

type AdminStatus = {
  serverTime: string;
  currentWeek: {
    id: string;
    status: WeekStatus;
  } | null;
  pauserAddress: string | null;
};

type JobState = "idle" | "running" | "success" | "error";

type JobStatus = {
  name: string;
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type JobsResponse = {
  running: boolean;
  jobs: Record<string, JobStatus>;
};

const statusLabels: Record<WeekStatus, string> = {
  DRAFT_OPEN: "Draft Open",
  LOCKED: "Locked",
  ACTIVE: "Active",
  FINALIZE_PENDING: "Finalize Pending",
  FINALIZED: "Finalized",
};

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

export default function OpsSecurityPage() {
  const router = useRouter();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextJobs] = await Promise.all([
        apiGet<AdminStatus>("/admin/status"),
        apiGet<JobsResponse>("/admin/jobs"),
      ]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      setMessage(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to fetch status";
      setMessage(text);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const runAction = useCallback(
    async (path: string, payload?: unknown) => {
      setLoading(true);
      setMessage(null);
      try {
        await apiPost(path, payload ?? {});
        setMessage("Job started.");
      } catch (error) {
        const text = error instanceof Error ? error.message : "Job failed";
        setMessage(text);
        if (text.toLowerCase().includes("unauthorized")) {
          router.push("/ops/login?next=/ops/security");
        }
      } finally {
        setLoading(false);
        refresh();
      }
    },
    [refresh, router],
  );

  const currentWeek = status?.currentWeek ?? null;
  const isRunning = jobs?.running ?? false;
  const runningJob = useMemo(() => {
    const map = jobs?.jobs ?? {};
    return Object.values(map).find((job) => job.state === "running") ?? null;
  }, [jobs]);

  return (
    <div className="grid gap-8">
      <section className="arena-panel rounded-[28px] p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2">
            <span className="arena-chip">Ops Console</span>
            <h1 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">
              Security Controls
            </h1>
            <p className="text-sm text-[color:var(--arena-muted)] md:text-base">
              Audit decisions and emergency pause controls are managed here.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/ops"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Back to Ops
            </Link>
          </div>
        </div>
        {message ? <p className="mt-4 text-sm text-[color:var(--arena-gold)]">{message}</p> : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="arena-panel-strong">
          <CardHeader className="space-y-2">
            <p className="arena-label">Audit</p>
            <CardTitle>Finalization Gate</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="accent">{currentWeek ? statusLabels[currentWeek.status] : "No Week"}</Badge>
              <Badge variant="cool">Week {currentWeek?.id ?? "--"}</Badge>
            </div>
            <Button
              variant="outline"
              onClick={() => runAction("/admin/jobs/finalize-audit")}
              disabled={loading || isRunning || currentWeek?.status !== "FINALIZE_PENDING"}
            >
              Approve Finalization
            </Button>
            <Button
              variant="outline"
              className="border-[color:var(--arena-danger)] text-[color:var(--arena-danger)] hover:bg-[rgba(255,78,78,0.08)]"
              onClick={() => runAction("/admin/jobs/finalize-reject")}
              disabled={loading || isRunning || currentWeek?.status !== "FINALIZE_PENDING"}
            >
              Reject Finalization
            </Button>
            <p className="text-xs text-[color:var(--arena-muted)]">
              Buttons are enabled only while current week is FINALIZE_PENDING.
            </p>
          </CardContent>
        </Card>

        <Card className="arena-panel-strong">
          <CardHeader className="space-y-2">
            <p className="arena-label">Pause</p>
            <CardTitle>Admin Governance</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] p-3 text-xs text-[color:var(--arena-muted)]">
              Pause and unpause are signed by PAUSER_PRIVATE_KEY on testnet.
            </div>
            <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] p-3 text-xs text-[color:var(--arena-muted)] break-all">
              Pause wallet: {status?.pauserAddress ?? "missing"}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                onClick={() => runAction("/admin/jobs/pause")}
                disabled={loading || isRunning}
              >
                Pause Contract
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction("/admin/jobs/unpause")}
                disabled={loading || isRunning}
              >
                Unpause Contract
              </Button>
            </div>
            {runningJob ? (
              <Button
                variant="outline"
                className="border-[color:var(--arena-danger)] text-[color:var(--arena-danger)] hover:bg-[rgba(255,78,78,0.08)]"
                onClick={() => runAction("/admin/jobs/stop", { name: runningJob.name })}
                disabled={loading}
              >
                Stop Running Job
              </Button>
            ) : (
              <p className="text-xs text-[color:var(--arena-muted)]">No running job.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <Card className="arena-panel-strong">
          <CardHeader className="space-y-2">
            <p className="arena-label">Status</p>
            <CardTitle>Security Snapshot</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs text-[color:var(--arena-muted)]">
            <div>Server time: {formatDate(status?.serverTime)}</div>
            <div>Running job: {runningJob?.name ?? "none"}</div>
            <div>Started: {formatDate(runningJob?.startedAt)}</div>
            <div>Finished: {formatDate(runningJob?.finishedAt)}</div>
            {runningJob?.error ? <div className="text-[color:var(--arena-danger)]">Error: {runningJob.error}</div> : null}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

