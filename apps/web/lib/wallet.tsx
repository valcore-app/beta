"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import type { WalletClient } from "viem";
import {
  useAccount,
  useChainId,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { useRuntimeProfile } from "./runtime-profile";

type WalletStatus = "idle" | "connecting" | "connected" | "no-provider";

type WalletContextValue = {
  status: WalletStatus;
  address: string | null;
  chainId: number | null;
  isConnected: boolean;
  isCorrectNetwork: boolean;
  hasProvider: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  ensureChain: () => Promise<boolean>;
  getWalletClient: () => WalletClient | null;
  publicClient: ReturnType<typeof usePublicClient>;
  walletAuthStatus: "idle" | "signing" | "authenticated" | "error";
  walletSessionAddress: string | null;
  refreshWalletSession: (options?: { force?: boolean }) => Promise<boolean>;
  errorMessage: string | null;
};

const AUTH_RETRY_COOLDOWN_MS = 30_000;
const AUTH_ERROR_RESET_MS = 12_000;
const ADDRESS_STICKY_GRACE_MS = 5_000;
const toHexChainId = (value: number) => `0x${value.toString(16)}`;

let globalAuthInFlightAddress: string | null = null;
let globalAuthInFlightPromise: Promise<boolean> | null = null;
const globalLastAuthAttemptAt = new Map<string, number>();

export function useWallet(): WalletContextValue {
  const { profile } = useRuntimeProfile();
  if (!profile) {
    throw new Error("Runtime profile is not loaded");
  }

  const { address: wagmiAddress, status: accountStatus } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [hasProvider, setHasProvider] = useState(false);
  const [providerChecked, setProviderChecked] = useState(false);
  const [walletAuthStatus, setWalletAuthStatus] = useState<
    "idle" | "signing" | "authenticated" | "error"
  >("idle");
  const [walletSessionAddress, setWalletSessionAddress] = useState<string | null>(null);
  const [walletSessionResolved, setWalletSessionResolved] = useState(false);
  const authInFlightRef = useRef<string | null>(null);

  const [stickyAddress, setStickyAddress] = useState<string | null>(null);
  const stickyClearTimerRef = useRef<number | null>(null);

  const manualDisconnectRef = useRef(false);
  const [manualDisconnected, setManualDisconnected] = useState(false);
  const chainPrimeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setHasProvider(Boolean((window as Window & { ethereum?: unknown }).ethereum));
    setProviderChecked(true);
  }, []);

  const allowedChainIds = useMemo(() => new Set<number>([profile.chainId]), [profile.chainId]);

  const liveConnected = accountStatus === "connected" && Boolean(wagmiAddress);
  const liveAddress = !manualDisconnected && liveConnected ? wagmiAddress ?? null : null;
  const normalizedLiveAddress = liveAddress?.toLowerCase() ?? null;
  const sessionAddress = manualDisconnected ? null : walletSessionAddress;
  const displayAddress = liveAddress ?? sessionAddress ?? stickyAddress;

  const isConnected = Boolean(displayAddress);
  const isCorrectNetwork = !liveAddress ? true : (chainId ? allowedChainIds.has(chainId) : false);

  const status: WalletStatus = !providerChecked
    ? "connecting"
    : !hasProvider
      ? "no-provider"
      : isConnected
        ? "connected"
        : accountStatus === "connecting" || accountStatus === "reconnecting"
          ? "connecting"
          : "idle";

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (liveAddress) {
      if (stickyClearTimerRef.current) {
        window.clearTimeout(stickyClearTimerRef.current);
        stickyClearTimerRef.current = null;
      }
      if (stickyAddress !== liveAddress) {
        setStickyAddress(liveAddress);
      }
      return;
    }

    if (manualDisconnectRef.current || manualDisconnected || !hasProvider) {
      if (stickyClearTimerRef.current) {
        window.clearTimeout(stickyClearTimerRef.current);
        stickyClearTimerRef.current = null;
      }
      if (stickyAddress) {
        setStickyAddress(null);
      }
      return;
    }

    if (!stickyAddress || stickyClearTimerRef.current) return;

    stickyClearTimerRef.current = window.setTimeout(() => {
      stickyClearTimerRef.current = null;
      setStickyAddress(null);
    }, ADDRESS_STICKY_GRACE_MS);
  }, [hasProvider, liveAddress, manualDisconnected, stickyAddress]);

  useEffect(() => {
    return () => {
      if (stickyClearTimerRef.current) {
        window.clearTimeout(stickyClearTimerRef.current);
        stickyClearTimerRef.current = null;
      }
    };
  }, []);

  const fetchWalletSessionAddress = useCallback(async () => {
    try {
      const res = await fetch("/api/wallet/session", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setWalletSessionAddress(null);
        return null;
      }
      const payload = (await res.json()) as { walletAddress?: string | null };
      const normalized = payload.walletAddress?.toLowerCase() ?? null;
      if (manualDisconnectRef.current || manualDisconnected) {
        setWalletSessionAddress(null);
        return null;
      }
      setWalletSessionAddress(normalized);
      return normalized;
    } catch {
      setWalletSessionAddress(null);
      return null;
    } finally {
      setWalletSessionResolved(true);
    }
  }, [manualDisconnected]);

  useEffect(() => {
    void fetchWalletSessionAddress();
  }, [fetchWalletSessionAddress]);

  const connect = useCallback(async () => {
    manualDisconnectRef.current = false;
    setManualDisconnected(false);
    openConnectModal?.();
  }, [openConnectModal]);

  const refreshWalletSession = useCallback(async (options?: { force?: boolean }) => {
    if (!normalizedLiveAddress || !liveAddress) {
      setWalletAuthStatus("error");
      await connect();
      return false;
    }

    if (walletSessionAddress === normalizedLiveAddress) {
      setWalletAuthStatus("authenticated");
      return true;
    }

    if (!walletClient) {
      setWalletAuthStatus("error");
      await connect();
      return false;
    }

    const nowMs = Date.now();
    const force = options?.force === true;
    const lastAttemptAt = globalLastAuthAttemptAt.get(normalizedLiveAddress) ?? 0;
    if (!force && nowMs - lastAttemptAt < AUTH_RETRY_COOLDOWN_MS) {
      return false;
    }

    if (globalAuthInFlightAddress === normalizedLiveAddress && globalAuthInFlightPromise) {
      return globalAuthInFlightPromise;
    }

    if (authInFlightRef.current === normalizedLiveAddress) {
      return false;
    }

    authInFlightRef.current = normalizedLiveAddress;
    globalLastAuthAttemptAt.set(normalizedLiveAddress, nowMs);

    const runAuth = async () => {
      setWalletAuthStatus("signing");

      const nonceRes = await fetch("/api/wallet/nonce", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!nonceRes.ok) {
        setWalletAuthStatus("error");
        return false;
      }

      const noncePayload = (await nonceRes.json()) as { nonce?: string };
      const nonce = noncePayload.nonce?.trim();
      if (!nonce) {
        setWalletAuthStatus("error");
        return false;
      }

      const now = new Date();
      const expiration = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
      const host = typeof window !== "undefined" ? window.location.host : "localhost:3000";
      const message = new SiweMessage({
        domain: host,
        address: liveAddress,
        statement: "Sign in to Valcore",
        uri: origin,
        version: "1",
        chainId: chainId ?? profile.chainId,
        nonce,
        issuedAt: now.toISOString(),
        expirationTime: expiration.toISOString(),
      });
      const preparedMessage = message.prepareMessage();

      const signature = await walletClient.signMessage({
        account: liveAddress as `0x${string}`,
        message: preparedMessage,
      });

      const result = await fetch("/api/wallet/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: preparedMessage,
          signature,
        }),
      });

      if (!result.ok) {
        setWalletAuthStatus("error");
        return false;
      }

      const payload = (await result.json()) as { walletAddress?: string | null };
      setWalletSessionAddress(payload.walletAddress?.toLowerCase() ?? normalizedLiveAddress);
      setWalletSessionResolved(true);
      setWalletAuthStatus("authenticated");
      globalLastAuthAttemptAt.delete(normalizedLiveAddress);
      return true;
    };

    globalAuthInFlightAddress = normalizedLiveAddress;
    globalAuthInFlightPromise = runAuth();

    try {
      return await globalAuthInFlightPromise;
    } catch {
      setWalletAuthStatus("error");
      return false;
    } finally {
      if (globalAuthInFlightAddress === normalizedLiveAddress) {
        globalAuthInFlightAddress = null;
        globalAuthInFlightPromise = null;
      }
      if (authInFlightRef.current === normalizedLiveAddress) {
        authInFlightRef.current = null;
      }
    }
  }, [chainId, connect, liveAddress, normalizedLiveAddress, profile.chainId, walletClient, walletSessionAddress]);

  useEffect(() => {
    if (!walletSessionResolved) {
      return;
    }

    if (walletSessionAddress && (!normalizedLiveAddress || walletSessionAddress === normalizedLiveAddress)) {
      if (walletAuthStatus !== "authenticated") {
        setWalletAuthStatus("authenticated");
      }
      return;
    }

    if (walletAuthStatus !== "idle") {
      setWalletAuthStatus("idle");
    }
  }, [normalizedLiveAddress, walletAuthStatus, walletSessionAddress, walletSessionResolved]);

  useEffect(() => {
    if (walletAuthStatus !== "error") return;
    const timer = window.setTimeout(() => {
      setWalletAuthStatus("idle");
    }, AUTH_ERROR_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [walletAuthStatus]);

  const requestWalletRpc = useCallback(async (payload: unknown) => {
    const requester = walletClient as unknown as { request?: (args: unknown) => Promise<unknown> };
    if (!requester.request) return false;
    try {
      await requester.request(payload);
      return true;
    } catch {
      return false;
    }
  }, [walletClient]);

  const primeWalletChain = useCallback(async () => {
    if (!walletClient) return false;

    const chainKey = `${profile.chainId}:${profile.rpcUrl}:${profile.explorerUrl}:${profile.nativeSymbol}`;
    if (chainPrimeKeyRef.current === chainKey) {
      return true;
    }

    const primed = await requestWalletRpc({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: toHexChainId(profile.chainId),
          chainName: profile.label,
          rpcUrls: [profile.rpcUrl],
          blockExplorerUrls: [profile.explorerUrl],
          nativeCurrency: {
            name: profile.nativeSymbol,
            symbol: profile.nativeSymbol,
            decimals: 18,
          },
        },
      ],
    });

    if (primed) {
      chainPrimeKeyRef.current = chainKey;
    }

    return primed;
  }, [
    profile.chainId,
    profile.explorerUrl,
    profile.label,
    profile.nativeSymbol,
    profile.rpcUrl,
    requestWalletRpc,
    walletClient,
  ]);

  const ensureChain = useCallback(async () => {
    if (!liveAddress) {
      await connect();
      return false;
    }

    if (!walletClient) {
      await connect();
      return false;
    }

    await primeWalletChain();

    if (chainId && allowedChainIds.has(chainId)) {
      return true;
    }

    if (switchChainAsync) {
      try {
        await switchChainAsync({ chainId: profile.chainId });
        return true;
      } catch {
        // fall through to raw wallet request
      }
    }

    const switched = await requestWalletRpc({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(profile.chainId) }],
    });

    return switched;
  }, [
    allowedChainIds,
    chainId,
    connect,
    liveAddress,
    primeWalletChain,
    profile.chainId,
    requestWalletRpc,
    switchChainAsync,
    walletClient,
  ]);

  const getWalletClient = useCallback(() => walletClient ?? null, [walletClient]);

  const disconnectWallet = useCallback(() => {
    manualDisconnectRef.current = true;
    setManualDisconnected(true);

    if (stickyClearTimerRef.current) {
      window.clearTimeout(stickyClearTimerRef.current);
      stickyClearTimerRef.current = null;
    }

    setStickyAddress(null);
    setWalletSessionAddress(null);
    setWalletSessionResolved(true);
    setWalletAuthStatus("idle");

    globalAuthInFlightAddress = null;
    globalAuthInFlightPromise = null;
    chainPrimeKeyRef.current = null;

    void fetch("/api/wallet/session", {
      method: "DELETE",
      credentials: "same-origin",
    }).catch(() => {});

    disconnect();
  }, [disconnect]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      address: displayAddress,
      chainId: liveAddress ? chainId ?? null : null,
      isConnected,
      isCorrectNetwork,
      hasProvider,
      connect,
      disconnect: disconnectWallet,
      ensureChain,
      getWalletClient,
      publicClient,
      walletAuthStatus,
      walletSessionAddress,
      refreshWalletSession,
      errorMessage: null,
    }),
    [
      chainId,
      connect,
      disconnectWallet,
      displayAddress,
      ensureChain,
      getWalletClient,
      hasProvider,
      isConnected,
      isCorrectNetwork,
      liveAddress,
      publicClient,
      refreshWalletSession,
      status,
      walletAuthStatus,
      walletSessionAddress,
    ],
  );

  return value;
}
