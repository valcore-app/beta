import { ethers } from "ethers";
import { env } from "../env.js";
import {
  getRuntimeProvider,
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

const REACTIVE_ACTION_LOCK = 2;
const REACTIVE_ACTION_START = 3;
const REACTIVE_EXECUTED_TOPIC0 = ethers.id("ReactiveLifecycleExecuted(bytes32,uint8,uint256)");

const REACTIVE_DISPATCHER_ABI = [
  "function dispatch(bytes payload,uint64 gasLimit)",
  "function coverDebt() payable",
  "function destinationChainId() view returns (uint256)",
  "function destinationReceiver() view returns (address)",
  "function operator() view returns (address)",
] as const;
const REACTIVE_RECEIVER_ABI = [
  "function rxCreateWeek(address,bytes32,uint256,uint64,uint64,uint64)",
  "function rxTransition(address,bytes32,uint8,uint256,bool)",
  "function rxFinalize(address,bytes32,uint256,bytes32,bytes32,uint256,bool)",
  "function rxApprove(address,bytes32,uint256)",
  "function rxReject(address,bytes32,uint256)",
  "function coverDebt()",
] as const;
const REACTIVE_RECEIVER_VIEW_ABI = [
  "function reactiveSender() view returns (address)",
] as const;
const REACTIVE_CALLBACK_PROXY_ABI = [
  "function debt(address) view returns (uint256)",
] as const;
const REACTIVE_SYSTEM_ABI = [
  "function debt(address) view returns (uint256)",
] as const;
const REACTIVE_SYSTEM_ADDRESS = "0x0000000000000000000000000000000000fffFfF";

const normalizeHex = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "0x0";
  if (raw.startsWith("0x") || raw.startsWith("0X")) return raw.toLowerCase();
  return `0x${BigInt(raw).toString(16)}`;
};

const asBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return 0n;
    return BigInt(normalized);
  }
  return 0n;
};

const asNumber = (value: unknown) => Number(asBigInt(value));

const normalizeAddress = (value: string, label: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is not configured`);
  }
  return ethers.getAddress(normalized);
};

const toPositiveIntEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const FUNDING_PENDING_PREFIX = "FUNDING_PENDING";

const parseEthEnvToWei = (raw: string | undefined, fallback: string, label: string): bigint => {
  const text = String(raw ?? "").trim() || fallback;
  try {
    return ethers.parseEther(text);
  } catch {
    throw new Error(`${label} is invalid: ${text}`);
  }
};

const CHAIN_GAS_MIN_BALANCE_WEI = parseEthEnvToWei(
  env.CHAIN_GAS_MIN_BALANCE_ETH,
  "0.02",
  "CHAIN_GAS_MIN_BALANCE_ETH",
);
const CHAIN_GAS_BANK_TOPUP_WEI = parseEthEnvToWei(
  env.CHAIN_GAS_BANK_TOPUP_ETH,
  "0.3",
  "CHAIN_GAS_BANK_TOPUP_ETH",
);
const REACTIVE_EXECUTOR_MIN_BALANCE_WEI = parseEthEnvToWei(
  env.REACTIVE_EXECUTOR_MIN_BALANCE_ETH,
  "0.03",
  "REACTIVE_EXECUTOR_MIN_BALANCE_ETH",
);
const REACTIVE_GAS_BANK_TOPUP_WEI = parseEthEnvToWei(
  env.REACTIVE_GAS_BANK_TOPUP_ETH,
  "3",
  "REACTIVE_GAS_BANK_TOPUP_ETH",
);
const REACTIVE_RECEIVER_DEBT_BUFFER_WEI = parseEthEnvToWei(
  (env as any).REACTIVE_RECEIVER_DEBT_BUFFER_ETH ?? env.REACTIVE_DISPATCHER_DEBT_BUFFER_ETH,
  "0.02",
  "REACTIVE_RECEIVER_DEBT_BUFFER_ETH",
);

const ensureWalletFundedByBank = async ({
  provider,
  targetAddress,
  targetLabel,
  minBalanceWei,
  topupWei,
  bankPrivateKey,
  bankLabel,
}: {
  provider: ethers.Provider;
  targetAddress: string;
  targetLabel: string;
  minBalanceWei: bigint;
  topupWei: bigint;
  bankPrivateKey?: string;
  bankLabel: string;
}) => {
  const currentBalance = await provider.getBalance(targetAddress);
  if (currentBalance >= minBalanceWei) return;

  const missing = minBalanceWei - currentBalance;
  const bankPk = String(bankPrivateKey ?? "").trim();
  if (!bankPk) {
    throw new Error(
      `${FUNDING_PENDING_PREFIX}: ${targetLabel} low balance (${ethers.formatEther(currentBalance)} < ${ethers.formatEther(
        minBalanceWei,
      )}). Fund ${targetAddress} manually or set ${bankLabel}. Missing at least ${ethers.formatEther(missing)} native.`,
    );
  }

  const bankWallet = new ethers.Wallet(bankPk, provider);
  const normalizedTarget = ethers.getAddress(targetAddress);
  if (bankWallet.address.toLowerCase() === normalizedTarget.toLowerCase()) {
    throw new Error(`${FUNDING_PENDING_PREFIX}: ${bankLabel} cannot equal target wallet ${normalizedTarget}`);
  }

  const bankBalance = await provider.getBalance(bankWallet.address);
  const feeData = await provider.getFeeData().catch(() => null);
  const gasPrice = feeData?.gasPrice ?? 0n;
  const gasReserve = gasPrice > 0n ? gasPrice * 120_000n : ethers.parseEther("0.0002");
  if (bankBalance < topupWei + gasReserve) {
    throw new Error(
      `${FUNDING_PENDING_PREFIX}: ${bankLabel} (${bankWallet.address}) has insufficient balance. Need ${ethers.formatEther(
        topupWei + gasReserve,
      )}, have ${ethers.formatEther(bankBalance)}.`,
    );
  }

  const topupTx = await bankWallet.sendTransaction({
    to: normalizedTarget,
    value: topupWei,
  });
  await topupTx.wait();

  const afterBalance = await provider.getBalance(normalizedTarget);
  if (afterBalance < minBalanceWei) {
    throw new Error(
      `${FUNDING_PENDING_PREFIX}: ${targetLabel} still below minimum after bank top-up. Current ${ethers.formatEther(
        afterBalance,
      )}, required ${ethers.formatEther(minBalanceWei)}.`,
    );
  }
};

const resolveLifecycleIntentOpKey = (value: string | undefined, fallback: string) => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};

const toIntentId = (opKey: string) => ethers.id(opKey);

type ReactiveTransportConfig = {
  rpcUrl: string;
  chainId: number;
  executorPrivateKey: string;
  dispatcherAddress: string;
  receiverAddress: string;
  gasLimit: bigint;
  waitMs: number;
  pollMs: number;
};

let reactiveDispatcherPreflightCacheKey: string | null = null;
let reactiveDispatcherResolvedSender: string | null = null;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(
  fn: () => Promise<T>,
  attempts: number,
  retryDelayMs: number,
  label: string,
): Promise<T> => {
  let lastError: unknown = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        await wait(retryDelayMs);
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`${label} failed after ${attempts} attempts: ${message}`);
};

const getReactiveTransportConfig = async (): Promise<ReactiveTransportConfig | null> => {
  const mode = String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase();
  if (mode !== "REACTIVE") return null;

  const rpcUrl = String(env.REACTIVE_CHAIN_RPC_URL ?? "").trim();
  const executorPrivateKey = String(env.REACTIVE_EXECUTOR_PRIVATE_KEY ?? "").trim();
  const dispatcherAddressRaw = String(env.REACTIVE_DISPATCHER_ADDRESS ?? "").trim();
  const receiverAddressRaw = String(env.REACTIVE_RECEIVER_ADDRESS ?? "").trim();

  if (!rpcUrl || !executorPrivateKey || !dispatcherAddressRaw || !receiverAddressRaw) {
    throw new Error(
      "Reactive transport is enabled but REACTIVE_CHAIN_RPC_URL / REACTIVE_EXECUTOR_PRIVATE_KEY / REACTIVE_DISPATCHER_ADDRESS / REACTIVE_RECEIVER_ADDRESS are missing",
    );
  }

  return {
    rpcUrl,
    chainId: toPositiveIntEnv(env.REACTIVE_CHAIN_ID, 5318007),
    executorPrivateKey,
    dispatcherAddress: normalizeAddress(dispatcherAddressRaw, "REACTIVE_DISPATCHER_ADDRESS"),
    receiverAddress: normalizeAddress(receiverAddressRaw, "REACTIVE_RECEIVER_ADDRESS"),
    gasLimit: BigInt(toPositiveIntEnv(env.REACTIVE_CALLBACK_GAS_LIMIT, 900000)),
    waitMs: toPositiveIntEnv(env.REACTIVE_DESTINATION_WAIT_MS, 240000),
    pollMs: Math.max(1000, toPositiveIntEnv(env.REACTIVE_DESTINATION_POLL_MS, 3000)),
  };
};

const ensureReactiveDispatcherPreflight = async (config: ReactiveTransportConfig) => {
  const cacheKey = [
    config.rpcUrl.toLowerCase(),
    String(config.chainId),
    config.dispatcherAddress.toLowerCase(),
    config.receiverAddress.toLowerCase(),
    config.executorPrivateKey.toLowerCase(),
  ].join("|");
  const cachedStaticPreflight = reactiveDispatcherPreflightCacheKey === cacheKey;

  const reactiveProvider = new ethers.JsonRpcProvider(
    config.rpcUrl,
    { chainId: config.chainId, name: "reactive" },
    { staticNetwork: true },
  );
  const dispatcher = new ethers.Contract(config.dispatcherAddress, REACTIVE_DISPATCHER_ABI, reactiveProvider);
  const preflightTimeoutMs = Math.max(3000, toPositiveIntEnv(process.env.REACTIVE_PREFLIGHT_TIMEOUT_MS, 15000));
  const preflightRetryAttempts = Math.max(1, toPositiveIntEnv(process.env.REACTIVE_PREFLIGHT_RETRY_ATTEMPTS, 3));
  const preflightRetryDelayMs = Math.max(250, toPositiveIntEnv(process.env.REACTIVE_PREFLIGHT_RETRY_DELAY_MS, 1200));
  const preflightTxWaitMs = Math.max(
    preflightTimeoutMs,
    toPositiveIntEnv(process.env.REACTIVE_PREFLIGHT_TX_WAIT_MS, 180000),
  );
  const destinationProvider = await getRuntimeProvider();

  if (!cachedStaticPreflight) {
    const destinationNetwork = await withTimeout(
      destinationProvider.getNetwork(),
      preflightTimeoutMs,
      "reactive preflight: destination.getNetwork",
    );
    const expectedDestinationChainId = BigInt(destinationNetwork.chainId);
    const expectedDestinationReceiver = config.receiverAddress.toLowerCase();
    const expectedOperator = new ethers.Wallet(config.executorPrivateKey).address.toLowerCase();

    const [destinationChainId, destinationReceiver, operator] = await withRetry(
      () =>
        Promise.all([
          withTimeout(dispatcher.destinationChainId(), preflightTimeoutMs, "reactive preflight: dispatcher.destinationChainId"),
          withTimeout(dispatcher.destinationReceiver(), preflightTimeoutMs, "reactive preflight: dispatcher.destinationReceiver"),
          withTimeout(dispatcher.operator(), preflightTimeoutMs, "reactive preflight: dispatcher.operator"),
        ]),
      preflightRetryAttempts,
      preflightRetryDelayMs,
      "reactive preflight: dispatcher static reads",
    );

    if (BigInt(destinationChainId) !== expectedDestinationChainId) {
      throw new Error(
        `Reactive dispatcher destinationChainId mismatch: expected=${expectedDestinationChainId.toString()} got=${BigInt(destinationChainId).toString()}`,
      );
    }

    if (String(destinationReceiver).toLowerCase() !== expectedDestinationReceiver) {
      throw new Error(
        `Reactive dispatcher destinationReceiver mismatch: expected=${expectedDestinationReceiver} got=${String(destinationReceiver).toLowerCase()}`,
      );
    }

    if (String(operator).toLowerCase() !== expectedOperator) {
      throw new Error(
        `Reactive dispatcher operator mismatch: expected=${expectedOperator} got=${String(operator).toLowerCase()}`,
      );
    }

    const mapping = await withRetry(
      () =>
        withTimeout(
          reactiveProvider.send("rnk_getRnkAddressMapping", [config.dispatcherAddress]),
          preflightTimeoutMs,
          "reactive preflight: rnk_getRnkAddressMapping",
        ),
      preflightRetryAttempts,
      preflightRetryDelayMs,
      "reactive preflight: dispatcher mapping read",
    );
    const mappedRvmIdRaw = String(
      (mapping as { rvmId?: unknown; RvmId?: unknown } | null | undefined)?.rvmId ??
        (mapping as { rvmId?: unknown; RvmId?: unknown } | null | undefined)?.RvmId ??
        "",
    ).trim();
    if (!mappedRvmIdRaw) {
      throw new Error("Reactive dispatcher RVM mapping is missing (rnk_getRnkAddressMapping)");
    }
    const expectedReactiveSender = ethers.getAddress(mappedRvmIdRaw).toLowerCase();
    const receiver = new ethers.Contract(config.receiverAddress, REACTIVE_RECEIVER_VIEW_ABI, destinationProvider);
    const configuredReactiveSender = String(
      await withRetry(
        () => withTimeout(receiver.reactiveSender(), preflightTimeoutMs, "reactive preflight: receiver.reactiveSender"),
        preflightRetryAttempts,
        preflightRetryDelayMs,
        "reactive preflight: receiver reactive sender read",
      ),
    ).toLowerCase();
    if (configuredReactiveSender !== expectedReactiveSender) {
      throw new Error(
        `Reactive receiver reactiveSender mismatch: expected=${expectedReactiveSender} got=${configuredReactiveSender}`,
      );
    }

    reactiveDispatcherResolvedSender = expectedReactiveSender;
    reactiveDispatcherPreflightCacheKey = cacheKey;
  }

  const executor = new ethers.Wallet(config.executorPrivateKey, reactiveProvider);
  await ensureWalletFundedByBank({
    provider: reactiveProvider,
    targetAddress: executor.address,
    targetLabel: `reactive executor ${executor.address}`,
    minBalanceWei: REACTIVE_EXECUTOR_MIN_BALANCE_WEI,
    topupWei: REACTIVE_GAS_BANK_TOPUP_WEI,
    bankPrivateKey: env.REACTIVE_GAS_BANK_PRIVATE_KEY,
    bankLabel: "REACTIVE_GAS_BANK_PRIVATE_KEY",
  });

  const reactiveSystem = new ethers.Contract(REACTIVE_SYSTEM_ADDRESS, REACTIVE_SYSTEM_ABI, reactiveProvider);
  let [dispatcherBalance, dispatcherDebt] = await withRetry(
    () =>
      Promise.all([
        withTimeout(reactiveProvider.getBalance(config.dispatcherAddress), preflightTimeoutMs, "reactive preflight: dispatcher balance"),
        withTimeout(reactiveSystem.debt(config.dispatcherAddress), preflightTimeoutMs, "reactive preflight: dispatcher debt"),
      ]),
    preflightRetryAttempts,
    preflightRetryDelayMs,
    "reactive preflight: dispatcher funding reads",
  );
  const bufferRaw = String(env.REACTIVE_DISPATCHER_DEBT_BUFFER_ETH ?? "0.02").trim();
  const bufferWei = ethers.parseEther(bufferRaw || "0.02");
  const requiredDispatcherBalance = dispatcherDebt + bufferWei;
  if (dispatcherBalance < requiredDispatcherBalance) {
    let executorBalance = await withTimeout(
      reactiveProvider.getBalance(executor.address),
      preflightTimeoutMs,
      "reactive preflight: executor balance",
    );
    const requiredValue = requiredDispatcherBalance - dispatcherBalance;

    const gasPrice = await withTimeout(
      reactiveProvider.getFeeData().then((fee) => fee.gasPrice ?? 0n).catch(() => 0n),
      preflightTimeoutMs,
      "reactive preflight: feeData",
    );
    const estimatedGasReserve = gasPrice > 0n ? gasPrice * 300_000n : ethers.parseEther("0.0001");
    if (executorBalance < requiredValue + estimatedGasReserve) {
      await ensureWalletFundedByBank({
        provider: reactiveProvider,
        targetAddress: executor.address,
        targetLabel: `reactive executor ${executor.address} (debt cover)`,
        minBalanceWei: requiredValue + estimatedGasReserve,
        topupWei: REACTIVE_GAS_BANK_TOPUP_WEI,
        bankPrivateKey: env.REACTIVE_GAS_BANK_PRIVATE_KEY,
        bankLabel: "REACTIVE_GAS_BANK_PRIVATE_KEY",
      });
      executorBalance = await withTimeout(
        reactiveProvider.getBalance(executor.address),
        preflightTimeoutMs,
        "reactive preflight: executor balance post-topup",
      );
      if (executorBalance < requiredValue + estimatedGasReserve) {
        throw new Error(
          `${FUNDING_PENDING_PREFIX}: Reactive dispatcher debt cover still lacks executor balance. dispatcher=${config.dispatcherAddress} balance=${ethers.formatEther(
            dispatcherBalance,
          )} debt=${ethers.formatEther(dispatcherDebt)} requiredTopup=${ethers.formatEther(
            requiredValue,
          )} executor=${executor.address} executorBalance=${ethers.formatEther(executorBalance)}`,
        );
      }
    }

    const dispatcherWithExecutor = new ethers.Contract(config.dispatcherAddress, REACTIVE_DISPATCHER_ABI, executor);
    const topupTx = await withTimeout(
      executor.sendTransaction({
        to: config.dispatcherAddress,
        value: requiredValue,
      }),
      preflightTimeoutMs,
      "reactive preflight: dispatcher topup send",
    );
    await withTimeout(
      topupTx.wait(),
      preflightTxWaitMs,
      "reactive preflight: dispatcher topup confirmation",
    );
    if (dispatcherDebt > 0n) {
      const coverTx = await withTimeout(
        dispatcherWithExecutor.coverDebt(),
        preflightTimeoutMs,
        "reactive preflight: coverDebt send",
      );
      await withTimeout(
        coverTx.wait(),
        preflightTxWaitMs,
        "reactive preflight: coverDebt confirmation",
      );
    }

    [dispatcherBalance, dispatcherDebt] = await withRetry(
      () =>
        Promise.all([
          withTimeout(
            reactiveProvider.getBalance(config.dispatcherAddress),
            preflightTimeoutMs,
            "reactive preflight: dispatcher balance post-topup",
          ),
          withTimeout(
            reactiveSystem.debt(config.dispatcherAddress),
            preflightTimeoutMs,
            "reactive preflight: dispatcher debt post-topup",
          ),
        ]),
      preflightRetryAttempts,
      preflightRetryDelayMs,
      "reactive preflight: dispatcher funding reads post-topup",
    );

    if (dispatcherBalance < dispatcherDebt + bufferWei) {
      throw new Error(
        `Reactive dispatcher still underfunded after auto-topup: address=${config.dispatcherAddress} balance=${ethers.formatEther(dispatcherBalance)} debt=${ethers.formatEther(dispatcherDebt)} buffer=${ethers.formatEther(bufferWei)}`,
      );
    }
  }

  const callbackProxyAddress = normalizeAddress(
    String(env.REACTIVE_CALLBACK_PROXY_ADDRESS ?? "").trim(),
    "REACTIVE_CALLBACK_PROXY_ADDRESS",
  );
  const callbackProxy = new ethers.Contract(callbackProxyAddress, REACTIVE_CALLBACK_PROXY_ABI, destinationProvider);

  let [receiverDebt, receiverBalance] = await withRetry(
    () =>
      Promise.all([
        withTimeout(
          callbackProxy.debt(config.receiverAddress),
          preflightTimeoutMs,
          "reactive preflight: callbackProxy.debt(receiver)",
        ),
        withTimeout(
          destinationProvider.getBalance(config.receiverAddress),
          preflightTimeoutMs,
          "reactive preflight: receiver balance",
        ),
      ]),
    preflightRetryAttempts,
    preflightRetryDelayMs,
    "reactive preflight: receiver debt reads",
  );

  const requiredReceiverBalance = receiverDebt + REACTIVE_RECEIVER_DEBT_BUFFER_WEI;
  if (receiverBalance < requiredReceiverBalance) {
    await ensureWalletFundedByBank({
      provider: destinationProvider,
      targetAddress: config.receiverAddress,
      targetLabel: `reactive receiver ${config.receiverAddress}`,
      minBalanceWei: requiredReceiverBalance,
      topupWei: CHAIN_GAS_BANK_TOPUP_WEI,
      bankPrivateKey: env.CHAIN_GAS_BANK_PRIVATE_KEY,
      bankLabel: "CHAIN_GAS_BANK_PRIVATE_KEY",
    });
    receiverBalance = await withTimeout(
      destinationProvider.getBalance(config.receiverAddress),
      preflightTimeoutMs,
      "reactive preflight: receiver balance post-topup",
    );
    if (receiverBalance < requiredReceiverBalance) {
      throw new Error(
        `${FUNDING_PENDING_PREFIX}: reactive receiver still underfunded after top-up. receiver=${config.receiverAddress} balance=${ethers.formatEther(
          receiverBalance,
        )} required=${ethers.formatEther(requiredReceiverBalance)}`,
      );
    }
  }

  if (receiverDebt > 0n) {
    const debtSettlerPk = String(env.CHAIN_GAS_BANK_PRIVATE_KEY ?? "").trim() || await getRequiredRuntimeOraclePrivateKey();
    const debtSettler = new ethers.Wallet(debtSettlerPk, destinationProvider);
    const receiverWithSettler = new ethers.Contract(config.receiverAddress, REACTIVE_RECEIVER_ABI, debtSettler);
    const coverTx = (await withTimeout(
      (receiverWithSettler as any).coverDebt(),
      preflightTimeoutMs,
      "reactive preflight: receiver coverDebt send",
    )) as { wait: () => Promise<unknown> };
    await withTimeout(
      coverTx.wait(),
      preflightTxWaitMs,
      "reactive preflight: receiver coverDebt confirmation",
    );

    receiverDebt = await withRetry(
      () =>
        withTimeout(
          callbackProxy.debt(config.receiverAddress),
          preflightTimeoutMs,
          "reactive preflight: callbackProxy.debt(receiver) post-cover",
        ),
      preflightRetryAttempts,
      preflightRetryDelayMs,
      "reactive preflight: receiver debt read post-cover",
    );

    if (receiverDebt > 0n) {
      throw new Error(
        `Reactive receiver debt remains after coverDebt: receiver=${config.receiverAddress} debt=${ethers.formatEther(receiverDebt)}`,
      );
    }
  }

};

const getReactiveSenderForPayload = async (config: ReactiveTransportConfig): Promise<string> => {
  await ensureReactiveDispatcherPreflight(config);
  if (!reactiveDispatcherResolvedSender) {
    throw new Error("Reactive dispatcher sender mapping is unavailable");
  }
  return ethers.getAddress(reactiveDispatcherResolvedSender);
};

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

const REACTIVE_DESTINATION_READ_TIMEOUT_MS = Math.max(
  3000,
  toPositiveIntEnv(process.env.REACTIVE_DESTINATION_READ_TIMEOUT_MS, 10000),
);

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForWeekStatus = async (
  leagueAddress: string,
  weekId: bigint,
  expectedStatus: number,
  waitMs: number,
  pollMs: number,
  label: string,
) => {
  const deadline = Date.now() + waitMs;
  let lastStatus = -1;
  let lastReadError: string | null = null;
  while (Date.now() <= deadline) {
    try {
      const state = await withTimeout(
        getOnchainWeekState(leagueAddress, weekId),
        REACTIVE_DESTINATION_READ_TIMEOUT_MS,
        `${label}: getOnchainWeekState`,
      );
      const status = Number(state.status ?? 0);
      if (status === expectedStatus) {
        return;
      }
      lastStatus = status;
      lastReadError = null;
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : String(error);
    }
    await sleepMs(pollMs);
  }
  const readSuffix = lastReadError ? `; lastReadError=${lastReadError}` : "";
  throw new Error(
    `${label}: destination week status did not reach ${expectedStatus} in ${waitMs}ms (last=${lastStatus})${readSuffix}`,
  );
};

const findReactiveCallbackDestinationTx = async (
  receiverAddress: string,
  intentId: string,
  fromBlockInclusive: number,
): Promise<string | null> => {
  const provider = await getRuntimeProvider();
  const latest = await provider.getBlockNumber();
  if (latest < fromBlockInclusive) return null;

  const logs = await provider.getLogs({
    address: receiverAddress,
    fromBlock: fromBlockInclusive,
    toBlock: latest,
    topics: [REACTIVE_EXECUTED_TOPIC0, intentId],
  });

  const txHash = String(logs[logs.length - 1]?.transactionHash ?? "").trim().toLowerCase();
  if (!txHash) return null;
  return txHash;
};

type ReactiveDispatchResult = {
  reactiveTxHash: string;
  destinationTxHash: string | null;
};

const dispatchReactiveCallback = async (
  payload: string,
  label: string,
  leagueAddress: string,
  weekId: bigint,
  expectedStatusAfter: number,
  intentId: string,
): Promise<ReactiveDispatchResult> => {
  const config = await getReactiveTransportConfig();
  if (!config) {
    throw new Error("Reactive dispatch requested while reactive transport is disabled");
  }
  await ensureReactiveDispatcherPreflight(config);

  const destinationProvider = await getRuntimeProvider();
  const startBlock = await destinationProvider.getBlockNumber();

  const reactiveProvider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const reactiveWallet = new ethers.Wallet(config.executorPrivateKey, reactiveProvider);
  const dispatcher = new ethers.Contract(config.dispatcherAddress, REACTIVE_DISPATCHER_ABI, reactiveWallet);
  let sent: Awaited<ReturnType<typeof sendTxWithPolicy>>;
  try {
    sent = await sendTxWithPolicy({
      label,
      signer: reactiveWallet,
      send: (overrides) => (dispatcher as any).dispatch(payload, config.gasLimit, overrides),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.toLowerCase().includes("insufficient funds")) {
      throw new Error(`${FUNDING_PENDING_PREFIX}: reactive dispatcher send has insufficient funds. ${message}`);
    }
    throw error;
  }

  const reactiveTxHash = String(sent.txHash ?? "").toLowerCase();
  try {
    await waitForWeekStatus(leagueAddress, weekId, expectedStatusAfter, config.waitMs, config.pollMs, label);

    const destinationTxHash = await findReactiveCallbackDestinationTx(config.receiverAddress, intentId, startBlock);
    return {
      reactiveTxHash,
      destinationTxHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(
      `${label}: reactive tx submitted ${reactiveTxHash}; destination confirmation pending. ${message}`,
    ) as Error & { reactiveTxHash?: string; destinationTxHash?: string | null };
    wrapped.reactiveTxHash = reactiveTxHash;
    try {
      wrapped.destinationTxHash = await findReactiveCallbackDestinationTx(
        config.receiverAddress,
        intentId,
        startBlock,
      );
    } catch {
      wrapped.destinationTxHash = null;
    }
    throw wrapped;
  }
};

const getEvmPrivateKeyByRole = async (role: EvmRole): Promise<string> => {
  if (role === "oracle") return getRequiredRuntimeOraclePrivateKey();
  if (role === "auditor") return getRequiredRuntimeAuditorPrivateKey();
  if (role === "contract_admin") return getRequiredRuntimeContractAdminPrivateKey();
  if (role === "pauser") return getRequiredRuntimePauserPrivateKey();
  return getRequiredRuntimeFaucetMinterPrivateKey();
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

  await ensureWalletFundedByBank({
    provider,
    targetAddress: wallet.address,
    targetLabel: `${label} signer ${wallet.address}`,
    minBalanceWei: CHAIN_GAS_MIN_BALANCE_WEI,
    topupWei: CHAIN_GAS_BANK_TOPUP_WEI,
    bankPrivateKey: env.CHAIN_GAS_BANK_PRIVATE_KEY,
    bankLabel: "CHAIN_GAS_BANK_PRIVATE_KEY",
  });

  let sent: Awaited<ReturnType<typeof sendTxWithPolicy>>;
  try {
    sent = await sendTxWithPolicy({
      label,
      signer: wallet,
      send: (overrides) =>
        sender(
          contract,
          overrides,
        ) as Promise<{ hash: string; wait: (confirmations?: number) => Promise<ethers.TransactionReceipt | null> }>,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message.toLowerCase().includes("insufficient funds")) {
      throw new Error(`${FUNDING_PENDING_PREFIX}: ${label} signer has insufficient funds. ${message}`);
    }
    throw error;
  }

  return sent.txHash;
};

export const getOnchainFeeBps = async (leagueAddress: string): Promise<number> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function feeBps() view returns (uint16)"], provider);
  return Number(
    await withTimeout(
      league.feeBps(),
      REACTIVE_DESTINATION_READ_TIMEOUT_MS,
      "feeBps()",
    ),
  );
};

export const getOnchainWeekState = async (leagueAddress: string, weekId: bigint): Promise<ChainWeekState> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(
    leagueAddress,
    [
      "function weekStates(uint256) view returns (uint64,uint64,uint64,uint64,uint8,uint128,uint128,bytes32,bytes32)",
    ],
    provider,
  );
  const state = await withTimeout(
    league.weekStates(weekId),
    REACTIVE_DESTINATION_READ_TIMEOUT_MS,
    `weekStates(${weekId.toString()})`,
  );
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
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(
    leagueAddress,
    [
      "function positions(uint256,address) view returns (uint128 principal,uint128 risk,uint128 forfeitedReward,bytes32 lineupHash,uint8 swaps,bool claimed)",
    ],
    provider,
  );
  const state = await withTimeout(
    league.positions(weekId, address),
    REACTIVE_DESTINATION_READ_TIMEOUT_MS,
    `positions(${weekId.toString()},${address})`,
  );
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
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function testMode() view returns (bool)"], provider);
  return Boolean(
    await withTimeout(
      league.testMode(),
      REACTIVE_DESTINATION_READ_TIMEOUT_MS,
      "testMode()",
    ),
  );
};

export const getOnchainPaused = async (leagueAddress: string): Promise<boolean> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function paused() view returns (bool)"], provider);
  return Boolean(
    await withTimeout(
      league.paused(),
      REACTIVE_DESTINATION_READ_TIMEOUT_MS,
      "paused()",
    ),
  );
};

export const createWeekOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  startAt: number,
  lockAt: number,
  endAt: number,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(lifecycleIntentOpKey, `create:${weekId.toString()}:${startAt}:${lockAt}:${endAt}`);
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxCreateWeek", [
      reactiveSender,
      intentId,
      weekId,
      startAt,
      lockAt,
      endAt,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.createWeek(${weekId.toString()})`,
      leagueAddress,
      weekId,
      1,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  return sendEvmChainTx(
    "oracle",
    leagueAddress,
    ["function createWeekWithIntent(bytes32,uint256,uint64,uint64,uint64)"],
    `createWeekWithIntent(${weekId.toString()})`,
    (league, overrides) =>
      (league as any).createWeekWithIntent(
        intentId,
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
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(
    lifecycleIntentOpKey,
    `transition:${action}:${weekId.toString()}:${useForce ? "force" : "timed"}`,
  );
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const actionCode = action === "lock" ? REACTIVE_ACTION_LOCK : REACTIVE_ACTION_START;
    const expectedStatus = action === "lock" ? 2 : 3;
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxTransition", [
      reactiveSender,
      intentId,
      actionCode,
      weekId,
      useForce,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.${action}Week(${weekId.toString()})`,
      leagueAddress,
      weekId,
      expectedStatus,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  const abi = [
    "function lockWeekWithIntent(bytes32,uint256)",
    "function startWeekWithIntent(bytes32,uint256)",
    "function forceLockWeekWithIntent(bytes32,uint256)",
    "function forceStartWeekWithIntent(bytes32,uint256)",
  ] as const;
  const fnName = useForce
    ? action === "lock"
      ? "forceLockWeekWithIntent"
      : "forceStartWeekWithIntent"
    : action === "lock"
    ? "lockWeekWithIntent"
    : "startWeekWithIntent";

  return sendEvmChainTx("oracle", leagueAddress, abi, `${fnName}(${weekId.toString()})`, (league, overrides) =>
    (league as Record<string, (...args: unknown[]) => Promise<unknown>>)[fnName](intentId, weekId, overrides),
  );
};

export const sendFinalizeOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  root: string,
  metadataHash: string,
  retainedFee: bigint,
  useForce: boolean,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(
    lifecycleIntentOpKey,
    `finalize:${weekId.toString()}:${String(root).toLowerCase()}:${String(metadataHash).toLowerCase()}:${retainedFee.toString()}:${useForce ? "force" : "timed"}`,
  );
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxFinalize", [
      reactiveSender,
      intentId,
      weekId,
      root,
      metadataHash,
      retainedFee,
      useForce,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.finalizeWeek(${weekId.toString()})`,
      leagueAddress,
      weekId,
      4,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  const abi = [
    "function finalizeWeekWithIntent(bytes32,uint256,bytes32,bytes32,uint256)",
    "function forceFinalizeWeekWithIntent(bytes32,uint256,bytes32,bytes32,uint256)",
  ] as const;
  const fnName = useForce ? "forceFinalizeWeekWithIntent" : "finalizeWeekWithIntent";

  return sendEvmChainTx("oracle", leagueAddress, abi, `${fnName}(${weekId.toString()})`, (league, overrides) =>
    (league as Record<string, (...args: unknown[]) => Promise<unknown>>)[fnName](
      intentId,
      weekId,
      root,
      metadataHash,
      retainedFee,
      overrides,
    ),
  );
};

export const sendApproveFinalizationOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(lifecycleIntentOpKey, `approve:${weekId.toString()}`);
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxApprove", [
      reactiveSender,
      intentId,
      weekId,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.approveFinalization(${weekId.toString()})`,
      leagueAddress,
      weekId,
      5,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  return sendEvmChainTx(
    "auditor",
    leagueAddress,
    ["function approveFinalizationWithIntent(bytes32,uint256)"],
    `approveFinalizationWithIntent(${weekId.toString()})`,
    (league, overrides) => (league as any).approveFinalizationWithIntent(intentId, weekId, overrides),
  );
};

export const sendRejectFinalizationOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(lifecycleIntentOpKey, `reject:${weekId.toString()}`);
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxReject", [
      reactiveSender,
      intentId,
      weekId,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.rejectFinalization(${weekId.toString()})`,
      leagueAddress,
      weekId,
      3,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  return sendEvmChainTx(
    "auditor",
    leagueAddress,
    ["function rejectFinalizationWithIntent(bytes32,uint256)"],
    `rejectFinalizationWithIntent(${weekId.toString()})`,
    (league, overrides) => (league as any).rejectFinalizationWithIntent(intentId, weekId, overrides),
  );
};

export const sendSetTestModeOnchain = async (leagueAddress: string, enabled: boolean): Promise<string> => {
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
  return sendEvmChainTx(
    "pauser",
    leagueAddress,
    ["function pause()"],
    "pause",
    (league, overrides) => (league as any).pause(overrides),
  );
};

export const sendUnpauseOnchain = async (leagueAddress: string): Promise<string> => {
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
  const provider = await getRuntimeProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  return Boolean(receipt && Number(receipt.status) === 1);
};

export const mintStablecoinOnchain = async (
  stablecoinAddress: string,
  recipient: string,
  amountWei: bigint,
): Promise<string> => {
  return sendEvmChainTx(
    "faucet_minter",
    stablecoinAddress,
    ["function mint(address,uint256)"],
    `faucetMint(${recipient})`,
    (token, overrides) =>
      (token as any).mint(recipient, amountWei, overrides),
  );
};


