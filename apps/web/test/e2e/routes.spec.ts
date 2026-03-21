import { expect, test } from "@playwright/test";

test("strategy page renders core UI", async ({ page }) => {
  await page.goto("/strategy");
  await expect(page.getByText("Strategy Board")).toBeVisible();
  await expect(page.getByText("Tactical Moves", { exact: false })).toBeVisible();
});