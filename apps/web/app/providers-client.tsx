"use client";

import { QueryProvider } from "../lib/query-client";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { createWagmiConfig } from "../lib/wagmi";
import { SessionProvider } from "next-auth/react";
import { useRuntimeProfile } from "../lib/runtime-profile";
import { ErrorMonitor } from "../lib/error-monitor";

function WalletProviders({ children }: { children: React.ReactNode }) {
  const { profile, isLoading, error } = useRuntimeProfile();
  const wagmiConfig = profile
    ? createWagmiConfig({
        chainId: profile.chainId,
        label: profile.label,
        networkKey: profile.networkKey,
        rpcUrl: profile.rpcUrl,
        explorerUrl: profile.explorerUrl,
        nativeSymbol: profile.nativeSymbol,
        transportRpcUrl: process.env.NEXT_PUBLIC_CHAIN_READ_RPC_URL || "/api/rpc",
      })
    : null;

  if (error) {
    throw error;
  }
  if (isLoading || !profile) {
    return null;
  }
  if (!wagmiConfig) {
    return null;
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <RainbowKitProvider
        theme={lightTheme({
          accentColor: "#111827",
          accentColorForeground: "#f8fafc",
          borderRadius: "large",
          overlayBlur: "small",
        })}
      >
        {children}
      </RainbowKitProvider>
    </WagmiProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <QueryProvider>
        <ErrorMonitor />
        <WalletProviders>{children}</WalletProviders>
      </QueryProvider>
    </SessionProvider>
  );
}
