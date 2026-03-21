import { formatUnits, keccak256, stringToBytes } from "viem";
import {
  roleMeta,
  roleOrder,
  roleSlotLabels,
  stablecoinDecimals,
} from "./lineup-config";
import type { Asset, Formation, Slot } from "./lineup-types";

const priceFormatter2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const priceFormatter3 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const priceFormatter5 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export const buildSlots = (formation: Formation): Slot[] => {
  const nextSlots: Slot[] = [];
  roleOrder.forEach((role) => {
    const count = formation.roles[role];
    for (let i = 0; i < count; i += 1) {
      const index = i + 1;
      const labelBase = roleSlotLabels[role];
      nextSlots.push({
        id: `${role}-${index}`,
        role,
        label: count === 1 ? labelBase : `${labelBase} ${index}`,
        note: roleMeta[role].subtitle,
      });
    }
  });
  return nextSlots;
};

export const createLineup = (slots: Slot[]) => {
  const initial: Record<string, Asset | null> = {};
  slots.forEach((slot) => {
    initial[slot.id] = null;
  });
  return initial;
};

export const formatPrice = (price: number) => {
  if (!Number.isFinite(price)) return "--";
  if (price === 0) return "0.00";
  if (price >= 100) {
    return priceFormatter2.format(price);
  }
  if (price >= 1) {
    return priceFormatter3.format(price);
  }
  if (price >= 0.01) {
    return priceFormatter5.format(price);
  }
  const decimals = Math.max(6, Math.ceil(Math.log10(1 / price)) + 2);
  return price.toFixed(Math.min(decimals, 8));
};

export const formatPct = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
};

export const formatSalary = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${Math.round(value).toString()}`;
};

export const formatPnl = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

export const parseClaimedFlag = (position: unknown) => {
  if (Array.isArray(position)) {
    return Boolean(position[5] ?? position[position.length - 1]);
  }
  if (position && typeof position === "object" && "claimed" in position) {
    return Boolean((position as { claimed?: boolean }).claimed);
  }
  return false;
};

const parseSwapCountValue = (value: unknown) => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
};

const parseBigintValue = (value: unknown) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && value) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
};

export const parsePrincipalRisk = (position: unknown) => {
  if (position && typeof position === "object" && !Array.isArray(position)) {
    const principal = parseBigintValue((position as { principal?: unknown }).principal);
    const risk = parseBigintValue((position as { risk?: unknown }).risk);
    if (principal !== 0n || risk !== 0n) return { principal, risk };
  }
  if (Array.isArray(position)) {
    return {
      principal: parseBigintValue(position[0]),
      risk: parseBigintValue(position[1]),
    };
  }
  return { principal: 0n, risk: 0n };
};

export const parseSwapsUsed = (position: unknown) => {
  if (position && typeof position === "object" && !Array.isArray(position) && "swaps" in position) {
    const parsed = parseSwapCountValue((position as { swaps?: unknown }).swaps);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Array.isArray(position)) {
    const swaps = parseSwapCountValue(position[4]);
    if (Number.isFinite(swaps)) return swaps;
  }
  return 0;
};

export const formatSignedStableAmount = (wei: bigint, decimals = stablecoinDecimals) => {
  const sign = wei >= 0n ? "+" : "-";
  const absValue = wei >= 0n ? wei : -wei;
  const value = Number(formatUnits(absValue, decimals));
  return `${sign}$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export const formatStableAmount = (wei: bigint, decimals = stablecoinDecimals) => {
  const value = Number(formatUnits(wei, decimals));
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export const formatScore = (value: number) => {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
};

export const formatWeekStartUtc = (iso?: string | null) => {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const midnightUtc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = midnightUtc.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() - daysFromMonday);
  return midnightUtc.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const buildLineupHash = (
  weekId: string,
  address: string,
  slots: Record<string, Asset | null>,
  allSlots: Slot[],
) => {
  const payload = {
    weekId,
    address: address.toLowerCase(),
    slots: allSlots.map((slot) => ({
      slotId: slot.id,
      coinId: slots[slot.id]?.id ?? "",
    })),
  };
  return keccak256(stringToBytes(JSON.stringify(payload)));
};
