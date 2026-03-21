export type RoleType = "core" | "stabilizer" | "amplifier" | "wildcard";
export type PositionType = "GK" | "DEF" | "MID" | "FWD";

export type Slot = {
  id: string;
  role: RoleType;
  label: string;
  note: string;
};

export type Asset = {
  id: string;
  symbol: string;
  name: string;
  imagePath?: string | null;
  role: RoleType;
  position: PositionType;
  rank: number;
  salary: number;
  snapshotPrice: number | null;
  risk: "Low" | "Medium" | "High";
  power: number;
  momentum: "Down" | "Steady" | "Up";
  momentumLive?: "Down" | "Steady" | "Up" | null;
};

export type LadderEntry = {
  id: string;
  symbol: string;
  name: string;
  imagePath?: string | null;
  entryPrice: number;
  livePrice: number;
  pctSinceEntry: number;
  inLineup: boolean;
  role: RoleType;
};

export type Formation = {
  id: string;
  label: string;
  hint: string;
  roles: Record<RoleType, number>;
};

export type LineupCache = {
  version: number;
  formationId: string;
  lineup: Record<string, string | null>;
  updatedAt: string;
};

export type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

export type WeekSummaryLite = {
  id: string;
  startAtUtc?: string | null;
  status: WeekStatus;
};

export type ClaimData = {
  address: string;
  principal: string;
  riskPayout: string;
  totalWithdraw: string;
  rewardAmount?: string;
  proof: `0x${string}`[];
};

export type ClaimableWeekSummary = {
  weekId: string;
  weekStartAtUtc?: string | null;
  netResultWei: bigint;
  guaranteedWei: bigint;
  performanceWei: bigint;
  historyUrl: string;
};

export type DbLineupResponse = {
  slots: Array<{ slotId: string; coinId: string }>;
  lineupHash: string;
  depositWei: string;
  principalWei: string;
  riskWei: string;
  swaps: number;
  createdAt: string;
};

export type WeekCoinRow = {
  id: string;
  coinId: string;
  rank: number;
  position: PositionType;
  snapshotPrice: number | null;
  salary: number;
  power: number;
  risk: "Low" | "Medium" | "High";
  momentum: "Down" | "Steady" | "Up";
  momentumLive?: "Down" | "Steady" | "Up" | null;
  metricsUpdatedAt?: string | null;
  coin: {
    symbol: string;
    name: string;
    isStable: boolean;
    imagePath: string | null;
  };
};

export type WeekShowcaseLineupResponse = {
  weekId: string;
  formationId: string;
  generatedAt: string;
  refreshIntervalSeconds: number;
  slots: Array<{ slotId: string; coinId: string }>;
};

export type SortKey =
  | "asset"
  | "role"
  | "power"
  | "salary"
  | "risk"
  | "price"
  | "weekChange"
  | "momentum"
  | "rank";
