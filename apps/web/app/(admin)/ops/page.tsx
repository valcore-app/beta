"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { apiGet, apiPost } from "../../../lib/api";

type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

type AdminStatus = {
  serverTime: string;
  timeMode: string;
  chainEnabled: boolean;
  leagueContractSet: boolean;
  stablecoinAddressSet: boolean;
  stablecoinSymbol: string | null;
  pauserAddress: string | null;
  currentWeek: {
    id: string;
    startAtUtc: string;
    lockAtUtc: string;
    endAtUtc: string;
    status: WeekStatus;
  } | null;
  counts: {
    coins: number;
    weekCoins: number;
    lineups: number;
    weeklyResults: number;
  };
};

type JobState = "idle" | "running" | "success" | "error";

type JobStatus = {
  name: string;
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  output: string;
  command: string;
  error: string | null;
  attempt?: number;
  runId?: string | null;
  weekId?: string | null;
  lastError?: string | null;
  retryCount?: number;
  nextRetryAt?: string | null;
};

type JobsResponse = {
  running: boolean;
  jobs: Record<string, JobStatus>;
};

type JobIncident = {
  run_id: string;
  job_name: string;
  week_id: string | null;
  attempts: number;
  error_count: number;
  first_started_at: string;
  last_finished_at: string | null;
  success_at: string | null;
  success_attempt: number | null;
  last_error: string | null;
  last_error_code: string | null;
  last_status: string | null;
};

type JobIncidentsResponse = {
  incidents: JobIncident[];
};
type SelfHealSummary = {
  total: number;
  byStatus: Record<string, number>;
  recovered: number;
};

type SelfHealDashboardResponse = {
  summary: SelfHealSummary;
};

const INCIDENT_ACTIVITY_WINDOW_MS = 90 * 60 * 1000;

const statusLabels: Record<WeekStatus, string> = {
  DRAFT_OPEN: "Draft Open",
  LOCKED: "Locked",
  ACTIVE: "Active",
  FINALIZE_PENDING: "Finalize Pending",
  FINALIZED: "Finalized",
};

const jobOrder = [
  "run-week",
  "refresh-week-coins",
  "transition-lock",
  "transition-start",
  "finalize",
  "finalize-audit",
  "finalize-reject",
  "time-mode",
  "reset-db",
];

const jobNames: Record<string, string> = {
  "run-week": "Run Week",
  "refresh-week-coins": "Refresh Week Coins",
  "momentum-live": "Update Momentum Live",
  "transition-lock": "Lock Week",
  "transition-start": "Start Week",
  finalize: "Finalize Week",
  "finalize-audit": "Approve Finalization",
  "finalize-reject": "Reject Finalization",
  "time-mode": "Apply Automation Mode",
  "reset-db": "Reset DB (keep coins)",
};

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const isStoppedError = (message?: string | null) =>
  Boolean(message && message.toLowerCase().includes("stopped by operator"));

const jobStatusLabel = (job: JobStatus) =>
  isStoppedError(job.lastError) || isStoppedError(job.error) ? "stopped" : job.state;

const incidentStatusLabel = (incident: JobIncident) =>
  incident.last_status === "success"
    ? "Recovered"
    : incident.last_error_code === "stopped" || isStoppedError(incident.last_error)
      ? "Stopped"
      : "Still failing";

const incidentBadgeClass = (incident: JobIncident) =>
  incident.last_status === "success"
    ? "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]"
    : incident.last_error_code === "stopped" || isStoppedError(incident.last_error)
      ? "border-[color:var(--arena-muted)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]"
      : "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";

const jobBadgeClass = (job: JobStatus) =>
  isStoppedError(job.lastError) || isStoppedError(job.error)
    ? "border-[color:var(--arena-muted)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]"
    : statusBadgeClass(job.state);

const statusBadgeClass = (state: JobState) => {
  if (state === "running") {
    return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  }
  if (state === "success") {
    return "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]";
  }
  if (state === "error") {
    return "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";
  }
  return "border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
};

export default function OpsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [jobs, setJobs] = useState<JobsResponse | null>(null);
  const [incidents, setIncidents] = useState<JobIncident[]>([]);
  const [selfHealSummary, setSelfHealSummary] = useState<SelfHealSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sseState, setSseState] = useState<"connecting" | "open" | "error" | "closed">(
    "connecting",
  );
  const [sseLastEventAt, setSseLastEventAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextJobs, nextIncidents, nextSelfHeal] = await Promise.all([
        apiGet<AdminStatus>("/admin/status"),
        apiGet<JobsResponse>("/admin/jobs"),
        apiGet<JobIncidentsResponse>("/admin/job-logs"),
        apiGet<SelfHealDashboardResponse>("/admin/self-heal"),
      ]);
      setStatus(nextStatus);
      setJobs(nextJobs);
      setIncidents(nextIncidents?.incidents ?? []);
      setSelfHealSummary(nextSelfHeal?.summary ?? { total: 0, byStatus: {}, recovered: 0 });
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


  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/oracle/events");
    const handleRefresh = () => {
      setSseLastEventAt(new Date().toISOString());
      refresh();
    };
    source.onopen = () => setSseState("open");
    source.onerror = () => setSseState("error");
    source.addEventListener("week", handleRefresh);
    source.addEventListener("job", handleRefresh);
    source.addEventListener("ping", handleRefresh);
    source.addEventListener("self-heal", handleRefresh);
    return () => {
      source.removeEventListener("week", handleRefresh);
      source.removeEventListener("job", handleRefresh);
      source.removeEventListener("ping", handleRefresh);
      source.removeEventListener("self-heal", handleRefresh);
      source.close();
      setSseState("closed");
    };
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
          router.push("/ops/login?next=/ops");
        }
      } finally {
        setLoading(false);
        refresh();
      }
    },
    [refresh, router],
  );

  const isRunning = jobs?.running ?? false;
  const currentWeek = status?.currentWeek ?? null;
  const timeMode = status?.timeMode ?? "NORMAL";
  const stablecoinSymbol = status?.stablecoinSymbol || "Stablecoin";

  const jobList = useMemo(() => {
    const map = jobs?.jobs ?? {};
    return jobOrder
      .map((name) => map[name])
      .filter((job): job is JobStatus => Boolean(job));
  }, [jobs]);

  const activeIncidents = useMemo(() => {
    const currentWeekId = currentWeek?.id ?? null;
    const nowMs = Date.now();

    return incidents.filter((incident) => {
      if (incident.last_status === "success") return false;
      if (incident.last_error_code === "stopped" || isStoppedError(incident.last_error)) {
        return false;
      }

      const incidentAt = Date.parse(incident.last_finished_at ?? incident.first_started_at ?? "");
      const isStale = Number.isFinite(incidentAt)
        ? nowMs - incidentAt > INCIDENT_ACTIVITY_WINDOW_MS
        : false;

      if (currentWeekId) {
        if (incident.week_id && incident.week_id !== currentWeekId) return false;
        if (!incident.week_id && isStale) return false;
        return true;
      }

      return !isStale;
    });
  }, [currentWeek?.id, incidents]);

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
              Oracle Manual Jobs
            </h1>
            <p className="text-sm text-[color:var(--arena-muted)] md:text-base">
              Run weekly jobs manually and track the current state in one place.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/ops/finance"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Finance
            </Link>
            <Link
              href="/ops/score-lab"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Score Lab
            </Link>
            <Link
              href="/ops/self-heal"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Self-Heal Center
            </Link>
            <Link
              href="/ops/security"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Security
            </Link>
            <Link
              href="/ops/reactive"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Reactive TX
            </Link>
            <Link
              href="/ops/errors"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Errors
            </Link>
          </div>
        </div>
        {message ? (
          <p className="mt-4 text-sm text-[color:var(--arena-gold)]">{message}</p>
        ) : null}
      </section>

      <section>
        <Card className="arena-panel-strong">
          <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="arena-label">Recovery</p>
              <CardTitle>Self-Heal Snapshot</CardTitle>
            </div>
            <Link
              href="/ops/self-heal"
              className="inline-flex h-9 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-4 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Open Self-Heal Center
            </Link>
          </CardHeader>
          <CardContent className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
              <div className="text-[color:var(--arena-muted)]">Queue Total</div>
              <div className="text-lg font-semibold">{selfHealSummary?.total ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
              <div className="text-[color:var(--arena-muted)]">Pending</div>
              <div className="text-lg font-semibold">{selfHealSummary?.byStatus?.pending ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
              <div className="text-[color:var(--arena-muted)]">Retrying</div>
              <div className="text-lg font-semibold">{selfHealSummary?.byStatus?.retrying ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
              <div className="text-[color:var(--arena-muted)]">Recovered</div>
              <div className="text-lg font-semibold">{selfHealSummary?.recovered ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
              <div className="text-[color:var(--arena-muted)]">Dead</div>
              <div className="text-lg font-semibold">{selfHealSummary?.byStatus?.dead ?? 0}</div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="arena-panel-strong">
          <CardHeader className="space-y-2">
            <p className="arena-label">Current Week</p>
            <CardTitle>Week Status</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="accent">
                {currentWeek ? statusLabels[currentWeek.status] : "No Week"}
              </Badge>
              <Badge
                className={
                  status?.chainEnabled
                    ? "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]"
                    : "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]"
                }
              >
                {status?.chainEnabled ? "Chain Enabled" : "Chain Disabled"}
              </Badge>
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Week ID</span>
                <span className="font-semibold">{currentWeek?.id ?? "--"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Start</span>
                <span className="font-semibold">{formatDate(currentWeek?.startAtUtc)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Lock</span>
                <span className="font-semibold">{formatDate(currentWeek?.lockAtUtc)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">End</span>
                <span className="font-semibold">{formatDate(currentWeek?.endAtUtc)}</span>
              </div>
            </div>
            <div className="grid gap-2 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Coins</span>
                <span className="font-semibold">{status?.counts.coins ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Week Coins</span>
                <span className="font-semibold">{status?.counts.weekCoins ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Strategies</span>
                <span className="font-semibold">{status?.counts.lineups ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[color:var(--arena-muted)]">Weekly Results</span>
                <span className="font-semibold">{status?.counts.weeklyResults ?? 0}</span>
              </div>
            </div>
            <div className="grid gap-1 text-xs text-[color:var(--arena-muted)]">
              <div>League contract: {status?.leagueContractSet ? "set" : "missing"}</div>
              <div>{stablecoinSymbol} address: {status?.stablecoinAddressSet ? "set" : "missing"}</div>
              <div>Pause Wallet: {status?.pauserAddress ? status.pauserAddress : "missing"}</div>
              <div>
                SSE:{" "}
                <span
                  className={
                    sseState === "open"
                      ? "text-[color:var(--arena-success)]"
                      : sseState === "error"
                      ? "text-[color:var(--arena-danger)]"
                      : "text-[color:var(--arena-muted)]"
                  }
                >
                  {sseState}
                </span>
                {sseLastEventAt ? ` \u00b7 last ${formatDate(sseLastEventAt)}` : ""}
              </div>
              <div>
                Contract mode:{" "}
                <span
                  className={
                    timeMode === "MANUAL"
                      ? "text-[color:var(--arena-gold)]"
                      :  "text-[color:var(--arena-muted)]"
                  }
                >
                  {timeMode}
                </span>
              </div>
            </div>
            <p className="text-xs uppercase tracking-[0.28em] text-[color:var(--arena-muted)]">
              Server time: {formatDate(status?.serverTime)}
            </p>
          </CardContent>
        </Card>

        <Card className="arena-panel-strong">
          <CardHeader className="space-y-2">
            <p className="arena-label">Actions</p>
          <CardTitle>Manual Controls</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="grid gap-4">
            <div className="grid gap-3">
              <div className="arena-label">Week Status Actions</div>
              <Button
                variant="glow"
                onClick={() => runAction("/admin/jobs/run-week")}
                disabled={loading || isRunning}
              >
                Run Week
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction("/admin/jobs/refresh-week-coins")}
                disabled={loading || isRunning || currentWeek?.status !== "DRAFT_OPEN"}
              >
                Refresh Week Coins
              </Button>
              <Button
                onClick={() => runAction("/admin/jobs/transition", { action: "lock" })}
                disabled={loading || isRunning || currentWeek?.status !== "DRAFT_OPEN"}
              >
                Lock Week
              </Button>
              <Button
                onClick={() => runAction("/admin/jobs/transition", { action: "start" })}
                disabled={loading || isRunning || currentWeek?.status !== "LOCKED"}
              >
                Start Week
              </Button>
              <Button
                variant="outline"
                onClick={() => runAction("/admin/jobs/finalize")}
                disabled={loading || isRunning || currentWeek?.status !== "ACTIVE"}
              >
                Finalize Week
              </Button>
            </div>

            <div className="grid gap-3">
              <div className="arena-label">Admin / Safety</div>
              <Button
                variant="outline"
                className="border-[color:var(--arena-danger)] text-[color:var(--arena-danger)] hover:bg-[rgba(255,78,78,0.08)]"
                onClick={() =>
                  runAction("/admin/jobs/stop", runningJob ? { name: runningJob.name } : {})
                }
                disabled={loading || !runningJob}
              >
                {runningJob
                  ? `Stop ${jobNames[runningJob.name] ?? runningJob.name}`
                  : "Stop Job"}
              </Button>
              <p className="text-xs text-[color:var(--arena-muted)]">
                Halts the current job and cancels scheduled retries.
              </p>
              <Button
                variant="outline"
                onClick={() => runAction("/admin/jobs/time-mode")}
                disabled={loading || isRunning}
              >
                Apply Automation Mode
              </Button>
              <p className="text-xs text-[color:var(--arena-muted)]">
                Syncs contract test mode from AUTOMATION_MODE (MANUAL maps to test mode ON; other modes set it OFF).
              </p>
              <Button
                variant="outline"
                className="border-[color:var(--arena-danger)] text-[color:var(--arena-danger)] hover:bg-[rgba(255,78,78,0.08)]"
                onClick={() => runAction("/admin/jobs/reset-db")}
                disabled={loading || isRunning}
              >
                Reset DB (keep coins)
              </Button>
              <p className="text-xs text-[color:var(--arena-muted)]">
                Clears epochs, strategies, and results. Coins and faucet claims stay intact.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[rgba(15,15,15,0.6)] p-4 text-xs text-[color:var(--arena-muted)]">
            Lock/Start updates the DB status and writes to chain only if the oracle keys and
            contract address are configured.
          </div>
        </CardContent>
      </Card>
      </section>

      <section className="grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Active Job Incidents</h2>
          <Link href="/ops/errors" className="text-xs text-[color:var(--arena-muted)] hover:text-[color:var(--arena-ink)]">
            View resolved / full history
          </Link>
        </div>
        <div className="grid gap-4">
          {activeIncidents.length ? (
            activeIncidents.map((incident) => (
              <Card key={`${incident.run_id}-${incident.job_name}`} className="arena-panel-strong">
                <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base">
                      {jobNames[incident.job_name] ?? incident.job_name}
                    </CardTitle>
                    <p className="text-xs text-[color:var(--arena-muted)]">
                      Week {incident.week_id ?? "--"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="default">
                      {incident.error_count} errors / {incident.attempts} attempts
                    </Badge>
                    {incident.last_status === "success" ? (
                      <Badge variant="cool">Recovered (attempt {incident.success_attempt ?? "?"})</Badge>
                    ) : (
                      <Badge className={incidentBadgeClass(incident)}>
                        {incidentStatusLabel(incident)}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-2 text-xs">
                  <div className="grid gap-1 text-[color:var(--arena-muted)]">
                    <div className="flex items-center justify-between">
                      <span>First attempt</span>
                      <span className="font-semibold">{formatDate(incident.first_started_at)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Last finished</span>
                      <span className="font-semibold">{formatDate(incident.last_finished_at)}</span>
                    </div>
                    {incident.success_at ? (
                      <div className="flex items-center justify-between">
                        <span>Recovered</span>
                        <span className="font-semibold">{formatDate(incident.success_at)}</span>
                      </div>
                    ) : null}
                  </div>
                  {incident.last_error ? (
                    <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.8)] p-3 text-[color:var(--arena-danger)]">
                      {incident.last_error}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))
          ) : (
            <p className="text-sm text-[color:var(--arena-muted)]">
              No ongoing incidents in the active window. Resolved entries are available under /ops/errors.
            </p>
          )}
        </div>
      </section>

      <section className="grid gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Job Status</h2>
        <div className="grid gap-4">
          {jobs === null ? (
            <p className="text-sm text-[color:var(--arena-muted)]">Loading job status...</p>
          ) : jobList.length ? (
            jobList.map((job) => (
              <Card key={job.name} className="arena-panel-strong">
                <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{jobNames[job.name] ?? job.name}</CardTitle>
                    <p className="text-xs text-[color:var(--arena-muted)]">
                      {job.command || "pnpm job"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={jobBadgeClass(job)}>{jobStatusLabel(job)}</Badge>
                    {job.exitCode !== null ? (
                      <Badge variant="cool">exit {job.exitCode}</Badge>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 text-xs">
                  <div className="grid gap-1 text-[color:var(--arena-muted)]">
                    <div className="flex items-center justify-between">
                      <span>Started</span>
                      <span className="font-semibold">{formatDate(job.startedAt)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Finished</span>
                      <span className="font-semibold">{formatDate(job.finishedAt)}</span>
                    </div>
                    {job.weekId ? (
                      <div className="flex items-center justify-between">
                        <span>Week</span>
                        <span className="font-semibold">{job.weekId}</span>
                      </div>
                    ) : null}
                    {job.runId ? (
                      <div className="flex items-center justify-between">
                        <span>Run ID</span>
                        <span className="font-semibold">{job.runId}</span>
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between">
                      <span>Attempt</span>
                      <span className="font-semibold">{job.attempt ?? 0}</span>
                    </div>
                    {job.nextRetryAt ? (
                      <div className="text-[color:var(--arena-gold)]">
                        Next retry: {formatDate(job.nextRetryAt)}
                      </div>
                    ) : null}
                    {job.lastError ? (
                      <div className="text-[color:var(--arena-danger)]">
                        Last error: {job.lastError}
                      </div>
                    ) : null}
                    {job.error ? (
                      <div className="text-[color:var(--arena-danger)]">Error: {job.error}</div>
                    ) : null}
                  </div>
                  <pre className="max-h-56 overflow-auto rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(10,10,10,0.8)] p-3 text-[0.7rem] text-[color:var(--arena-muted)]">
                    {job.output || "No output yet."}
                  </pre>
                </CardContent>
              </Card>
            ))
          ) : (
            <p className="text-sm text-[color:var(--arena-muted)]">
              No job history yet. Run a job to see logs here.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}















































