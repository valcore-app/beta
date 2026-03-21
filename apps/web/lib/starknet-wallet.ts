"use client";

export type StarknetInjectedWallet = {
  id: "argentx" | "braavos" | "ready" | "starknet";
  label: string;
  provider: {
    id?: string;
    name?: string;
    isReady?: boolean;
    isConnected?: boolean;
    selectedAddress?: string;
    chainId?: string | number;
    account?: {
      address?: string;
      execute?: (calls: unknown) => Promise<{ transaction_hash?: string }>;
      signMessage?: (typedData: unknown) => Promise<unknown>;
    };
    enable?: (options?: unknown) => Promise<string[]>;
    request?: (payload: { type: string; params?: unknown }) => Promise<unknown>;
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    off?: (event: string, handler: (...args: unknown[]) => void) => void;
    disconnect?: () => Promise<void> | void;
  };
};

const PREFERRED_WALLET_KEY = "valcore:starknet-wallet-id";

export const normalizeStarknetAddress = (value: unknown) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[a-f0-9]{1,64}$/u.test(prefixed)) return null;
  try {
    // Canonical felt-like address form: no leading zero padding, stable comparisons.
    return `0x${BigInt(prefixed).toString(16)}` as `0x${string}`;
  } catch {
    return null;
  }
};

const inferWalletIdentity = (
  provider: StarknetInjectedWallet["provider"],
  fallbackId: StarknetInjectedWallet["id"],
  fallbackLabel: string,
) => {
  const rawName = String(provider.name ?? provider.id ?? fallbackLabel).trim();
  const normalized = rawName.toLowerCase();
  if (provider.isReady || normalized.includes("ready")) {
    return { id: "ready" as const, label: "Ready" };
  }
  if (normalized.includes("argent")) {
    return { id: "argentx" as const, label: "Argent X" };
  }
  if (normalized.includes("braavos")) {
    return { id: "braavos" as const, label: "Braavos" };
  }
  if (!rawName) {
    return { id: fallbackId, label: fallbackLabel };
  }
  return { id: fallbackId, label: rawName };
};

const fromWindow = (): StarknetInjectedWallet[] => {
  if (typeof window === "undefined") return [];
  const source = window as Window & {
    starknet_argentX?: StarknetInjectedWallet["provider"];
    starknet_braavos?: StarknetInjectedWallet["provider"];
    starknet?: StarknetInjectedWallet["provider"];
  };

  const wallets: StarknetInjectedWallet[] = [];
  if (source.starknet_argentX) {
    const identity = inferWalletIdentity(source.starknet_argentX, "argentx", "Argent X");
    wallets.push({ id: identity.id, label: identity.label, provider: source.starknet_argentX });
  }
  if (source.starknet_braavos) {
    const identity = inferWalletIdentity(source.starknet_braavos, "braavos", "Braavos");
    wallets.push({ id: identity.id, label: identity.label, provider: source.starknet_braavos });
  }
  if (source.starknet) {
    const identity = inferWalletIdentity(source.starknet, "starknet", "Starknet Wallet");
    wallets.push({ id: identity.id, label: identity.label, provider: source.starknet });
  }
  return wallets;
};

const addressFromProvider = (provider: StarknetInjectedWallet["provider"]) =>
  normalizeStarknetAddress(provider.account?.address) ??
  normalizeStarknetAddress(provider.selectedAddress);

const readPreferredWalletId = (): StarknetInjectedWallet["id"] | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFERRED_WALLET_KEY);
    if (raw === "argentx" || raw === "braavos" || raw === "ready" || raw === "starknet") {
      return raw;
    }
  } catch {
    // ignore
  }
  return null;
};

const writePreferredWalletId = (id: StarknetInjectedWallet["id"]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERRED_WALLET_KEY, id);
  } catch {
    // ignore
  }
};

const clearPreferredWalletId = () => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFERRED_WALLET_KEY);
  } catch {
    // ignore
  }
};

const rankWallets = (wallets: StarknetInjectedWallet[]) => {
  const preferredId = readPreferredWalletId();
  return [...wallets].sort((a, b) => {
    const score = (wallet: StarknetInjectedWallet) => {
      let total = 0;
      if (preferredId && wallet.id === preferredId) total += 100;
      if (typeof wallet.provider.account?.execute === "function") total += 500;
      if (addressFromProvider(wallet.provider)) total += 20;
      if (wallet.provider.isConnected === true) total += 10;
      if (wallet.provider.isReady) total += 5;
      return total;
    };
    return score(b) - score(a);
  });
};

const addressFromResponse = (payload: unknown): `0x${string}` | null => {
  const direct = normalizeStarknetAddress(payload);
  if (direct) return direct;
  if (!payload || typeof payload !== "object") return null;

  const seen = new Set<unknown>();
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    const nestedDirect =
      normalizeStarknetAddress(record.address) ??
      normalizeStarknetAddress(record.selectedAddress);
    if (nestedDirect) return nestedDirect;

    const nextCandidates = [record.account, record.accounts, record.result, record.data];
    for (const candidate of nextCandidates) {
      const candidateDirect = normalizeStarknetAddress(candidate);
      if (candidateDirect) return candidateDirect;
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          const itemDirect = normalizeStarknetAddress(item);
          if (itemDirect) return itemDirect;
          if (item && typeof item === "object") queue.push(item);
        }
        continue;
      }
      if (candidate && typeof candidate === "object") {
        queue.push(candidate);
      }
    }
  }

  return null;
};

const requestAccounts = async (
  provider: StarknetInjectedWallet["provider"],
  options: { silent: boolean; showModal: boolean },
) => {
  if (!options.silent && options.showModal && typeof provider.enable === "function") {
    try {
      return await provider.enable({ showModal: true });
    } catch {
      // fallback to request path for providers that prefer wallet_requestAccounts
    }
  }

  if (typeof provider.request === "function") {
    return provider.request({
      type: "wallet_requestAccounts",
      params: { silent_mode: options.silent },
    });
  }
  if (typeof provider.enable === "function") {
    return provider.enable({ showModal: options.showModal });
  }
  throw new Error("Starknet wallet connector is unavailable");
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

const resolveAddress = async (
  provider: StarknetInjectedWallet["provider"],
  responsePayload?: unknown,
) => {
  const fromPayload = addressFromResponse(responsePayload);
  if (fromPayload) return fromPayload;

  let address = addressFromProvider(provider);
  if (address) return address;

  for (let retry = 0; retry < 6; retry += 1) {
    await wait(120);
    address = addressFromProvider(provider);
    if (address) return address;
  }

  return null;
};

export const hasStarknetProvider = () => fromWindow().length > 0;

export const getStarknetWalletDebugState = () => {
  const wallets = fromWindow();
  return wallets.map((wallet) => ({
    id: wallet.id,
    label: wallet.label,
    providerId: String(wallet.provider.id ?? ""),
    providerName: String(wallet.provider.name ?? ""),
    isReady: Boolean(wallet.provider.isReady),
    isConnected: wallet.provider.isConnected,
    chainId: String(wallet.provider.chainId ?? ""),
    selectedAddress: String(wallet.provider.selectedAddress ?? ""),
    accountAddress: String(wallet.provider.account?.address ?? ""),
    hasExecute: typeof wallet.provider.account?.execute === "function",
    hasRequest: typeof wallet.provider.request === "function",
    hasEnable: typeof wallet.provider.enable === "function",
  }));
};

type GetStarknetWalletOptions = {
  targetAddress?: string | null;
  requireSigner?: boolean;
};

export const getStarknetInjectedWallet = (
  options: GetStarknetWalletOptions = {},
): StarknetInjectedWallet | null => {
  const wallets = rankWallets(fromWindow());
  if (wallets.length === 0) return null;

  const targetAddress = normalizeStarknetAddress(options.targetAddress);
  const requireSigner = options.requireSigner === true;

  const addressMatched = targetAddress
    ? wallets.filter((wallet) => addressFromProvider(wallet.provider) === targetAddress)
    : wallets;

  if (addressMatched.length > 0) {
    if (!requireSigner) return addressMatched[0] ?? null;
    const signerMatched = addressMatched.find(
      (wallet) => typeof wallet.provider.account?.execute === "function",
    );
    if (signerMatched) return signerMatched;
    return null;
  }

  if (requireSigner) {
    const signerAny = wallets.find((wallet) => typeof wallet.provider.account?.execute === "function");
    if (signerAny) return signerAny;
    return null;
  }

  return wallets[0] ?? null;
};

export const connectStarknetWallet = async (): Promise<{
  wallet: StarknetInjectedWallet;
  address: `0x${string}`;
}> => {
  const wallets = rankWallets(fromWindow());
  if (wallets.length === 0) {
    throw new Error("No Starknet wallet provider found");
  }

  let lastError: unknown = null;
  for (const wallet of wallets) {
    try {
      const responsePayload = await requestAccounts(wallet.provider, {
        silent: false,
        showModal: true,
      });
      const address = await resolveAddress(wallet.provider, responsePayload);
      if (!address) {
        throw new Error(`Starknet wallet (${wallet.label}) returned no address`);
      }
      const signerWallet = getStarknetInjectedWallet({ targetAddress: address, requireSigner: true });
      const selectedWallet = signerWallet ?? wallet;
      writePreferredWalletId(selectedWallet.id);
      return { wallet: selectedWallet, address };
    } catch (error) {
      lastError = error;
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("Starknet wallet connect failed"));
};

export const tryReconnectStarknetWallet = async (): Promise<{
  wallet: StarknetInjectedWallet;
  address: `0x${string}`;
} | null> => {
  const wallets = rankWallets(fromWindow());
  if (wallets.length === 0) return null;

  for (const wallet of wallets) {
    let address = addressFromProvider(wallet.provider);
    if (address) {
      const signerWallet = getStarknetInjectedWallet({ targetAddress: address, requireSigner: true });
      const selectedWallet = signerWallet ?? wallet;
      writePreferredWalletId(selectedWallet.id);
      return { wallet: selectedWallet, address };
    }

    try {
      const responsePayload = await requestAccounts(wallet.provider, {
        silent: true,
        showModal: false,
      });
      address = await resolveAddress(wallet.provider, responsePayload);
      if (address) {
        const signerWallet = getStarknetInjectedWallet({ targetAddress: address, requireSigner: true });
        const selectedWallet = signerWallet ?? wallet;
        writePreferredWalletId(selectedWallet.id);
        return { wallet: selectedWallet, address };
      }
    } catch {
      // continue to next provider
    }
  }

  return null;
};

export const disconnectStarknetWallet = async () => {
  const wallet = getStarknetInjectedWallet();
  clearPreferredWalletId();
  if (!wallet) return;
  if (typeof wallet.provider.disconnect === "function") {
    await wallet.provider.disconnect();
  }
};

export const getConnectedStarknetAddress = (): `0x${string}` | null => {
  const wallets = rankWallets(fromWindow());
  for (const wallet of wallets) {
    const address = addressFromProvider(wallet.provider);
    if (address) return address;
  }
  return null;
};
