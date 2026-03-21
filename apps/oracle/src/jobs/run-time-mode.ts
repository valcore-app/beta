import { env } from "../env.js";
import {
  getRequiredRuntimeValcoreAddress,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { sendSetTestModeOnchain } from "../network/valcore-chain-client.js";
import { getDerivedTimeMode, isManualAutomationMode, normalizeAutomationMode } from "../admin/automation.js";

const automationMode = normalizeAutomationMode(env.AUTOMATION_MODE);
const enable = isManualAutomationMode(automationMode);
const derivedTimeMode = getDerivedTimeMode(automationMode);

const run = async () => {
  if (!isValcoreChainEnabled()) {
    console.log(
      `Contract mode sync skipped (ORACLE_VALCORE_CHAIN_ENABLED=false). Target=${derivedTimeMode} via AUTOMATION_MODE=${automationMode}`,
    );
    return;
  }

  const leagueAddress = await getRequiredRuntimeValcoreAddress();
  await sendSetTestModeOnchain(leagueAddress, enable);
  console.log(`Test mode set to ${enable} (AUTOMATION_MODE=${automationMode}, derived=${derivedTimeMode}).`);
};

run().catch((error) => {
  console.error("Time mode job failed:", error);
  process.exit(1);
});
