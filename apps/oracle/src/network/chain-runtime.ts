import { ethers } from "ethers";
import { Account, RpcProvider } from "starknet";
import { env } from "../env.js";

const normalizeValue = (value: string | null | undefined) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
};

const splitRpcUrls = (value: string | null | undefined) =>
  String(value ?? "")
    .split(/[\r\n,;]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => /^https?:\/\//iu.test(entry));

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

const normalizeChainType = (value: string | null | undefined) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || "evm";
};

const normalizeAddressByChain = (value: string | null | undefined, chainType: string) => {
  const normalized = normalizeValue(value);
  if (!normalized) return null;

  if (chainType === "starknet") {
    if (!/^0x[a-fA-F0-9]{1,64}$/u.test(normalized)) {
      throw new Error(`Invalid Starknet address format: ${normalized}`);
    }
    return normalized.toLowerCase();
  }

  try {
    return ethers.getAddress(normalized);
  } catch {
    throw new Error(`Invalid EVM address format: ${normalized}`);
  }
};

const deriveEvmAddressFromPrivateKey = (privateKey: string | null) => {
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
  rpcUrls: string[];
  explorerUrl: string;
  nativeSymbol: string;
  nativeTokenAddress: string | null;
  valcoreAddress: string | null;
  stablecoinAddress: string | null;
  treasuryAddress: string | null;
  pauserAddress: string | null;
  deployMockStablecoin: boolean;

  oraclePrivateKey: string | null;
  oracleAccountAddress: string | null;

  contractAdminPrivateKey: string | null;
  contractAdminAccountAddress: string | null;

  pauserPrivateKey: string | null;
  pauserAccountAddress: string | null;

  faucetMinterPrivateKey: string | null;
  faucetMinterAccountAddress: string | null;

  auditorPrivateKey: string | null;
  auditorAccountAddress: string | null;

  sentinelPrivateKey: string | null;
  sentinelAccountAddress: string | null;

  deployerPrivateKey: string | null;
  deployerAccountAddress: string | null;

  stablecoinSymbol: string;
  stablecoinName: string;
  stablecoinDecimals: number;
};

type EvmProviderCacheEntry = {
  key: string;
  provider: ethers.JsonRpcProvider;
};

let evmProviderCache: EvmProviderCacheEntry | null = null;
const starknetProviderCache = new Map<string, RpcProvider>();

export const getRuntimeChainConfig = async (): Promise<RuntimeChainConfig> => {
  const chainType = normalizeChainType(env.CHAIN_TYPE);
  const pauserPrivateKey = normalizeValue(env.PAUSER_PRIVATE_KEY);
  const oraclePrivateKey = normalizeValue(env.ORACLE_PRIVATE_KEY);
  const contractAdminPrivateKey = normalizeValue(env.CONTRACT_ADMIN_PRIVATE_KEY);
  const faucetMinterPrivateKey = normalizeValue(env.FAUCET_MINTER_PRIVATE_KEY);
  const auditorPrivateKey = normalizeValue(env.AUDITOR_PRIVATE_KEY);
  const sentinelPrivateKey = normalizeValue(env.SENTINEL_PRIVATE_KEY);
  const deployerPrivateKey = normalizeValue(env.DEPLOYER_PRIVATE_KEY);

  const chainId = requirePositiveInt(env.CHAIN_ID, "CHAIN_ID");
  const rpcCandidates = splitRpcUrls(env.CHAIN_RPC_URL);
  const rpcUrl = rpcCandidates[0] ?? requireText(env.CHAIN_RPC_URL, "CHAIN_RPC_URL");
  const fallbackRpcUrls = [...rpcCandidates.slice(1), ...splitRpcUrls(env.CHAIN_RPC_FALLBACK_URLS)];
  const rpcUrls = Array.from(new Set([rpcUrl, ...fallbackRpcUrls]));
  const stablecoinDecimals = requirePositiveInt(env.STABLECOIN_DECIMALS, "STABLECOIN_DECIMALS");

  const oracleAccountAddress = normalizeAddressByChain(env.ORACLE_ACCOUNT_ADDRESS, chainType);
  const contractAdminAccountAddress = normalizeAddressByChain(
    env.CONTRACT_ADMIN_ACCOUNT_ADDRESS,
    chainType,
  );
  const pauserAccountAddress = normalizeAddressByChain(env.PAUSER_ACCOUNT_ADDRESS, chainType);
  const faucetMinterAccountAddress = normalizeAddressByChain(
    env.FAUCET_MINTER_ACCOUNT_ADDRESS,
    chainType,
  );
  const auditorAccountAddress = normalizeAddressByChain(env.AUDITOR_ACCOUNT_ADDRESS, chainType);
  const sentinelAccountAddress = normalizeAddressByChain(env.SENTINEL_ACCOUNT_ADDRESS, chainType);
  const deployerAccountAddress = normalizeAddressByChain(env.DEPLOYER_ACCOUNT_ADDRESS, chainType);

  const valcoreAddress = normalizeAddressByChain(env.VALCORE_ADDRESS, chainType);
  const stablecoinAddress = normalizeAddressByChain(env.STABLECOIN_ADDRESS, chainType);
  const treasuryAddress = normalizeAddressByChain(env.TREASURY_ADDRESS, chainType);
  const nativeTokenAddress = normalizeAddressByChain(env.CHAIN_NATIVE_TOKEN_ADDRESS, chainType);

  const pauserAddress =
    chainType === "evm"
      ? deriveEvmAddressFromPrivateKey(pauserPrivateKey)
      : pauserAccountAddress;

  return {
    networkKey: requireText(env.CHAIN_KEY, "CHAIN_KEY"),
    label: requireText(env.CHAIN_LABEL, "CHAIN_LABEL"),
    chainType,
    chainId,
    rpcUrl,
    rpcUrls,
    explorerUrl: normalizeValue(env.CHAIN_EXPLORER_URL) ?? "",
    nativeSymbol: requireText(env.CHAIN_NATIVE_SYMBOL, "CHAIN_NATIVE_SYMBOL"),
    nativeTokenAddress,
    valcoreAddress,
    stablecoinAddress,
    treasuryAddress,
    pauserAddress,
    deployMockStablecoin: parseBoolean(env.DEPLOY_MOCK_STABLECOIN, false),

    oraclePrivateKey,
    oracleAccountAddress,

    contractAdminPrivateKey,
    contractAdminAccountAddress,

    pauserPrivateKey,
    pauserAccountAddress,

    faucetMinterPrivateKey,
    faucetMinterAccountAddress,

    auditorPrivateKey,
    auditorAccountAddress,

    sentinelPrivateKey,
    sentinelAccountAddress,

    deployerPrivateKey,
    deployerAccountAddress,

    stablecoinSymbol: requireText(env.STABLECOIN_SYMBOL, "STABLECOIN_SYMBOL"),
    stablecoinName: requireText(env.STABLECOIN_NAME, "STABLECOIN_NAME"),
    stablecoinDecimals,
  };
};

export const getRuntimeProvider = async () => {
  const { rpcUrl, chainId, networkKey, chainType } = await getRuntimeChainConfig();
  if (chainType !== "evm") {
    throw new Error(`getRuntimeProvider is only valid for EVM chains. active=${chainType}`);
  }

  const cacheKey = `${networkKey}:${chainId}:${rpcUrl}`;
  if (evmProviderCache?.key === cacheKey) {
    return evmProviderCache.provider;
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);
  if (!Number.isInteger(actualChainId) || actualChainId !== chainId) {
    throw new Error(
      `RPC chainId mismatch for ${networkKey}: expected=${chainId} actual=${String(network.chainId)}`,
    );
  }
  evmProviderCache = {
    key: cacheKey,
    provider,
  };
  return provider;
};

const getOrCreateStarknetProvider = (cacheKey: string, rpcUrl: string) => {
  const cached = starknetProviderCache.get(cacheKey);
  if (cached) return cached;
  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  starknetProviderCache.set(cacheKey, provider);
  return provider;
};

const isStarknetProviderRetryableError = (error: unknown) => {
  const text = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  return [
    "timeout",
    "timed out",
    "temporarily",
    "rate",
    "429",
    "502",
    "503",
    "504",
    "gateway",
    "fetch",
    "network",
    "connection",
    "unavailable",
    "no available nodes found",
    "unexpected token '<'",
    "<!doctype",
    "<html",
  ].some((hint) => text.includes(hint));
};

export const getRuntimeStarknetProviderUrls = async () => {
  const { chainType, rpcUrls } = await getRuntimeChainConfig();
  if (chainType !== "starknet") {
    throw new Error(`getRuntimeStarknetProviderUrls is only valid for starknet. active=${chainType}`);
  }
  return rpcUrls;
};

export const withRuntimeStarknetProvider = async <T>(
  operation: (provider: RpcProvider, rpcUrl: string) => Promise<T>,
): Promise<T> => {
  const { chainId, networkKey } = await getRuntimeChainConfig();
  const urls = await getRuntimeStarknetProviderUrls();

  let lastError: unknown = null;
  for (const rpcUrl of urls) {
    const cacheKey = `${networkKey}:${chainId}:${rpcUrl}`;
    const provider = getOrCreateStarknetProvider(cacheKey, rpcUrl);
    try {
      return await operation(provider, rpcUrl);
    } catch (error) {
      lastError = error;
      if (!isStarknetProviderRetryableError(error)) {
        throw error;
      }
    }
  }

  const reason = String(lastError instanceof Error ? lastError.message : lastError ?? "unknown");
  throw new Error(`All Starknet RPC endpoints failed: ${reason}`);
};

export const getRuntimeStarknetProvider = async () => {
  return withRuntimeStarknetProvider(async (provider) => {
    await provider.getBlockLatestAccepted();
    return provider;
  });
};

export const getRuntimeWallet = async (privateKey: string) =>
  new ethers.Wallet(privateKey, await getRuntimeProvider());

export const getRuntimeChainIdBigInt = async () => {
  const config = await getRuntimeChainConfig();
  if (config.chainType !== "evm") {
    return BigInt(config.chainId);
  }
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
    throw new Error("VALCORE_ADDRESS is not configured");
  }
  return address;
};

export const getRuntimeStablecoinAddress = async () =>
  (await getRuntimeChainConfig()).stablecoinAddress;

export const getRequiredRuntimeStablecoinAddress = async () => {
  const address = await getRuntimeStablecoinAddress();
  if (!address) {
    throw new Error("STABLECOIN_ADDRESS is not configured");
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

export const getRuntimeChainType = async () => (await getRuntimeChainConfig()).chainType;

const getRequiredAddressByRole = async (
  role:
    | "oracle"
    | "contract_admin"
    | "pauser"
    | "faucet_minter"
    | "auditor"
    | "sentinel"
    | "deployer",
) => {
  const config = await getRuntimeChainConfig();
  const mapping = {
    oracle: config.oracleAccountAddress,
    contract_admin: config.contractAdminAccountAddress,
    pauser: config.pauserAccountAddress,
    faucet_minter: config.faucetMinterAccountAddress,
    auditor: config.auditorAccountAddress,
    sentinel: config.sentinelAccountAddress,
    deployer: config.deployerAccountAddress,
  } as const;

  const value = mapping[role];
  if (!value) {
    throw new Error(`${role.toUpperCase()}_ACCOUNT_ADDRESS is not configured`);
  }
  return value;
};

const getRequiredPrivateKeyByRole = async (
  role:
    | "oracle"
    | "contract_admin"
    | "pauser"
    | "faucet_minter"
    | "auditor"
    | "sentinel"
    | "deployer",
) => {
  const config = await getRuntimeChainConfig();
  const mapping = {
    oracle: config.oraclePrivateKey,
    contract_admin: config.contractAdminPrivateKey,
    pauser: config.pauserPrivateKey,
    faucet_minter: config.faucetMinterPrivateKey,
    auditor: config.auditorPrivateKey,
    sentinel: config.sentinelPrivateKey,
    deployer: config.deployerPrivateKey,
  } as const;

  const value = mapping[role];
  if (!value) {
    throw new Error(`${role.toUpperCase()}_PRIVATE_KEY is not configured`);
  }
  return value;
};

export const getRequiredRuntimeStarknetAccount = async (
  role:
    | "oracle"
    | "contract_admin"
    | "pauser"
    | "faucet_minter"
    | "auditor"
    | "sentinel"
    | "deployer",
  rpcUrlOverride?: string,
) => {
  const config = await getRuntimeChainConfig();
  if (config.chainType !== "starknet") {
    throw new Error(`getRequiredRuntimeStarknetAccount is only valid for starknet. active=${config.chainType}`);
  }

  const [address, privateKey] = await Promise.all([
    getRequiredAddressByRole(role),
    getRequiredPrivateKeyByRole(role),
  ]);

  const provider = rpcUrlOverride
    ? getOrCreateStarknetProvider(config.networkKey + ":" + config.chainId + ":" + rpcUrlOverride, rpcUrlOverride)
    : await getRuntimeStarknetProvider();

  return new Account({ provider, address, signer: privateKey, cairoVersion: "1" });
};










