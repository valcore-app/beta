"use client";

import { CallData, Contract, RpcProvider } from "starknet";
import type { StarknetInjectedWallet } from "./starknet-wallet";
import { reportClientError } from "./error-report";

const normalizeHex = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "0x0";
  try {
    const asBigInt = BigInt(raw.startsWith("0x") ? raw : `0x${raw}`);
    return `0x${asBigInt.toString(16)}`;
  } catch {
    return raw.toLowerCase();
  }
};

const asBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return 0n;
    return BigInt(raw);
  }
  if (value && typeof value === "object") {
    const record = value as { low?: unknown; high?: unknown };
    if (record.low !== undefined || record.high !== undefined) {
      const low = asBigInt(record.low ?? 0);
      const high = asBigInt(record.high ?? 0);
      return (high << 128n) + low;
    }
  }
  return 0n;
};

const toU256 = (value: bigint) => {
  if (value < 0n) throw new Error("Negative value is not valid for u256");
  const mask = (1n << 128n) - 1n;
  const low = value & mask;
  const high = value >> 128n;
  return {
    low: `0x${low.toString(16)}`,
    high: `0x${high.toString(16)}`,
  };
};

const STARKNET_FIELD_PRIME = BigInt(
  "0x800000000000011000000000000000000000000000000000000000000000001",
);

export const toStarknetFeltHash = (value: string) => {
  const asInt = BigInt(value);
  return `0x${(asInt % STARKNET_FIELD_PRIME).toString(16)}`;
};

const valcoreReadAbi = [
  {
    type: "function",
    name: "get_position",
    inputs: [
      { name: "week_id", type: "core::integer::u64" },
      { name: "user", type: "core::starknet::contract_address::ContractAddress" },
    ],
    outputs: [
      {
        type: "core::tuple",
        items: [
          { type: "core::integer::u128", name: "principal" },
          { type: "core::integer::u128", name: "risk" },
          { type: "core::integer::u128", name: "forfeited_reward" },
          { type: "core::felt252", name: "lineup_hash" },
          { type: "core::integer::u8", name: "swaps" },
          { type: "core::bool", name: "claimed" },
        ],
      },
    ],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "get_week_state",
    inputs: [{ name: "week_id", type: "core::integer::u64" }],
    outputs: [
      {
        type: "core::tuple",
        items: [
          { type: "core::integer::u64", name: "start_at" },
          { type: "core::integer::u64", name: "lock_at" },
          { type: "core::integer::u64", name: "end_at" },
          { type: "core::integer::u64", name: "finalized_at" },
          { type: "core::integer::u8", name: "status" },
          { type: "core::integer::u128", name: "risk_committed" },
          { type: "core::integer::u128", name: "retained_fee" },
          { type: "core::felt252", name: "merkle_root" },
          { type: "core::felt252", name: "metadata_hash" },
        ],
      },
    ],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "test_mode",
    inputs: [],
    outputs: [{ name: "test_mode", type: "core::bool" }],
    state_mutability: "view",
  },
];

const stablecoinReadAbi = [
  {
    type: "function",
    name: "balance_of",
    inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ name: "balance", type: "core::integer::u256" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "core::starknet::contract_address::ContractAddress" },
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
    ],
    outputs: [{ name: "remaining", type: "core::integer::u256" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "decimals", type: "core::integer::u8" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "symbol", type: "core::felt252" }],
    state_mutability: "view",
  },
];

const splitRpcUrls = (value: string) =>
  String(value ?? "")
    .split(/[\r\n,;]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => /^https?:\/\//iu.test(entry) || entry.startsWith("/"));

const getRpcCandidates = (rpcUrl: string) => {
  const primary = splitRpcUrls(rpcUrl);
  const fallback = splitRpcUrls(process.env.NEXT_PUBLIC_CHAIN_RPC_FALLBACK_URLS ?? "");
  const merged = Array.from(new Set([...primary, ...fallback]));
  if (merged.length === 0 && rpcUrl.trim()) return [rpcUrl.trim()];
  return merged;
};

const isRpcRetryable = (error: unknown) => {
  const text = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  return [
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
  ].some((hint) => text.includes(hint));
};

const withProviderFallback = async <T>(rpcUrl: string, operation: (provider: RpcProvider) => Promise<T>): Promise<T> => {
  const candidates = getRpcCandidates(rpcUrl);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const provider = new RpcProvider({ nodeUrl: candidate });
      return await operation(provider);
    } catch (error) {
      lastError = error;
      if (!isRpcRetryable(error)) throw error;
    }
  }
  throw new Error(String(lastError instanceof Error ? lastError.message : lastError ?? "All Starknet RPC endpoints failed"));
};


const getWalletProviderSnapshots = (wallet: StarknetInjectedWallet) => {
  const source =
    typeof window !== "undefined"
      ? (window as Window & {
          starknet?: StarknetInjectedWallet["provider"];
          starknet_argentX?: StarknetInjectedWallet["provider"];
          starknet_braavos?: StarknetInjectedWallet["provider"];
        })
      : null;

  const providers: Array<{ key: string; provider: StarknetInjectedWallet["provider"] | null | undefined }> = [
    { key: "wallet.provider", provider: wallet.provider },
    { key: "window.starknet", provider: source?.starknet },
    { key: "window.starknet_argentX", provider: source?.starknet_argentX },
    { key: "window.starknet_braavos", provider: source?.starknet_braavos },
  ];

  return providers
    .filter((entry) => Boolean(entry.provider))
    .map((entry) => {
      const provider = entry.provider!;
      const account = provider.account;
      return {
        key: entry.key,
        providerId: String(provider.id ?? ""),
        providerName: String(provider.name ?? ""),
        isReady: Boolean(provider.isReady),
        isConnected: provider.isConnected,
        chainId: String(provider.chainId ?? ""),
        selectedAddress: String(provider.selectedAddress ?? ""),
        accountAddress: String(account?.address ?? ""),
        hasExecute: typeof account?.execute === "function",
        hasRequest: typeof provider.request === "function",
        hasEnable: typeof provider.enable === "function",
      };
    });
};



const parseTxHash = (value: unknown): `0x${string}` => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{1,64}$/u.test(normalized)) {
    throw new Error("Invalid Starknet tx hash");
  }
  return normalized as `0x${string}`;
};

const toU64Hex = (value: string) => `0x${BigInt(value).toString(16)}`;

const callContractRaw = async (
  provider: RpcProvider,
  contractAddress: string,
  entrypoint: string,
  calldata: string[],
): Promise<string[]> => {
  const raw = await provider.callContract({ contractAddress, entrypoint, calldata });
  if (Array.isArray(raw)) return raw;
  const result = (raw as { result?: string[] } | null | undefined)?.result;
  return Array.isArray(result) ? result : [];
};

const waitForWalletAccount = async (
  wallet: StarknetInjectedWallet,
): Promise<{ execute: (calls: unknown) => Promise<{ transaction_hash?: string }> } | null> => {
  const readAccountFromProvider = (provider: StarknetInjectedWallet["provider"] | null | undefined) => {
    const account = provider?.account;
    if (!account || typeof account.execute !== "function") return null;
    return account as { execute: (calls: unknown) => Promise<{ transaction_hash?: string }> };
  };

  const getCandidateProviders = () => {
    const providers: Array<StarknetInjectedWallet["provider"]> = [];
    if (wallet?.provider) providers.push(wallet.provider);

    if (typeof window !== "undefined") {
      const source = window as Window & {
        starknet?: StarknetInjectedWallet["provider"];
        starknet_argentX?: StarknetInjectedWallet["provider"];
        starknet_braavos?: StarknetInjectedWallet["provider"];
      };
      if (source.starknet) providers.push(source.starknet);
      if (source.starknet_argentX) providers.push(source.starknet_argentX);
      if (source.starknet_braavos) providers.push(source.starknet_braavos);
    }

    return Array.from(new Set(providers));
  };

  const readAnyAccount = () => {
    for (const provider of getCandidateProviders()) {
      const account = readAccountFromProvider(provider);
      if (account) return account;
    }
    return null;
  };

  const hydrateProvider = async (
    provider: StarknetInjectedWallet["provider"],
    showModal: boolean,
  ) => {
    try {
      if (typeof provider.request === "function") {
        await provider.request({
          type: "wallet_requestAccounts",
          params: { silent_mode: !showModal },
        });
        return;
      }
    } catch {
      // fall through
    }

    try {
      if (typeof provider.enable === "function") {
        await provider.enable({ showModal });
      }
    } catch {
      // ignore hydration errors here; final null check handles failure
    }
  };

  const immediate = readAnyAccount();
  if (immediate) return immediate;

  const providers = getCandidateProviders();
  for (const provider of providers) {
    await hydrateProvider(provider, false);
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const hydrated = readAnyAccount();
    if (hydrated) return hydrated;
  }

  for (const provider of providers) {
    await hydrateProvider(provider, true);
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const hydrated = readAnyAccount();
    if (hydrated) return hydrated;
  }

  return null;
};

const getWalletAccount = async (
  wallet: StarknetInjectedWallet,
): Promise<{ execute: (calls: unknown) => Promise<{ transaction_hash?: string }> }> => {
  const account = await waitForWalletAccount(wallet);
  if (!account) {
    throw new Error("Starknet wallet account is unavailable");
  }
  return account;
};

const resolveExecuteTxHash = (payload: unknown): `0x${string}` => {
  const direct = (candidate: unknown): `0x${string}` | null => {
    try {
      return parseTxHash(candidate);
    } catch {
      return null;
    }
  };

  const directHit = direct(payload);
  if (directHit) return directHit;

  const seen = new Set<unknown>();
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        const hit = direct(item);
        if (hit) return hit;
        if (item && typeof item === "object") queue.push(item);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const candidates: unknown[] = [
      record.transaction_hash,
      record.transactionHash,
      record.hash,
      record.tx_hash,
      record.txHash,
      record.result,
      record.data,
      record.response,
    ];

    for (const candidate of candidates) {
      const hit = direct(candidate);
      if (hit) return hit;
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          const nestedHit = direct(item);
          if (nestedHit) return nestedHit;
          if (item && typeof item === "object") queue.push(item);
        }
        continue;
      }
      if (candidate && typeof candidate === "object") {
        queue.push(candidate);
      }
    }
  }

  throw new Error("Starknet wallet returned no transaction hash");
};

const invokeViaProviderRequest = async (
  wallet: StarknetInjectedWallet,
  call: { contractAddress: string; entrypoint: string; calldata: string[] },
): Promise<`0x${string}`> => {
  const request = wallet.provider.request;
  if (typeof request !== "function") {
    throw new Error("Starknet wallet request interface is unavailable");
  }

  try {
    await request({
      type: "wallet_requestAccounts",
      params: { silent_mode: false },
    });
  } catch {
    // Continue; some wallets reject repeated requestAccounts calls.
  }

  const calls = [
    {
      contract_address: call.contractAddress,
      entry_point: call.entrypoint,
      calldata: call.calldata,
    },
  ];

  const payloadCandidates = [
    {
      type: "wallet_addInvokeTransaction",
      params: {
        calls,
      },
    },
    {
      type: "wallet_addInvokeTransaction",
      params: {
        calls,
        version: "0x1",
      },
    },
    {
      type: "wallet_addInvokeTransaction",
      params: [
        {
          calls,
        },
      ],
    },
  ];

  let lastError: unknown = null;
  for (const payload of payloadCandidates) {
    try {
      const result = await request(payload as { type: string; params?: unknown });
      return resolveExecuteTxHash(result);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Starknet wallet invoke request failed: ${String(
      lastError instanceof Error ? lastError.message : lastError ?? "unknown",
    )}`,
  );
};

const execute = async (
  wallet: StarknetInjectedWallet,
  call: { contractAddress: string; entrypoint: string; calldata: string[] },
): Promise<`0x${string}`> => {
  try {
    const account = await getWalletAccount(wallet);
    const result = await account.execute([call]);
    return resolveExecuteTxHash(result);
  } catch (error) {
    const lowered = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
    const shouldFallback =
      lowered.includes("wallet account is unavailable") ||
      lowered.includes("wallet signer") ||
      lowered.includes("no transaction hash");

    if (!shouldFallback) {
      throw error;
    }

    try {
      return await invokeViaProviderRequest(wallet, call);
    } catch (fallbackError) {
      const snapshots = getWalletProviderSnapshots(wallet);
      const context = {
        walletId: wallet.id,
        walletLabel: wallet.label,
        primaryError: String(error instanceof Error ? error.message : error ?? "unknown"),
        fallbackError: String(
          fallbackError instanceof Error ? fallbackError.message : fallbackError ?? "unknown",
        ),
        snapshots,
      };
      console.error("starknet-account-unavailable", context);
      void reportClientError({
        source: "web-client",
        severity: "error",
        category: "wallet-starknet-account",
        message: "Starknet wallet account is unavailable",
        fingerprint: "wallet:starknet:account-unavailable",
        path: typeof window !== "undefined" ? window.location.pathname : "/",
        context,
      });
      throw fallbackError;
    }
  }
};
export const waitForStarknetTx = async (rpcUrl: string, txHash: `0x${string}`) => {
  const isPendingLookupError = (error: unknown) => {
    const text = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
    return [
      "not found",
      "transaction hash",
      "pending",
      "no transaction",
      "no tx",
      "still pending",
      "timed out",
      "timeout",
      "waitfortransaction timed-out",
    ].some((hint) => text.includes(hint));
  };

  const normalizeStatus = (value: unknown) => String(value ?? "").trim().toUpperCase();

  const parseReceiptState = (receipt: unknown) => {
    const value = (receipt ?? {}) as Record<string, unknown>;
    const executionStatus = normalizeStatus(value.execution_status ?? value.executionStatus);
    const finalityStatus = normalizeStatus(value.finality_status ?? value.finalityStatus ?? value.status);

    if (executionStatus === "REVERTED" || executionStatus === "REJECTED" || finalityStatus === "REJECTED") {
      return { state: "failed" as const, executionStatus, finalityStatus };
    }

    if (
      executionStatus === "SUCCEEDED" ||
      finalityStatus === "ACCEPTED_ON_L1" ||
      finalityStatus === "ACCEPTED_ON_L2"
    ) {
      return { state: "succeeded" as const, executionStatus, finalityStatus };
    }

    return { state: "pending" as const, executionStatus, finalityStatus };
  };

  return withProviderFallback(rpcUrl, async (provider) => {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const receipt = await provider.waitForTransaction(txHash, {
          retries: 2,
          lifeCycleRetries: 2,
          retryInterval: 800,
        });
        const parsed = parseReceiptState(receipt);
        if (parsed.state === "failed") {
          throw new Error(`Starknet tx failed: ${parsed.executionStatus || parsed.finalityStatus || "unknown"}`);
        }
        if (parsed.state === "succeeded") {
          return receipt;
        }
      } catch (error) {
        lastError = error;
        if (!isPendingLookupError(error)) {
          throw error;
        }

        try {
          const directReceipt = await (provider as any).getTransactionReceipt?.(txHash);
          if (directReceipt) {
            const parsed = parseReceiptState(directReceipt);
            if (parsed.state === "failed") {
              throw new Error(`Starknet tx failed: ${parsed.executionStatus || parsed.finalityStatus || "unknown"}`);
            }
            if (parsed.state === "succeeded") {
              return directReceipt;
            }
          }
        } catch (receiptError) {
          if (!isPendingLookupError(receiptError)) {
            throw receiptError;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    throw new Error(
      `Starknet transaction receipt is still unavailable for ${txHash}: ${String(
        lastError instanceof Error ? lastError.message : lastError ?? "unknown",
      )}`,
    );
  });
};
export const readStarknetStablecoinBalance = async (
  rpcUrl: string,
  stablecoinAddress: string,
  ownerAddress: string,
): Promise<bigint> => {
  return withProviderFallback(rpcUrl, async (provider) => {
    const contract = new Contract({ abi: stablecoinReadAbi as any, address: stablecoinAddress, providerOrAccount: provider as any });
    const raw = await (contract as any).call("balance_of", [ownerAddress]);
    return asBigInt((raw as Record<string, unknown>)?.balance ?? raw);
  });
};

export const readStarknetTokenMetadata = async (
  rpcUrl: string,
  tokenAddress: string,
): Promise<{ decimals: number | null; symbol: string | null }> => {
  return withProviderFallback(rpcUrl, async (provider) => {
    const contract = new Contract({ abi: stablecoinReadAbi as any, address: tokenAddress, providerOrAccount: provider as any });

    let decimals: number | null = null;
    let symbol: string | null = null;

    try {
      const rawDecimals = await (contract as any).call("decimals", []);
      const asNumber = Number(asBigInt((rawDecimals as Record<string, unknown>)?.decimals ?? rawDecimals));
      if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 255) {
        decimals = Math.trunc(asNumber);
      }
    } catch {
      decimals = null;
    }

    try {
      const rawSymbol = await (contract as any).call("symbol", []);
      const symbolValue = (rawSymbol as Record<string, unknown>)?.symbol ?? rawSymbol;
      if (typeof symbolValue === "string" && symbolValue.trim()) {
        symbol = symbolValue.trim();
      }
    } catch {
      symbol = null;
    }

    return { decimals, symbol };
  });
};

export const readStarknetStablecoinAllowance = async (
  rpcUrl: string,
  stablecoinAddress: string,
  ownerAddress: string,
  spenderAddress: string,
): Promise<bigint> => {
  return withProviderFallback(rpcUrl, async (provider) => {
    const contract = new Contract({ abi: stablecoinReadAbi as any, address: stablecoinAddress, providerOrAccount: provider as any });
    const raw = await (contract as any).call("allowance", [ownerAddress, spenderAddress]);
    return asBigInt((raw as Record<string, unknown>)?.remaining ?? raw);
  });
};

export const readStarknetPosition = async (
  rpcUrl: string,
  leagueAddress: string,
  weekId: string,
  ownerAddress: string,
) => {
  return withProviderFallback(rpcUrl, async (provider) => {
    const rawResult = await callContractRaw(
      provider,
      leagueAddress,
      "get_position",
      [toU64Hex(weekId), normalizeHex(ownerAddress)],
    );

    if (rawResult.length >= 6) {
      return {
        principal: asBigInt(rawResult[0]),
        risk: asBigInt(rawResult[1]),
        lineupHash: normalizeHex(rawResult[3]),
        swaps: Number(asBigInt(rawResult[4])),
        claimed: asBigInt(rawResult[5]) !== 0n,
      };
    }

    const contract = new Contract({ abi: valcoreReadAbi as any, address: leagueAddress, providerOrAccount: provider as any });
    const raw = await (contract as any).call("get_position", [BigInt(weekId), ownerAddress]);
    const value = (raw ?? {}) as Record<string, unknown>;
    const arr = Array.isArray(raw) ? raw : [];
    return {
      principal: asBigInt(value.principal ?? arr[0]),
      risk: asBigInt(value.risk ?? arr[1]),
      lineupHash: normalizeHex(value.lineup_hash ?? arr[3]),
      swaps: Number(asBigInt(value.swaps ?? arr[4])),
      claimed: asBigInt(value.claimed ?? arr[5]) !== 0n,
    };
  });
};

export const readStarknetWeekState = async (rpcUrl: string, leagueAddress: string, weekId: string) => {
  return withProviderFallback(rpcUrl, async (provider) => {
    const rawResult = await callContractRaw(provider, leagueAddress, "get_week_state", [toU64Hex(weekId)]);
    if (rawResult.length >= 5) {
      return {
        lockAt: Number(asBigInt(rawResult[1])),
        status: Number(asBigInt(rawResult[4])),
      };
    }

    const contract = new Contract({ abi: valcoreReadAbi as any, address: leagueAddress, providerOrAccount: provider as any });
    const raw = await (contract as any).call("get_week_state", [BigInt(weekId)]);
    const value = (raw ?? {}) as Record<string, unknown>;
    const arr = Array.isArray(raw) ? raw : [];
    return {
      lockAt: Number(asBigInt(value.lock_at ?? arr[1])),
      status: Number(asBigInt(value.status ?? arr[4])),
    };
  });
};

export const readStarknetTestMode = async (rpcUrl: string, leagueAddress: string) => {
  return withProviderFallback(rpcUrl, async (provider) => {
    const rawResult = await callContractRaw(provider, leagueAddress, "test_mode", []);
    if (rawResult.length > 0) {
      return asBigInt(rawResult[0]) !== 0n;
    }

    const contract = new Contract({ abi: valcoreReadAbi as any, address: leagueAddress, providerOrAccount: provider as any });
    const raw = await (contract as any).call("test_mode", []);
    return asBigInt((raw as Record<string, unknown>)?.test_mode ?? raw) !== 0n;
  });
};

export const approveStarknetStablecoin = async (
  wallet: StarknetInjectedWallet,
  stablecoinAddress: string,
  spenderAddress: string,
  amount: bigint,
) => {
  const calldata = CallData.compile({
    spender: spenderAddress,
    amount: toU256(amount),
  });
  return execute(wallet, {
    contractAddress: stablecoinAddress,
    entrypoint: "approve",
    calldata,
  });
};

export const commitStarknetLineup = async (
  wallet: StarknetInjectedWallet,
  leagueAddress: string,
  weekId: string,
  lineupHash: string,
  amount: bigint,
) => {
  const calldata = CallData.compile({
    week_id: BigInt(weekId),
    lineup_hash: toStarknetFeltHash(lineupHash),
    deposit_amount: amount,
  });
  return execute(wallet, {
    contractAddress: leagueAddress,
    entrypoint: "commit_lineup",
    calldata,
  });
};

export const swapStarknetLineup = async (
  wallet: StarknetInjectedWallet,
  leagueAddress: string,
  weekId: string,
  lineupHash: string,
) => {
  const calldata = CallData.compile({
    week_id: BigInt(weekId),
    new_hash: toStarknetFeltHash(lineupHash),
  });
  return execute(wallet, {
    contractAddress: leagueAddress,
    entrypoint: "swap_lineup",
    calldata,
  });
};

export const claimStarknetWeek = async (
  wallet: StarknetInjectedWallet,
  leagueAddress: string,
  weekId: string,
  principal: bigint,
  riskPayout: bigint,
  totalWithdraw: bigint,
  proof: `0x${string}`[],
) => {
  const calldata = CallData.compile({
    week_id: BigInt(weekId),
    principal,
    risk_payout: riskPayout,
    total_withdraw: totalWithdraw,
    proof,
  });
  return execute(wallet, {
    contractAddress: leagueAddress,
    entrypoint: "claim",
    calldata,
  });
};






