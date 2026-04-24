import { ethers } from "ethers";
import { getCoins, getLineupByAddress, getWeekCoins } from "../store.js";
import {
  getRequiredRuntimeValcoreAddress,
  getRuntimeProvider,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";

export type SyncSource = "commit" | "swap";

export type LineupSyncSlot = {
  slotId: string;
  coinId: string;
};

export type LineupSyncPayload = {
  txHash: string;
  weekIdHint?: string;
  addressHint?: string;
  source?: SyncSource;
  slots: LineupSyncSlot[];
  swap?: {
    slotId: string;
    removedSymbol: string;
    addedSymbol: string;
  };
};

export type VerifiedLineupSync = {
  weekId: string;
  address: string;
  lineupHash: string;
  depositWei: string;
  principalWei: string;
  riskWei: string;
  swaps: number;
  source: SyncSource;
  txHash: string;
  stale: boolean;
};

const BPS = 10_000n;
const SALARY_CAP = 100_000;
const ALLOWED_FORMATION_KEYS = new Set(["1-4-4-2", "1-4-3-3", "1-3-4-3"]);

const roleToPosition = {
  core: "GK",
  stabilizer: "DEF",
  amplifier: "MID",
  wildcard: "FWD",
} as const;

const LINEUP_ABI = [
  "event LineupCommitted(uint256 indexed weekId, address indexed user, bytes32 lineupHash, uint256 deposit)",
  "event LineupUpdated(uint256 indexed weekId, address indexed user, bytes32 lineupHash, uint256 deposit)",
  "event LineupSwapped(uint256 indexed weekId, address indexed user, bytes32 lineupHash, uint8 swapsUsed)",
  "function positions(uint256 weekId, address user) view returns (uint128 principal, uint128 risk, uint128 forfeitedReward, bytes32 lineupHash, uint8 swaps, bool claimed)",
  "function principalRatioBps() view returns (uint16)",
] as const;

const iface = new ethers.Interface(LINEUP_ABI);

const deterministic = (message: string) => new Error(`DETERMINISTIC: ${message}`);
const transient = (message: string) => new Error(`TRANSIENT: ${message}`);

const normalizeHash = (value: string) => {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw deterministic("Invalid tx hash");
  return value.toLowerCase();
};

const getLeagueAddress = async () => {
  const raw = await getRequiredRuntimeValcoreAddress();
  try {
    return ethers.getAddress(raw).toLowerCase();
  } catch {
    throw deterministic("League contract address is invalid");
  }
};

const normalizeSlots = (slots: LineupSyncSlot[]) => {
  const seen = new Set<string>();
  return slots.map((slot) => {
    const slotId = slot.slotId.trim();
    const coinId = (slot.coinId ?? "").trim();
    if (!slotId) throw deterministic("slotId is required");
    if (!coinId) throw deterministic(`coinId is required for slot ${slotId}`);
    if (seen.has(slotId)) throw deterministic(`Duplicate slotId: ${slotId}`);
    seen.add(slotId);
    return { slotId, coinId };
  });
};

const normalizeSwapPayload = (swap: LineupSyncPayload["swap"]) => {
  if (!swap) throw deterministic("swap payload is required for swap source");
  const slotId = swap.slotId.trim();
  const removedSymbol = swap.removedSymbol.trim().toUpperCase();
  const addedSymbol = swap.addedSymbol.trim().toUpperCase();
  if (!slotId) throw deterministic("swap.slotId is required");
  if (!removedSymbol) throw deterministic("swap.removedSymbol is required");
  if (!addedSymbol) throw deterministic("swap.addedSymbol is required");
  return { slotId, removedSymbol, addedSymbol };
};

const slotRoleFromId = (slotId: string): keyof typeof roleToPosition => {
  const prefix = slotId.split("-")[0]?.toLowerCase();
  if (prefix === "core") return "core";
  if (prefix === "stabilizer") return "stabilizer";
  if (prefix === "amplifier") return "amplifier";
  if (prefix === "wildcard") return "wildcard";
  throw deterministic(`Invalid slotId: ${slotId}`);
};

const validateLineupBusinessRules = async (
  weekId: string,
  slots: LineupSyncSlot[],
  source: SyncSource,
  swap: LineupSyncPayload["swap"] | undefined,
) => {
  if (slots.length !== 11) {
    throw deterministic("Lineup must contain exactly 11 slots");
  }

  const [weekCoins, allCoins] = await Promise.all([getWeekCoins(weekId), getCoins()]);
  if (!weekCoins.length) {
    throw deterministic(`Week ${weekId} coin universe is missing`);
  }

  const weekCoinById = new Map(weekCoins.map((row) => [row.coin_id, row]));
  const coinById = new Map(allCoins.map((coin) => [coin.id, coin]));
  const roleCounts = { core: 0, stabilizer: 0, amplifier: 0, wildcard: 0 };
  const usedCoinIds = new Set<string>();
  let totalSalary = 0;

  for (const slot of slots) {
    const role = slotRoleFromId(slot.slotId);
    roleCounts[role] += 1;

    if (usedCoinIds.has(slot.coinId)) {
      throw deterministic(`Duplicate coinId in lineup: ${slot.coinId}`);
    }
    usedCoinIds.add(slot.coinId);

    const weekCoin = weekCoinById.get(slot.coinId);
    if (!weekCoin) {
      throw deterministic(`coinId is not eligible for this week: ${slot.coinId}`);
    }

    const expectedPosition = roleToPosition[role];
    const actualPosition = String(weekCoin.position ?? "").toUpperCase();
    if (actualPosition !== expectedPosition) {
      throw deterministic(
        `coinId ${slot.coinId} cannot be assigned to ${role} (${expectedPosition})`,
      );
    }

    const salary = Number(weekCoin.salary ?? 0);
    if (!Number.isFinite(salary) || salary <= 0) {
      throw deterministic(`Invalid salary for coinId ${slot.coinId}`);
    }
    totalSalary += salary;
  }

  const formationKey = `${roleCounts.core}-${roleCounts.stabilizer}-${roleCounts.amplifier}-${roleCounts.wildcard}`;
  if (!ALLOWED_FORMATION_KEYS.has(formationKey)) {
    throw deterministic(`Invalid role distribution: ${formationKey}`);
  }

  if (totalSalary > SALARY_CAP) {
    throw deterministic(`Salary cap exceeded: ${Math.round(totalSalary)} > ${SALARY_CAP}`);
  }

  if (source === "swap") {
    const swapPayload = normalizeSwapPayload(swap);
    const target = slots.find((slot) => slot.slotId === swapPayload.slotId);
    if (!target) {
      throw deterministic(`Swap slot not found in lineup: ${swapPayload.slotId}`);
    }
    const addedSymbol = coinById.get(target.coinId)?.symbol?.toUpperCase();
    if (!addedSymbol) {
      throw deterministic(`Swap target coin not found: ${target.coinId}`);
    }
    if (addedSymbol !== swapPayload.addedSymbol) {
      throw deterministic(
        `Swap payload addedSymbol mismatch: expected ${addedSymbol}, got ${swapPayload.addedSymbol}`,
      );
    }
    if (swapPayload.removedSymbol === swapPayload.addedSymbol) {
      throw deterministic("Swap removedSymbol and addedSymbol cannot be equal");
    }
  }
};

const buildLineupHash = (weekId: string, address: string, slots: LineupSyncSlot[]) => {
  const payload = {
    weekId,
    address: address.toLowerCase(),
    slots,
  };
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload))).toLowerCase();
};

const extractEvent = (
  source: SyncSource,
  logs: ethers.LogDescription[],
): ethers.LogDescription => {
  if (source === "commit") {
    const candidates = logs.filter(
      (log) => log.name === "LineupCommitted" || log.name === "LineupUpdated",
    );
    if (!candidates.length) throw deterministic("Commit tx missing LineupCommitted/LineupUpdated event");
    return candidates[candidates.length - 1];
  }

  const candidates = logs.filter((log) => log.name === "LineupSwapped");
  if (!candidates.length) throw deterministic("Swap tx missing LineupSwapped event");
  return candidates[candidates.length - 1];
};

const parseIndexed = (value: unknown) => {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return String(value ?? "");
};

export const verifyLineupSyncPayload = async (
  payload: LineupSyncPayload,
): Promise<VerifiedLineupSync> => {
  if (!isValcoreChainEnabled()) {
    throw deterministic("Valcore chain sync is disabled");
  }

  const source: SyncSource = payload.source ?? "commit";
  const txHash = normalizeHash(payload.txHash);
  const slots = normalizeSlots(payload.slots ?? []);
  if (!slots.length) throw deterministic("slots is required");
  if (source === "swap") {
    normalizeSwapPayload(payload.swap);
  }

  const leagueAddress = await getLeagueAddress();
  const provider = await getRuntimeProvider();

  let receipt: ethers.TransactionReceipt | null = null;
  let tx: ethers.TransactionResponse | null = null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
    tx = await provider.getTransaction(txHash);
  } catch (error) {
    const text = error instanceof Error ? error.message : "rpc failure";
    throw transient(`RPC lookup failed: ${text}`);
  }

  if (!receipt) throw transient(`Transaction receipt not found for ${txHash}`);
  if (receipt.status !== 1) throw deterministic(`Transaction reverted: ${txHash}`);

  const txTo = (receipt.to ?? tx?.to ?? "").toLowerCase();
  if (!txTo || txTo !== leagueAddress) {
    throw deterministic("Transaction target does not match league contract");
  }

  const parsedLogs = receipt.logs
    .filter((log) => log.address.toLowerCase() === leagueAddress)
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((log): log is ethers.LogDescription => Boolean(log));

  const eventLog = extractEvent(source, parsedLogs);

  const weekId = parseIndexed(eventLog.args?.weekId);
  const weekIdHint = payload.weekIdHint?.trim();
  if (weekIdHint && weekIdHint !== weekId) {
    throw deterministic("weekId hint does not match on-chain event");
  }
  const userRaw = parseIndexed(eventLog.args?.user);
  let address = "";
  try {
    address = ethers.getAddress(userRaw).toLowerCase();
  } catch {
    throw deterministic("Invalid user address in event");
  }

  const txFrom = (tx?.from ?? "").toLowerCase();
  if (!txFrom) {
    throw transient("Transaction sender could not be resolved");
  }
  if (txFrom !== address) {
    throw deterministic("Event user does not match tx sender");
  }

  if (payload.addressHint) {
    let expectedAddress = "";
    try {
      expectedAddress = ethers.getAddress(payload.addressHint).toLowerCase();
    } catch {
      throw deterministic("address hint is invalid");
    }
    if (expectedAddress !== address) {
      throw deterministic("address hint does not match tx sender");
    }
  }

  await validateLineupBusinessRules(weekId, slots, source, payload.swap);

  const eventLineupHash = parseIndexed(eventLog.args?.lineupHash).toLowerCase();
  const calculatedHash = buildLineupHash(weekId, address, slots);
  if (calculatedHash !== eventLineupHash) {
    throw deterministic("Provided slots do not match on-chain lineup hash");
  }

  const contract = new ethers.Contract(leagueAddress, LINEUP_ABI, provider);

  let principalWei = 0n;
  let riskWei = 0n;
  let swaps = 0;
  let stale = false;

  if (source === "commit") {
    const eventDeposit = BigInt(parseIndexed(eventLog.args?.deposit));
    if (eventDeposit <= 0n) throw deterministic("Commit deposit is zero");

    let ratio = 0n;
    try {
      ratio = BigInt(await contract.principalRatioBps());
    } catch (error) {
      const text = error instanceof Error ? error.message : "ratio read failed";
      throw transient(`Unable to read principal ratio: ${text}`);
    }

    principalWei = (eventDeposit * ratio) / BPS;
    riskWei = eventDeposit - principalWei;
    swaps = 0;

    try {
      const position = await contract.positions(BigInt(weekId), address);
      const onchainHash = String(position?.lineupHash ?? "").toLowerCase();
      if (onchainHash && onchainHash !== eventLineupHash) {
        stale = true;
      }
    } catch {
      // position read is best-effort for staleness, not required for commit sync
    }
  } else {
    const swapsUsed = Number(eventLog.args?.swapsUsed ?? 0);
    if (!Number.isFinite(swapsUsed) || swapsUsed < 0) {
      throw deterministic("Invalid swapsUsed in swap event");
    }

    let position: {
      principal: bigint;
      risk: bigint;
      lineupHash: string;
      swaps: number;
    } | null = null;

    try {
      const raw = await contract.positions(BigInt(weekId), address);
      position = {
        principal: BigInt(raw?.principal ?? 0),
        risk: BigInt(raw?.risk ?? 0),
        lineupHash: String(raw?.lineupHash ?? "").toLowerCase(),
        swaps: Number(raw?.swaps ?? 0),
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : "position read failed";
      throw transient(`Unable to read on-chain position: ${text}`);
    }

    principalWei = position.principal;
    riskWei = position.risk;
    swaps = swapsUsed;

    if (position.lineupHash && position.lineupHash !== eventLineupHash) {
      stale = true;
    }

    const existing = await getLineupByAddress(weekId, address);
    const existingSwaps = existing ? Number(existing.swaps ?? 0) : 0;
    if (Number.isFinite(existingSwaps) && existingSwaps > swapsUsed) {
      stale = true;
    }

    if (Number.isFinite(position.swaps) && position.swaps > swapsUsed) {
      stale = true;
    }
  }

  const depositWei = principalWei + riskWei;

  return {
    weekId,
    address,
    lineupHash: eventLineupHash,
    depositWei: depositWei.toString(),
    principalWei: principalWei.toString(),
    riskWei: riskWei.toString(),
    swaps,
    source,
    txHash,
    stale,
  };
};


