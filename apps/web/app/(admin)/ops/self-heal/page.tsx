"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { apiGet, apiPost } from "../../../../lib/api";

type SelfHealTask = {
  id: number;
  task_type: string;
  task_key: string;
  week_id: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  last_error_code: string | null;
  updated_at: string;
  resolved_at: string | null;
  last_attempt: number | null;
  last_run_status: string | null;
  last_run_error_message: string | null;
  last_run_error_code: string | null;
  last_run_finished_at: string | null;
};

type SelfHealRun = {
  id: number;
  task_id: number;
  task_type: string;
  task_key: string;
  week_id: string | null;
  attempt: number;
  status: string;
  error_message: string | null;
  error_code: string | null;
  started_at: string;
  finished_at: string;
};

type SelfHealDashboard = {
  summary: {
    total: number;
    byStatus: Record<string, number>;
    recovered: number;
  };
  tasks: SelfHealTask[];
  runs: SelfHealRun[];
};

const selfHealBadgeClass = (status: string) => {
  const normalized = status.toLowerCase();
  if (normalized === "success") {
    return "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]";
  }
  if (normalized === "retrying" || normalized === "pending" || normalized === "running") {
    return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  }
  if (normalized === "canceled") {
    return "border-[color:var(--arena-muted)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
  }
  return "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";
};

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

export default function OpsSelfHealPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);
  const [dashboard, setDashboard] = useState<SelfHealDashboard | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<SelfHealDashboard>("/admin/self-heal");
      setDashboard(data);
      setMessage(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to load self-heal data";
      setMessage(text);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  const runSweep = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      await apiPost("/admin/self-heal/sweep", {});
      setMessage("Self-heal sweep started.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Sweep failed";
      setMessage(text);
    } finally {
      setLoading(false);
      void refresh();
    }
  }, [refresh]);

  const runTaskAction = useCallback(
    async (taskId: number, action: "retry" | "cancel") => {
      setBusyTaskId(taskId);
      setMessage(null);
      try {
        await apiPost(`/admin/self-heal/tasks/${taskId}/${action}`, {});
        setMessage(action === "retry" ? "Task retried." : "Task canceled.");
      } catch (error) {
        const text = error instanceof Error ? error.message : "Task action failed";
        setMessage(text);
      } finally {
        setBusyTaskId(null);
        void refresh();
      }
    },
    [refresh],
  );

  const summary = dashboard?.summary;
  const tasks = dashboard?.tasks ?? [];
  const runs = useMemo(() => (dashboard?.runs ?? []).slice(0, 40), [dashboard]);
  return (
    <div className="grid gap-6">
      <section className="arena-panel rounded-[28px] p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-2">
            <span className="arena-chip">Ops Console</span>
            <h1 className="font-display text-3xl font-semibold tracking-tight">Self-Heal Center</h1>
            <p className="text-sm text-[color:var(--arena-muted)]">
              Inspect automatic recovery, retry failed tasks, and track unresolved incidents.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
            <Button variant="outline" onClick={() => void runSweep()} disabled={loading}>
              Sweep Now
            </Button>
            <a
              href="/ops"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-6 text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Back To Ops
            </a>
          </div>
        </div>
        {message ? <p className="mt-4 text-sm text-[color:var(--arena-gold)]">{message}</p> : null}
      </section>

      <Card className="arena-panel-strong">
        <CardHeader>
          <CardTitle>Queue Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-6 text-xs">
          <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
            <div className="text-[color:var(--arena-muted)]">Total</div>
            <div className="text-lg font-semibold">{summary?.total ?? 0}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
            <div className="text-[color:var(--arena-muted)]">Pending</div>
            <div className="text-lg font-semibold">{summary?.byStatus.pending ?? 0}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
            <div className="text-[color:var(--arena-muted)]">Retrying</div>
            <div className="text-lg font-semibold">{summary?.byStatus.retrying ?? 0}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
            <div className="text-[color:var(--arena-muted)]">Recovered</div>
            <div className="text-lg font-semibold">{summary?.recovered ?? 0}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
            <div className="text-[color:var(--arena-muted)]">Dead</div>
            <div className="text-lg font-semibold">{summary?.byStatus.dead ?? 0}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
            <div className="text-[color:var(--arena-muted)]">Canceled</div>
            <div className="text-lg font-semibold">{summary?.byStatus.canceled ?? 0}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="arena-panel-strong">
        <CardHeader>
          <CardTitle>Task Queue</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {tasks.length ? (
            tasks.map((task) => {
              const canRetry = ["dead", "canceled", "retrying", "pending"].includes(task.status);
              const canCancel = ["pending", "retrying", "running"].includes(task.status);
              return (
                <div
                  key={task.id}
                  className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[rgba(10,10,10,0.65)] p-4"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[color:var(--arena-ink)]">
                          {task.task_type}
                        </span>
                        <Badge className={selfHealBadgeClass(task.status)}>{task.status}</Badge>
                      </div>
                      <div className="text-xs text-[color:var(--arena-muted)] break-all">
                        key: {task.task_key}
                      </div>
                      <div className="text-xs text-[color:var(--arena-muted)]">
                        Week: {task.week_id ?? "--"} | attempts {task.attempt_count}/{task.max_attempts}
                      </div>
                      <div className="text-xs text-[color:var(--arena-muted)]">
                        Next: {formatDate(task.next_attempt_at)} | Updated: {formatDate(task.updated_at)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canRetry || busyTaskId === task.id}
                        onClick={() => void runTaskAction(task.id, "retry")}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canCancel || busyTaskId === task.id}
                        onClick={() => void runTaskAction(task.id, "cancel")}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                  {task.last_error ? (
                    <div className="mt-3 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.9)] p-3 text-xs text-[color:var(--arena-danger)]">
                      {task.last_error}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="text-sm text-[color:var(--arena-muted)]">No self-heal tasks yet.</p>
          )}
        </CardContent>
      </Card>

      <Card className="arena-panel-strong">
        <CardHeader>
          <CardTitle>Recovery Runs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-xs">
          {runs.length ? (
            runs.map((run) => (
              <div
                key={run.id}
                className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.8)] px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[color:var(--arena-ink)]">
                    {run.task_type} | task #{run.task_id} | attempt {run.attempt}
                  </span>
                  <Badge className={selfHealBadgeClass(run.status)}>{run.status}</Badge>
                </div>
                <div className="text-[color:var(--arena-muted)]">
                  Week {run.week_id ?? "--"} | {formatDate(run.started_at)} to {formatDate(run.finished_at)}
                </div>
                {run.error_message ? (
                  <div className="text-[color:var(--arena-danger)]">{run.error_message}</div>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-sm text-[color:var(--arena-muted)]">No recovery runs yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
