import {
  getRequiredRuntimeValcoreAddress,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { getOnchainPaused, sendPauseOnchain } from "../network/valcore-chain-client.js";

const run = async () => {
  if (!isValcoreChainEnabled()) {
    console.log("pause skipped: valcore chain mode is disabled");
    return;
  }

  const leagueAddress = await getRequiredRuntimeValcoreAddress();
  if (await getOnchainPaused(leagueAddress)) {
    console.log("pause skipped: contract is already paused");
    return;
  }

  await sendPauseOnchain(leagueAddress);
};

run().catch((error) => {
  console.error("pause job failed", error);
  process.exit(1);
});
