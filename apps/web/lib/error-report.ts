export type ClientErrorReportPayload = {
  source?: string;
  severity?: "warn" | "error" | "fatal";
  category?: string;
  message: string;
  errorName?: string;
  stack?: string;
  fingerprint?: string;
  path?: string;
  method?: string;
  statusCode?: number;
  context?: unknown;
  tags?: Record<string, string>;
  release?: string;
  sessionAddress?: string;
  walletAddress?: string;
  strategistDisplayName?: string;
  userAgent?: string;
};

const INGEST_ENDPOINT = "/api/oracle/errors/ingest";
const DEDUPE_WINDOW_MS = 15_000;
const MAX_DEDUPE_KEYS = 500;
const ACTIVE_STRATEGIST_CACHE_KEY = "valcore:active-strategist";

const recentKeys = new Map<string, number>();

const trimText = (value: unknown, max = 4000) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
};

const normalizeSeverity = (value: unknown): "warn" | "error" | "fatal" => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "fatal") return "fatal";
  if (normalized === "warn") return "warn";
  return "error";
};

const buildKey = (payload: ClientErrorReportPayload) => {
  return [
    normalizeSeverity(payload.severity),
    trimText(payload.category ?? "runtime", 64),
    trimText(payload.message, 600),
    trimText(payload.path ?? "", 300),
    trimText(payload.method ?? "", 16),
    String(payload.statusCode ?? ""),
  ].join("|");
};

const shouldSendNow = (key: string) => {
  const now = Date.now();
  const previous = recentKeys.get(key);
  if (previous && now - previous < DEDUPE_WINDOW_MS) {
    return false;
  }
  recentKeys.set(key, now);

  if (recentKeys.size > MAX_DEDUPE_KEYS) {
    const threshold = now - DEDUPE_WINDOW_MS;
    for (const [storedKey, ts] of recentKeys.entries()) {
      if (ts < threshold) {
        recentKeys.delete(storedKey);
      }
    }
    if (recentKeys.size > MAX_DEDUPE_KEYS) {
      const firstKey = recentKeys.keys().next().value;
      if (firstKey) recentKeys.delete(firstKey);
    }
  }

  return true;
};

const readActivePlayerMeta = () => {
  if (typeof window === "undefined") {
    return { address: null as string | null, displayName: null as string | null };
  }

  try {
    const raw = window.localStorage.getItem(ACTIVE_STRATEGIST_CACHE_KEY);
    if (!raw) {
      return { address: null, displayName: null };
    }

    const parsed = JSON.parse(raw) as { address?: string | null; displayName?: string | null };
    return {
      address: trimText(parsed?.address ?? "", 120) || null,
      displayName: trimText(parsed?.displayName ?? "", 64) || null,
    };
  } catch {
    return { address: null, displayName: null };
  }
};

export async function reportClientError(payload: ClientErrorReportPayload): Promise<void> {
  if (typeof window === "undefined") return;

  const message = trimText(payload.message, 4000);
  if (!message) return;

  const severity = normalizeSeverity(payload.severity);
  const category = trimText(payload.category ?? "runtime", 64) || "runtime";
  const key = buildKey({ ...payload, severity, category, message });
  if (!shouldSendNow(key)) return;

  const activePlayer = readActivePlayerMeta();
  const effectiveWalletAddress = trimText(payload.walletAddress ?? activePlayer.address ?? "", 120) || undefined;
  const effectiveSessionAddress = trimText(payload.sessionAddress ?? activePlayer.address ?? "", 120) || undefined;
  const effectivePlayerDisplayName =
    trimText(payload.strategistDisplayName ?? activePlayer.displayName ?? "", 64) || undefined;

  try {
    await fetch(INGEST_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify({
        eventId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        source: trimText(payload.source ?? "web-client", 64) || "web-client",
        severity,
        category,
        message,
        errorName: trimText(payload.errorName ?? "", 200) || undefined,
        stack: trimText(payload.stack ?? "", 30000) || undefined,
        fingerprint: trimText(payload.fingerprint ?? key, 200) || undefined,
        path: trimText(payload.path ?? window.location.pathname, 500) || undefined,
        method: trimText(payload.method ?? "", 16) || undefined,
        statusCode: Number.isFinite(Number(payload.statusCode)) ? Number(payload.statusCode) : undefined,
        context: payload.context,
        tags: payload.tags,
        release: trimText(payload.release ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "", 120) || undefined,
        sessionAddress: effectiveSessionAddress,
        walletAddress: effectiveWalletAddress,
        strategistDisplayName: effectivePlayerDisplayName,
        userAgent: trimText(payload.userAgent ?? window.navigator.userAgent, 1024) || undefined,
      }),
    });
  } catch {
    // Silent by design. Error telemetry should never break UX.
  }
}

