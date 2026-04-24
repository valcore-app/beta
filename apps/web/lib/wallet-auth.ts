import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

export const WALLET_SESSION_COOKIE = "valcore_wallet_session";
export const WALLET_NONCE_COOKIE = "valcore_wallet_nonce";

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_NONCE_TTL_SECONDS = 10 * 60;
const walletAddressRegex = /^0x[a-f0-9]{40}$/;

const getWalletAuthSecret = () => {
  const secret = (process.env.WALLET_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "").trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("WALLET_AUTH_SECRET (or NEXTAUTH_SECRET) is required.");
    }
    return "dev-wallet-secret";
  }
  return secret;
};

const toPositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const signPayload = (payload: string) =>
  createHmac("sha256", getWalletAuthSecret()).update(payload).digest("base64url");

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

export const normalizeWalletAddress = (value: unknown) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return walletAddressRegex.test(normalized) ? normalized : null;
};

export const createWalletNonce = () => randomBytes(32).toString("hex");

export const encodeWalletSession = (address: string) => {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) return null;
  const ttlSeconds = toPositiveInt(
    process.env.WALLET_SESSION_TTL_SECONDS,
    DEFAULT_SESSION_TTL_SECONDS,
  );
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${normalized}.${expiresAt}`;
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
};

export const decodeWalletSession = (token: string | undefined | null) => {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [address, expiresAtRaw, signature] = parts;
  const normalized = normalizeWalletAddress(address);
  if (!normalized) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const payload = `${normalized}.${expiresAtRaw}`;
  const expected = signPayload(payload);
  if (!safeEqual(signature, expected)) return null;
  return { address: normalized, expiresAt };
};

export const readWalletSessionAddress = (request: NextRequest) => {
  const token = request.cookies.get(WALLET_SESSION_COOKIE)?.value ?? null;
  return decodeWalletSession(token)?.address ?? null;
};

export const walletSessionCookieOptions = () => ({
  httpOnly: true as const,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: toPositiveInt(process.env.WALLET_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
});

export const walletNonceCookieOptions = () => ({
  httpOnly: true as const,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: toPositiveInt(process.env.WALLET_NONCE_TTL_SECONDS, DEFAULT_NONCE_TTL_SECONDS),
});
