import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const normalize = (value: string | undefined | null) => String(value ?? "").trim();

const splitUrls = (value: string | undefined | null) =>
  normalize(value)
    .split(/[\r\n,;]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => /^https?:\/\//iu.test(entry));

const isHtmlPayload = (contentType: string, body: string) => {
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes("text/html")) return true;
  const trimmed = body.trim().toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
};

const parseJsonSafely = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const getRetryableRpcErrorMessage = (body: string): string | null => {
  const parsed = parseJsonSafely(body);
  if (!parsed || typeof parsed !== "object") return null;

  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;

  const message = String((error as { message?: unknown }).message ?? "").trim();
  const data = (error as { data?: unknown }).data;
  const dataMessage =
    data && typeof data === "object"
      ? String((data as { message?: unknown; execution_error?: unknown }).message ?? (data as { execution_error?: unknown }).execution_error ?? "").trim()
      : String(data ?? "").trim();

  const haystack = `${message} ${dataMessage}`.toLowerCase();
  const hints = [
    "timeout",
    "timed out",
    "temporarily",
    "rate",
    "429",
    "502",
    "503",
    "504",
    "gateway",
    "fetch",
    "network",
    "connection",
    "unavailable",
    "no available nodes found",
    "upstream",
  ];

  return hints.some((hint) => haystack.includes(hint)) ? haystack : null;
};

const resolveUpstreamRpcUrls = () => {
  const primary = splitUrls(process.env.CHAIN_RPC_URL || process.env.NEXT_PUBLIC_CHAIN_RPC_URL);
  const fallbacks = [
    ...splitUrls(process.env.CHAIN_RPC_FALLBACK_URLS),
    ...splitUrls(process.env.NEXT_PUBLIC_CHAIN_RPC_FALLBACK_URLS),
  ];
  const urls = Array.from(new Set([...primary, ...fallbacks]));
  if (urls.length === 0) {
    throw new Error("CHAIN_RPC_URL (or NEXT_PUBLIC_CHAIN_RPC_URL) is required for /api/rpc");
  }
  return urls;
};

const proxyRpc = async (request: NextRequest) => {
  const upstreamUrls = resolveUpstreamRpcUrls();
  const body = await request.text();
  const contentType = request.headers.get("content-type") ?? "application/json";

  let lastStatus = 502;
  let lastBody = '{"jsonrpc":"2.0","error":{"code":-32000,"message":"RPC unavailable"},"id":null}';
  let lastContentType = "application/json";

  for (const upstreamUrl of upstreamUrls) {
    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": contentType,
        },
        body,
        cache: "no-store",
      });

      const responseBody = await upstreamResponse.text();
      const upstreamContentType = upstreamResponse.headers.get("content-type") ?? "application/json";
      const htmlPayload = isHtmlPayload(upstreamContentType, responseBody);
      const retryableRpcError = getRetryableRpcErrorMessage(responseBody);

      lastStatus = upstreamResponse.status;
      lastBody = responseBody;
      lastContentType = upstreamContentType;

      const isServerSideFailure = upstreamResponse.status >= 500;
      if (isServerSideFailure || htmlPayload || retryableRpcError) {
        continue;
      }

      return new Response(responseBody, {
        status: upstreamResponse.status,
        headers: {
          "content-type": upstreamContentType,
          "cache-control": "no-store",
        },
      });
    } catch {
      // Try next upstream URL.
    }
  }

  return new Response(lastBody, {
    status: lastStatus,
    headers: {
      "content-type": lastContentType,
      "cache-control": "no-store",
    },
  });
};

export const POST = proxyRpc;
