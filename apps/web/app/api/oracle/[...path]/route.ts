import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, authRuntime } from "../../../../lib/auth";
import { readWalletSessionAddress } from "../../../../lib/wallet-auth";

const DEFAULT_ORACLE_URL = process.env.NEXT_PUBLIC_ORACLE_URL ?? "http://localhost:3101";
const ORACLE_BASE_URL = process.env.ORACLE_INTERNAL_URL ?? DEFAULT_ORACLE_URL;
const ORACLE_ADMIN_API_KEY = process.env.ORACLE_ADMIN_API_KEY ?? "";
const ORACLE_STRATEGIST_API_KEY = process.env.ORACLE_STRATEGIST_API_KEY ?? "";
const MAX_PROXY_BODY_BYTES = 1_000_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length"]);
const isLineupIntentActionPath = (path: string) => /^\/lineups\/intents\/[^/]+\/(submit|cancel)$/.test(path);
const isPlaywrightTestMode = process.env.PLAYWRIGHT_TEST === "1";

const isAdminPath = (path: string) => path.startsWith("/admin/");

const isStrategistApiPath = (method: string, path: string) =>
  method === "POST" &&
  (
    path === "/lineups/sync" ||
    path === "/lineups/intents" ||
    isLineupIntentActionPath(path) ||
    path === "/faucet" ||
    path === "/strategists/profile" ||
    path === "/strategists/profile/nonce" ||
    path === "/errors/ingest"
  );

const isWalletSessionRequiredPath = (method: string, path: string) =>
  method === "POST" &&
  (
    path === "/lineups/sync" ||
    path === "/lineups/intents" ||
    isLineupIntentActionPath(path) ||
    path === "/faucet"
  );

const isAddressBoundPath = (path: string) =>
  path === "/lineups/sync" ||
  path === "/lineups/intents" ||
  isLineupIntentActionPath(path) ||
  path === "/faucet";

const readAddressFromStrategistPayload = (path: string, payload: { address?: string; addressHint?: string } | null) => {
  if (!payload) return null;
  if (path === "/lineups/sync") {
    return payload.addressHint ?? null;
  }
  return payload.address ?? null;
};

const normalizePath = (segments: string[] | undefined) => {
  const safe = (segments ?? [])
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (safe.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return `/${safe.join("/")}`;
};

const getExpectedHost = (request: NextRequest) => {
  const configured = process.env.NEXTAUTH_URL;
  if (configured) {
    try {
      return new URL(configured).host;
    } catch {
      // Fall through.
    }
  }
  return request.nextUrl.host;
};

const buildAllowedHosts = (request: NextRequest) => {
  const allowed = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized) {
      allowed.add(normalized);
    }
  };

  push(getExpectedHost(request));
  push(request.nextUrl.host);
  push(request.headers.get("host"));

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const first = forwardedHost.split(",")[0]?.trim();
    push(first);
  }

  return allowed;
};

const sameOrigin = (request: NextRequest) => {
  const origin = request.headers.get("origin");
  if (!origin) {
    const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase() ?? "";
    if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
      return false;
    }
    return true;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  return buildAllowedHosts(request).has(originHost);
};

const createForwardHeaders = (
  request: NextRequest,
  path: string,
  adminPath: boolean,
  strategistApiPath: boolean,
) => {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  const accept = request.headers.get("accept");

  if (contentType) headers.set("content-type", contentType);
  if (accept) headers.set("accept", accept);

  if (adminPath && ORACLE_ADMIN_API_KEY) {
    headers.set("x-admin-api-key", ORACLE_ADMIN_API_KEY);
  }
  if (strategistApiPath && ORACLE_STRATEGIST_API_KEY) {
    headers.set("x-strategist-api-key", ORACLE_STRATEGIST_API_KEY);
  }
  if (strategistApiPath || path === "/errors/ingest") {
    const walletSessionAddress = readWalletSessionAddress(request);
    if (walletSessionAddress) {
      headers.set("x-wallet-session-address", walletSessionAddress);
    }
  }

  return headers;
};

const createResponseHeaders = (upstream: Response) => {
  const headers = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
    headers.set(key, value);
  }
  return headers;
};

const buildPlaywrightRuntimeProfile = () => {
  const chainId = Number(process.env.CHAIN_ID ?? process.env.NEXT_PUBLIC_CHAIN_ID ?? "43113");
  const stablecoinDecimals = Number(process.env.STABLECOIN_DECIMALS ?? "6");
  const chainIdSafe = Number.isFinite(chainId) && chainId > 0 ? Math.floor(chainId) : 43113;
  const stablecoinDecimalsSafe =
    Number.isFinite(stablecoinDecimals) && stablecoinDecimals > 0
      ? Math.floor(stablecoinDecimals)
      : 6;
  return {
    networkKey: process.env.CHAIN_KEY ?? process.env.ACTIVE_NETWORK_KEY ?? "chain_testnet",
    label: process.env.CHAIN_LABEL ?? "Chain Testnet",
    chainType: (process.env.CHAIN_TYPE ?? "evm").toLowerCase(),
    chainId: chainIdSafe,
    rpcUrl:
      process.env.CHAIN_RPC_URL ??
      process.env.NEXT_PUBLIC_CHAIN_READ_RPC_URL ??
      "http://127.0.0.1:8545",
    explorerUrl: process.env.CHAIN_EXPLORER_URL ?? process.env.EXPLORER_URL ?? "",
    nativeSymbol: process.env.CHAIN_NATIVE_SYMBOL ?? process.env.NATIVE_SYMBOL ?? "NATIVE",
    nativeTokenAddress: process.env.CHAIN_NATIVE_TOKEN_ADDRESS ?? process.env.NEXT_PUBLIC_STARKNET_NATIVE_TOKEN_ADDRESS ?? null,
    stablecoin: {
      symbol: process.env.STABLECOIN_SYMBOL ?? "USDT",
      name: process.env.STABLECOIN_NAME ?? "Tether",
      decimals: stablecoinDecimalsSafe,
      address: process.env.STABLECOIN_ADDRESS ?? null,
    },
    contracts: {
      leagueAddress: process.env.VALCORE_CONTRACT_ADDRESS ?? null,
      stablecoinAddress: process.env.STABLECOIN_ADDRESS ?? null,
    },
  };
};

async function proxy(request: NextRequest, params: { path: string[] }) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  const path = normalizePath(params.path);
  if (!path || path === "/") {
    return NextResponse.json({ error: "Path required" }, { status: 400 });
  }

  if (isPlaywrightTestMode && path === "/runtime/profile" && method === "GET") {
    return NextResponse.json(buildPlaywrightRuntimeProfile(), { status: 200 });
  }

  const adminPath = isAdminPath(path);
  const strategistApiPath = isStrategistApiPath(method, path);
  const strategistAuthPath = isWalletSessionRequiredPath(method, path);

  let requestBody: string | undefined;
  if (method === "POST") {
    const contentLengthRaw = request.headers.get("content-length");
    if (contentLengthRaw) {
      const contentLength = Number(contentLengthRaw);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        return NextResponse.json({ error: "Invalid Content-Length" }, { status: 400 });
      }
      if (contentLength > MAX_PROXY_BODY_BYTES) {
        return NextResponse.json({ error: "Payload too large" }, { status: 413 });
      }
    }
    requestBody = await request.text();
    const payloadBytes = new TextEncoder().encode(requestBody).byteLength;
    if (payloadBytes > MAX_PROXY_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
  }

  let session:
    | null
    | {
        user?: {
          isOpsAdmin?: boolean;
        } | null;
      } = null;

  if (adminPath) {
    if (!authRuntime.hasDatabase || !authRuntime.hasProviders) {
      return NextResponse.json({ error: "Ops auth is not configured" }, { status: 503 });
    }
    session = await getServerSession(authOptions);
    const isAdmin = Boolean(session?.user && session.user.isOpsAdmin);
    if (!isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!sameOrigin(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (process.env.NODE_ENV === "production" && !ORACLE_ADMIN_API_KEY) {
      return NextResponse.json({ error: "Ops proxy misconfigured" }, { status: 500 });
    }
  }

  if (strategistApiPath && !sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (strategistAuthPath) {
    const walletSessionAddress = readWalletSessionAddress(request);
    let isAdmin = false;
    if (!walletSessionAddress) {
      if (authRuntime.hasDatabase && authRuntime.hasProviders) {
        session = session ?? (await getServerSession(authOptions));
        isAdmin = Boolean(session?.user?.isOpsAdmin);
      }
    }

    if (!isAdmin && !walletSessionAddress) {
      return NextResponse.json({ error: "Wallet signature required" }, { status: 401 });
    }

    if (isAddressBoundPath(path) && !isAdmin) {
      let payload: { address?: string; addressHint?: string } | null = null;
      try {
        payload = requestBody
          ? (JSON.parse(requestBody) as { address?: string; addressHint?: string })
          : null;
      } catch {
        return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
      }
      const requestedAddressRaw = readAddressFromStrategistPayload(path, payload);
      const requestedAddress = requestedAddressRaw?.toLowerCase() ?? null;
      if (!requestedAddress || requestedAddress !== walletSessionAddress) {
        return NextResponse.json({ error: "Wallet/session mismatch" }, { status: 403 });
      }
    }
  }

  const target = new URL(path, ORACLE_BASE_URL);
  target.search = request.nextUrl.search;

  const init: RequestInit = {
    method,
    headers: createForwardHeaders(request, path, adminPath, strategistApiPath),
    cache: "no-store",
  };

  if (method === "POST") {
    init.body = requestBody ?? "";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return NextResponse.json({ error: "Oracle unavailable" }, { status: 502 });
  }

  const headers = createResponseHeaders(upstream);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const params = await context.params;
  return proxy(request, params);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const params = await context.params;
  return proxy(request, params);
}




