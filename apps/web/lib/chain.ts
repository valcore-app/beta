"use client";

import { defineChain } from "viem";

export type ChainDefinitionInput = {
  chainId: number;
  label: string;
  networkKey: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeSymbol: string;
};

const normalizeText = (value: unknown) => {
  const normalized = String(value ?? "").trim();
  return normalized || "";
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const toNetworkSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "active-chain";

export const buildChain = (input: ChainDefinitionInput) => {
  const chainId = toPositiveInt(input.chainId, 0);
  if (chainId <= 0) {
    throw new Error("buildChain: chainId must be a positive integer");
  }
  const rpcUrl = normalizeText(input.rpcUrl);
  if (!rpcUrl) {
    throw new Error("buildChain: rpcUrl is required");
  }
  const explorerUrl = normalizeText(input.explorerUrl);
  if (!explorerUrl) {
    throw new Error("buildChain: explorerUrl is required");
  }
  const chainName = normalizeText(input.label);
  if (!chainName) {
    throw new Error("buildChain: label is required");
  }
  const nativeSymbol = normalizeText(input.nativeSymbol);
  if (!nativeSymbol) {
    throw new Error("buildChain: nativeSymbol is required");
  }
  const network = toNetworkSlug(input.networkKey || chainName);
  return defineChain({
    id: chainId,
    name: chainName,
    network,
    nativeCurrency: {
      name: nativeSymbol,
      symbol: nativeSymbol,
      decimals: 18,
    },
    testnet: true,
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "Explorer",
        url: explorerUrl,
      },
    },
  });
};
