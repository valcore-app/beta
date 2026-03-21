const toBool = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

const isLocalDbHost = (connectionString?: string | null) => {
  const normalized = String(connectionString ?? "").trim();
  if (!normalized) return false;

  const hostParamMatch = normalized.match(/[?&]host=([^&]+)/i);
  if (hostParamMatch?.[1]) {
    const decodedHost = decodeURIComponent(hostParamMatch[1]).trim();
    if (decodedHost.startsWith("/") || decodedHost.includes("/cloudsql/")) {
      return true;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:\/\/[^@]+@\//i.test(normalized)) {
    return true;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
};

export const resolveDbSsl = (connectionString?: string | null) => {
  if (isLocalDbHost(connectionString)) {
    return undefined;
  }
  if (process.env.NODE_ENV !== "production") {
    return { rejectUnauthorized: false };
  }
  return {
    rejectUnauthorized: toBool(process.env.AUTH_DB_SSL_REJECT_UNAUTHORIZED, true),
  };
};

