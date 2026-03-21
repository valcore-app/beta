import { describe, expect, it } from "@jest/globals";
import { assertWeekChainSync, isUnresolvedDbWeekStatus } from "../jobs/week-sync-guard.js";

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

describe("week sync guard", () => {
  it("throws explicit mid-week redeploy error when DB unresolved but on-chain NONE", async () => {
    await expect(
      assertWeekChainSync({
        context: "run-transition",
        leagueAddress: "0x123",
        weekId: "42",
        dbStatus: "DRAFT_OPEN",
        getOnchainWeekStateFn: async () => mockWeekState(0),
      }),
    ).rejects.toThrow("mid-week redeploy detected");
  });

  it("throws mismatch error when DB and on-chain statuses differ", async () => {
    await expect(
      assertWeekChainSync({
        context: "run-finalize",
        leagueAddress: "0x123",
        weekId: "42",
        dbStatus: "ACTIVE",
        getOnchainWeekStateFn: async () => mockWeekState(2),
      }),
    ).rejects.toThrow("DB/on-chain week status mismatch");
  });

  it("passes when DB and on-chain statuses are aligned", async () => {
    const result = await assertWeekChainSync({
      context: "run-finalize",
      leagueAddress: "0x123",
      weekId: "42",
      dbStatus: "ACTIVE",
      getOnchainWeekStateFn: async () => mockWeekState(3),
    });

    expect(result.onchainStatus).toBe(3);
    expect(result.expectedOnchainStatus).toBe(3);
  });

  it("supports explicit expectedOnchainStatus override", async () => {
    const result = await assertWeekChainSync({
      context: "run-finalize-audit",
      leagueAddress: "0x123",
      weekId: "42",
      dbStatus: "ACTIVE",
      expectedOnchainStatus: 4,
      getOnchainWeekStateFn: async () => mockWeekState(4),
    });

    expect(result.onchainStatus).toBe(4);
    expect(result.expectedOnchainStatus).toBe(4);
  });

  it("normalizes unresolved status checks", () => {
    expect(isUnresolvedDbWeekStatus("draft_open")).toBe(true);
    expect(isUnresolvedDbWeekStatus("FINALIZE_PENDING")).toBe(true);
    expect(isUnresolvedDbWeekStatus("FINALIZED")).toBe(false);
  });
});
