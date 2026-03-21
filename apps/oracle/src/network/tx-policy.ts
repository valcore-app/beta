import { ethers } from "ethers";
import { env } from "../env.js";

type TxOverrides = {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasLimit?: bigint;
};

type TxResponseLike = {
  hash: string;
  wait: (confirmations?: number) => Promise<ethers.TransactionReceipt | null>;
};

type SendTxOptions = {
  label: string;
  signer: ethers.Signer;
  send: (overrides: TxOverrides) => Promise<TxResponseLike>;
  estimateGas?: (overrides: TxOverrides) => Promise<bigint>;
};

type SendTxResult = {
  txHash: string;
  receipt: ethers.TransactionReceipt;
  attempts: number;
};

const toPositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) return fallback;
  return parsed;
};

const toNonNegativeInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return fallback;
  return parsed;
};

const RETRY_BASE_MS = toPositiveInt(env.CHAIN_TX_RETRY_BASE_MS, 1500);
const MAX_ATTEMPTS = toPositiveInt(env.CHAIN_TX_MAX_ATTEMPTS, 4);
const FEE_BUMP_BPS = toNonNegativeInt(env.CHAIN_TX_FEE_BUMP_BPS, 1500);
const GAS_LIMIT_BUFFER_BPS = toNonNegativeInt(env.CHAIN_TX_GAS_LIMIT_BUFFER_BPS, 2000);
const CONFIRMATIONS = toPositiveInt(env.CHAIN_TX_CONFIRMATIONS, 1);

const RETRYABLE_HINTS = [
  "replacement fee too low",
  "max fee per gas",
  "base fee",
  "fee too low",
  "underpriced",
  "nonce too low",
  "already known",
  "temporarily unavailable",
  "timeout",
  "timed out",
  "429",
  "502",
  "503",
  "504",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bumpByAttempt = (value: bigint, attempt: number) => {
  if (attempt <= 1 || FEE_BUMP_BPS <= 0) return value;
  const multiplierBps = BigInt(10_000 + FEE_BUMP_BPS * (attempt - 1));
  return (value * multiplierBps + 9_999n) / 10_000n;
};

const addGasLimitBuffer = (gasLimit: bigint) => {
  if (GAS_LIMIT_BUFFER_BPS <= 0) return gasLimit;
  const multiplierBps = BigInt(10_000 + GAS_LIMIT_BUFFER_BPS);
  return (gasLimit * multiplierBps + 9_999n) / 10_000n;
};

const normalizeErrorMessage = (error: unknown) => {
  if (error instanceof Error) return `${error.message}`.toLowerCase();
  return String(error ?? "unknown").toLowerCase();
};

const isRetryableError = (error: unknown) => {
  const message = normalizeErrorMessage(error);
  return RETRYABLE_HINTS.some((hint) => message.includes(hint));
};

const buildFeeOverrides = async (
  signer: ethers.Signer,
  attempt: number,
): Promise<TxOverrides> => {
  const provider = signer.provider;
  if (!provider) {
    throw new Error("Signer provider is missing for tx policy");
  }
  const feeData = await provider.getFeeData();
  const overrides: TxOverrides = {};
  if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
    overrides.maxFeePerGas = bumpByAttempt(feeData.maxFeePerGas, attempt);
    overrides.maxPriorityFeePerGas = bumpByAttempt(feeData.maxPriorityFeePerGas, attempt);
    if (overrides.maxPriorityFeePerGas >= overrides.maxFeePerGas) {
      overrides.maxFeePerGas = overrides.maxPriorityFeePerGas + 1n;
    }
    return overrides;
  }
  if (feeData.gasPrice != null) {
    overrides.gasPrice = bumpByAttempt(feeData.gasPrice, attempt);
  }
  return overrides;
};

export const sendTxWithPolicy = async ({
  label,
  signer,
  send,
  estimateGas,
}: SendTxOptions): Promise<SendTxResult> => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const overrides = await buildFeeOverrides(signer, attempt);
    if (estimateGas) {
      const estimated = await estimateGas(overrides);
      overrides.gasLimit = addGasLimitBuffer(estimated);
    }
    try {
      const tx = await send(overrides);
      const receipt = await tx.wait(CONFIRMATIONS);
      if (!receipt) {
        throw new Error(`${label} returned empty receipt`);
      }
      return {
        txHash: tx.hash,
        receipt,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} failed after ${attempt} attempt(s): ${message}`);
      }
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
  throw new Error(
    `${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};
