import { Contract, parseUnits } from "ethers";
import { createProfileWallet, getRequiredAddresses, loadActiveProfile } from "./_runtime";

async function main() {
  const to = process.env.FAUCET_TO;
  const amount = process.env.FAUCET_AMOUNT || "10000";
  const profile = await loadActiveProfile();
  const wallet = await createProfileWallet(profile, "faucet");
  const { stablecoinAddress } = getRequiredAddresses(profile);

  if (!to) {
    throw new Error("FAUCET_TO is required");
  }

  const stablecoin = new Contract(stablecoinAddress, ["function mint(address,uint256)"], wallet);
  const tx = await stablecoin.mint(to, parseUnits(amount, profile.stablecoinDecimals));
  await tx.wait();

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

