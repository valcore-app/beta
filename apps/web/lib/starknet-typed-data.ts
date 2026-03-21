import { id } from "ethers";

const SN_MAIN = "0x534e5f4d41494e";
const SN_SEPOLIA = "0x534e5f5345504f4c4941";

const to0x = (value: string) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "0x0";
  if (raw.startsWith("0x") || raw.startsWith("0X")) return raw.toLowerCase();
  return `0x${raw.toLowerCase()}`;
};

export const resolveStarknetTypedDataChainId = (networkKey: string, explicit?: string | null) => {
  const normalizedExplicit = String(explicit ?? "").trim();
  if (normalizedExplicit) return normalizedExplicit;

  const key = String(networkKey ?? "").toLowerCase();
  if (key.includes("mainnet") || key.endsWith("_main")) return SN_MAIN;
  return SN_SEPOLIA;
};

export const buildStarknetPlayerNameTypedData = (
  _address: string,
  displayName: string,
  nonce: string,
  chainId: string,
) => ({
  types: {
    StarknetDomain: [
      { name: "name", type: "felt" },
      { name: "version", type: "felt" },
      { name: "chainId", type: "felt" },
    ],
    PlayerNameApproval: [
      { name: "display_name_hash", type: "felt" },
      { name: "nonce", type: "felt" },
    ],
  },
  primaryType: "PlayerNameApproval",
  domain: {
    name: "Valcore",
    version: "1",
    chainId,
  },
  message: {
    display_name_hash: id(displayName),
    nonce: to0x(nonce),
  },
});

export const normalizeStarknetSignature = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => /^0x[a-fA-F0-9]+$/u.test(entry));
  if (!normalized.length) return null;
  return normalized.map((entry) => entry.toLowerCase());
};