import { Contract } from "ethers";
import { createProfileWallet, getRequiredAddresses, loadActiveProfile } from "./_runtime";

const oracleUrl = process.env.ORACLE_URL || "http://localhost:3101";

async function main() {
  const profile = await loadActiveProfile();
  const wallet = await createProfileWallet(profile, "oracle");
  const { valcoreAddress } = getRequiredAddresses(profile);

  const weekRes = await fetch(`${oracleUrl}/weeks/current`);
  if (!weekRes.ok) throw new Error("week fetch failed");
  const week = await weekRes.json();

  const valcore = new Contract(valcoreAddress, ["function startWeek(uint256)"], wallet);
  const tx = await valcore.startWeek(BigInt(week.id));
  await tx.wait();

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
