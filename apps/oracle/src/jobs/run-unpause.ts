import { ethers } from "ethers";
import {
  getRequiredRuntimePauserPrivateKey,
  getRequiredRuntimeValcoreAddress,
  getRuntimeProvider,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { sendTxWithPolicy } from "../network/tx-policy.js";

const run = async () => {
  if (!isValcoreChainEnabled()) {
    console.log("unpause skipped: valcore chain mode is disabled");
    return;
  }

  const leagueAddress = await getRequiredRuntimeValcoreAddress();
  const pauserKey = await getRequiredRuntimePauserPrivateKey();
  const provider = await getRuntimeProvider();
  const wallet = new ethers.Wallet(pauserKey, provider);

  const league = new ethers.Contract(
    leagueAddress,
    [
      "function paused() view returns (bool)",
      "function unpause()",
      "function hasRole(bytes32,address) view returns (bool)",
      "function PAUSER_ROLE() view returns (bytes32)",
    ],
    wallet,
  );

  if (!(await league.paused())) {
    console.log("unpause skipped: contract is already live");
    return;
  }

  const pauserRole = await league.PAUSER_ROLE();
  const hasPauserRole = await league.hasRole(pauserRole, wallet.address);
  if (!hasPauserRole) {
    throw new Error(
      `PAUSER_PRIVATE_KEY address ${wallet.address} is missing PAUSER_ROLE on ${leagueAddress}`,
    );
  }

  await sendTxWithPolicy({
    label: "unpause",
    signer: wallet,
    send: (overrides) => league.unpause(overrides),
  });
};

run().catch((error) => {
  console.error("unpause job failed", error);
  process.exit(1);
});
