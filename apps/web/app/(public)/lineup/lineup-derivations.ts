import type { Asset, LadderEntry, RoleType, Slot, SortKey } from "./lineup-types";

export type AssetMetrics = {
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlValue: number;
  momentum: string;
  momentumLive: string | null;
  flash: boolean;
  priceDirection: "up" | "down" | "flat";
};

export const buildSlotGroups = (slots: Slot[]) =>
  ({
    core: slots.filter((slot) => slot.role === "core"),
    stabilizer: slots.filter((slot) => slot.role === "stabilizer"),
    amplifier: slots.filter((slot) => slot.role === "amplifier"),
    wildcard: slots.filter((slot) => slot.role === "wildcard"),
  }) as const;

export const buildAssignedIds = (lineup: Record<string, Asset | null>) =>
  new Set(Object.values(lineup).filter(Boolean).map((asset) => asset!.id));

export const countFilledSlots = (
  slots: Slot[],
  lineup: Record<string, Asset | null>,
) => slots.filter((slot) => lineup[slot.id]).length;

export const computeUsedPower = (
  slots: Slot[],
  lineup: Record<string, Asset | null>,
  isSpectatorWeekView: boolean,
) => {
  if (isSpectatorWeekView) return 0;
  return slots.reduce((sum, slot) => sum + (lineup[slot.id]?.salary ?? 0), 0);
};

export const computeAvailableBudget = (
  selectedSlot: Slot | null,
  lineup: Record<string, Asset | null>,
  usedPower: number,
  powerCap: number,
) => {
  if (!selectedSlot) return 0;
  const selectedSlotAsset = lineup[selectedSlot.id];
  const remaining = powerCap - usedPower;
  return selectedSlotAsset ? remaining + selectedSlotAsset.salary : remaining;
};

export const computeProjectedMultiplier = (params: {
  isSpectatorWeekView: boolean;
  filledCount: number;
  usedPower: number;
  powerCap: number;
  budgetMinRatio: number;
  budgetAlpha: number;
  budgetCap: number;
}) => {
  const {
    isSpectatorWeekView,
    filledCount,
    usedPower,
    powerCap,
    budgetMinRatio,
    budgetAlpha,
    budgetCap,
  } = params;
  if (isSpectatorWeekView) return 1.0;
  if (filledCount === 0) return 1.0;
  const unusedRatio = Math.max((powerCap - usedPower) / powerCap, 0);
  const effectiveRatio = Math.max((unusedRatio - budgetMinRatio) / (1 - budgetMinRatio), 0);
  const raw = 1 + budgetAlpha * Math.sqrt(effectiveRatio);
  return Math.min(raw, budgetCap);
};

export const buildSlotByAssetId = (lineup: Record<string, Asset | null>) => {
  const map = new Map<string, string>();
  Object.entries(lineup).forEach(([slotId, asset]) => {
    if (asset) {
      map.set(asset.id, slotId);
    }
  });
  return map;
};

export const buildLadderBase = (params: {
  coins: Asset[];
  livePrices: Record<string, number>;
  assignedIds: Set<string>;
}) => {
  const { coins, livePrices, assignedIds } = params;
  return coins
    .map((asset) => {
      const entryPrice =
        typeof asset.snapshotPrice === "number" && Number.isFinite(asset.snapshotPrice)
          ? asset.snapshotPrice
          : 0;
      if (!entryPrice || entryPrice <= 0) return null;
      const symbol = asset.symbol.toUpperCase();
      const livePrice = livePrices[symbol] ?? entryPrice;
      if (!Number.isFinite(livePrice) || livePrice <= 0) return null;
      const pctSinceEntry = (livePrice / entryPrice - 1) * 100;
      return {
        id: asset.id,
        symbol,
        name: asset.name,
        imagePath: asset.imagePath ?? null,
        entryPrice,
        livePrice,
        pctSinceEntry,
        inLineup: assignedIds.has(asset.id),
        role: asset.role,
      } as LadderEntry;
    })
    .filter(Boolean) as LadderEntry[];
};

export const applyLadderHysteresisOrder = (
  prevOrder: string[],
  items: LadderEntry[],
  direction: "asc" | "desc",
  ladderHysteresis: number,
) => {
  if (!items.length) return [];
  const scoreById = new Map(items.map((item) => [item.id, item.pctSinceEntry]));
  const currentIds = items.map((item) => item.id);
  let order = prevOrder.filter((id) => scoreById.has(id));
  const missing = currentIds.filter((id) => !order.includes(id));
  missing.sort((a, b) => {
    const aScore = scoreById.get(a) ?? 0;
    const bScore = scoreById.get(b) ?? 0;
    return direction === "desc" ? bScore - aScore : aScore - bScore;
  });
  order = order.concat(missing);
  const next = order.slice();
  const shouldSwap = (aScore: number, bScore: number) =>
    direction === "desc"
      ? bScore > aScore + ladderHysteresis
      : bScore < aScore - ladderHysteresis;
  for (let pass = 0; pass < next.length; pass += 1) {
    let swapped = false;
    for (let idx = 1; idx < next.length; idx += 1) {
      const aId = next[idx - 1];
      const bId = next[idx];
      const aScore = scoreById.get(aId) ?? 0;
      const bScore = scoreById.get(bId) ?? 0;
      if (shouldSwap(aScore, bScore)) {
        next[idx - 1] = bId;
        next[idx] = aId;
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  if (next.length === prevOrder.length && next.every((id, idx) => id === prevOrder[idx])) {
    return prevOrder;
  }
  return next;
};

export const buildLadderFallbackOrder = (
  currentOrder: string[],
  items: LadderEntry[],
  direction: "asc" | "desc",
) => {
  if (currentOrder.length) return currentOrder;
  return [...items]
    .sort((a, b) =>
      direction === "desc"
        ? b.pctSinceEntry - a.pctSinceEntry
        : a.pctSinceEntry - b.pctSinceEntry,
    )
    .map((item) => item.id);
};

export const buildLadderDisplay = (params: {
  ids: string[];
  ladderById: Map<string, LadderEntry>;
  count: number;
  reverse?: boolean;
}) => {
  const { ids, ladderById, count, reverse = false } = params;
  const resolved = ids
    .filter((id) => ladderById.has(id))
    .slice(0, count)
    .map((id) => ladderById.get(id)!);
  return reverse ? resolved.reverse() : resolved;
};

export const buildHotLadderSlice = (
  items: LadderEntry[],
  direction: "asc" | "desc",
  count = 3,
) =>
  [...items]
    .sort((a, b) =>
      direction === "desc"
        ? b.pctSinceEntry - a.pctSinceEntry
        : a.pctSinceEntry - b.pctSinceEntry,
    )
    .slice(0, count);

export const deriveAssetMetrics = (
  asset: Asset,
  livePrices: Record<string, number>,
  priceFlash: Record<string, boolean>,
): AssetMetrics => {
  const entryPrice =
    typeof asset.snapshotPrice === "number" && Number.isFinite(asset.snapshotPrice)
      ? asset.snapshotPrice
      : 0;
  const symbol = asset.symbol.toUpperCase();
  const livePrice = Number(livePrices[symbol]);
  const hasLivePrice = Number.isFinite(livePrice) && livePrice > 0;
  const hasEntryPrice = Number.isFinite(entryPrice) && entryPrice > 0;
  const currentPrice = hasLivePrice
    ? livePrice
    : hasEntryPrice
      ? entryPrice
      : Number.NaN;
  const pnl =
    hasEntryPrice && Number.isFinite(currentPrice) && currentPrice > 0
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : 0;
  const pnlValue = (asset.salary * pnl) / 100;
  const momentum = asset.momentum ? asset.momentum.toLowerCase() : "steady";
  const momentumLive = asset.momentumLive ? asset.momentumLive.toLowerCase() : null;
  const flash = Boolean(priceFlash[symbol]);
  const priceDelta =
    Number.isFinite(currentPrice) && hasEntryPrice ? currentPrice - entryPrice : 0;
  const priceDirection = priceDelta > 0 ? "up" : priceDelta < 0 ? "down" : "flat";
  return {
    entryPrice,
    currentPrice,
    pnl,
    pnlValue,
    momentum,
    momentumLive,
    flash,
    priceDirection,
  };
};

export const calculateSpectatorWeekScore = (params: {
  isSpectatorWeekView: boolean;
  slots: Slot[];
  lineup: Record<string, Asset | null>;
  powerCap: number;
  getAssetMetrics: (asset: Asset) => AssetMetrics;
}) => {
  const { isSpectatorWeekView, slots, lineup, powerCap, getAssetMetrics } = params;
  if (!isSpectatorWeekView) return 0;
  const positiveWeights: Record<RoleType, number> = {
    core: 5,
    stabilizer: 3,
    amplifier: 2,
    wildcard: 4,
  };
  const negativeWeights: Record<RoleType, number> = {
    core: 8,
    stabilizer: 5,
    amplifier: 3,
    wildcard: 2,
  };

  return slots.reduce((sum, slot) => {
    const asset = lineup[slot.id];
    if (!asset) return sum;
    const metrics = getAssetMetrics(asset);
    const weight = metrics.pnl >= 0 ? positiveWeights[slot.role] : negativeWeights[slot.role];
    const contribution = metrics.pnl * (asset.salary / powerCap) * weight;
    return sum + contribution;
  }, 0);
};

export const filterAndSortAssets = (params: {
  coins: Asset[];
  selectedRole: RoleType | null;
  search: string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  roleOrder: RoleType[];
  getAssetMetrics: (asset: Asset) => AssetMetrics;
}) => {
  const { coins, selectedRole, search, sortKey, sortDir, roleOrder, getAssetMetrics } = params;
  const roleRank = roleOrder.reduce<Record<RoleType, number>>((acc, role, index) => {
    acc[role] = index;
    return acc;
  }, { core: 0, stabilizer: 1, amplifier: 2, wildcard: 3 });
  const riskRank = { Low: 0, Medium: 1, High: 2 } as const;
  const momentumRank = { down: 0, steady: 1, up: 2 } as const;
  const normalizedSearch = search.trim().toLowerCase();
  const metricsCache = new Map<string, AssetMetrics>();
  const getCachedMetrics = (asset: Asset) => {
    const cached = metricsCache.get(asset.id);
    if (cached) return cached;
    const next = getAssetMetrics(asset);
    metricsCache.set(asset.id, next);
    return next;
  };
  const roleFiltered = selectedRole
    ? coins.filter((asset) => asset.role === selectedRole)
    : coins;
  const searched = roleFiltered.filter((asset) => {
    if (!normalizedSearch) return true;
    return (
      asset.name.toLowerCase().includes(normalizedSearch) ||
      asset.symbol.toLowerCase().includes(normalizedSearch)
    );
  });
  const direction = sortKey === "rank" ? 1 : sortDir === "asc" ? 1 : -1;
  if (sortKey === "price" || sortKey === "weekChange" || sortKey === "momentum") {
    const decorated = searched.map((asset) => ({
      asset,
      metrics: getCachedMetrics(asset),
    }));
    decorated.sort((a, b) => {
      if (sortKey === "price") {
        return (a.metrics.currentPrice - b.metrics.currentPrice) * direction;
      }
      if (sortKey === "weekChange") {
        return (a.metrics.pnl - b.metrics.pnl) * direction;
      }
      const aKey = a.metrics.momentum as keyof typeof momentumRank;
      const bKey = b.metrics.momentum as keyof typeof momentumRank;
      return (momentumRank[aKey] - momentumRank[bKey]) * direction;
    });
    return decorated.map((row) => row.asset);
  }
  const sorted = [...searched];
  sorted.sort((a, b) => {
    if (sortKey === "rank") {
      return (a.rank - b.rank) * direction;
    }
    if (sortKey === "asset") {
      return a.name.localeCompare(b.name) * direction;
    }
    if (sortKey === "role") {
      return (roleRank[a.role] - roleRank[b.role]) * direction;
    }
    if (sortKey === "power") {
      return (a.power - b.power) * direction;
    }
    if (sortKey === "salary") {
      return (a.salary - b.salary) * direction;
    }
    if (sortKey === "risk") {
      return (riskRank[a.risk] - riskRank[b.risk]) * direction;
    }
    return 0;
  });
  return sorted;
};
