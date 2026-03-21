const { spawn } = require("node:child_process");
const net = require("node:net");

const STARTUP_TIMEOUT_MS = 120000;
const SHUTDOWN_TIMEOUT_MS = 5000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort(start = 3400) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port));
      });
    };
    try {
      tryPort(start);
    } catch (error) {
      reject(error);
    }
  });
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
      lastError = new Error(`Unexpected status ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError ? String(lastError) : "unknown"}`);
}

async function stopProcess(child) {
  if (!child || child.killed) return;

  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);

  if (!stopped) {
    child.kill("SIGKILL");
  }
}

async function run() {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];

  const child = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
        env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onLog = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    if (logs.length > 100) logs.shift();
  };

  child.stdout.on("data", onLog);
  child.stderr.on("data", onLog);

  try {
    await waitForHttp(`${baseUrl}/strategy`, STARTUP_TIMEOUT_MS);

    const lineupRes = await fetch(`${baseUrl}/strategy`);
    const lineupHtml = await lineupRes.text();
    if (lineupRes.status !== 200) {
      throw new Error(`/strategy returned ${lineupRes.status}`);
    }
    if (!lineupHtml.toLowerCase().includes("valcore")) {
      throw new Error("/strategy response does not contain expected app marker");
    }

    const opsRes = await fetch(`${baseUrl}/ops/login`);
    const opsHtml = await opsRes.text();
    if (opsRes.status !== 200) {
      throw new Error(`/ops/login returned ${opsRes.status}`);
    }
    if (!opsHtml.toLowerCase().includes("ops")) {
      throw new Error("/ops/login response does not contain expected marker");
    }

    const providersRes = await fetch(`${baseUrl}/api/auth/providers`);
    if (providersRes.status !== 200) {
      throw new Error(`/api/auth/providers returned ${providersRes.status}`);
    }

    console.log("Smoke checks passed:", ["/strategy", "/ops/login", "/api/auth/providers"].join(", "));
  } catch (error) {
    console.error("Smoke test failed.");
    console.error(String(error));
    console.error("Recent server logs:\n", logs.join(""));
    process.exitCode = 1;
  } finally {
    await stopProcess(child);
  }
}

run().catch((error) => {
  console.error("Smoke runner crashed:", error);
  process.exit(1);
});