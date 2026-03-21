import { withWriteTransaction } from "../db/db.js";

const run = async () => {
  await withWriteTransaction(async (client) => {
    await client.query("TRUNCATE weeks RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE job_runs RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE self_heal_task_runs RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE self_heal_tasks RESTART IDENTITY CASCADE");
  });

  console.log(
    "Database reset: cleared weeks, related tables, job logs, and self-heal tasks. Coins and faucet claims preserved.",
  );
};

run().catch((error) => {
  console.error("Reset DB failed:", error);
  process.exit(1);
});