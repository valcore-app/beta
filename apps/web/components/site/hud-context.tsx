"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";

type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

type CurrentWeek = {
  id: string;
  status?: WeekStatus | null;
  startAtUtc?: string | null;
  lockAtUtc?: string | null;
  endAtUtc?: string | null;
  finalizedAtUtc?: string | null;
  cooldownEndsAtUtc?: string | null;
};

type HudMoves = {
  remaining: number;
  total: number;
  swapCount: number;
};

type HudContextValue = {
  week: CurrentWeek | null;
  statusLabel: string;
  countdownText: string;
  moves: HudMoves | null;
  setMoves: (moves: HudMoves | null) => void;
  swapMode: boolean;
  setSwapMode: React.Dispatch<React.SetStateAction<boolean>>;
};

const HudContext = createContext<HudContextValue | null>(null);

const statusLabels: Record<WeekStatus, string> = {
  DRAFT_OPEN: "Draft Open",
  LOCKED: "Locked",
  ACTIVE: "Epoch Active",
  FINALIZE_PENDING: "Finalize Pending",
  FINALIZED: "Finalized",
};

const formatCountdown = (msRemaining: number) => {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return "00d 00h 00m";
  const totalMinutes = Math.floor(msRemaining / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(days)}d ${pad(hours)}h ${pad(minutes)}m`;
};

export function HudProvider({ children }: { children: React.ReactNode }) {
  const [week, setWeek] = useState<CurrentWeek | null>(null);
  const [now, setNow] = useState(Date.now());
  const [moves, setMoves] = useState<HudMoves | null>(null);
  const [swapMode, setSwapMode] = useState(false);

  const refreshWeek = useCallback(async () => {
    try {
      const data = await apiGet<CurrentWeek>("/weeks/current");
      if (!data || !data.id) {
        setWeek(null);
        return;
      }
      setWeek(data);
    } catch {
      setWeek(null);
    }
  }, []);

  useEffect(() => {
    refreshWeek();
    const interval = setInterval(refreshWeek, 30000);
    return () => clearInterval(interval);
  }, [refreshWeek]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const source = new EventSource("/api/oracle/events");
    const handleWeek = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as Partial<CurrentWeek> | null;
        if (!data || !data.id) return;
        setWeek((prev) => ({
          id: data.id ?? prev?.id ?? "",
          status: data.status ?? prev?.status ?? null,
          startAtUtc: data.startAtUtc ?? prev?.startAtUtc ?? null,
          lockAtUtc: data.lockAtUtc ?? prev?.lockAtUtc ?? null,
          endAtUtc: data.endAtUtc ?? prev?.endAtUtc ?? null,
          finalizedAtUtc: data.finalizedAtUtc ?? prev?.finalizedAtUtc ?? null,
          cooldownEndsAtUtc: data.cooldownEndsAtUtc ?? prev?.cooldownEndsAtUtc ?? null,
        }));
      } catch {
        // Ignore malformed payloads.
      }
    };
    source.addEventListener("week", handleWeek);
    return () => {
      source.removeEventListener("week", handleWeek);
      source.close();
    };
  }, []);

  const statusLabel = useMemo(() => {
    if (!week?.status) return "Epoch Status";
    return statusLabels[week.status] ?? "Epoch Status";
  }, [week?.status]);

  const countdownText = useMemo(() => {
    if (!week?.status) return "--";
    const lockAt = week.lockAtUtc ? new Date(week.lockAtUtc) : null;
    const endAt = week.endAtUtc ? new Date(week.endAtUtc) : null;
    const cooldownEndsAt = week.cooldownEndsAtUtc ? new Date(week.cooldownEndsAtUtc) : null;
    if (week.status === "DRAFT_OPEN" && lockAt) {
      return formatCountdown(lockAt.getTime() - now);
    }
    if (week.status === "ACTIVE" && endAt) {
      return formatCountdown(endAt.getTime() - now);
    }
    if ((week.status === "FINALIZED" || week.status === "FINALIZE_PENDING") && cooldownEndsAt) {
      return formatCountdown(cooldownEndsAt.getTime() - now);
    }
    return "--";
  }, [now, week?.cooldownEndsAtUtc, week?.endAtUtc, week?.lockAtUtc, week?.status]);

  const value = useMemo(
    () => ({
      week,
      statusLabel,
      countdownText,
      moves,
      setMoves,
      swapMode,
      setSwapMode,
    }),
    [week, statusLabel, countdownText, moves, swapMode],
  );

  return <HudContext.Provider value={value}>{children}</HudContext.Provider>;
}

export function useHudContext() {
  const context = useContext(HudContext);
  if (!context) {
    throw new Error("useHudContext must be used within a HudProvider");
  }
  return context;
}

export type { CurrentWeek, HudMoves, WeekStatus };
