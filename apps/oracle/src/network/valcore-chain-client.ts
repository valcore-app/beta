import { ethers } from "ethers";
import { env } from "../env.js";
import {
  getRuntimeChainType,
  getRuntimeProvider,
  getRuntimeStarknetProviderUrls,
  withRuntimeStarknetProvider,
  getRequiredRuntimeStarknetAccount,
  getRequiredRuntimeOraclePrivateKey,
  getRequiredRuntimeAuditorPrivateKey,
  getRequiredRuntimeContractAdminPrivateKey,
  getRequiredRuntimePauserPrivateKey,
  getRequiredRuntimeFaucetMinterPrivateKey,
} from "./chain-runtime.js";
import { sendTxWithPolicy } from "./tx-policy.js";

export type ChainWeekState = {
  startAt: bigint;
  lockAt: bigint;
  endAt: bigint;
  finalizedAt: bigint;
  status: number;
  riskCommitted: bigint;
  retainedFee: bigint;
  merkleRoot: string;
  metadataHash: string;
};

export type ChainPositionState = {
  principal: bigint;
  risk: bigint;
  forfeitedReward: bigint;
  lineupHash: string;
  swaps: number;
  claimed: boolean;
};

type EvmRole = "oracle" | "auditor" | "contract_admin" | "pauser" | "faucet_minter";
type StarkRole = EvmRole;

const MAX_ATTEMPTS = (() => {
  const parsed = Number(env.CHAIN_TX_MAX_ATTEMPTS);
  if (!Number.isInteger(parsed) || parsed <= 0) return 4;
  return parsed;
})();

const BASE_DELAY_MS = (() => {
  const parsed = Number(env.CHAIN_TX_RETRY_BASE_MS);
  if (!Number.isInteger(parsed) || parsed <= 0) return 1500;
  return parsed;
})();

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const TX_WAIT_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.CHAIN_TX_WAIT_TIMEOUT_MS ?? "90000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 90000;
  return Math.trunc(parsed);
})();

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const isRetryable = (error: unknown) => {
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
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
    "nonce",
    "rejected",
    "unexpected token '<'",
    "no available nodes found",
    "<!doctype",
    "<html",
  ];
  return hints.some((hint) => text.includes(hint));
};

const normalizeHex = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "0x0";
  if (raw.startsWith("0x") || raw.startsWith("0X")) return raw.toLowerCase();
  return `0x${BigInt(raw).toString(16)}`;
};

const normalizeHashForStarknetFelt = (value: string) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(normalized)) {
    throw new Error("Invalid Starknet felt hash: " + String(value ?? ""));
  }
  const starknetFieldPrime = BigInt("0x800000000000011000000000000000000000000000000000000000000000001");
  return ethers.toBeHex(BigInt(normalized) % starknetFieldPrime, 32).toLowerCase();
};


const asBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return 0n;
    return BigInt(normalized);
  }
  if (value && typeof value === "object") {
    const maybe = value as { low?: unknown; high?: unknown };
    if (maybe.low !== undefined || maybe.high !== undefined) {
      const low = asBigInt(maybe.low ?? 0);
      const high = asBigInt(maybe.high ?? 0);
      return (high << 128n) + low;
    }
  }
  return 0n;
};

const asBool = (value: unknown) => asBigInt(value) !== 0n;
const asNumber = (value: unknown) => Number(asBigInt(value));

const toU256 = (value: bigint) => {
  if (value < 0n) throw new Error("Negative value is not valid for u256");
  const lowMask = (1n << 128n) - 1n;
  const low = value & lowMask;
  const high = value >> 128n;
  return {
    low: `0x${low.toString(16)}`,
    high: `0x${high.toString(16)}`,
  };
};

const toStarknetCalldataHex = (value: unknown): string => {
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "0x0";
    if (/^0x[0-9a-f]+$/iu.test(raw)) return raw.toLowerCase();
    return `0x${BigInt(raw).toString(16)}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0x0";
    return `0x${BigInt(Math.trunc(value)).toString(16)}`;
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  if (value && typeof value === "object") {
    const record = value as { low?: unknown; high?: unknown };
    if (record.low !== undefined || record.high !== undefined) {
      return [toStarknetCalldataHex(record.low ?? 0), toStarknetCalldataHex(record.high ?? 0)].join(",");
    }
  }
  return "0x0";
};

const flattenStarknetCalldata = (items: unknown[]): string[] => {
  const output: string[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (record.low !== undefined || record.high !== undefined) {
        output.push(toStarknetCalldataHex(record.low ?? 0));
        output.push(toStarknetCalldataHex(record.high ?? 0));
        continue;
      }
    }
    output.push(toStarknetCalldataHex(item));
  }
  return output;
};

const callStarknetContractRaw = async (
  provider: {
    callContract: (request: {
      contractAddress: string;
      entrypoint: string;
      calldata: string[];
    }) => Promise<unknown>;
  },
  contractAddress: string,
  entrypoint: string,
  calldata: unknown[],
): Promise<string[]> => {
  const raw = await provider.callContract({
    contractAddress,
    entrypoint,
    calldata: flattenStarknetCalldata(calldata),
  });
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  const result = (raw as { result?: unknown[] } | null | undefined)?.result;
  if (Array.isArray(result)) {
    return result.map((item) => String(item));
  }
  return [];
};
const waitForStarknetTx = async (provider: { waitForTransaction: (tx: string) => Promise<unknown> }, transactionHash: string) => {
  const receipt = await withTimeout(
    provider.waitForTransaction(transactionHash),
    TX_WAIT_TIMEOUT_MS,
    `waitForTransaction(${transactionHash})`,
  );

  const statusText = String((receipt as { execution_status?: string }).execution_status ?? "").toUpperCase();
  if (statusText && statusText !== "SUCCEEDED") {
    throw new Error(`Starknet tx execution failed: ${statusText}`);
  }
  return receipt;
};

const getEvmPrivateKeyByRole = async (role: EvmRole): Promise<string> => {
  if (role === "oracle") return getRequiredRuntimeOraclePrivateKey();
  if (role === "auditor") return getRequiredRuntimeAuditorPrivateKey();
  if (role === "contract_admin") return getRequiredRuntimeContractAdminPrivateKey();
  if (role === "pauser") return getRequiredRuntimePauserPrivateKey();
  return getRequiredRuntimeFaucetMinterPrivateKey();
};

const sendStarknetInvoke = async (
  role: StarkRole,
  contractAddress: string,
  fnName: string,
  calldata: unknown[],
  label: string,
  _abiOverride?: unknown[],
): Promise<string> => {
  const rpcUrls = await getRuntimeStarknetProviderUrls();
  const flatCalldata = flattenStarknetCalldata(calldata);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (const rpcUrl of rpcUrls) {
      try {
        const account = await getRequiredRuntimeStarknetAccount(role, rpcUrl);
        const response = await (account as any).execute([
          {
            contractAddress,
            entrypoint: fnName,
            calldata: flatCalldata,
          },
        ]);
        const txHash = String((response as { transaction_hash?: string }).transaction_hash ?? "").toLowerCase();
        if (!txHash) {
          throw new Error(label + ": missing transaction hash");
        }
        await waitForStarknetTx(((account as any).provider ?? (account as any)) as any, txHash);
        return txHash;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(label + " failed: " + message);
        }
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(label + " failed after " + String(MAX_ATTEMPTS) + " attempt(s): " + message);
};
const sendEvmChainTx = async (
  role: EvmRole,
  contractAddress: string,
  abi: readonly string[],
  label: string,
  sender: (contract: ethers.Contract, overrides: Record<string, bigint>) => Promise<unknown>,
): Promise<string> => {
  const provider = await getRuntimeProvider();
  const privateKey = await getEvmPrivateKeyByRole(role);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, abi, wallet);

  const sent = await sendTxWithPolicy({
    label,
    signer: wallet,
    send: (overrides) =>
      sender(
        contract,
        overrides,
      ) as Promise<{ hash: string; wait: (confirmations?: number) => Promise<ethers.TransactionReceipt | null> }>,
  });

  return sent.txHash;
};

const parseWeekStateFromStarknet = (raw: unknown): ChainWeekState => {
  const value = (raw ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(raw) ? raw : [];
  return {
    startAt: asBigInt(value.start_at ?? arr[0]),
    lockAt: asBigInt(value.lock_at ?? arr[1]),
    endAt: asBigInt(value.end_at ?? arr[2]),
    finalizedAt: asBigInt(value.finalized_at ?? arr[3]),
    status: asNumber(value.status ?? arr[4]),
    riskCommitted: asBigInt(value.risk_committed ?? arr[5]),
    retainedFee: asBigInt(value.retained_fee ?? arr[6]),
    merkleRoot: normalizeHex(value.merkle_root ?? arr[7]),
    metadataHash: normalizeHex(value.metadata_hash ?? arr[8]),
  };
};

const parsePositionFromStarknet = (raw: unknown): ChainPositionState => {
  const value = (raw ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(raw) ? raw : [];
  return {
    principal: asBigInt(value.principal ?? arr[0]),
    risk: asBigInt(value.risk ?? arr[1]),
    forfeitedReward: asBigInt(value.forfeited_reward ?? arr[2]),
    lineupHash: normalizeHex(value.lineup_hash ?? arr[3]),
    swaps: asNumber(value.swaps ?? arr[4]),
    claimed: asBool(value.claimed ?? arr[5]),
  };
};

export const getOnchainFeeBps = async (leagueAddress: string): Promise<number> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return withRuntimeStarknetProvider(async (provider) => {
      const raw = await callStarknetContractRaw(provider as any, leagueAddress, "fee_bps", []);
      return asNumber(raw[0] ?? 0);
    });
  }

  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function feeBps() view returns (uint16)"], provider);
  return Number(await league.feeBps());
};

export const getOnchainWeekState = async (leagueAddress: string, weekId: bigint): Promise<ChainWeekState> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return withRuntimeStarknetProvider(async (provider) => {
      const raw = await callStarknetContractRaw(provider as any, leagueAddress, "get_week_state", [weekId]);
      return parseWeekStateFromStarknet(raw);
    });
  }

  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(
    leagueAddress,
    [
      "function weekStates(uint256) view returns (uint64,uint64,uint64,uint64,uint8,uint128,uint128,bytes32,bytes32)",
    ],
    provider,
  );
  const state = await league.weekStates(weekId);
  return {
    startAt: asBigInt(state[0]),
    lockAt: asBigInt(state[1]),
    endAt: asBigInt(state[2]),
    finalizedAt: asBigInt(state[3]),
    status: asNumber(state[4]),
    riskCommitted: asBigInt(state[5]),
    retainedFee: asBigInt(state[6]),
    merkleRoot: normalizeHex(state[7]),
    metadataHash: normalizeHex(state[8]),
  };
};

export const getOnchainPosition = async (
  leagueAddress: string,
  weekId: bigint,
  address: string,
): Promise<ChainPositionState> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return withRuntimeStarknetProvider(async (provider) => {
      const raw = await callStarknetContractRaw(provider as any, leagueAddress, "get_position", [weekId, address]);
      return parsePositionFromStarknet(raw);
    });
  }

  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(
    leagueAddress,
    [
      "function positions(uint256,address) view returns (uint128 principal,uint128 risk,uint128 forfeitedReward,bytes32 lineupHash,uint8 swaps,bool claimed)",
    ],
    provider,
  );
  const state = await league.positions(weekId, address);
  return {
    principal: asBigInt(state.principal ?? state[0]),
    risk: asBigInt(state.risk ?? state[1]),
    forfeitedReward: asBigInt(state.forfeitedReward ?? state[2]),
    lineupHash: normalizeHex(state.lineupHash ?? state[3]),
    swaps: asNumber(state.swaps ?? state[4]),
    claimed: Boolean(state.claimed ?? state[5]),
  };
};

export const getOnchainTestMode = async (leagueAddress: string): Promise<boolean> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return withRuntimeStarknetProvider(async (provider) => {
      const raw = await callStarknetContractRaw(provider as any, leagueAddress, "test_mode", []);
      return asBool(raw[0] ?? 0);
    });
  }

  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function testMode() view returns (bool)"], provider);
  return Boolean(await league.testMode());
};

export const getOnchainPaused = async (leagueAddress: string): Promise<boolean> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return withRuntimeStarknetProvider(async (provider) => {
      const raw = await callStarknetContractRaw(provider as any, leagueAddress, "paused", []);
      return asBool(raw[0] ?? 0);
    });
  }

  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function paused() view returns (bool)"], provider);
  return Boolean(await league.paused());
};

export const createWeekOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  startAt: number,
  lockAt: number,
  endAt: number,
): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return sendStarknetInvoke(
      "oracle",
      leagueAddress,
      "create_week",
      [weekId, BigInt(startAt), BigInt(lockAt), BigInt(endAt)],
      `create_week(${weekId.toString()})`,
    );
  }

  return sendEvmChainTx(
    "oracle",
    leagueAddress,
    ["function createWeek(uint256,uint64,uint64,uint64)"],
    `createWeek(${weekId.toString()})`,
    (league, overrides) =>
      (league as any).createWeek(
        weekId,
        startAt,
        lockAt,
        endAt,
        overrides,
      ),
  );
};

export const sendTransitionOnchain = async (
  leagueAddress: string,
  action: "lock" | "start",
  weekId: bigint,
  useForce: boolean,
): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    const fnName = useForce
      ? action === "lock"
        ? "force_lock_week"
        : "force_start_week"
      : action === "lock"
      ? "lock_week"
      : "start_week";
    return sendStarknetInvoke("oracle", leagueAddress, fnName, [weekId], `${fnName}(${weekId.toString()})`);
  }

  const abi = [
    "function lockWeek(uint256)",
    "function startWeek(uint256)",
    "function forceLockWeek(uint256)",
    "function forceStartWeek(uint256)",
  ] as const;
  const fnName = useForce
    ? action === "lock"
      ? "forceLockWeek"
      : "forceStartWeek"
    : action === "lock"
    ? "lockWeek"
    : "startWeek";

  return sendEvmChainTx("oracle", leagueAddress, abi, `${fnName}(${weekId.toString()})`, (league, overrides) =>
    (league as Record<string, (...args: unknown[]) => Promise<unknown>>)[fnName](weekId, overrides),
  );
};

export const sendFinalizeOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  root: string,
  metadataHash: string,
  retainedFee: bigint,
  useForce: boolean,
): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    const fnName = useForce ? "force_finalize_week" : "finalize_week";
    const rootFelt = normalizeHashForStarknetFelt(root);
    const metadataHashFelt = normalizeHashForStarknetFelt(metadataHash);
    return sendStarknetInvoke(
      "oracle",
      leagueAddress,
      fnName,
      [weekId, rootFelt, metadataHashFelt, retainedFee],
      `${fnName}(${weekId.toString()})`,
    );
  }

  const abi = [
    "function finalizeWeek(uint256,bytes32,bytes32,uint256)",
    "function forceFinalizeWeek(uint256,bytes32,bytes32,uint256)",
  ] as const;
  const fnName = useForce ? "forceFinalizeWeek" : "finalizeWeek";

  return sendEvmChainTx("oracle", leagueAddress, abi, `${fnName}(${weekId.toString()})`, (league, overrides) =>
    (league as Record<string, (...args: unknown[]) => Promise<unknown>>)[fnName](
      weekId,
      root,
      metadataHash,
      retainedFee,
      overrides,
    ),
  );
};

export const sendApproveFinalizationOnchain = async (leagueAddress: string, weekId: bigint): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return sendStarknetInvoke("auditor", leagueAddress, "approve_finalization", [weekId], `approve_finalization(${weekId.toString()})`);
  }

  return sendEvmChainTx(
    "auditor",
    leagueAddress,
    ["function approveFinalization(uint256)"],
    `approveFinalization(${weekId.toString()})`,
    (league, overrides) =>
      (league as any).approveFinalization(
        weekId,
        overrides,
      ),
  );
};

export const sendRejectFinalizationOnchain = async (leagueAddress: string, weekId: bigint): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return sendStarknetInvoke("auditor", leagueAddress, "reject_finalization", [weekId], `reject_finalization(${weekId.toString()})`);
  }

  return sendEvmChainTx(
    "auditor",
    leagueAddress,
    ["function rejectFinalization(uint256)"],
    `rejectFinalization(${weekId.toString()})`,
    (league, overrides) =>
      (league as any).rejectFinalization(
        weekId,
        overrides,
      ),
  );
};

export const sendSetTestModeOnchain = async (leagueAddress: string, enabled: boolean): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return sendStarknetInvoke(
      "contract_admin",
      leagueAddress,
      "set_test_mode",
      [enabled ? 1n : 0n],
      `set_test_mode(${String(enabled)})`,
    );
  }

  return sendEvmChainTx(
    "contract_admin",
    leagueAddress,
    ["function setTestMode(bool)"],
    "setTestMode",
    (league, overrides) =>
      (league as any).setTestMode(enabled, overrides),
  );
};

export const sendPauseOnchain = async (leagueAddress: string): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return sendStarknetInvoke("pauser", leagueAddress, "pause", [], "pause");
  }

  return sendEvmChainTx(
    "pauser",
    leagueAddress,
    ["function pause()"],
    "pause",
    (league, overrides) => (league as any).pause(overrides),
  );
};

export const sendUnpauseOnchain = async (leagueAddress: string): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return sendStarknetInvoke("pauser", leagueAddress, "unpause", [], "unpause");
  }

  return sendEvmChainTx(
    "pauser",
    leagueAddress,
    ["function unpause()"],
    "unpause",
    (league, overrides) =>
      (league as any).unpause(overrides),
  );
};

export const isOnchainTxSuccessful = async (txHash: string): Promise<boolean> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    return withRuntimeStarknetProvider(async (provider) => {
      const receipt = await provider.getTransactionReceipt(txHash);
      const statusText = String((receipt as { execution_status?: string }).execution_status ?? "").toUpperCase();
      return statusText === "SUCCEEDED";
    });
  }

  const provider = await getRuntimeProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  return Boolean(receipt && Number(receipt.status) === 1);
};

export const mintStablecoinOnchain = async (
  stablecoinAddress: string,
  recipient: string,
  amountWei: bigint,
): Promise<string> => {
  const chainType = await getRuntimeChainType();
  if (chainType === "starknet") {
    const mintAbi = [
      {
        type: "function",
        name: "mint",
        inputs: [
          { name: "recipient", type: "core::starknet::contract_address::ContractAddress" },
          { name: "amount", type: "core::integer::u256" },
        ],
        outputs: [],
        state_mutability: "external",
      },
    ];
    return sendStarknetInvoke(
      "faucet_minter",
      stablecoinAddress,
      "mint",
      [recipient, toU256(amountWei)],
      `mint(${recipient})`,
      mintAbi,
    );
  }

  return sendEvmChainTx(
    "faucet_minter",
    stablecoinAddress,
    ["function mint(address,uint256)"],
    `faucetMint(${recipient})`,
    (token, overrides) =>
      (token as any).mint(recipient, amountWei, overrides),
  );
};















