import { NextRequest, NextResponse } from "next/server";
import { SiweMessage } from "siwe";
import {
  WALLET_NONCE_COOKIE,
  WALLET_SESSION_COOKIE,
  decodeWalletSession,
  encodeWalletSession,
  normalizeWalletAddress,
  walletNonceCookieOptions,
  walletSessionCookieOptions,
} from "../../../../lib/wallet-auth";

const getExpectedHost = (request: NextRequest) => {
  const configured = process.env.NEXTAUTH_URL;
  if (configured) {
    try {
      return new URL(configured).host;
    } catch {
      // Fall through to request host.
    }
  }
  return request.nextUrl.host;
};

const getChainType = () =>
  String(process.env.CHAIN_TYPE ?? "evm").trim().toLowerCase() === "starknet" ? "starknet" : "evm";

type SessionPayload = {
  message?: string;
  signature?: string;
  address?: string;
  nonce?: string;
};

const shouldUseStarknetFlow = (payload: SessionPayload, configuredChainType: "evm" | "starknet") => {
  const hasEvmFields = Boolean(payload.message) || Boolean(payload.signature);
  const hasStarkFields = Boolean(payload.address) || Boolean(payload.nonce);
  if (hasEvmFields) return false;
  if (hasStarkFields) return true;
  return configuredChainType === "starknet";
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

const clearWalletCookies = (response: NextResponse) => {
  response.cookies.set(WALLET_NONCE_COOKIE, "", {
    ...walletNonceCookieOptions(),
    maxAge: 0,
  });
  response.cookies.set(WALLET_SESSION_COOKIE, "", {
    ...walletSessionCookieOptions(),
    maxAge: 0,
  });
};

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get(WALLET_SESSION_COOKIE)?.value ?? null;
  const address = decodeWalletSession(sessionToken)?.address ?? null;
  return NextResponse.json({ walletAddress: address });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const nonce = request.cookies.get(WALLET_NONCE_COOKIE)?.value ?? null;
  if (!nonce) {
    return NextResponse.json({ error: "Missing nonce" }, { status: 401 });
  }

  let payload: SessionPayload = {};
  try {
    payload = (await request.json()) as SessionPayload;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const configuredChainType = getChainType();
  if (shouldUseStarknetFlow(payload, configuredChainType)) {
    const normalizedAddress = normalizeWalletAddress(payload.address ?? "", "starknet");
    const bodyNonce = String(payload.nonce ?? "").trim();

    if (!normalizedAddress) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }
    if (!bodyNonce || bodyNonce !== nonce) {
      return NextResponse.json({ error: "Invalid nonce" }, { status: 401 });
    }

    const token = encodeWalletSession(normalizedAddress);
    if (!token) {
      return NextResponse.json({ error: "Session encode failed" }, { status: 500 });
    }

    const response = NextResponse.json({ ok: true, walletAddress: normalizedAddress });
    response.cookies.set(WALLET_SESSION_COOKIE, token, walletSessionCookieOptions());
    response.cookies.set(WALLET_NONCE_COOKIE, "", { ...walletNonceCookieOptions(), maxAge: 0 });
    return response;
  }

  const message = payload.message ?? "";
  const signature = payload.signature ?? "";
  if (!message || !signature) {
    return NextResponse.json({ error: "Missing signature payload" }, { status: 400 });
  }

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(message);
  } catch {
    return NextResponse.json({ error: "Invalid SIWE message" }, { status: 400 });
  }

  const expectedHost = getExpectedHost(request);
  let verifyResult;
  try {
    verifyResult = await siwe.verify({
      signature,
      domain: expectedHost,
      nonce,
    });
  } catch {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
  }

  const verifiedAddress = normalizeWalletAddress(verifyResult.data?.address ?? "", "evm");
  if (!verifyResult.success || !verifiedAddress) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = encodeWalletSession(verifiedAddress);
  if (!token) {
    return NextResponse.json({ error: "Session encode failed" }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, walletAddress: verifiedAddress });
  response.cookies.set(WALLET_SESSION_COOKIE, token, walletSessionCookieOptions());
  response.cookies.set(WALLET_NONCE_COOKIE, "", { ...walletNonceCookieOptions(), maxAge: 0 });
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true });
  clearWalletCookies(response);
  return response;
}
