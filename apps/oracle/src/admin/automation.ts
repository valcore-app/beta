export type AutomationMode = "MANUAL" | "CRON" | "REACTIVE";

const normalizeText = (value: unknown) => String(value ?? "").trim().toUpperCase();

export const normalizeAutomationMode = (value: unknown): AutomationMode => {
  const normalized = normalizeText(value);
  if (normalized === "CRON") return "CRON";
  if (normalized === "REACTIVE") return "REACTIVE";
  return "MANUAL";
};

export const getDerivedTimeMode = (automationMode: AutomationMode): "MANUAL" | "NORMAL" =>
  automationMode === "MANUAL" ? "MANUAL" : "NORMAL";

export const isManualAutomationMode = (automationMode: AutomationMode): boolean =>
  automationMode === "MANUAL";

const parseChainIdNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const normalizeChainType = (value: unknown) => String(value ?? "evm").trim().toLowerCase();
const normalizeChainKey = (value: unknown) => String(value ?? "").trim().toLowerCase();

const isTestnetKey = (key: string) => key.includes("testnet") || key.includes("sepolia") || key.includes("fuji");

/**
 * Reactive support policy:
 * - Non-EVM: unsupported.
 * - EVM testnet: only Sepolia is supported.
 * - EVM mainnet: supported.
 */
export const isReactiveSupported = (input: {
  chainType?: unknown;
  chainId?: unknown;
  chainKey?: unknown;
}): boolean => {
  const chainType = normalizeChainType(input.chainType);
  if (chainType !== "evm") return false;

  const chainId = parseChainIdNumber(input.chainId);
  const chainKey = normalizeChainKey(input.chainKey);

  if (chainId === 11155111) return true; // Ethereum Sepolia
  if (chainKey.includes("sepolia")) return true;

  if (isTestnetKey(chainKey)) return false;
  return true;
};

export const getAutomationSupportReason = (input: {
  chainType?: unknown;
  chainId?: unknown;
  chainKey?: unknown;
}): string => {
  const chainType = normalizeChainType(input.chainType);
  const chainKey = normalizeChainKey(input.chainKey);
  const chainId = parseChainIdNumber(input.chainId);
  if (chainType !== "evm") {
    return `Reactive automation is unsupported for chain type '${chainType}'. Use CRON or MANUAL.`;
  }
  if (chainId === 11155111 || chainKey.includes("sepolia")) {
    return "Reactive automation is supported on Sepolia testnet.";
  }
  if (isTestnetKey(chainKey)) {
    return "Reactive automation testnet support is currently limited to Sepolia.";
  }
  return "Reactive automation is supported on this EVM mainnet profile.";
};
