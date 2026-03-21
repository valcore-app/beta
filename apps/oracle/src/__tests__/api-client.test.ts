import { describe, it, expect, jest } from "@jest/globals";
import { retryWithBackoff, chunk, withConcurrency } from "../services/api-client.js";

describe("API Client Utilities", () => {
  describe("retryWithBackoff", () => {
    it("should succeed on first attempt", async () => {
      const fn = jest.fn<Promise<string>, []>().mockResolvedValue("success");
      const result = await retryWithBackoff<string>(fn, { maxRetries: 3, backoffMs: 100 });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure", async () => {
      const fn = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("success");

      const result = await retryWithBackoff<string>(fn, { maxRetries: 3, backoffMs: 10 });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should throw after max retries", async () => {
      const fn = jest.fn<Promise<string>, []>().mockRejectedValue(new Error("always fails"));

      await expect(
        retryWithBackoff<string>(fn, { maxRetries: 2, backoffMs: 10 }),
      ).rejects.toThrow(
        "always fails",
      );

      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });
  });

  describe("chunk", () => {
    it("should split array into chunks", () => {
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const chunks = chunk(array, 3);

      expect(chunks).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ]);
    });

    it("should handle non-divisible arrays", () => {
      const array = [1, 2, 3, 4, 5];
      const chunks = chunk(array, 2);

      expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("should handle empty arrays", () => {
      const chunks = chunk([], 3);
      expect(chunks).toEqual([]);
    });
  });

  describe("withConcurrency", () => {
    it("should process items with limited concurrency", async () => {
      const items = [1, 2, 3, 4, 5];
      const task = async (n: number) => n * 2;

      const results = await withConcurrency(items, 2, task);

      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it("should maintain order", async () => {
      const items = [1, 2, 3, 4, 5];
      const task = async (n: number) => {
        // Simulate varying async times
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
        return n * 2;
      };

      const results = await withConcurrency(items, 3, task);

      expect(results).toEqual([2, 4, 6, 8, 10]);
    });
  });
});
