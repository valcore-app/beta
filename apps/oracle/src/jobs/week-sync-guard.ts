import { getOnchainWeekState, type ChainWeekState } from "../network/valcore-chain-client.js";

const DB_TO_CHAIN_STATUS: Record<string, number> = {
  DRAFT_OPEN: 1,
  LOCKED: 2,
  ACTIVE: 3,
  FINALIZE_PENDING: 4,
  FINALIZED: 5,
};

const UNRESOLVED_DB_STATUSES = new Set(["DRAFT_OPEN", "LOCKED", "ACTIVE", "FINALIZE_PENDING"]);

type WeekChainSyncInput = {
  context: string;
  leagueAddress: string;
  weekId: string | number;
  dbStatus: string;
  expectedOnchainStatus?: number;
  getOnchainWeekStateFn?: (leagueAddress: string, weekId: bigint) => Promise<ChainWeekState>;
};

type WeekChainSyncResult = {
  onchain: ChainWeekState;
  onchainStatus: number;
  dbStatus: string;
  expectedOnchainStatus: number | null;
};

export const assertWeekChainSync = async (input: WeekChainSyncInput): Promise<WeekChainSyncResult> => {
  const dbStatus = String(input.dbStatus ?? "").trim().toUpperCase();
  const expectedOnchainStatus = Number.isInteger(input.expectedOnchainStatus)
    ? Number(input.expectedOnchainStatus)
    : (DB_TO_CHAIN_STATUS[dbStatus] ?? null);

  const getWeekState = input.getOnchainWeekStateFn ?? getOnchainWeekState;
  const onchain = await getWeekState(input.leagueAddress, BigInt(input.weekId));
  const onchainStatus = Number(onchain.status ?? 0);

  if (UNRESOLVED_DB_STATUSES.has(dbStatus) && onchainStatus === 0) {
    throw new Error(
      `${input.context}: mid-week redeploy detected for week ${String(input.weekId)}. ` +
        `DB status=${dbStatus} but on-chain status=NONE. ` +
        `Do not change VALCORE_ADDRESS before week reaches FINALIZED.`,
    );
  }

  if (expectedOnchainStatus !== null && onchainStatus !== expectedOnchainStatus) {
    throw new Error(
      `${input.context}: DB/on-chain week status mismatch for week ${String(input.weekId)}. ` +
        `DB=${dbStatus} expects on-chain=${expectedOnchainStatus}, actual on-chain=${onchainStatus}.`,
    );
  }

  return {
    onchain,
    onchainStatus,
    dbStatus,
    expectedOnchainStatus,
  };
};

export const isUnresolvedDbWeekStatus = (status: string) =>
  UNRESOLVED_DB_STATUSES.has(String(status ?? "").trim().toUpperCase());
