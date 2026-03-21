import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api";

/**
 * Oracle API Types
 */

export type Week = {
  id: string;
  startAtUtc: string;
  lockAtUtc: string;
  endAtUtc: string;
  status: string;
};

export type WeekCoin = {
  id: string;
  weekId: string;
  coinId: string;
  rank: number;
  position: string;
  salary: number;
  snapshotPrice: number | null;
  power: number;
  risk: "Low" | "Medium" | "High";
  momentum: "Down" | "Steady" | "Up";
  momentumLive?: "Down" | "Steady" | "Up" | null;
  coin: {
    symbol: string;
    name: string;
    isStable: boolean;
  };
};

export type ClaimData = {
  address: string;
  principal: number;
  riskPayout: number;
  totalWithdraw: number;
  proof: string[];
};

export type LineupSyncPayload = {
  txHash: string;
  weekId?: string;
  addressHint?: string;
  source?: "commit" | "swap";
  slots: Array<{
    slotId: string;
    coinId: string;
  }>;
  swap?: {
    slotId: string;
    removedSymbol: string;
    addedSymbol: string;
  };
};

/**
 * Query Keys
 */
export const oracleKeys = {
  all: ["oracle"] as const,
  currentWeek: () => [...oracleKeys.all, "current-week"] as const,
  weekCoins: (weekId: string) => [...oracleKeys.all, "week-coins", weekId] as const,
  claim: (weekId: string, address: string) =>
    [...oracleKeys.all, "claim", weekId, address] as const,
};

/**
 * Hooks
 */

/**
 * Get current week
 */
export function useCurrentWeek() {
  return useQuery({
    queryKey: oracleKeys.currentWeek(),
    queryFn: () => apiGet<Week | null>("/weeks/current"),
    staleTime: 30 * 1000,
  });
}

/**
 * Get coins for a specific week
 */
export function useWeekCoins(weekId: string | undefined) {
  return useQuery({
    queryKey: oracleKeys.weekCoins(weekId || ""),
    queryFn: () => apiGet<WeekCoin[]>(`/weeks/${weekId}/coins`),
    enabled: !!weekId,
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Get claim data for a user
 */
export function useClaim(weekId: string | undefined, address: string | undefined) {
  return useQuery({
    queryKey: oracleKeys.claim(weekId || "", address || ""),
    queryFn: () => apiGet<ClaimData>(`/weeks/${weekId}/claims/${address}`),
    enabled: !!weekId && !!address,
    retry: false,
  });
}

/**
 * Enqueue lineup sync using a verified tx hash.
 */
export function useSubmitLineup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: LineupSyncPayload) =>
      apiPost<{ ok: boolean; synced: boolean; healing: boolean }>("/lineups/sync", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: oracleKeys.currentWeek() });
    },
  });
}
