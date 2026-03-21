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
import {
  connectStarknetWallet,
  disconnectStarknetWallet,
  getConnectedStarknetAddress,
  getStarknetInjectedWallet,
  hasStarknetProvider,
  normalizeStarknetAddress,
  tryReconnectStarknetWallet,
  type StarknetInjectedWallet,
} from "./starknet-wallet";

type WalletStatus = "idle" | "connecting" | "connected" | "no-provider";

type WalletContextValue = {
  status: WalletStatus;
  address: string | null;
  chainId: number | null;
  chainType: string;
  isConnected: boolean;
  isCorrectNetwork: boolean;
  hasProvider: boolean;
  walletSessionResolved: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  ensureChain: () => Promise<boolean>;
  getWalletClient: () => WalletClient | null;
  getStarknetWallet: () => StarknetInjectedWallet | null;
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
const STARKNET_MAIN_CHAIN_ID = "0x534e5f4d41494e";
const STARKNET_SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";

const parseStarknetChainId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = raw.startsWith("0x") ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
};

const normalizeStarknetChainHex = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === "sn_main" || lowered === "sn_mainnet") return STARKNET_MAIN_CHAIN_ID;
  if (lowered === "sn_sepolia") return STARKNET_SEPOLIA_CHAIN_ID;
  if (lowered.startsWith("0x")) return lowered;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return `0x${Math.trunc(parsed).toString(16)}`;
};

const resolveExpectedStarknetChainHex = (networkKey: string) => {
  const key = String(networkKey ?? "").toLowerCase();
  if (key.includes("mainnet") || key.endsWith("_main")) return STARKNET_MAIN_CHAIN_ID;
  return STARKNET_SEPOLIA_CHAIN_ID;
};

const normalizeWalletAddress = (value: unknown, evm: boolean): string | null => {
  if (evm) {
    const normalized = String(value ?? "").trim().toLowerCase();
    return normalized || null;
  }
  return normalizeStarknetAddress(value);
};

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

  const [starknetAddress, setStarknetAddress] = useState<string | null>(null);
  const [starknetChainId, setStarknetChainId] = useState<number | null>(null);

  const manualDisconnectRef = useRef(false);
  const [manualDisconnected, setManualDisconnected] = useState(false);
  const chainPrimeKeyRef = useRef<string | null>(null);

  const isEvmWalletAuth = profile.chainType.toLowerCase() === "evm";

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isEvmWalletAuth) {
      setHasProvider(Boolean((window as Window & { ethereum?: unknown }).ethereum));
      setProviderChecked(true);
      return;
    }

    const has = hasStarknetProvider();
    setHasProvider(has);
    setProviderChecked(true);
    const connected = getConnectedStarknetAddress();
    setStarknetAddress(connected);
    const wallet = getStarknetInjectedWallet({ targetAddress: connected });
    setStarknetChainId(parseStarknetChainId(wallet?.provider.chainId));
  }, [isEvmWalletAuth]);

  useEffect(() => {
    if (typeof window === "undefined" || isEvmWalletAuth) return;

    const sync = () => {
      if (manualDisconnectRef.current || manualDisconnected) {
        setStarknetAddress((prev) => (prev === null ? prev : null));
        setStarknetChainId((prev) => (prev === null ? prev : null));
        setHasProvider(hasStarknetProvider());
        setProviderChecked(true);
        return;
      }

      const connected = getConnectedStarknetAddress();
      setStarknetAddress((prev) => (prev === connected ? prev : connected));
      const wallet = getStarknetInjectedWallet({ targetAddress: connected });
      const nextChainId = parseStarknetChainId(wallet?.provider.chainId);
      setStarknetChainId((prev) => (prev === nextChainId ? prev : nextChainId));
      setHasProvider(hasStarknetProvider());
      setProviderChecked(true);
    };

    sync();
    const timer = window.setInterval(sync, 1500);
    return () => window.clearInterval(timer);
  }, [isEvmWalletAuth, manualDisconnected]);

  const allowedChainIds = useMemo(() => new Set<number>([profile.chainId]), [profile.chainId]);

  const evmLiveConnected = accountStatus === "connected" && Boolean(wagmiAddress);
  const evmLiveAddress = !manualDisconnected && evmLiveConnected ? wagmiAddress ?? null : null;
  const starkLiveAddress = !manualDisconnected ? starknetAddress : null;
  const liveAddress = isEvmWalletAuth ? evmLiveAddress : starkLiveAddress;
  const normalizedLiveAddress = normalizeWalletAddress(liveAddress, isEvmWalletAuth);
  const sessionAddress = manualDisconnected ? null : walletSessionAddress;
  const displayAddress = liveAddress ?? sessionAddress ?? stickyAddress;

  const isConnected = Boolean(displayAddress);
  const isCorrectNetwork = !liveAddress
    ? true
    : isEvmWalletAuth
      ? (chainId ? allowedChainIds.has(chainId) : false)
      : true;

  const status: WalletStatus = !providerChecked
    ? "connecting"
    : !hasProvider
      ? "no-provider"
      : isConnected
        ? "connected"
        : isEvmWalletAuth && (accountStatus === "connecting" || accountStatus === "reconnecting")
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
      const normalized = normalizeWalletAddress(payload.walletAddress, isEvmWalletAuth);
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
  }, [isEvmWalletAuth, manualDisconnected]);

  useEffect(() => {
    void fetchWalletSessionAddress();
  }, [fetchWalletSessionAddress]);

  const establishStarknetSession = useCallback(async (walletAddress: string) => {
    const normalized = normalizeStarknetAddress(walletAddress);
    if (!normalized) return false;
    try {
      const nonceRes = await fetch("/api/wallet/nonce", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!nonceRes.ok) return false;
      const noncePayload = (await nonceRes.json()) as { nonce?: string };
      const nonce = noncePayload.nonce?.trim();
      if (!nonce) return false;

      const sessionRes = await fetch("/api/wallet/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: normalized,
          nonce,
        }),
      });
      if (!sessionRes.ok) return false;
      setWalletSessionAddress(normalized);
      setWalletSessionResolved(true);
      setWalletAuthStatus("authenticated");
      return true;
    } catch {
      return false;
    }
  }, []);

  const connect = useCallback(async () => {
    manualDisconnectRef.current = false;
    setManualDisconnected(false);

    if (!isEvmWalletAuth) {
      const { address } = await connectStarknetWallet();
      const normalized = normalizeStarknetAddress(address);
      if (!normalized) {
        throw new Error("Connected Starknet wallet returned invalid address");
      }
      setStarknetAddress(normalized);
      await establishStarknetSession(normalized);
      return;
    }

    openConnectModal?.();
  }, [establishStarknetSession, isEvmWalletAuth, openConnectModal]);

  const refreshWalletSession = useCallback(async (options?: { force?: boolean }) => {
    if (!normalizedLiveAddress || !liveAddress) {
      setWalletAuthStatus("error");
      await connect();

      if (!isEvmWalletAuth) {
        const connectedAddress = getConnectedStarknetAddress();
        const postConnectWallet = getStarknetInjectedWallet({
          targetAddress: connectedAddress,
          requireSigner: false,
        });
        const postConnectAddress = normalizeStarknetAddress(
          postConnectWallet?.provider.account?.address ??
            postConnectWallet?.provider.selectedAddress ??
            connectedAddress ??
            "",
        );

        if (postConnectAddress) {
          setStarknetAddress(postConnectAddress as `0x${string}`);
          setStarknetChainId(parseStarknetChainId(postConnectWallet?.provider.chainId));
          await establishStarknetSession(postConnectAddress);

          const expected = resolveExpectedStarknetChainHex(profile.networkKey);
          const connected = normalizeStarknetChainHex(postConnectWallet?.provider.chainId);
          if (connected && connected !== expected) {
            return false;
          }
          return true;
        }
      }

      return false;
    }

    if (walletSessionAddress === normalizedLiveAddress) {
      setWalletAuthStatus("authenticated");
      return true;
    }

    if (isEvmWalletAuth && !walletClient) {
      setWalletAuthStatus("error");
      await connect();

      if (!isEvmWalletAuth) {
        const connectedAddress = getConnectedStarknetAddress();
        const postConnectWallet = getStarknetInjectedWallet({
          targetAddress: connectedAddress,
          requireSigner: false,
        });
        const postConnectAddress = normalizeStarknetAddress(
          postConnectWallet?.provider.account?.address ??
            postConnectWallet?.provider.selectedAddress ??
            connectedAddress ??
            "",
        );

        if (postConnectAddress) {
          setStarknetAddress(postConnectAddress as `0x${string}`);
          setStarknetChainId(parseStarknetChainId(postConnectWallet?.provider.chainId));
          await establishStarknetSession(postConnectAddress);

          const expected = resolveExpectedStarknetChainHex(profile.networkKey);
          const connected = normalizeStarknetChainHex(postConnectWallet?.provider.chainId);
          if (connected && connected !== expected) {
            return false;
          }
          return true;
        }
      }

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

      let result: Response;

      if (!isEvmWalletAuth) {
        result = await fetch("/api/wallet/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: normalizedLiveAddress,
            nonce,
          }),
        });
      } else {
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

        const signature = await walletClient!.signMessage({
          account: liveAddress as `0x${string}`,
          message: preparedMessage,
        });

        result = await fetch("/api/wallet/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: preparedMessage,
            signature,
          }),
        });
      }

      if (!result.ok) {
        setWalletAuthStatus("error");
        return false;
      }

      const payload = (await result.json()) as { walletAddress?: string | null };
      setWalletSessionAddress(normalizeWalletAddress(payload.walletAddress, isEvmWalletAuth) ?? normalizedLiveAddress);
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
  }, [chainId, connect, isEvmWalletAuth, liveAddress, normalizedLiveAddress, profile.chainId, walletClient, walletSessionAddress]);

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
    if (isEvmWalletAuth) return;
    if (!walletSessionResolved) return;
    if (!normalizedLiveAddress || !liveAddress) return;
    if (walletSessionAddress === normalizedLiveAddress) {
      if (walletAuthStatus !== "authenticated") {
        setWalletAuthStatus("authenticated");
      }
      return;
    }
    if (walletAuthStatus === "signing") return;
    void refreshWalletSession();
  }, [
    isEvmWalletAuth,
    liveAddress,
    normalizedLiveAddress,
    refreshWalletSession,
    walletAuthStatus,
    walletSessionAddress,
    walletSessionResolved,
  ]);

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
    if (!isEvmWalletAuth) return true;
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
    isEvmWalletAuth,
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
      if (!isEvmWalletAuth) {
        const restored = await tryReconnectStarknetWallet();
        if (restored) {
          manualDisconnectRef.current = false;
          setManualDisconnected(false);
          setStarknetAddress(restored.address);
          setStarknetChainId(parseStarknetChainId(restored.wallet.provider.chainId));
          await establishStarknetSession(restored.address);

          const expected = resolveExpectedStarknetChainHex(profile.networkKey);
          const connected = normalizeStarknetChainHex(restored.wallet.provider.chainId);
          if (connected && connected !== expected) {
            return false;
          }
          return true;
        }
      }
      await connect();

      if (!isEvmWalletAuth) {
        const connectedAddress = getConnectedStarknetAddress();
        const postConnectWallet = getStarknetInjectedWallet({
          targetAddress: connectedAddress,
          requireSigner: false,
        });
        const postConnectAddress = normalizeStarknetAddress(
          postConnectWallet?.provider.account?.address ??
            postConnectWallet?.provider.selectedAddress ??
            connectedAddress ??
            "",
        );

        if (postConnectAddress) {
          setStarknetAddress(postConnectAddress as `0x${string}`);
          setStarknetChainId(parseStarknetChainId(postConnectWallet?.provider.chainId));
          await establishStarknetSession(postConnectAddress);

          const expected = resolveExpectedStarknetChainHex(profile.networkKey);
          const connected = normalizeStarknetChainHex(postConnectWallet?.provider.chainId);
          if (connected && connected !== expected) {
            return false;
          }
          return true;
        }
      }

      return false;
    }

    if (!isEvmWalletAuth) {
      let wallet = getStarknetInjectedWallet({
        targetAddress: normalizedLiveAddress,
        requireSigner: false,
      });

      if (!wallet) {
        const restored = await tryReconnectStarknetWallet();
        if (restored) {
          manualDisconnectRef.current = false;
          setManualDisconnected(false);
          setStarknetAddress(restored.address);
          setStarknetChainId(parseStarknetChainId(restored.wallet.provider.chainId));
          await establishStarknetSession(restored.address);
          wallet = getStarknetInjectedWallet({
            targetAddress: restored.address,
            requireSigner: false,
          });
        }
      }

      if (!wallet) {
        try {
          const connected = await connectStarknetWallet();
          manualDisconnectRef.current = false;
          setManualDisconnected(false);
          setStarknetAddress(connected.address);
          setStarknetChainId(parseStarknetChainId(connected.wallet.provider.chainId));
          await establishStarknetSession(connected.address);
          wallet = getStarknetInjectedWallet({
            targetAddress: connected.address,
            requireSigner: false,
          });
        } catch {
          return false;
        }
      }

      if (!wallet) {
        return false;
      }

      let providerAddress = normalizeStarknetAddress(
        wallet.provider.account?.address ?? wallet.provider.selectedAddress ?? "",
      );

      if (!providerAddress) {
        try {
          const connected = await connectStarknetWallet();
          manualDisconnectRef.current = false;
          setManualDisconnected(false);
          setStarknetAddress(connected.address);
          setStarknetChainId(parseStarknetChainId(connected.wallet.provider.chainId));
          await establishStarknetSession(connected.address);
          wallet =
            getStarknetInjectedWallet({
              targetAddress: connected.address,
              requireSigner: false,
            }) ?? connected.wallet;
          providerAddress = normalizeStarknetAddress(
            wallet.provider.account?.address ?? wallet.provider.selectedAddress ?? "",
          );
        } catch {
          return false;
        }
      }

      if (!providerAddress) {
        return false;
      }

      if (!normalizedLiveAddress || providerAddress !== normalizedLiveAddress) {
        setStarknetAddress(providerAddress as `0x${string}`);
        await establishStarknetSession(providerAddress);
      }

      const connectedChain = normalizeStarknetChainHex(wallet.provider.chainId);
      const expected = resolveExpectedStarknetChainHex(profile.networkKey);
      if (connectedChain && connectedChain !== expected) {
        return false;
      }
      return true;
    }

    if (!walletClient) {
      await connect();

      if (!isEvmWalletAuth) {
        const connectedAddress = getConnectedStarknetAddress();
        const postConnectWallet = getStarknetInjectedWallet({
          targetAddress: connectedAddress,
          requireSigner: false,
        });
        const postConnectAddress = normalizeStarknetAddress(
          postConnectWallet?.provider.account?.address ??
            postConnectWallet?.provider.selectedAddress ??
            connectedAddress ??
            "",
        );

        if (postConnectAddress) {
          setStarknetAddress(postConnectAddress as `0x${string}`);
          setStarknetChainId(parseStarknetChainId(postConnectWallet?.provider.chainId));
          await establishStarknetSession(postConnectAddress);

          const expected = resolveExpectedStarknetChainHex(profile.networkKey);
          const connected = normalizeStarknetChainHex(postConnectWallet?.provider.chainId);
          if (connected && connected !== expected) {
            return false;
          }
          return true;
        }
      }

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
    establishStarknetSession,
    isEvmWalletAuth,
    liveAddress,
    normalizedLiveAddress,
    primeWalletChain,
    profile.chainId,
    profile.networkKey,
    requestWalletRpc,
    switchChainAsync,
    walletClient,
  ]);

  const getWalletClient = useCallback(() => (isEvmWalletAuth ? walletClient ?? null : null), [isEvmWalletAuth, walletClient]);

  const getStarknetWallet = useCallback(() => {
    if (isEvmWalletAuth) return null;
    return getStarknetInjectedWallet({
      targetAddress: normalizedLiveAddress ?? displayAddress,
      requireSigner: false,
    });
  }, [displayAddress, isEvmWalletAuth, normalizedLiveAddress]);

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
    setStarknetAddress(null);

    globalAuthInFlightAddress = null;
    globalAuthInFlightPromise = null;
    chainPrimeKeyRef.current = null;

    void fetch("/api/wallet/session", {
      method: "DELETE",
      credentials: "same-origin",
    }).catch(() => {});

    if (isEvmWalletAuth) {
      disconnect();
      return;
    }

    void disconnectStarknetWallet().catch(() => {});
  }, [disconnect, isEvmWalletAuth]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      address: displayAddress,
      chainId: liveAddress
        ? (isEvmWalletAuth ? chainId ?? null : starknetChainId ?? profile.chainId ?? null)
        : null,
      chainType: profile.chainType,
      isConnected,
      isCorrectNetwork,
      hasProvider,
      walletSessionResolved,
      connect,
      disconnect: disconnectWallet,
      ensureChain,
      getWalletClient,
      getStarknetWallet,
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
      getStarknetWallet,
      hasProvider,
      isConnected,
      isCorrectNetwork,
      isEvmWalletAuth,
      liveAddress,
      profile.chainId,
      profile.chainType,
      publicClient,
      refreshWalletSession,
      starknetChainId,
      status,
      walletAuthStatus,
      walletSessionAddress,
      walletSessionResolved,
    ],
  );

  return value;
}



























