"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./api";

export type RuntimeProfile = {
  networkKey: string;
  label: string;
  chainType: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  nativeSymbol: string;
  nativeTokenAddress?: `0x${string}`;
  stablecoinSymbol: string;
  stablecoinName: string;
  stablecoinDecimals: number;
  stablecoinAddress?: `0x${string}`;
  leagueAddress?: `0x${string}`;
};

type RuntimeProfileResponse = {
  networkKey?: string | null;
  label?: string | null;
  chainType?: string | null;
  chainId?: number | string | null;
  rpcUrl?: string | null;
  explorerUrl?: string | null;
  nativeSymbol?: string | null;
  nativeTokenAddress?: string | null;
  stablecoin?: {
    symbol?: string | null;
    name?: string | null;
    decimals?: number | string | null;
    address?: string | null;
  } | null;
  contracts?: {
    leagueAddress?: string | null;
    stablecoinAddress?: string | null;
  } | null;
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const normalizeText = (value: unknown) => {
  const normalized = String(value ?? "").trim();
  return normalized || "";
};

const normalizeChainType = (value: unknown) => {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || "evm";
};

const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value);

const resolveRpcUrl = (value: unknown, chainType: string) => {
  if (chainType === "starknet") {
    const browserReadRpc = normalizeText(process.env.NEXT_PUBLIC_CHAIN_READ_RPC_URL);
    if (isHttpUrl(browserReadRpc) || browserReadRpc.startsWith("/")) {
      return browserReadRpc;
    }
  }

  const fromProfile = normalizeText(value);
  if (isHttpUrl(fromProfile)) return fromProfile;
  if (fromProfile.startsWith("/")) return fromProfile;
  throw new Error("rpcUrl is missing in runtime profile");
};

const normalizeAddress = (
  value: unknown,
  chainType: string,
): `0x${string}` | undefined => {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (chainType === "starknet") {
    if (!/^0x[a-fA-F0-9]{1,64}$/u.test(normalized)) return undefined;
    return normalized.toLowerCase() as `0x${string}`;
  }
  if (!/^0x[a-fA-F0-9]{40}$/u.test(normalized)) return undefined;
  return normalized as `0x${string}`;
};

const requireText = (value: unknown, label: string) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`${label} is missing in runtime profile`);
  }
  return normalized;
};

const requirePositiveInt = (value: unknown, label: string) => {
  const parsed = toPositiveInt(value, 0);
  if (parsed <= 0) {
    throw new Error(`${label} must be a positive integer in runtime profile`);
  }
  return parsed;
};

const mapResponse = (payload: RuntimeProfileResponse): RuntimeProfile => {
  const chainType = normalizeChainType(payload.chainType);
  return {
    networkKey: requireText(payload.networkKey, "networkKey"),
    label: requireText(payload.label, "label"),
    chainType,
    chainId: requirePositiveInt(payload.chainId, "chainId"),
    rpcUrl: resolveRpcUrl(payload.rpcUrl, chainType),
    explorerUrl: requireText(payload.explorerUrl, "explorerUrl"),
    nativeSymbol: requireText(payload.nativeSymbol, "nativeSymbol"),
    nativeTokenAddress: normalizeAddress(payload.nativeTokenAddress, chainType),
    stablecoinSymbol: requireText(payload.stablecoin?.symbol, "stablecoin.symbol"),
    stablecoinName: requireText(payload.stablecoin?.name, "stablecoin.name"),
    stablecoinDecimals: requirePositiveInt(payload.stablecoin?.decimals, "stablecoin.decimals"),
    stablecoinAddress:
      normalizeAddress(payload.stablecoin?.address, chainType) ??
      normalizeAddress(payload.contracts?.stablecoinAddress, chainType),
    leagueAddress: normalizeAddress(payload.contracts?.leagueAddress, chainType),
  };
};

export const fetchRuntimeProfile = async (): Promise<RuntimeProfile> => {
  const payload = await apiGet<RuntimeProfileResponse>("/runtime/profile");
  return mapResponse(payload ?? {});
};

export const useRuntimeProfile = () => {
  const query = useQuery({
    queryKey: ["runtime-profile"],
    queryFn: fetchRuntimeProfile,
    staleTime: 30_000,
    retry: 1,
  });

  return {
    ...query,
    profile: query.data ?? null,
  };
};




