import { Contract } from "ethers";
import { createProfileWallet, getRequiredAddresses, loadActiveProfile } from "./_runtime";

const oracleUrl = process.env.ORACLE_URL || "http://localhost:3101";

async function main() {
  const profile = await loadActiveProfile();
  const wallet = await createProfileWallet(profile, "user");
  const { valcoreAddress } = getRequiredAddresses(profile);
  const userAddress = wallet.address;
  const weekRes = await fetch(`${oracleUrl}/weeks/current`);
  if (!weekRes.ok) throw new Error("week fetch failed");
  const week = await weekRes.json();

  const claimRes = await fetch(`${oracleUrl}/weeks/${week.id}/claims/${userAddress}`);
  if (!claimRes.ok) throw new Error("claim fetch failed");
  const claim = await claimRes.json();

  const valcore = new Contract(
    valcoreAddress,
    ["function claim(uint256,uint256,uint256,uint256,bytes32[])"],
    wallet,
  );
  const tx = await valcore.claim(
    BigInt(week.id),
    BigInt(claim.principal),
    BigInt(claim.riskPayout),
    BigInt(claim.totalWithdraw),
    claim.proof,
  );
  await tx.wait();

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
