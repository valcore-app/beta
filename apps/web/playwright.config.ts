import { defineConfig } from "@playwright/test";

const port = 3201;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `node ./node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/strategy`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
