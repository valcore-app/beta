import { describe, expect, it } from "@jest/globals";
import { reconcileWeekStatusDrift } from "../jobs/week-drift.js";

const mockWeekState = (status: number) => ({
  startAt: 0n,
  lockAt: 0n,
  endAt: 0n,
  finalizedAt: 0n,
  status,
  riskCommitted: 0n,
  retainedFee: 0n,
  merkleRoot: "0x0",
  metadataHash: "0x0",
});

describe("week drift reconcile", () => {
  it("reconciles DRAFT_OPEN -> LOCKED drift", async () => {
    const updates: Array<{ weekId: string; status: string }> = [];
    const result = await reconcileWeekStatusDrift({
      context: "test",
      weekId: "42",
      dbStatus: "DRAFT_OPEN",
      leagueAddress: "0x123",
      getOnchainWeekStateFn: async () => mockWeekState(2),
      updateWeekStatusFn: async (weekId, status) => {
        updates.push({ weekId: String(weekId), status: String(status) });
      },
      insertErrorEventFn: async () => null,
    });

    expect(result.reconciled).toBe(true);
    expect(result.reconciledToStatus).toBe("LOCKED");
    expect(updates).toEqual([{ weekId: "42", status: "LOCKED" }]);
  });

  it("does not reconcile when statuses are aligned", async () => {
    const result = await reconcileWeekStatusDrift({
      context: "test",
      weekId: "42",
      dbStatus: "ACTIVE",
      leagueAddress: "0x123",
      getOnchainWeekStateFn: async () => mockWeekState(3),
      updateWeekStatusFn: async () => {
        throw new Error("should not be called");
      },
      insertErrorEventFn: async () => null,
    });

    expect(result.reconciled).toBe(false);
    expect(result.onchainStatus).toBe(3);
  });

  it("throws on unresolved DB with on-chain NONE", async () => {
    await expect(
      reconcileWeekStatusDrift({
        context: "test",
        weekId: "42",
        dbStatus: "LOCKED",
        leagueAddress: "0x123",
        getOnchainWeekStateFn: async () => mockWeekState(0),
        updateWeekStatusFn: async () => undefined,
        insertErrorEventFn: async () => null,
      }),
    ).rejects.toThrow("mid-week redeploy detected");
  });

  it("does not throw for PREPARING when on-chain is NONE", async () => {
    const result = await reconcileWeekStatusDrift({
      context: "test",
      weekId: "42",
      dbStatus: "PREPARING",
      leagueAddress: "0x123",
      getOnchainWeekStateFn: async () => mockWeekState(0),
      updateWeekStatusFn: async () => {
        throw new Error("should not be called");
      },
      insertErrorEventFn: async () => null,
    });

    expect(result.reconciled).toBe(false);
    expect(result.onchainStatus).toBe(0);
    expect(result.reconciledToStatus).toBeNull();
  });
});
