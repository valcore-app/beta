import { randomUUID } from "crypto";
import { getOnchainWeekState } from "../network/valcore-chain-client.js";
import { insertErrorEvent, updateWeekStatus } from "../store.js";

const DB_TO_ONCHAIN_STATUS: Record<string, number> = {
  DRAFT_OPEN: 1,
  LOCKED: 2,
  ACTIVE: 3,
  FINALIZE_PENDING: 4,
  FINALIZED: 5,
};

const ONCHAIN_TO_DB_STATUS: Record<number, string> = {
  1: "DRAFT_OPEN",
  2: "LOCKED",
  3: "ACTIVE",
  4: "FINALIZE_PENDING",
  5: "FINALIZED",
};

const UNRESOLVED_DB_STATUSES = new Set(["DRAFT_OPEN", "LOCKED", "ACTIVE", "FINALIZE_PENDING"]);

export type WeekDriftReconcileInput = {
  context: string;
  weekId: string | number;
  dbStatus: string;
  leagueAddress: string;
  emitErrorEvent?: boolean;
  getOnchainWeekStateFn?: typeof getOnchainWeekState;
  updateWeekStatusFn?: typeof updateWeekStatus;
  insertErrorEventFn?: typeof insertErrorEvent;
};

export type WeekDriftReconcileResult = {
  weekId: string;
  dbStatus: string;
  onchainStatus: number;
  expectedOnchainStatus: number | null;
  reconciled: boolean;
  reconciledToStatus: string | null;
  reason: string | null;
};

const toNormalizedStatus = (value: unknown) => String(value ?? "").trim().toUpperCase();

const emitDriftEvent = async (
  insertErrorEventFn: typeof insertErrorEvent,
  source: string,
  severity: "warn" | "error",
  message: string,
  context: Record<string, unknown>,
) => {
  await insertErrorEventFn({
    event_id: randomUUID(),
    source,
    severity,
    category: "automation-drift",
    message,
    context_json: JSON.stringify(context),
    created_at: new Date().toISOString(),
  });
};

export const reconcileWeekStatusDrift = async (
  input: WeekDriftReconcileInput,
): Promise<WeekDriftReconcileResult> => {
  const getOnchainWeekStateFn = input.getOnchainWeekStateFn ?? getOnchainWeekState;
  const updateWeekStatusFn = input.updateWeekStatusFn ?? updateWeekStatus;
  const insertErrorEventFn = input.insertErrorEventFn ?? insertErrorEvent;
  const weekId = String(input.weekId);
  const dbStatus = toNormalizedStatus(input.dbStatus);
  const expectedOnchainStatus = DB_TO_ONCHAIN_STATUS[dbStatus] ?? null;

  const onchain = await getOnchainWeekStateFn(input.leagueAddress, BigInt(weekId));
  const onchainStatus = Number(onchain.status ?? 0);
  const mappedDbStatus = ONCHAIN_TO_DB_STATUS[onchainStatus] ?? null;

  // PREPARING is the only valid transient state where on-chain can still be NONE (0)
  // while reactive/chain creation is in-flight.
  if (dbStatus === "PREPARING" && onchainStatus === 0) {
    return {
      weekId,
      dbStatus,
      onchainStatus,
      expectedOnchainStatus,
      reconciled: false,
      reconciledToStatus: null,
      reason: null,
    };
  }

  if (UNRESOLVED_DB_STATUSES.has(dbStatus) && onchainStatus === 0) {
    const message =
      `${input.context}: mid-week redeploy detected for week ${weekId}. ` +
      `DB status=${dbStatus} but on-chain status=NONE.`;
    if (input.emitErrorEvent !== false) {
      await emitDriftEvent(insertErrorEventFn, "oracle-drift-guard", "error", message, {
        weekId,
        context: input.context,
        dbStatus,
        onchainStatus,
      });
    }
    throw new Error(message);
  }

  if (expectedOnchainStatus !== null && onchainStatus === expectedOnchainStatus) {
    return {
      weekId,
      dbStatus,
      onchainStatus,
      expectedOnchainStatus,
      reconciled: false,
      reconciledToStatus: null,
      reason: null,
    };
  }

  if (!mappedDbStatus) {
    const message =
      `${input.context}: unsupported on-chain status=${onchainStatus} for week ${weekId} (DB=${dbStatus}).`;
    if (input.emitErrorEvent !== false) {
      await emitDriftEvent(insertErrorEventFn, "oracle-drift-guard", "error", message, {
        weekId,
        context: input.context,
        dbStatus,
        onchainStatus,
      });
    }
    throw new Error(message);
  }

  if (mappedDbStatus === dbStatus) {
    return {
      weekId,
      dbStatus,
      onchainStatus,
      expectedOnchainStatus,
      reconciled: false,
      reconciledToStatus: null,
      reason: null,
    };
  }

  await updateWeekStatusFn(weekId, mappedDbStatus);

  const reason = `${input.context}: reconciled DB week status ${dbStatus} -> ${mappedDbStatus} from on-chain=${onchainStatus}`;
  if (input.emitErrorEvent !== false) {
    await emitDriftEvent(insertErrorEventFn, "oracle-drift-guard", "warn", reason, {
      weekId,
      context: input.context,
      dbStatusBefore: dbStatus,
      dbStatusAfter: mappedDbStatus,
      onchainStatus,
      expectedOnchainStatus,
    });
  }

  return {
    weekId,
    dbStatus,
    onchainStatus,
    expectedOnchainStatus,
    reconciled: true,
    reconciledToStatus: mappedDbStatus,
    reason,
  };
};
