import {
  getLifecycleTxIntentByOpKey,
  upsertLifecycleTxIntent,
  markLifecycleTxIntentSubmitted,
  markLifecycleTxIntentCompleted,
  markLifecycleTxIntentFailed,
} from "../store.js";

type LifecycleIntentRow = {
  id: number;
  op_key: string;
  week_id: string | null;
  operation: string;
  status: string;
  tx_hash: string | null;
  details_json: string | null;
  last_error: string | null;
};

type JsonRecord = Record<string, unknown>;

const parseDetails = (raw: string | null | undefined): JsonRecord => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as JsonRecord;
  } catch {
    return {};
  }
};

const mergeDetailsJson = (existingRaw: string | null | undefined, patch?: JsonRecord) => {
  const merged = { ...parseDetails(existingRaw), ...(patch ?? {}) };
  return JSON.stringify(merged);
};

export const ensureLifecycleIntent = async (input: {
  opKey: string;
  weekId?: string | null;
  operation: string;
  details?: JsonRecord;
}): Promise<LifecycleIntentRow> => {
  const existing = (await getLifecycleTxIntentByOpKey(input.opKey)) as LifecycleIntentRow | null;
  const detailsJson = mergeDetailsJson(existing?.details_json, input.details);
  const upserted = await upsertLifecycleTxIntent({
    op_key: input.opKey,
    week_id: input.weekId ?? null,
    operation: input.operation,
    details_json: detailsJson,
  });
  return upserted as LifecycleIntentRow;
};

export const markLifecycleIntentSubmitted = async (
  intent: LifecycleIntentRow,
  txHash: string,
  patch?: JsonRecord,
): Promise<LifecycleIntentRow | null> => {
  const detailsJson = mergeDetailsJson(intent.details_json, patch);
  const row = await markLifecycleTxIntentSubmitted(intent.id, txHash, detailsJson);
  return (row as LifecycleIntentRow | null) ?? null;
};

export const markLifecycleIntentCompleted = async (
  intent: LifecycleIntentRow,
  patch?: JsonRecord,
): Promise<LifecycleIntentRow | null> => {
  const detailsJson = mergeDetailsJson(intent.details_json, patch);
  const row = await markLifecycleTxIntentCompleted(intent.id, detailsJson);
  return (row as LifecycleIntentRow | null) ?? null;
};

export const markLifecycleIntentFailed = async (
  intent: LifecycleIntentRow,
  errorMessage: string,
  patch?: JsonRecord,
): Promise<LifecycleIntentRow | null> => {
  const detailsJson = mergeDetailsJson(intent.details_json, patch);
  const row = await markLifecycleTxIntentFailed(intent.id, errorMessage, detailsJson);
  return (row as LifecycleIntentRow | null) ?? null;
};
