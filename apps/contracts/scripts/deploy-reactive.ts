import { artifacts, ethers } from "hardhat";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const normalizeText = (value: unknown) => {
  const normalized = String(value ?? "").trim();
  return normalized || "";
};

const requireText = (value: unknown, label: string) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
};

const toPositiveInt = (value: unknown, label: string, fallback?: number) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)) {
    return parsed;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`${label} must be a positive integer`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createFactory = async (
  name: "ValcoreReactiveReceiver" | "ValcoreReactiveDispatcher" | "ValcoreReactiveTrigger",
  wallet: Wallet,
) => {
  const artifact = await artifacts.readArtifact(name);
  return new ContractFactory(artifact.abi, artifact.bytecode, wallet);
};

const resolveReactiveSenderWithRetry = async (provider: JsonRpcProvider, dispatcherAddress: string): Promise<string> => {
  const maxAttempts = 40;
  const delayMs = 3000;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const mapping = await provider.send("rnk_getRnkAddressMapping", [dispatcherAddress]);
      const mappedRvmIdRaw = String(
        (mapping as { rvmId?: unknown; RvmId?: unknown } | null | undefined)?.rvmId ??
          (mapping as { rvmId?: unknown; RvmId?: unknown } | null | undefined)?.RvmId ??
          "",
      ).trim();
      if (mappedRvmIdRaw) {
        return ethers.getAddress(mappedRvmIdRaw);
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown mapping error");
  throw new Error(`Reactive dispatcher RVM mapping is missing after ${maxAttempts} attempts: ${message}`);
};

const resolveDispatcherStateWithRetry = async (
  dispatcherView: ethers.Contract,
): Promise<{ destinationChainId: bigint; destinationReceiver: string; operator: string; subscriptionActive: boolean }> => {
  const maxAttempts = 30;
  const delayMs = 2000;
  let lastError: unknown = null;
  let lastState:
    | { destinationChainId: bigint; destinationReceiver: string; operator: string; subscriptionActive: boolean }
    | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const [subscriptionActive, destinationChainId, destinationReceiver, operator] = await Promise.all([
        dispatcherView.subscriptionActive(),
        dispatcherView.destinationChainId(),
        dispatcherView.destinationReceiver(),
        dispatcherView.operator(),
      ]);
      lastState = {
        subscriptionActive: Boolean(subscriptionActive),
        destinationChainId: BigInt(destinationChainId),
        destinationReceiver: String(destinationReceiver),
        operator: String(operator),
      };
      if (lastState.subscriptionActive) {
        return lastState;
      }
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  if (lastState) {
    return lastState;
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown dispatcher read error");
  throw new Error(`Dispatcher post-deploy state unavailable after ${maxAttempts} attempts: ${message}`);
};

const ensureRole = async (
  valcore: ethers.Contract,
  role: string,
  account: string,
  roleLabel: string,
) => {
  const hasRole = Boolean(await valcore.hasRole(role, account));
  if (hasRole) return;
  const tx = await valcore.grantRole(role, account);
  await tx.wait();
  console.log(`granted ${roleLabel} to ${account}: ${tx.hash}`);
};

async function main() {
  const destinationChainId = toPositiveInt(process.env.CHAIN_ID, "CHAIN_ID");
  const destinationRpcUrl = requireText(process.env.CHAIN_RPC_URL, "CHAIN_RPC_URL");
  const valcoreAddress = requireText(process.env.VALCORE_ADDRESS, "VALCORE_ADDRESS");
  const adminPrivateKey = requireText(process.env.CONTRACT_ADMIN_PRIVATE_KEY, "CONTRACT_ADMIN_PRIVATE_KEY");

  const reactiveChainId = toPositiveInt(process.env.REACTIVE_CHAIN_ID, "REACTIVE_CHAIN_ID", 5318007);
  const reactiveRpcUrl = requireText(process.env.REACTIVE_CHAIN_RPC_URL, "REACTIVE_CHAIN_RPC_URL");
  const reactiveExecutorPrivateKey = requireText(process.env.REACTIVE_EXECUTOR_PRIVATE_KEY, "REACTIVE_EXECUTOR_PRIVATE_KEY");
  const reactiveDeployerPrivateKey = normalizeText(process.env.REACTIVE_DEPLOYER_PRIVATE_KEY) || reactiveExecutorPrivateKey;
  const callbackProxyAddress = requireText(process.env.REACTIVE_CALLBACK_PROXY_ADDRESS, "REACTIVE_CALLBACK_PROXY_ADDRESS");
  const callbackSenderAddress = requireText(process.env.REACTIVE_CALLBACK_SENDER_ADDRESS, "REACTIVE_CALLBACK_SENDER_ADDRESS");
  const receiverPrefundEth = normalizeText(process.env.REACTIVE_RECEIVER_PREFUND_ETH) || "0.001";
  const dispatcherPrefundEth = normalizeText(process.env.REACTIVE_DISPATCHER_PREFUND_ETH) || "0.01";

  const destinationProvider = new JsonRpcProvider(destinationRpcUrl, destinationChainId);
  const adminWallet = new Wallet(adminPrivateKey, destinationProvider);

  const reactiveProvider = new JsonRpcProvider(reactiveRpcUrl, reactiveChainId);
  const reactiveDeployer = new Wallet(reactiveDeployerPrivateKey, reactiveProvider);
  const reactiveExecutorAddress = new Wallet(reactiveExecutorPrivateKey).address;

  console.log(`destination admin=${adminWallet.address} chainId=${destinationChainId}`);
  console.log(`reactive deployer=${reactiveDeployer.address} chainId=${reactiveChainId}`);
  console.log(`reactive executor=${reactiveExecutorAddress}`);

  const ReceiverFactory = await createFactory("ValcoreReactiveReceiver", adminWallet);
  const receiver = await ReceiverFactory.deploy(callbackProxyAddress, valcoreAddress, reactiveDeployer.address);
  await receiver.waitForDeployment();
  const receiverAddress = await receiver.getAddress();
  if (receiverAddress.toLowerCase() === callbackProxyAddress.toLowerCase()) {
    throw new Error("Receiver address resolved to callback proxy address; aborting deployment");
  }
  console.log(`receiver deployed: ${receiverAddress}`);

  const receiverPrefundWei = ethers.parseEther(receiverPrefundEth);
  if (receiverPrefundWei > 0n) {
    const fundTx = await adminWallet.sendTransaction({ to: receiverAddress, value: receiverPrefundWei });
    await fundTx.wait();
    console.log(`receiver prefunded: ${receiverPrefundEth} ETH (${fundTx.hash})`);
  }

  const receiverAdmin = new ethers.Contract(
    receiverAddress,
    ["function setAuthorizedSender(address,bool)", "function setReactiveSender(address)", "function coverDebt()"],
    adminWallet,
  );
  const coverDebtTx = await receiverAdmin.coverDebt();
  await coverDebtTx.wait();
  console.log(`receiver debt covered: ${coverDebtTx.hash}`);
  const setSenderTx = await receiverAdmin.setAuthorizedSender(callbackSenderAddress, true);
  await setSenderTx.wait();
  console.log(`receiver authorized sender set: ${callbackSenderAddress} (${setSenderTx.hash})`);

  const valcore = new ethers.Contract(
    valcoreAddress,
    [
      "function ORACLE_ROLE() view returns (bytes32)",
      "function AUDITOR_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
      "function grantRole(bytes32,address)",
    ],
    adminWallet,
  );

  const oracleRole = String(await valcore.ORACLE_ROLE());
  const auditorRole = String(await valcore.AUDITOR_ROLE());

  await ensureRole(valcore, oracleRole, receiverAddress, "ORACLE_ROLE");
  await ensureRole(valcore, auditorRole, receiverAddress, "AUDITOR_ROLE");

  const TriggerFactory = await createFactory("ValcoreReactiveTrigger", reactiveDeployer);
  const trigger = await TriggerFactory.deploy(reactiveDeployer.address);
  await trigger.waitForDeployment();
  const triggerAddress = await trigger.getAddress();
  console.log(`trigger deployed: ${triggerAddress}`);

  const DispatcherFactory = await createFactory("ValcoreReactiveDispatcher", reactiveDeployer);
  const dispatcherPrefundWei = ethers.parseEther(dispatcherPrefundEth);
  const dispatcher = await DispatcherFactory.deploy(
    destinationChainId,
    receiverAddress,
    reactiveExecutorAddress,
    triggerAddress,
    { value: dispatcherPrefundWei },
  );
  await dispatcher.waitForDeployment();
  const dispatcherAddress = await dispatcher.getAddress();
  if (dispatcherPrefundWei > 0n) {
    console.log(`dispatcher deploy-funded: ${dispatcherPrefundEth} REACT`);
  }

  const triggerAdmin = new ethers.Contract(
    triggerAddress,
    ["function setDispatcher(address)"],
    reactiveDeployer,
  );
  const setDispatcherTx = await triggerAdmin.setDispatcher(dispatcherAddress);
  await setDispatcherTx.wait();
  console.log(`trigger dispatcher set: ${setDispatcherTx.hash}`);

  const dispatcherAdmin = new ethers.Contract(
    dispatcherAddress,
    ["function coverDebt()"],
    reactiveDeployer,
  );
  try {
    const dispatcherDebtTx = await dispatcherAdmin.coverDebt();
    await dispatcherDebtTx.wait();
    console.log(`dispatcher debt covered: ${dispatcherDebtTx.hash}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`dispatcher debt cover skipped: ${message}`);
  }

  const dispatcherOperator = new ethers.Contract(
    dispatcherAddress,
    ["function activateSubscription()"],
    new Wallet(reactiveExecutorPrivateKey, reactiveProvider),
  );
  const activateTx = await dispatcherOperator.activateSubscription();
  await activateTx.wait();
  console.log(`dispatcher subscription activated: ${activateTx.hash}`);

  const dispatcherView = new ethers.Contract(
    dispatcherAddress,
    [
      "function subscriptionActive() view returns (bool)",
      "function destinationChainId() view returns (uint256)",
      "function destinationReceiver() view returns (address)",
      "function operator() view returns (address)",
      "function triggerContract() view returns (address)",
    ],
    reactiveProvider,
  );
  const dispatcherState = await resolveDispatcherStateWithRetry(dispatcherView);
  const subscriptionActiveCheck = dispatcherState.subscriptionActive;
  const destinationChainIdCheck = dispatcherState.destinationChainId;
  const destinationReceiverCheck = dispatcherState.destinationReceiver;
  const operatorCheck = dispatcherState.operator;
  const triggerCheck = String(await dispatcherView.triggerContract());
  if (!subscriptionActiveCheck) {
    throw new Error("Dispatcher subscriptionActive is false after activateSubscription()");
  }
  if (destinationChainIdCheck !== BigInt(destinationChainId)) {
    throw new Error(
      `Dispatcher destinationChainId mismatch after deploy: expected=${destinationChainId} got=${destinationChainIdCheck.toString()}`,
    );
  }
  if (destinationReceiverCheck.toLowerCase() !== receiverAddress.toLowerCase()) {
    throw new Error(
      `Dispatcher destinationReceiver mismatch after deploy: expected=${receiverAddress} got=${destinationReceiverCheck}`,
    );
  }
  if (operatorCheck.toLowerCase() !== reactiveExecutorAddress.toLowerCase()) {
    throw new Error(
      `Dispatcher operator mismatch after deploy: expected=${reactiveExecutorAddress} got=${operatorCheck}`,
    );
  }
  if (triggerCheck.toLowerCase() !== triggerAddress.toLowerCase()) {
    throw new Error(
      `Dispatcher triggerContract mismatch after deploy: expected=${triggerAddress} got=${triggerCheck}`,
    );
  }
  console.log(`dispatcher deployed: ${dispatcherAddress}`);

  const reactiveSenderAddress = await resolveReactiveSenderWithRetry(reactiveProvider, dispatcherAddress);
  const receiverView = new ethers.Contract(
    receiverAddress,
    ["function reactiveSender() view returns (address)"],
    destinationProvider,
  );
  const currentReactiveSender = String(await receiverView.reactiveSender());
  if (currentReactiveSender.toLowerCase() !== reactiveSenderAddress.toLowerCase()) {
    const setReactiveSenderTx = await receiverAdmin.setReactiveSender(reactiveSenderAddress);
    await setReactiveSenderTx.wait();
    console.log(`receiver reactive sender set: ${reactiveSenderAddress} (${setReactiveSenderTx.hash})`);
  } else {
    console.log(`receiver reactive sender already set: ${reactiveSenderAddress}`);
  }

  const summary = {
    deployedAt: new Date().toISOString(),
    destination: {
      chainId: destinationChainId,
      valcoreAddress,
      receiverAddress,
      callbackProxyAddress,
      callbackSenderAddress,
      adminAddress: adminWallet.address,
    },
    reactive: {
      chainId: reactiveChainId,
      dispatcherAddress,
      triggerAddress,
      deployerAddress: reactiveDeployer.address,
      executorAddress: reactiveExecutorAddress,
      reactiveSenderAddress,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log("\nSet oracle env to:");
  console.log(`REACTIVE_DISPATCHER_ADDRESS=${dispatcherAddress}`);
  console.log(`REACTIVE_RECEIVER_ADDRESS=${receiverAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
