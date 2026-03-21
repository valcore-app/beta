import { Contract, keccak256, toUtf8Bytes } from "ethers";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createProfileWallet, getRequiredAddresses, loadActiveProfile } from "./_runtime";

const oracleUrl = process.env.ORACLE_URL || "http://localhost:3101";

async function main() {
  const profile = await loadActiveProfile();
  const wallet = await createProfileWallet(profile, "oracle");
  const { valcoreAddress } = getRequiredAddresses(profile);

  const weekRes = await fetch(`${oracleUrl}/weeks/current`);
  if (!weekRes.ok) throw new Error("week fetch failed");
  const week = await weekRes.json();

  const metadataPath = resolve(
    __dirname,
    "..",
    "..",
    "oracle",
    "data",
    `metadata-${week.id}.json`,
  );
  const metadataJson = readFileSync(metadataPath, "utf-8");
  const metadata = JSON.parse(metadataJson);
  const metadataHash = keccak256(toUtf8Bytes(metadataJson));
  const retainedFeeWei = BigInt(metadata.retainedFeeWei ?? "0");

  const valcore = new Contract(
    valcoreAddress,
    ["function finalizeWeek(uint256,bytes32,bytes32,uint256)"],
    wallet,
  );

  const tx = await valcore.finalizeWeek(BigInt(week.id), metadata.root, metadataHash, retainedFeeWei);
  await tx.wait();

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
