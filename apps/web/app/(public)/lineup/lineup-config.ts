import type { Formation, PositionType, RoleType } from "./lineup-types";

export const roleOrder: RoleType[] = ["core", "stabilizer", "amplifier", "wildcard"];

export const roleMeta: Record<RoleType, { label: string; subtitle: string; hint: string }> = {
  core: {
    label: "Anchor",
    subtitle: "Anchor capital",
    hint: "Anchor keeps the system balanced.",
  },
  stabilizer: {
    label: "Guardians",
    subtitle: "Defensive line",
    hint: "Guardians absorb volatility.",
  },
  amplifier: {
    label: "Operators",
    subtitle: "Momentum engines",
    hint: "Operators drive controlled upside.",
  },
  wildcard: {
    label: "Raiders",
    subtitle: "Upside hunters",
    hint: "Raiders are the single decisive strike.",
  },
};

export const formations: Formation[] = [
  {
    id: "4-4-2",
    label: "4-4-2",
    hint: "Balanced Control",
    roles: { core: 1, stabilizer: 4, amplifier: 4, wildcard: 2 },
  },
  {
    id: "4-3-3",
    label: "4-3-3",
    hint: "Pressure Triangle",
    roles: { core: 1, stabilizer: 4, amplifier: 3, wildcard: 3 },
  },
  {
    id: "3-4-3",
    label: "3-4-3",
    hint: "Overload Surge",
    roles: { core: 1, stabilizer: 3, amplifier: 4, wildcard: 3 },
  },
];

export const spectatorFormationId = "4-4-2";

export const roleSlotLabels: Record<RoleType, string> = {
  core: "Anchor",
  stabilizer: "Guardian",
  amplifier: "Operator",
  wildcard: "Raider",
};

export const positionToRole: Record<PositionType, RoleType> = {
  GK: "core",
  DEF: "stabilizer",
  MID: "amplifier",
  FWD: "wildcard",
};

export const roleBadgeMap: Record<RoleType, string> = {
  core: "A",
  stabilizer: "G",
  amplifier: "O",
  wildcard: "R",
};

export const powerCap = 100000;
export const budgetAlpha = 0.4;
export const budgetCap = 1.3;
export const budgetMinRatio = 0.1;
export const totalMoves = 10;
export const ladderCount = 7;
export const ladderHysteresis = 0.2;

export const principalRatioBps = Number(process.env.NEXT_PUBLIC_PRINCIPAL_RATIO_BPS ?? "8000");
export const stablecoinDecimals = Number(process.env.NEXT_PUBLIC_STABLECOIN_DECIMALS ?? "18");
export const minDepositAmount = Number(process.env.NEXT_PUBLIC_MIN_DEPOSIT_STABLECOIN ?? "50");
export const lineupCachePrefix = "valcore:lineup-cache";
