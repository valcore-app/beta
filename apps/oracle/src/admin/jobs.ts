import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { env } from "../env.js";
import { insertJobRun, updateJobRun, getLatestWeekId } from "../store.js";

export const jobsEvents = new EventEmitter();
jobsEvents.setMaxListeners(50);

export type JobState = "idle" | "running" | "success" | "error";

export type JobStatus = {
  name: string;
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  output: string;
  command: string;
  error: string | null;
  attempt: number;
  runId: string | null;
  weekId: string | null;
  lastError: string | null;
  retryCount: number;
  nextRetryAt: string | null;
};

type JobControl = {
  child: ChildProcess | null;
  retryTimer: NodeJS.Timeout | null;
  canceled: boolean;
};

const WEBHOOK_URL = env.JOB_WEBHOOK_URL?.trim();
const WEBHOOK_API_KEY = env.JOB_WEBHOOK_API_KEY?.trim();

const sendWebhook = async (event: string, payload: Record<string, unknown>) => {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(WEBHOOK_API_KEY ? { "x-api-key": WEBHOOK_API_KEY } : {}),
      },
      body: JSON.stringify({ event, ...payload }),
    });
  } catch {
    // best-effort
  }
};

const killProcessTree = (child: ChildProcess) => {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: true,
    });
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 5000);
};

const MAX_OUTPUT_CHARS = 8000;
const RETRYABLE_JOBS = new Set(["run-week", "refresh-week-coins", "transition-lock", "transition-start", "finalize", "finalize-audit"]);
const TRANSIENT_HINTS = [
  "timeout",
  "timed out",
  "econnreset",
  "socket hang up",
  "connection refused",
  "connection closed",
  "network error",
  "temporary",
  "temporarily unavailable",
  "rate limit",
  "429",
  "502",
  "503",
  "504",
  "gateway",
  "service unavailable",
  "missing revert data",
  "nonce too low",
  "replacement fee too low",
  "gas price too low",
  "max fee per gas",
  "underpriced",
];

const NON_RETRYABLE_SYSTEM_HINTS = [
  "insufficient funds",
  "already known",
  "already imported",
  "invalid sender",
  "signature",
  "unauthorized",
  "unsupported chain",
  "chainid",
];

const NON_RETRYABLE_HINTS = [
  "weekalreadyexists",
  "invalidtimerange",
  "draftnotopen",
  "draftclosed",
  "locktimenotreached",
  "starttimenotreached",
  "endtimenotreached",
  "weeknotlocked",
  "weeknotactive",
  "weeknotfinalizepending",
  "invalidmerkleroot",
  "invalidhash",
  "invaliddeposit",
  "belowmindeposit",
  "deposittolarge",
  "swaplimitreached",
  "weekended",
  "nolineup",
  "alreadyclaimed",
  "invalidproof",
  "emergencyexitnotallowed",
  "emergencyrefundnotallowed",
  "emergencyrefundnotactive",
  "refundamountmismatch",
];
const draftOpenHoursRaw = Number(env.DRAFT_OPEN_HOURS ?? "23");
const DRAFT_OPEN_HOURS = Number.isFinite(draftOpenHoursRaw) && draftOpenHoursRaw > 0 ? draftOpenHoursRaw : 23;

const RETRY_BASE_MS = Number(env.JOB_RETRY_BASE_MS);
const RETRY_MAX_MS = Number(env.JOB_RETRY_MAX_MS);
const RETRY_JITTER_MS = Number(env.JOB_RETRY_JITTER_MS);
const MAX_RETRY_ATTEMPTS = Number(env.JOB_RETRY_MAX_ATTEMPTS);
const normalizeTimeoutMs = (value: number, fallback = 0) => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
};

const DEFAULT_JOB_TIMEOUT_MS = normalizeTimeoutMs(Number(env.JOB_TIMEOUT_MS), 0);
const RUN_WEEK_JOB_TIMEOUT_MS = normalizeTimeoutMs(
  Number(env.JOB_RUN_WEEK_TIMEOUT_MS),
  DEFAULT_JOB_TIMEOUT_MS,
);

const getJobTimeoutMs = (name: string) =>
  name === "run-week" ? RUN_WEEK_JOB_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;

const jobStatus = new Map<string, JobStatus>();
const jobControls = new Map<string, JobControl>();

const knownJobs = [
  { name: "run-week", command: "npm run job:week" },
  { name: "refresh-week-coins", command: "npm run job:refresh-week-coins" },
  { name: "momentum-live", command: "npm run job:momentum-live" },
  { name: "transition-lock", command: "npm run job:transition -- lock" },
  { name: "transition-start", command: "npm run job:transition -- start" },
  { name: "finalize", command: "npm run job:finalize" },
  { name: "finalize-audit", command: "npm run job:finalize-audit" },
  { name: "finalize-reject", command: "npm run job:finalize-reject" },
  { name: "pause", command: "npm run job:pause" },
  { name: "unpause", command: "npm run job:unpause" },
  { name: "time-mode", command: "npm run job:time-mode" },
  { name: "reset-db", command: "npm run job:reset-db" },
] as const;

const ensureStatus = (name: string, command: string): JobStatus => {
  const existing = jobStatus.get(name);
  if (existing) return existing;
  const next: JobStatus = {
    name,
    state: "idle",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    output: "",
    command,
    error: null,
    attempt: 0,
    runId: null,
    weekId: null,
    lastError: null,
    retryCount: 0,
    nextRetryAt: null,
  };
  jobStatus.set(name, next);
  return next;
};

const ensureControl = (name: string): JobControl => {
  const existing = jobControls.get(name);
  if (existing) return existing;
  const next: JobControl = { child: null, retryTimer: null, canceled: false };
  jobControls.set(name, next);
  return next;
};

const appendOutput = (status: JobStatus, chunk: string) => {
  const next = `${status.output}${chunk}`;
  status.output = next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
};

export const hasRunningJob = () =>
  Array.from(jobStatus.values()).some((status) => status.state === "running");

export const listJobStatuses = () => {
  for (const job of knownJobs) {
    ensureStatus(job.name, job.command);
  }
  const entries = Array.from(jobStatus.entries()).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
};

export const stopJob = async (name?: string) => {
  const names = name ? [name] : Array.from(jobControls.keys());
  const stopped: string[] = [];
  for (const jobName of names) {
    const control = jobControls.get(jobName);
    const status = jobStatus.get(jobName);
    if (!control && !status) continue;
    if (control) {
      control.canceled = true;
      if (control.retryTimer) {
        clearTimeout(control.retryTimer);
        control.retryTimer = null;
      }
      if (control.child) {
        killProcessTree(control.child);
        control.child = null;
      }
    }
    if (status) {
      const finishedAt = new Date().toISOString();
      status.state = "error";
      status.error = "Stopped by operator";
      status.lastError = status.error;
      status.finishedAt = finishedAt;
      status.nextRetryAt = null;
      status.exitCode = status.exitCode ?? 1;

      // Persist explicit stop signal so incident dashboard does not remain "still failing".
      if (status.runId) {
        try {
          await insertJobRun({
            run_id: status.runId,
            job_name: jobName,
            week_id: status.weekId ?? null,
            attempt: status.attempt > 0 ? status.attempt : 1,
            status: "error",
            error_message: "Stopped by operator",
            error_code: "stopped",
            output: status.output,
            started_at: status.startedAt ?? finishedAt,
            finished_at: finishedAt,
          });
        } catch (error) {
          appendOutput(status, `Stop log insert failed: ${error instanceof Error ? error.message : "unknown"}\n`);
        }
      }

      jobsEvents.emit("job:finished", { name: jobName, status: { ...status } });
    }
    stopped.push(jobName);
  }
  return { stopped };
};
type RetryClass = "transient" | "unknown" | "non-retryable" | "stopped";

type RetryDecision = {
  retryable: boolean;
  kind: RetryClass;
};

const normalizeErrorHint = (value: string) => value.toLowerCase().replace(/[^a-z0-9_]/g, "");

const classifyRetry = (message: string | null): RetryDecision => {
  if (!message) return { retryable: true, kind: "unknown" };
  const normalized = normalizeErrorHint(message);
  if (normalized.includes("stoppedbyoperator")) {
    return { retryable: false, kind: "stopped" };
  }
  if (
    NON_RETRYABLE_HINTS.some((hint) => normalized.includes(hint)) ||
    NON_RETRYABLE_SYSTEM_HINTS.some((hint) => normalized.includes(hint.replace(/[^a-z0-9_]/g, "")))
  ) {
    return { retryable: false, kind: "non-retryable" };
  }
  if (TRANSIENT_HINTS.some((hint) => normalized.includes(hint.replace(/[^a-z0-9_]/g, "")))) {
    return { retryable: true, kind: "transient" };
  }
  return { retryable: true, kind: "unknown" };
};

const computeRetryDelay = (attempt: number, kind: RetryClass) => {
  const base = Number.isFinite(RETRY_BASE_MS) && RETRY_BASE_MS > 0 ? RETRY_BASE_MS : 5000;
  const max = Number.isFinite(RETRY_MAX_MS) && RETRY_MAX_MS > 0 ? RETRY_MAX_MS : 60000;
  const jitter = Number.isFinite(RETRY_JITTER_MS) && RETRY_JITTER_MS >= 0 ? RETRY_JITTER_MS : 1500;
  const multiplier = kind === "unknown" ? 2 : 1;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)) * multiplier);
  const jitterOffset = Math.floor(Math.random() * jitter);
  return exp + jitterOffset;
};

const summarizeError = (explicit: string | null, output: string) => {
  if (explicit) return explicit;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const errorLines = lines.filter((line) => /error|revert|exception|failed/i.test(line));
  const candidate = errorLines.at(-1) ?? lines.at(-1);
  return candidate ? candidate.slice(0, 800) : null;
};

const computeWeekIdFromBase = (baseNowMs: number) => {
  const lockAt = new Date(baseNowMs + DRAFT_OPEN_HOURS * 60 * 60 * 1000);
  const startAt = lockAt;
  return String(Math.floor(startAt.getTime() / 1000));
};

const normalizeJobSpawnCommand = (command: string, args: string[]) => {
  if (command !== "pnpm") {
    return { command, args };
  }

  if (
    args.length >= 3 &&
    args[0] === "--filter" &&
    args[1] === "oracle" &&
    String(args[2] ?? "").startsWith("job:")
  ) {
    const script = String(args[2]);
    const tail = args.slice(3);
    const normalizedTail = tail[0] === "--" ? tail.slice(1) : tail;
    return {
      command: "npm",
      args: ["run", script, ...(normalizedTail.length ? ["--", ...normalizedTail] : [])],
    };
  }

  return { command, args };
};
const resolveWeekIdForJob = async (name: string, baseNowMs: number) => {
  if (name === "run-week") return computeWeekIdFromBase(baseNowMs);
  if (name === "refresh-week-coins") return await getLatestWeekId();
  if (name.startsWith("transition") || name === "finalize") {
    return await getLatestWeekId();
  }
  return null;
};

export const startJob = async (
  name: string,
  command: string,
  args: string[],
): Promise<JobStatus> => {
  const spawnTarget = normalizeJobSpawnCommand(command, args);
  const commandText = [spawnTarget.command, ...spawnTarget.args].join(" ");
  const status = ensureStatus(name, commandText);
  const control = ensureControl(name);

  const runId = randomUUID();
  const baseNowMs = Date.now();
  let weekId: string | null = null;
  try {
    weekId = await resolveWeekIdForJob(name, baseNowMs);
  } catch {
    weekId = null;
  }

  status.state = "running";
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.exitCode = null;
  status.output = "";
  status.command = commandText;
  status.error = null;
  status.attempt = 0;
  status.runId = runId;
  status.weekId = weekId;
  status.lastError = null;
  status.retryCount = 0;
  status.nextRetryAt = null;
  control.canceled = false;
  if (control.retryTimer) {
    clearTimeout(control.retryTimer);
    control.retryTimer = null;
  }
  control.child = null;

  const runAttempt = async (attempt: number) => {
    if (control.canceled) {
      status.state = "error";
      status.finishedAt = new Date().toISOString();
      status.error = "Stopped by operator";
      status.lastError = status.error;
      status.nextRetryAt = null;
      jobsEvents.emit("job:finished", { name, status: { ...status } });
      return;
    }
    if (control.retryTimer) {
      clearTimeout(control.retryTimer);
      control.retryTimer = null;
    }
    const attemptStartedAt = new Date().toISOString();
    status.state = "running";
    status.attempt = attempt;
    status.output = "";
    status.error = null;
    status.lastError = null;
    status.nextRetryAt = null;

    let runRowId: number | null = null;
    try {
      runRowId = await insertJobRun({
        run_id: runId,
        job_name: name,
        week_id: weekId,
        attempt,
        status: "running",
        started_at: attemptStartedAt,
      });
    } catch (error) {
      appendOutput(status, `Job log insert failed: ${error instanceof Error ? error.message : "unknown"}
`);
    }

    const child = spawn(spawnTarget.command, spawnTarget.args, {
      env: {
        ...process.env,
        ...(name === "run-week" ? { RUN_WEEK_BASE_TIME_MS: String(baseNowMs) } : {}),
      },
      shell: process.platform === "win32",
    });
    control.child = child;

    const timeoutMs = getJobTimeoutMs(name);
    let attemptTimeout: NodeJS.Timeout | null = null;

    let finished = false;
    const finalizeAttempt = async (code: number | null, explicitError: string | null) => {
      if (finished) return;
      finished = true;
      if (attemptTimeout) {
        clearTimeout(attemptTimeout);
        attemptTimeout = null;
      }

      const finishedAt = new Date().toISOString();
      const exitCode = typeof code === "number" ? code : 1;
      const wasCanceled = control.canceled;
      const errorText =
        exitCode === 0 && !wasCanceled
          ? null
          : wasCanceled
          ? "Stopped by operator"
          : summarizeError(explicitError, status.output);

      const decision = classifyRetry(errorText);
      const errorCode = exitCode === 0 && !wasCanceled ? null : decision.kind;

      control.child = null;

      if (runRowId !== null) {
        try {
          await updateJobRun(runRowId, {
            status: exitCode === 0 && !wasCanceled ? "success" : "error",
            error_message: errorText ?? null,
            error_code: errorCode,
            output: status.output,
            finished_at: finishedAt,
          });
        } catch (error) {
          appendOutput(status, `Job log update failed: ${error instanceof Error ? error.message : "unknown"}
`);
        }
      }

      status.exitCode = exitCode;

      if (exitCode === 0 && !wasCanceled) {
        status.state = "success";
        status.finishedAt = finishedAt;
        status.error = null;
        status.lastError = null;
        status.nextRetryAt = null;
        jobsEvents.emit("job:finished", { name, status: { ...status } });
        if (attempt > 1) {
          void sendWebhook("job.recovered", {
            job: name,
            weekId,
            runId,
            attempt,
          });
        }
        return;
      }

      if (wasCanceled) {
        status.state = "error";
        status.finishedAt = finishedAt;
        status.error = errorText ?? "Stopped by operator";
        status.lastError = status.error;
        status.nextRetryAt = null;
        jobsEvents.emit("job:finished", { name, status: { ...status } });
        void sendWebhook("job.stopped", {
          job: name,
          weekId,
          runId,
          attempt,
          error: errorText,
          retrying: false,
          kind: decision.kind,
        });
        return;
      }

      const canRetry =
        RETRYABLE_JOBS.has(name) &&
        decision.retryable &&
        (MAX_RETRY_ATTEMPTS <= 0 || attempt < MAX_RETRY_ATTEMPTS);

      if (canRetry) {
        status.retryCount = attempt;
        status.lastError = errorText ?? "Job failed";
        const delay = computeRetryDelay(attempt, decision.kind);
        status.nextRetryAt = new Date(Date.now() + delay).toISOString();
        jobsEvents.emit("job:finished", { name, status: { ...status } });
        void sendWebhook("job.error", {
          job: name,
          weekId,
          runId,
          attempt,
          error: errorText,
          retrying: true,
          nextRetryAt: status.nextRetryAt,
          kind: decision.kind,
        });
        control.retryTimer = setTimeout(() => {
          void runAttempt(attempt + 1);
        }, delay);
        return;
      }

      status.state = "error";
      status.finishedAt = finishedAt;
      status.error = errorText ?? `Exited with code ${exitCode}`;
      status.lastError = status.error;
      status.nextRetryAt = null;
      jobsEvents.emit("job:finished", { name, status: { ...status } });
      void sendWebhook("job.error", {
        job: name,
        weekId,
        runId,
        attempt,
        error: errorText,
        retrying: false,
        kind: decision.kind,
      });
    };

    if (timeoutMs > 0) {
      attemptTimeout = setTimeout(() => {
        const timeoutMessage = `${name} timed out after ${timeoutMs}ms`;
        appendOutput(status, timeoutMessage + "\n");
        try {
          killProcessTree(child);
        } catch {
          // best-effort
        }
        void finalizeAttempt(1, timeoutMessage);
      }, timeoutMs);
    }

    child.stdout.on("data", (data) => appendOutput(status, data.toString()));
    child.stderr.on("data", (data) => appendOutput(status, data.toString()));

    child.on("error", (error) => {
      status.error = error.message;
      void finalizeAttempt(1, error.message);
    });

    child.on("close", (code) => {
      void finalizeAttempt(code ?? 1, status.error);
    });
  };

  void runAttempt(1);
  return status;
};



