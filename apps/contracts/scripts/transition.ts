import { Contract } from "ethers";
import { createProfileWallet, getRequiredAddresses, loadActiveProfile } from "./_runtime";

const oracleUrl = process.env.ORACLE_URL || "http://localhost:3101";

async function main() {
  const action = process.argv[2];
  if (!action || !["lock", "start"].includes(action)) {
    throw new Error("Usage: transition.ts <lock|start>");
  }

  const profile = await loadActiveProfile();
  const wallet = await createProfileWallet(profile, "oracle");
  const { valcoreAddress } = getRequiredAddresses(profile);

  const weekRes = await fetch(`${oracleUrl}/weeks/current`);
  if (!weekRes.ok) throw new Error("week fetch failed");
  const week = await weekRes.json();

  const valcore = new Contract(
    valcoreAddress,
    ["function lockWeek(uint256)", "function startWeek(uint256)"],
    wallet,
  );

  const weekId = BigInt(week.id);
  const tx = action === "lock" ? await valcore.lockWeek(weekId) : await valcore.startWeek(weekId);
  await tx.wait();

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
