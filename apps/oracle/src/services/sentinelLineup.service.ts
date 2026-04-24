import { randomUUID } from "crypto";
import { ethers } from "ethers";
import { env } from "../env.js";
import {
  createLineupTxIntent,
  getLineupByAddress,
  getWeekCoins,
  markLineupTxIntentCompleted,
  markLineupTxIntentFailed,
  markLineupTxIntentSubmitted,
  upsertLineup,
} from "../store.js";
import {
  getRequiredRuntimeStablecoinAddress,
  getRequiredRuntimeValcoreAddress,
  getRuntimeChainConfig,
  getRuntimeProvider,
  getRuntimeStarknetProviderUrls,
  getRequiredRuntimeStarknetAccount,
  withRuntimeStarknetProvider,
} from "../network/chain-runtime.js";
import { sendTxWithPolicy } from "../network/tx-policy.js";
import { verifyLineupSyncPayload } from "./lineupSync.service.js";
import { mintStablecoinOnchain } from "../network/valcore-chain-client.js";

type Role = "core" | "stabilizer" | "amplifier" | "wildcard";
type Position = "GK" | "DEF" | "MID" | "FWD";

type Formation = {
  id: string;
  roles: Record<Role, number>;
};

type PoolItem = {
  coinId: string;
  salary: number;
  rank: number;
};

type SentinelCommitResult = {
  executed: boolean;
  reason: string;
  txHash?: string;
  address?: string;
};

type Slot = {
  slotId: string;
  coinId: string;
};

const formations: Formation[] = [
  {
    id: "1-4-4-2",
    roles: { core: 1, stabilizer: 4, amplifier: 4, wildcard: 2 },
  },
  {
    id: "1-4-3-3",
    roles: { core: 1, stabilizer: 4, amplifier: 3, wildcard: 3 },
  },
  {
    id: "1-3-4-3",
    roles: { core: 1, stabilizer: 3, amplifier: 4, wildcard: 3 },
  },
];

const roleOrder: Role[] = ["core", "stabilizer", "amplifier", "wildcard"];

const roleToPosition: Record<Role, Position> = {
  core: "GK",
  stabilizer: "DEF",
  amplifier: "MID",
  wildcard: "FWD",
};

const SALARY_CAP = 100_000;
const STABLECOIN_APPROVE_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
] as const;
const LEAGUE_COMMIT_ABI = [
  "function commitLineup(uint256 weekId, bytes32 lineupHash, uint256 depositAmount)",
] as const;

const STARKNET_FIELD_PRIME = BigInt("0x800000000000011000000000000000000000000000000000000000000000001");

const toHex = (value: bigint) => `0x${value.toString(16)}`;

const toU256Parts = (value: bigint) => {
  if (value < 0n) throw deterministic("u256 cannot be negative");
  const lowMask = (1n << 128n) - 1n;
  const low = value & lowMask;
  const high = value >> 128n;
  return [toHex(low), toHex(high)] as const;
};

const fromU256Parts = (lowRaw: unknown, highRaw: unknown) => {
  const low = BigInt(String(lowRaw ?? "0").startsWith("0x") ? String(lowRaw) : `0x${String(lowRaw ?? "0")}`);
  const high = BigInt(String(highRaw ?? "0").startsWith("0x") ? String(highRaw) : `0x${String(highRaw ?? "0")}`);
  return (high << 128n) + low;
};

const toStarknetLineupHash = (hashHex: string) => {
  const normalized = String(hashHex ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(normalized)) {
    throw deterministic("Invalid lineup hash for Starknet");
  }
  return toHex(BigInt(normalized) % STARKNET_FIELD_PRIME).toLowerCase();
};

const deterministic = (message: string) => new Error(`DETERMINISTIC: ${message}`);
const normalizeStarknetTxHash = (value: unknown) => {
  if (typeof value === "bigint") {
    return toHex(value).toLowerCase();
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Missing Starknet tx hash");
  }

  if (/^0x[0-9a-fA-F]{1,64}$/u.test(raw)) {
    return raw.toLowerCase();
  }

  if (/^[0-9a-fA-F]{1,64}$/u.test(raw)) {
    return `0x${raw.toLowerCase()}`;
  }

  if (/^[0-9]+$/u.test(raw)) {
    return toHex(BigInt(raw)).toLowerCase();
  }

  throw new Error(`Invalid Starknet tx hash format: ${raw}`);
};

const createDeterministicRandom = (seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffle = <T>(items: T[], random: () => number) => {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = list[i];
    list[i] = list[j] as T;
    list[j] = tmp as T;
  }
  return list;
};

const toPool = (rows: Array<{ coin_id: string; position: string; salary: number | string; rank: number | string }>) => {
  const pools: Record<Position, PoolItem[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const row of rows) {
    const position = String(row.position ?? "").toUpperCase();
    if (position !== "GK" && position !== "DEF" && position !== "MID" && position !== "FWD") {
      continue;
    }
    const salary = Number(row.salary ?? 0);
    const rank = Number(row.rank ?? 0);
    if (!Number.isFinite(salary) || salary <= 0) continue;
    pools[position].push({
      coinId: String(row.coin_id),
      salary,
      rank: Number.isFinite(rank) ? rank : 999999,
    });
  }
  for (const key of Object.keys(pools) as Position[]) {
    pools[key].sort((a, b) => a.rank - b.rank);
  }
  return pools;
};

const buildSlotsFromFormation = (selectedCoinIds: Record<Role, string[]>) => {
  const slots: Slot[] = [];
  for (const role of roleOrder) {
    const coinIds = selectedCoinIds[role] ?? [];
    for (let i = 0; i < coinIds.length; i += 1) {
      slots.push({ slotId: `${role}-${i + 1}`, coinId: coinIds[i] as string });
    }
  }
  return slots;
};

const pickCoinsForFormation = (
  formation: Formation,
  pools: Record<Position, PoolItem[]>,
  random: () => number,
) => {
  const selectedCoinIds = new Set<string>();
  const selectedByRole: Record<Role, string[]> = {
    core: [],
    stabilizer: [],
    amplifier: [],
    wildcard: [],
  };
  let totalSalary = 0;

  for (const role of roleOrder) {
    const position = roleToPosition[role];
    const needCount = formation.roles[role];
    const pool = shuffle(pools[position], random).filter((item) => !selectedCoinIds.has(item.coinId));
    if (pool.length < needCount) {
      return null;
    }

    const picked = pool.slice(0, needCount);
    for (const item of picked) {
      selectedCoinIds.add(item.coinId);
      selectedByRole[role].push(item.coinId);
      totalSalary += item.salary;
    }
  }

  return {
    slots: buildSlotsFromFormation(selectedByRole),
    totalSalary,
  };
};

const pickSentinelSlots = (
  weekId: string,
  address: string,
  rows: Array<{ coin_id: string; position: string; salary: number | string; rank: number | string }>,
): { slots: Slot[]; totalSalary: number } => {
  const pools = toPool(rows);

  const feasible = formations.filter((formation) =>
    roleOrder.every((role) => pools[roleToPosition[role]].length >= formation.roles[role]),
  );

  if (!feasible.length) {
    throw deterministic("Not enough week coins to build sentinel strategy");
  }

  const random = createDeterministicRandom(`sentinel:${weekId}:${address}`);
  let bestFallback: { slots: Slot[]; totalSalary: number } | null = null;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const formation = feasible[Math.floor(random() * feasible.length)] ?? feasible[0];
    if (!formation) continue;
    const picked = pickCoinsForFormation(formation, pools, random);
    if (!picked) continue;

    if (!bestFallback || Math.abs(SALARY_CAP - picked.totalSalary) < Math.abs(SALARY_CAP - bestFallback.totalSalary)) {
      bestFallback = picked;
    }

    if (picked.totalSalary <= SALARY_CAP) {
      return picked;
    }
  }

  if (bestFallback && bestFallback.totalSalary <= SALARY_CAP) {
    return bestFallback;
  }

  throw deterministic("Failed to build sentinel strategy under salary cap");
};

const buildLineupHash = (weekId: string, address: string, slots: Slot[]) => {
  const payload = {
    weekId,
    address: address.toLowerCase(),
    slots,
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload))).toLowerCase();
};

export const ensureSentinelLineupForWeek = async (weekId: string): Promise<SentinelCommitResult> => {
  const config = await getRuntimeChainConfig();
  const chainType = String(config.chainType ?? "").toLowerCase();
  if (chainType !== "evm" && chainType !== "starknet") {
    return { executed: false, reason: "unsupported-chain" };
  }

  const privateKey = String(env.SENTINEL_PRIVATE_KEY ?? "").trim();
  if (!privateKey) {
    return { executed: false, reason: "sentinel-not-configured" };
  }

  const stablecoinAddress = await getRequiredRuntimeStablecoinAddress();
  const leagueAddress = await getRequiredRuntimeValcoreAddress();

  const depositText = String(env.SENTINEL_STABLECOIN_DEPOSIT ?? "120").trim();
  const depositWei = ethers.parseUnits(depositText || "120", config.stablecoinDecimals);
  if (depositWei <= 0n) {
    throw deterministic("SENTINEL_STABLECOIN_DEPOSIT must be greater than zero");
  }

  if (chainType === "evm") {
    const provider = await getRuntimeProvider();
    const wallet = new ethers.Wallet(privateKey, provider);
    const derivedAddress = wallet.address.toLowerCase();

    const configuredAddress = String(env.SENTINEL_ACCOUNT_ADDRESS ?? "").trim();
    const sentinelAddress = configuredAddress ? ethers.getAddress(configuredAddress).toLowerCase() : derivedAddress;

    if (sentinelAddress !== derivedAddress) {
      throw deterministic("SENTINEL_ACCOUNT_ADDRESS does not match SENTINEL_PRIVATE_KEY");
    }

    const existing = await getLineupByAddress(weekId, sentinelAddress);
    if (existing) {
      return { executed: false, reason: "already-committed", address: sentinelAddress };
    }

    const weekCoins = await getWeekCoins(weekId);
    if (!Array.isArray(weekCoins) || weekCoins.length === 0) {
      throw deterministic(`Week ${weekId} has no week_coins`);
    }

    const { slots } = pickSentinelSlots(weekId, sentinelAddress, weekCoins as Array<{ coin_id: string; position: string; salary: number | string; rank: number | string }>);
    const lineupHash = buildLineupHash(weekId, sentinelAddress, slots);

    const intentId = `sentinel-${weekId}-${randomUUID()}`;
    await createLineupTxIntent({
      id: intentId,
      week_id: weekId,
      address: sentinelAddress,
      source: "commit",
      slots_json: JSON.stringify(slots),
      swap_json: null,
    });

    try {
      const stablecoin = new ethers.Contract(stablecoinAddress, STABLECOIN_APPROVE_ABI, wallet);
      const balanceBefore = BigInt(await stablecoin.balanceOf(sentinelAddress));
      if (balanceBefore < depositWei) {
        const mintAmount = depositWei - balanceBefore;
        const mintTxHash = await mintStablecoinOnchain(stablecoinAddress, sentinelAddress, mintAmount);
        console.log(`[sentinel] minted stablecoin amount=${mintAmount.toString()} tx=${mintTxHash}`);
      }

      const balance = BigInt(await stablecoin.balanceOf(sentinelAddress));
      if (balance < depositWei) {
        throw deterministic(`sentinel balance insufficient after mint: have=${balance.toString()} need=${depositWei.toString()}`);
      }

      const allowance = BigInt(await stablecoin.allowance(sentinelAddress, leagueAddress));
      if (allowance < depositWei) {
        await sendTxWithPolicy({
          label: `sentinel:approve:${weekId}`,
          signer: wallet,
          send: (overrides) => stablecoin.approve(leagueAddress, ethers.MaxUint256, overrides),
        });
      }

      const league = new ethers.Contract(leagueAddress, LEAGUE_COMMIT_ABI, wallet);
      const sent = await sendTxWithPolicy({
        label: `sentinel:commit:${weekId}`,
        signer: wallet,
        send: (overrides) => league.commitLineup(BigInt(weekId), lineupHash, depositWei, overrides),
      });

      await markLineupTxIntentSubmitted(intentId, sent.txHash);

      const verified = await verifyLineupSyncPayload({
        txHash: sent.txHash,
        weekIdHint: weekId,
        addressHint: sentinelAddress,
        source: "commit",
        slots,
      });

      if (verified.stale) {
        throw deterministic(`Sentinel commit for week ${weekId} became stale`);
      }

      await upsertLineup({
        week_id: verified.weekId,
        address: verified.address,
        slots_json: JSON.stringify(slots),
        lineup_hash: verified.lineupHash,
        deposit_wei: verified.depositWei,
        principal_wei: verified.principalWei,
        risk_wei: verified.riskWei,
        swaps: verified.swaps,
        created_at: new Date().toISOString(),
      });

      await markLineupTxIntentCompleted(intentId, null);

      return {
        executed: true,
        reason: "committed",
        txHash: sent.txHash,
        address: sentinelAddress,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markLineupTxIntentFailed(intentId, message);
      throw error;
    }
  }

  const normalizeStarkAddress = (value: string) => toHex(BigInt(String(value ?? "0x0"))).toLowerCase();

  const configuredAddress = String(env.SENTINEL_ACCOUNT_ADDRESS ?? "").trim();
  if (!configuredAddress) {
    return { executed: false, reason: "sentinel-not-configured" };
  }
  const sentinelAddress = normalizeStarkAddress(configuredAddress);

  const existing = await getLineupByAddress(weekId, sentinelAddress);
  if (existing) {
    return { executed: false, reason: "already-committed", address: sentinelAddress };
  }

  const weekCoins = await getWeekCoins(weekId);
  if (!Array.isArray(weekCoins) || weekCoins.length === 0) {
    throw deterministic(`Week ${weekId} has no week_coins`);
  }

  const { slots } = pickSentinelSlots(weekId, sentinelAddress, weekCoins as Array<{ coin_id: string; position: string; salary: number | string; rank: number | string }>);
  const lineupHash = buildLineupHash(weekId, sentinelAddress, slots);
  const lineupHashFelt = toStarknetLineupHash(lineupHash);

  const intentId = `sentinel-${weekId}-${randomUUID()}`;
  await createLineupTxIntent({
    id: intentId,
    week_id: weekId,
    address: sentinelAddress,
    source: "commit",
    slots_json: JSON.stringify(slots),
    swap_json: null,
  });

  const waitForStarkTx = async (txHash: string) => {
    const receipt = await withRuntimeStarknetProvider((provider) => provider.waitForTransaction(txHash));
    const statusText = String((receipt as { execution_status?: string }).execution_status ?? "").toUpperCase();
    if (statusText && statusText !== "SUCCEEDED") {
      throw new Error(`Starknet tx execution failed: ${statusText}`);
    }
  };

  const invokeStark = async (contractAddress: string, entrypoint: string, calldata: string[]) => {
    const account = await getRequiredRuntimeStarknetAccount("sentinel");
    const response = await (account as any).execute([
      {
        contractAddress,
        entrypoint,
        calldata,
      },
    ]);
    const txHash = normalizeStarknetTxHash((response as { transaction_hash?: unknown }).transaction_hash);
    await waitForStarkTx(txHash);
    return txHash;
  };

  const readU256 = async (contractAddress: string, entrypoint: string, calldata: string[]) => {
    const raw = await withRuntimeStarknetProvider((provider) =>
      provider.callContract({
        contractAddress,
        entrypoint,
        calldata,
      })
    );
    const values = Array.isArray(raw) ? raw : ((raw as { result?: unknown[] } | null | undefined)?.result ?? []);
    return fromU256Parts(values[0] ?? "0x0", values[1] ?? "0x0");
  };

  try {
    const rpcUrls = await getRuntimeStarknetProviderUrls();
    if (!rpcUrls.length) {
      throw deterministic("No Starknet RPC configured");
    }

    const balanceBefore = await readU256(stablecoinAddress, "balance_of", [sentinelAddress]);
    if (balanceBefore < depositWei) {
      const mintAmount = depositWei - balanceBefore;
      const mintTxHash = await mintStablecoinOnchain(stablecoinAddress, sentinelAddress, mintAmount);
      console.log(`[sentinel] minted stablecoin amount=${mintAmount.toString()} tx=${mintTxHash}`);
    }

    const balance = await readU256(stablecoinAddress, "balance_of", [sentinelAddress]);
    if (balance < depositWei) {
      throw deterministic(`sentinel balance insufficient after mint: have=${balance.toString()} need=${depositWei.toString()}`);
    }

    const allowance = await readU256(stablecoinAddress, "allowance", [sentinelAddress, leagueAddress]);
    if (allowance < depositWei) {
      const approveCalldata = [leagueAddress, ...toU256Parts(depositWei)];
      await invokeStark(stablecoinAddress, "approve", approveCalldata);
    }

    const commitCalldata = [toHex(BigInt(weekId)), lineupHashFelt, toHex(depositWei)];
    const commitTxHash = await invokeStark(leagueAddress, "commit_lineup", commitCalldata);

    await markLineupTxIntentSubmitted(intentId, commitTxHash);

    const verified = await verifyLineupSyncPayload({
      txHash: commitTxHash,
      weekIdHint: weekId,
      addressHint: sentinelAddress,
      source: "commit",
      slots,
    });

    if (verified.stale) {
      throw deterministic(`Sentinel commit for week ${weekId} became stale`);
    }

    await upsertLineup({
      week_id: verified.weekId,
      address: verified.address,
      slots_json: JSON.stringify(slots),
      lineup_hash: verified.lineupHash,
      deposit_wei: verified.depositWei,
      principal_wei: verified.principalWei,
      risk_wei: verified.riskWei,
      swaps: verified.swaps,
      created_at: new Date().toISOString(),
    });

    await markLineupTxIntentCompleted(intentId, null);

    return {
      executed: true,
      reason: "committed",
      txHash: commitTxHash,
      address: sentinelAddress,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLineupTxIntentFailed(intentId, message);
    throw error;
  }
};







