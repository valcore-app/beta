import {
  getRequiredRuntimeValcoreAddress,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { getOnchainPaused, sendUnpauseOnchain } from "../network/valcore-chain-client.js";

const run = async () => {
  if (!isValcoreChainEnabled()) {
    console.log("unpause skipped: valcore chain mode is disabled");
    return;
  }

  const leagueAddress = await getRequiredRuntimeValcoreAddress();
  if (!(await getOnchainPaused(leagueAddress))) {
    console.log("unpause skipped: contract is already live");
    return;
  }

  await sendUnpauseOnchain(leagueAddress);
};

run().catch((error) => {
  console.error("unpause job failed", error);
  process.exit(1);
});
