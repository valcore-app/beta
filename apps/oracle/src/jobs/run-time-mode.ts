import { env } from "../env.js";
import {
  getRequiredRuntimeContractAdminPrivateKey,
  getRequiredRuntimeValcoreAddress,
  getRuntimeProvider,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { sendTxWithPolicy } from "../network/tx-policy.js";
import { ethers } from "ethers";
import { getDerivedTimeMode, isManualAutomationMode, normalizeAutomationMode } from "../admin/automation.js";

const automationMode = normalizeAutomationMode(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE);
const enable = isManualAutomationMode(automationMode);
const derivedTimeMode = getDerivedTimeMode(automationMode);

const run = async () => {
  if (!isValcoreChainEnabled()) {
    console.log(
      `Contract mode sync skipped (ORACLE_VALCORE_CHAIN_ENABLED=false). Target=${derivedTimeMode} via AUTOMATION_MODE=${automationMode}`,
    );
    return;
  }

  const provider = await getRuntimeProvider();
  const adminKey = await getRequiredRuntimeContractAdminPrivateKey();
  const adminWallet = new ethers.Wallet(adminKey, provider);
  const leagueAddress = await getRequiredRuntimeValcoreAddress();
  const adminLeague = new ethers.Contract(
    leagueAddress,
    ["function setTestMode(bool)"],
    adminWallet,
  );

  const sent = await sendTxWithPolicy({
    label: `setTestMode(${enable})`,
    signer: adminWallet,
    send: (overrides) => adminLeague.setTestMode(enable, overrides),
  });

  console.log(
    `Test mode set to ${enable} (AUTOMATION_MODE=${automationMode}, derived=${derivedTimeMode}, tx=${sent.txHash}).`,
  );
};

run().catch((error) => {
  console.error("Time mode job failed:", error);
  process.exit(1);
});
