import { reportClientError } from "./error-report";

const API_BASE = "/api/oracle";

const withBase = (path: string) => {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
};

const toMessage = async (res: Response) => {
  try {
    const payload = (await res.json()) as { error?: string };
    if (payload?.error) return payload.error;
  } catch {
    // Ignore parse failures and fallback to status code.
  }
  return `API error ${res.status}`;
};

const shouldSuppressApiError = (input: {
  method: "GET" | "POST";
  path: string;
  statusCode?: number;
  message: string;
}) => {
  if (input.method !== "GET") return false;
  if (input.statusCode !== 404) return false;
  if (!/lineup\s+not\s+found/i.test(input.message)) return false;
  return /^\/weeks\/[^/]+\/lineups\/[^/]+(?:\/score)?$/i.test(input.path);
};
const reportApiError = (payload: {
  method: "GET" | "POST";
  path: string;
  message: string;
  statusCode?: number;
  category: string;
  context?: unknown;
}) => {
  void reportClientError({
    source: "web-client",
    severity: "error",
    category: payload.category,
    message: payload.message,
    path: payload.path,
    method: payload.method,
    statusCode: payload.statusCode,
    context: payload.context,
  });
};

export async function apiGet<T>(path: string): Promise<T> {
  const target = withBase(path);
  let res: Response;
  try {
    res = await fetch(target, { cache: "no-store", credentials: "same-origin" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    reportApiError({ method: "GET", path, message, category: "api-network" });
    throw error;
  }

  if (!res.ok) {
    const message = await toMessage(res);
    if (!shouldSuppressApiError({ method: "GET", path, statusCode: res.status, message })) {
      reportApiError({
        method: "GET",
        path,
        message,
        statusCode: res.status,
        category: "api-http",
      });
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const target = withBase(path);
  let res: Response;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    reportApiError({ method: "POST", path, message, category: "api-network" });
    throw error;
  }

  if (!res.ok) {
    const message = await toMessage(res);
    reportApiError({
      method: "POST",
      path,
      message,
      statusCode: res.status,
      category: "api-http",
      context: payload,
    });
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}