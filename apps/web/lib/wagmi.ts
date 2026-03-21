import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { buildChain, type ChainDefinitionInput } from "./chain";

const appName = "Valcore";
const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "valcore-dev";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Browser Wallets",
      wallets: [injectedWallet],
    },
  ],
  { appName, projectId: walletConnectProjectId },
);

type WagmiConfigInput = ChainDefinitionInput & {
  transportRpcUrl?: string;
};

const normalizeText = (value: unknown) => String(value ?? "").trim();

export const createWagmiConfig = (input: WagmiConfigInput) => {
  const chain = buildChain(input);
  const chainRpcUrl = chain.rpcUrls.default.http[0];
  if (!chainRpcUrl) {
    throw new Error(`RPC URL is missing for chain ${chain.name}`);
  }

  const transportRpcUrl =
    normalizeText(input.transportRpcUrl) ||
    normalizeText(process.env.NEXT_PUBLIC_CHAIN_READ_RPC_URL) ||
    "/api/rpc";

  return createConfig({
    chains: [chain],
    connectors,
    transports: {
      [chain.id]: http(transportRpcUrl),
    },
  });
};
