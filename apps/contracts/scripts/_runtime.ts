import { config as loadEnv } from "dotenv";
import { JsonRpcProvider, Wallet } from "ethers";
import { resolve } from "path";

loadEnv({ path: resolve(__dirname, "..", "..", "..", ".env") });

export type ActiveProfile = {
  key: string;
  chainId: number;
  rpcUrl: string;
  stablecoinDecimals: number;
  stablecoinSymbol: string;
  stablecoinName: string;
  stablecoinAddress: string | null;
  valcoreAddress: string | null;
  oraclePrivateKey: string | null;
  adminPrivateKey: string | null;
  deployerPrivateKey: string | null;
  deployMockStablecoin: boolean;
};

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

const parsePositiveInt = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
};

const parseBoolean = (value: unknown, fallback: boolean) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

export const loadActiveProfile = async (): Promise<ActiveProfile> => {
  return {
    key: requireText(process.env.CHAIN_KEY, "CHAIN_KEY"),
    chainId: parsePositiveInt(process.env.CHAIN_ID, "CHAIN_ID"),
    rpcUrl: requireText(process.env.CHAIN_RPC_URL, "CHAIN_RPC_URL"),
    stablecoinDecimals: parsePositiveInt(process.env.STABLECOIN_DECIMALS, "STABLECOIN_DECIMALS"),
    stablecoinSymbol: requireText(process.env.STABLECOIN_SYMBOL, "STABLECOIN_SYMBOL"),
    stablecoinName: requireText(process.env.STABLECOIN_NAME, "STABLECOIN_NAME"),
    stablecoinAddress: normalizeText(process.env.STABLECOIN_ADDRESS) || null,
    valcoreAddress: normalizeText(process.env.VALCORE_ADDRESS) || null,
    oraclePrivateKey: normalizeText(process.env.ORACLE_PRIVATE_KEY) || null,
    adminPrivateKey: normalizeText(process.env.CONTRACT_ADMIN_PRIVATE_KEY) || null,
    deployerPrivateKey: normalizeText(process.env.DEPLOYER_PRIVATE_KEY) || null,
    deployMockStablecoin: parseBoolean(process.env.DEPLOY_MOCK_STABLECOIN, false),
  };
};

const resolvePrivateKey = (
  _profile: ActiveProfile,
  purpose: "oracle" | "admin" | "deployer" | "user" | "faucet",
) => {
  switch (purpose) {
    case "oracle":
      return normalizeText(process.env.ORACLE_PRIVATE_KEY);
    case "admin":
      return normalizeText(process.env.CONTRACT_ADMIN_PRIVATE_KEY);
    case "deployer":
      return normalizeText(process.env.DEPLOYER_PRIVATE_KEY);
    case "user":
      return normalizeText(process.env.CLAIMANT_PRIVATE_KEY);
    case "faucet":
      return normalizeText(process.env.FAUCET_MINTER_PRIVATE_KEY);
    default:
      return "";
  }
};

export const createVerifiedProvider = async (profile: ActiveProfile) => {
  const provider = new JsonRpcProvider(profile.rpcUrl, profile.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== profile.chainId) {
    throw new Error(
      `RPC chainId mismatch for ${profile.key}: expected=${profile.chainId} actual=${String(network.chainId)}`,
    );
  }
  return provider;
};

export const createProfileWallet = async (
  profile: ActiveProfile,
  purpose: "oracle" | "admin" | "deployer" | "user" | "faucet",
) => {
  const privateKey = resolvePrivateKey(profile, purpose);
  if (!privateKey) {
    throw new Error(`Missing private key for signer purpose=${purpose}`);
  }
  const provider = await createVerifiedProvider(profile);
  return new Wallet(privateKey, provider);
};

export const getRequiredAddresses = (profile: ActiveProfile) => {
  const valcoreAddress = requireText(profile.valcoreAddress, "VALCORE_ADDRESS");
  const stablecoinAddress = requireText(profile.stablecoinAddress, "STABLECOIN_ADDRESS");
  return { valcoreAddress, stablecoinAddress };
};
