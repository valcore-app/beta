import { describe, it, expect, beforeAll } from "@jest/globals";

// NOTE: Store tests are disabled by default after migrating to Postgres.
// Enable with RUN_DB_TESTS=1 and point to a disposable test database.
const runDbTests = process.env.RUN_DB_TESTS === "1";

const describeDb = runDbTests ? describe : describe.skip;

describeDb("Store", () => {
  let store: typeof import("../store.js");

  beforeAll(async () => {
    store = await import("../store.js");
    await store.upsertCoinCategory({
      id: "eligible",
      name: "Eligible",
      description: null,
      sort_order: 1,
    });
    await store.upsertCoinCategory({
      id: "stablecoin",
      name: "Stablecoin",
      description: null,
      sort_order: 2,
    });
    await store.upsertCoinCategory({
      id: "excluded",
      name: "Excluded",
      description: null,
      sort_order: 3,
    });
  });

  describe("Weeks", () => {
    it("should insert and retrieve a week", async () => {
      const week = {
        id: "test-week-1",
        start_at: new Date().toISOString(),
        lock_at: new Date(Date.now() + 3600000).toISOString(),
        end_at: new Date(Date.now() + 86400000).toISOString(),
        status: "DRAFT_OPEN",
      };

      await store.upsertWeek(week);
      const weeks = await store.getWeeks();

      expect(weeks).toHaveLength(1);
      expect(weeks[0].id).toBe(week.id);
      expect(weeks[0].status).toBe(week.status);
    });

    it("should update existing week", async () => {
      const week = {
        id: "test-week-1",
        start_at: new Date().toISOString(),
        lock_at: new Date(Date.now() + 3600000).toISOString(),
        end_at: new Date(Date.now() + 86400000).toISOString(),
        status: "DRAFT_OPEN",
      };

      await store.upsertWeek(week);
      await store.updateWeekStatus(week.id, "LOCKED");

      const weeks = await store.getWeeks();
      expect(weeks[0].status).toBe("LOCKED");
    });
  });

  describe("Coins", () => {
    it("should insert and retrieve coins", async () => {
      const coin = {
        id: "bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        category_id: "eligible",
        image_path: null,
        last_updated: new Date().toISOString(),
      };

      await store.upsertCoin(coin);
      const coins = await store.getCoins();

      expect(coins).toHaveLength(1);
      expect(coins[0].symbol).toBe("BTC");
      expect(coins[0].id).toBe("bitcoin");
    });
  });

  describe("Week Coins", () => {
    it("should insert week coins with transaction", async () => {
      const weekId = "test-week-1";

      // First insert a week
      await store.upsertWeek({
        id: weekId,
        start_at: new Date().toISOString(),
        lock_at: new Date(Date.now() + 3600000).toISOString(),
        end_at: new Date(Date.now() + 86400000).toISOString(),
        status: "DRAFT_OPEN",
      });

      // Insert coins
      await store.upsertCoin({
        id: "bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        category_id: "eligible",
        image_path: null,
        last_updated: new Date().toISOString(),
      });

      // Insert week coins
      const weekCoins = [
        {
          week_id: weekId,
          coin_id: "bitcoin",
          rank: 1,
          position: "DEF",
          salary: 7000,
          power: 60,
          risk: "Medium",
          momentum: "Steady",
        },
      ];

      await store.setWeekCoins(weekId, weekCoins);
      const retrieved = await store.getWeekCoins(weekId);

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].position).toBe("DEF");
      expect(retrieved[0].salary).toBe(7000);
    });

    it("should replace week coins atomically", async () => {
      const weekId = "test-week-1";

      await store.upsertWeek({
        id: weekId,
        start_at: new Date().toISOString(),
        lock_at: new Date(Date.now() + 3600000).toISOString(),
        end_at: new Date(Date.now() + 86400000).toISOString(),
        status: "DRAFT_OPEN",
      });

      await store.upsertCoin({
        id: "bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        category_id: "eligible",
        image_path: null,
        last_updated: new Date().toISOString(),
      });

      // First insert
      await store.setWeekCoins(weekId, [
        {
          week_id: weekId,
          coin_id: "bitcoin",
          rank: 1,
          position: "DEF",
          salary: 7000,
          power: 60,
          risk: "Medium",
          momentum: "Steady",
        },
      ]);

      // Replace
      await store.setWeekCoins(weekId, [
        {
          week_id: weekId,
          coin_id: "bitcoin",
          rank: 1,
          position: "MID",
          salary: 5000,
          power: 62,
          risk: "High",
          momentum: "Down",
        },
      ]);

      const retrieved = await store.getWeekCoins(weekId);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].position).toBe("MID");
      expect(retrieved[0].salary).toBe(5000);
    });
  });

  describe("Lineups", () => {
    it("should insert and retrieve lineups", async () => {
      const weekId = "test-week-1";
      const address = "0x1234567890123456789012345678901234567890";

      await store.upsertWeek({
        id: weekId,
        start_at: new Date().toISOString(),
        lock_at: new Date(Date.now() + 3600000).toISOString(),
        end_at: new Date(Date.now() + 86400000).toISOString(),
        status: "DRAFT_OPEN",
      });

      const lineup = {
        week_id: weekId,
        address: address.toLowerCase(),
        slots_json: JSON.stringify([{ slotId: "1", coinId: "bitcoin" }]),
        lineup_hash: "0xabc123",
        deposit_wei: "1000000000000000000",
        principal_wei: "900000000000000000",
        risk_wei: "100000000000000000",
        swaps: 0,
        created_at: new Date().toISOString(),
      };

      await store.upsertLineup(lineup);
      const lineups = await store.getLineups(weekId);

      expect(lineups).toHaveLength(1);
      expect(lineups[0].address).toBe(address.toLowerCase());
      expect(lineups[0].swaps).toBe(0);
    });
  });
});
