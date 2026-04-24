import { ethers } from "ethers";
import { env } from "../env.js";

const normalizeValue = (value: string | null | undefined) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
};

const parseBoolean = (value: unknown, fallback: boolean) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

const requireText = (value: string | null | undefined, label: string) => {
  const normalized = normalizeValue(value);
  if (!normalized) {
    throw new Error(`${label} is not configured`);
  }
  return normalized;
};

const requirePositiveInt = (value: string | null | undefined, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
};

const normalizeAddress = (value: string | null | undefined) => {
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  try {
    return ethers.getAddress(normalized);
  } catch {
    throw new Error(`Invalid EVM address format: ${normalized}`);
  }
};

const deriveAddressFromPrivateKey = (privateKey: string | null) => {
  if (!privateKey) return null;
  return new ethers.Wallet(privateKey).address;
};

export const isValcoreChainEnabled = () => parseBoolean(env.ORACLE_VALCORE_CHAIN_ENABLED, true);

export type RuntimeChainConfig = {
  networkKey: string;
  label: string;
  chainType: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  nativeSymbol: string;
  nativeTokenAddress: string | null;
  valcoreAddress: string | null;
  stablecoinAddress: string | null;
  treasuryAddress: string | null;
  pauserAddress: string | null;
  deployMockStablecoin: boolean;
  oraclePrivateKey: string | null;
  contractAdminPrivateKey: string | null;
  pauserPrivateKey: string | null;
  faucetMinterPrivateKey: string | null;
  auditorPrivateKey: string | null;
  deployerPrivateKey: string | null;
  stablecoinSymbol: string;
  stablecoinName: string;
  stablecoinDecimals: number;
};

type ProviderCacheEntry = {
  key: string;
  provider: ethers.JsonRpcProvider;
};

let providerCache: ProviderCacheEntry | null = null;

export const getRuntimeChainConfig = async (): Promise<RuntimeChainConfig> => {
  const pauserPrivateKey = normalizeValue(env.PAUSER_PRIVATE_KEY);
  const chainId = requirePositiveInt(env.CHAIN_ID, "CHAIN_ID");
  const networkKey = requireText(env.CHAIN_KEY, "CHAIN_KEY");
  const label = requireText(env.CHAIN_LABEL, "CHAIN_LABEL");
  const rpcUrl = requireText(env.CHAIN_RPC_URL, "CHAIN_RPC_URL");

  return {
    networkKey,
    label,
    chainType: "evm",
    chainId,
    rpcUrl,
    explorerUrl: normalizeValue(env.CHAIN_EXPLORER_URL) ?? "",
    nativeSymbol: requireText(env.CHAIN_NATIVE_SYMBOL, "CHAIN_NATIVE_SYMBOL"),
    nativeTokenAddress: normalizeAddress(env.CHAIN_NATIVE_TOKEN_ADDRESS),
    valcoreAddress: normalizeAddress(env.VALCORE_ADDRESS),
    stablecoinAddress: normalizeAddress(env.STABLECOIN_ADDRESS),
    treasuryAddress: normalizeAddress(env.TREASURY_ADDRESS),
    pauserAddress: deriveAddressFromPrivateKey(pauserPrivateKey),
    deployMockStablecoin: parseBoolean(env.DEPLOY_MOCK_STABLECOIN, false),
    oraclePrivateKey: normalizeValue(env.ORACLE_PRIVATE_KEY),
    contractAdminPrivateKey: normalizeValue(env.CONTRACT_ADMIN_PRIVATE_KEY),
    pauserPrivateKey,
    faucetMinterPrivateKey: normalizeValue(env.FAUCET_MINTER_PRIVATE_KEY),
    auditorPrivateKey: normalizeValue(env.AUDITOR_PRIVATE_KEY),
    deployerPrivateKey: normalizeValue(env.DEPLOYER_PRIVATE_KEY),
    stablecoinSymbol: requireText(env.STABLECOIN_SYMBOL, "STABLECOIN_SYMBOL"),
    stablecoinName: requireText(env.STABLECOIN_NAME, "STABLECOIN_NAME"),
    stablecoinDecimals: requirePositiveInt(env.STABLECOIN_DECIMALS, "STABLECOIN_DECIMALS"),
  };
};

export const getRuntimeProvider = async () => {
  const { rpcUrl, chainId, networkKey } = await getRuntimeChainConfig();
  const cacheKey = `${networkKey}:${chainId}:${rpcUrl}`;
  if (providerCache?.key === cacheKey) {
    return providerCache.provider;
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);
  if (!Number.isInteger(actualChainId) || actualChainId !== chainId) {
    throw new Error(
      `RPC chainId mismatch for ${networkKey}: expected=${chainId} actual=${String(network.chainId)}`,
    );
  }
  providerCache = { key: cacheKey, provider };
  return provider;
};

export const getRuntimeWallet = async (privateKey: string) =>
  new ethers.Wallet(privateKey, await getRuntimeProvider());

export const getRuntimeChainIdBigInt = async () => {
  const provider = await getRuntimeProvider();
  const network = await provider.getNetwork();
  return BigInt(network.chainId);
};

export const getConfiguredRuntimeChainIdBigInt = async () => {
  const config = await getRuntimeChainConfig();
  return BigInt(config.chainId);
};

export const getRuntimeValcoreAddress = async () => (await getRuntimeChainConfig()).valcoreAddress;

export const getRequiredRuntimeValcoreAddress = async () => {
  const address = await getRuntimeValcoreAddress();
  if (!address) {
    throw new Error("valcoreAddress is not configured");
  }
  return address;
};

export const getRuntimeStablecoinAddress = async () =>
  (await getRuntimeChainConfig()).stablecoinAddress;

export const getRequiredRuntimeStablecoinAddress = async () => {
  const address = await getRuntimeStablecoinAddress();
  if (!address) {
    throw new Error("stablecoinAddress is not configured");
  }
  return address;
};

export const getRuntimeOraclePrivateKey = async () =>
  (await getRuntimeChainConfig()).oraclePrivateKey;

export const getRuntimeContractAdminPrivateKey = async () => {
  const config = await getRuntimeChainConfig();
  return config.contractAdminPrivateKey;
};

export const getRuntimePauserPrivateKey = async () => {
  const config = await getRuntimeChainConfig();
  return config.pauserPrivateKey;
};

export const getRuntimeFaucetMinterPrivateKey = async () => {
  const config = await getRuntimeChainConfig();
  return config.faucetMinterPrivateKey;
};

export const getRuntimeAuditorPrivateKey = async () => {
  const config = await getRuntimeChainConfig();
  return config.auditorPrivateKey;
};

export const getRuntimePauserAddress = async () => {
  const config = await getRuntimeChainConfig();
  return config.pauserAddress;
};

export const getRuntimeDeployerPrivateKey = async () => {
  const config = await getRuntimeChainConfig();
  return config.deployerPrivateKey;
};

export const getRequiredRuntimeOraclePrivateKey = async () => {
  const key = await getRuntimeOraclePrivateKey();
  if (!key) {
    throw new Error("ORACLE_PRIVATE_KEY is not configured");
  }
  return key;
};

export const getRequiredRuntimeContractAdminPrivateKey = async () => {
  const key = await getRuntimeContractAdminPrivateKey();
  if (!key) {
    throw new Error("CONTRACT_ADMIN_PRIVATE_KEY is not configured");
  }
  return key;
};

export const getRequiredRuntimePauserPrivateKey = async () => {
  const key = await getRuntimePauserPrivateKey();
  if (!key) {
    throw new Error("PAUSER_PRIVATE_KEY is not configured");
  }
  return key;
};

export const getRequiredRuntimeFaucetMinterPrivateKey = async () => {
  const key = await getRuntimeFaucetMinterPrivateKey();
  if (!key) {
    throw new Error("FAUCET_MINTER_PRIVATE_KEY is not configured");
  }
  return key;
};

export const getRequiredRuntimeAuditorPrivateKey = async () => {
  const key = await getRuntimeAuditorPrivateKey();
  if (!key) {
    throw new Error("AUDITOR_PRIVATE_KEY is not configured");
  }
  return key;
};
