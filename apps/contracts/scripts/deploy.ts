import { artifacts, ethers } from "hardhat";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

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
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${label} must be a positive integer`);
};

const parseBoolean = (value: unknown, fallback: boolean) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

const createFactory = async (name: "StablecoinMock" | "ValcoreV1", wallet: Wallet) => {
  const artifact = await artifacts.readArtifact(name);
  return new ContractFactory(artifact.abi, artifact.bytecode, wallet);
};

const ensureRole = async (contract: any, role: string, account: string, roleLabel: string) => {
  const hasRole = Boolean(await contract.hasRole(role, account));
  if (hasRole) return;
  const tx = await contract.grantRole(role, account);
  await tx.wait();
  console.log(`Granted ${roleLabel} to ${account}: ${tx.hash}`);
};

const getUnresolvedWeekForDeployGuard = async () => {
  const connectionString = normalizeText(process.env.APP_READ_DATABASE_URL);
  if (!connectionString) {
    throw new Error(
      "APP_READ_DATABASE_URL is required for deploy safety guard. Set ALLOW_MIDWEEK_REDEPLOY=true to bypass intentionally.",
    );
  }

  const rejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "false").trim().toLowerCase() === "true";
  const client = new Client({
    connectionString,
    ssl: rejectUnauthorized ? { rejectUnauthorized: true } : false,
  });

  await client.connect();
  try {
    const result = await client.query(
      "SELECT id, status FROM weeks WHERE upper(status) IN ('PREPARING','DRAFT_OPEN','LOCKED','ACTIVE','FINALIZE_PENDING') ORDER BY created_at DESC LIMIT 1",
    );
    return result.rows[0] as { id: string | number; status: string } | undefined;
  } finally {
    await client.end();
  }
};

async function main() {
  const chainKey = requireText(process.env.CHAIN_KEY, "CHAIN_KEY");
  const chainId = toPositiveInt(process.env.CHAIN_ID, "CHAIN_ID");
  const rpcUrl = requireText(process.env.CHAIN_RPC_URL, "CHAIN_RPC_URL");
  const deployerPrivateKey = requireText(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  const treasuryAddress = requireText(process.env.TREASURY_ADDRESS, "TREASURY_ADDRESS");

  const pauserPrivateKey = requireText(process.env.PAUSER_PRIVATE_KEY, "PAUSER_PRIVATE_KEY");
  const pauserAddress = new Wallet(pauserPrivateKey).address;
  const auditorAddress = requireText(process.env.AUDITOR_ADDRESS, "AUDITOR_ADDRESS");
  const oracleAccountAddress = requireText(process.env.ORACLE_ACCOUNT_ADDRESS, "ORACLE_ACCOUNT_ADDRESS");
  const auditorAccountAddress = normalizeText(process.env.AUDITOR_ACCOUNT_ADDRESS) || auditorAddress;

  const principalRatioBps = Number(process.env.PRINCIPAL_RATIO_BPS || "8000");
  const feeBps = Number(process.env.PROTOCOL_FEE_BPS || "1000");
  const minDepositAmount = process.env.MIN_DEPOSIT_STABLECOIN || "50";
  const stablecoinDecimals = toPositiveInt(process.env.STABLECOIN_DECIMALS, "STABLECOIN_DECIMALS", 18);
  const stablecoinSymbol = requireText(process.env.STABLECOIN_SYMBOL, "STABLECOIN_SYMBOL");
  const stablecoinName = requireText(process.env.STABLECOIN_NAME, "STABLECOIN_NAME");
  const deployMock = parseBoolean(process.env.DEPLOY_MOCK_STABLECOIN, false);
  const allowMidweekRedeploy = parseBoolean(process.env.ALLOW_MIDWEEK_REDEPLOY, false);

  if (!Number.isInteger(principalRatioBps) || principalRatioBps < 0 || principalRatioBps > 10_000) {
    throw new Error("PRINCIPAL_RATIO_BPS must be an integer between 0 and 10000");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error("PROTOCOL_FEE_BPS must be an integer between 0 and 10000");
  }
  if (!Number.isFinite(Number(minDepositAmount)) || Number(minDepositAmount) <= 0) {
    throw new Error("MIN_DEPOSIT_STABLECOIN must be a positive number");
  }

  if (!allowMidweekRedeploy) {
    const unresolved = await getUnresolvedWeekForDeployGuard();
    if (unresolved) {
      throw new Error(
        `mid-week redeploy blocked: unresolved week exists (id=${String(unresolved.id)}, status=${String(unresolved.status)}). Finalize or clear it before deploy.`,
      );
    }
  }

  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const deployer = new Wallet(deployerPrivateKey, provider);

  let stablecoinAddress = normalizeText(process.env.STABLECOIN_ADDRESS);

  if (deployMock) {
    const StablecoinMock = await createFactory("StablecoinMock", deployer);
    const stablecoin = await StablecoinMock.deploy(deployer.address, stablecoinName, stablecoinSymbol);
    await stablecoin.waitForDeployment();
    stablecoinAddress = await stablecoin.getAddress();
  } else if (!stablecoinAddress) {
    throw new Error("STABLECOIN_ADDRESS is required when DEPLOY_MOCK_STABLECOIN=false");
  }

  const minDeposit = ethers.parseUnits(minDepositAmount, stablecoinDecimals);

  const Valcore = await createFactory("ValcoreV1", deployer);
  const valcore = await Valcore.deploy(
    stablecoinAddress,
    principalRatioBps,
    feeBps,
    minDeposit,
    deployer.address,
    treasuryAddress,
    pauserAddress,
    auditorAddress,
  );
  await valcore.waitForDeployment();
  const valcoreAddress = await valcore.getAddress();

  const oracleRole = String(await valcore.ORACLE_ROLE());
  const auditorRole = String(await valcore.AUDITOR_ROLE());
  await ensureRole(valcore, oracleRole, oracleAccountAddress, "ORACLE_ROLE");
  await ensureRole(valcore, auditorRole, auditorAccountAddress, "AUDITOR_ROLE");

  const payload = {
    chainKey,
    chainId,
    rpcUrl,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    stablecoin: stablecoinAddress,
    stablecoinName,
    stablecoinSymbol,
    valcore: valcoreAddress,
    treasury: treasuryAddress,
    pauser: pauserAddress,
    auditor: auditorAddress,
    oracleAccount: oracleAccountAddress,
    deployMockStablecoin: deployMock,
    minDepositWei: minDeposit.toString(),
  };

  const outDir = resolve(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${chainKey}.json`);
  const activePath = resolve(outDir, "active.json");
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  writeFileSync(activePath, JSON.stringify(payload, null, 2));

  console.log(JSON.stringify(payload, null, 2));
  console.log("\nDeploy completed. Update .env with:");
  console.log(`VALCORE_ADDRESS=${valcoreAddress}`);
  if (deployMock) {
    console.log(`STABLECOIN_ADDRESS=${stablecoinAddress}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


