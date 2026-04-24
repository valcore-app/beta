"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../../../lib/api";
import { useWallet } from "../../../lib/wallet";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";

type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

type WeekSummary = {
  id: string;
  startAtUtc: string;
  lockAtUtc: string;
  endAtUtc: string;
  status: WeekStatus;
};

type WeeklyLeaderboardRow = {
  rank: number | string;
  epoch_id: string;
  strategy_id: string;
  address: string;
  score: number;
  swaps: number;
  display_name?: string | null;
};

type AllTimeLeaderboardRow = {
  rank: number | string;
  strategy_id: string;
  address: string;
  epochs_played: number;
  avg_score: number;
  total_score: number;
  best_score: number;
  avg_swaps: number;
  display_name?: string | null;
};
type SeasonLeaderboardRow = {
  rank: number | string;
  season_id: string;
  strategy_id: string;
  address: string;
  season_points: number;
  epochs_played: number;
  wins: number;
  top10: number;
  avg_score: number;
  total_score: number;
  best_rank?: number | null;
  display_name?: string | null;
};

type PagedRows<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  epochId?: string | null;
  scope?: string | null;
  seasonId?: string | null;
};

type StrategyEpochEntry = {
  epoch_id: string;
  strategy_id: string;
  swaps?: number;
  score?: number;
  rank?: number;
  created_at?: string;
};

type StrategySeasonEntry = {
  season_id: string;
  strategy_id: string;
  season_points?: number;
  epochs_played?: number;
  wins?: number;
  top10?: number;
  avg_score?: number;
  total_score?: number;
  best_rank?: number | null;
  updated_at?: string;
};

type StrategyDetailResponse = {
  strategy_id: string;
  address: string;
  display_name?: string | null;
  created_at?: string;
  updated_at?: string;
  epochs_played: number;
  avg_score: number;
  total_score: number;
  best_score: number;
  recentEpochs: StrategyEpochEntry[];
  recentSeasons?: StrategySeasonEntry[];
};

type ViewMode = "all" | "top10" | "top50" | "around_me";
type DiscoveryMode = "all" | "consistent" | "volatile" | "emerging";
type LeaderboardMode = "weekly" | "season" | "all_time";

type LeaderboardViewRow = {
  rank: number;
  strategyId?: string;
  address: string;
  weekScore?: number;
  swaps?: number;
  totalScore?: number;
  avgScore?: number;
  bestWeekScore?: number;
  weeksPlayed?: number;
  avgSwaps?: number;
  seasonId?: string;
  seasonPoints?: number;
  wins?: number;
  top10?: number;
  displayName?: string | null;
};

const weekStatusLabel: Record<WeekStatus, string> = {
  DRAFT_OPEN: "Draft Open",
  LOCKED: "Locked",
  ACTIVE: "Epoch Active",
  FINALIZE_PENDING: "Finalize Pending",
  FINALIZED: "Finalized",
};

const weekStatusClass = (status?: WeekStatus) => {
  if (status === "ACTIVE") {
    return "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]";
  }
  if (status === "FINALIZED") {
    return "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]";
  }
  if (status === "FINALIZE_PENDING" || status === "LOCKED") {
    return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  }
  return "border-[color:var(--arena-stroke-strong)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
};

const formatUtc = (iso?: string | null) => {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace(".000Z", "Z");
};

const formatWeekMondayUtc = (iso?: string | null) => {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const midnightUtc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = midnightUtc.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() - daysFromMonday);
  return midnightUtc.toISOString().slice(0, 10);
};

const LEADERBOARD_WEEKLY_CACHE_KEY_PREFIX = "valcore:leaderboard:weekly:";
const LEADERBOARD_ALL_TIME_CACHE_KEY = "valcore:leaderboard:all-time";
const LEADERBOARD_SEASON_CACHE_KEY_PREFIX = "valcore:leaderboard:season:";
const ACTIVE_WEEK_CACHE_TTL_MS = 60_000;
const PASSIVE_WEEK_CACHE_TTL_MS = 10 * 60_000;
const ALL_TIME_CACHE_TTL_MS = 60_000;
const SEASON_CACHE_TTL_MS = 60_000;
const ACTIVE_WEEK_REFRESH_MS = 60_000;
const ALL_TIME_REFRESH_MS = 60_000;
const SEASON_REFRESH_MS = 60_000;
const LEADERBOARD_PAGE_SIZE = 100;

const shortAddress = (value: string) => `${value.slice(0, 6)}...${value.slice(-4)}`;

const formatScore = (score: number) => {
  const value = Number.isFinite(score) ? score : 0;
  const fixed = Math.abs(value).toFixed(2);
  return `${value >= 0 ? "+" : "-"}${fixed}`;
};

const formatStrategyId = (value?: string) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "-";
  const compact = raw.replace(/-/g, "").toUpperCase();
  if (compact.length <= 8) return compact;
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
};

const formatSwaps = (value?: number) => {
  if (!Number.isFinite(value ?? NaN)) return "-";
  return Number(value).toFixed(2);
};

const formatPoints = (value?: number) => {
  if (!Number.isFinite(value ?? NaN)) return "-";
  return Math.round(Number(value)).toString();
};

const getSeasonIdFromWeekStart = (iso?: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  const bucket = Math.floor((Math.max(1, isoWeek) - 1) / 12) + 1;
  return `${isoYear}-S${bucket}`;
};

const formatPercent = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
};
const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const fetchAllPagedRows = async <T,>(buildPath: (page: number) => string) => {
  const rows: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await apiGet<PagedRows<T>>(buildPath(page));
    rows.push(...(response.rows ?? []));
    totalPages = Math.max(1, Number(response.totalPages ?? 1));
    page += 1;
  } while (page <= totalPages);

  return rows;
};
export default function LeaderboardPage() {
  const { address, connect, hasProvider } = useWallet();

  const [mode, setMode] = useState<LeaderboardMode>("weekly");
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [selectedSeasonId, setSelectedSeasonId] = useState<string>("");
  const [weeklyRows, setWeeklyRows] = useState<LeaderboardViewRow[]>([]);
  const [seasonRows, setSeasonRows] = useState<LeaderboardViewRow[]>([]);
  const [allTimeRows, setAllTimeRows] = useState<LeaderboardViewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode>("all");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [strategyDetail, setStrategyDetail] = useState<StrategyDetailResponse | null>(null);
  const [strategyDetailLoading, setStrategyDetailLoading] = useState(false);
  const [strategyDetailError, setStrategyDetailError] = useState<string | null>(null);
  const strategyDetailCacheRef = useRef<Record<string, StrategyDetailResponse>>({});

  const selectedWeek = useMemo(
    () => weeks.find((week) => week.id === selectedWeekId) ?? null,
    [weeks, selectedWeekId],
  );

  const loadWeeks = useCallback(async () => {
    const [list, current] = await Promise.all([
      apiGet<WeekSummary[]>("/weeks?limit=36"),
      apiGet<WeekSummary | null>("/weeks/current"),
    ]);
    setWeeks(list);
    const initialId = current?.id ?? list[0]?.id ?? "";
    setSelectedWeekId((prev) => (prev ? prev : initialId));

    const initialSeasonId = getSeasonIdFromWeekStart(current?.startAtUtc ?? list[0]?.startAtUtc ?? null) ?? "";
    setSelectedSeasonId((prev) => (prev ? prev : initialSeasonId));
  }, []);

  const loadWeeklyLeaderboard = useCallback(
    async (weekId: string, options?: { force?: boolean }) => {
      if (!weekId) {
        setWeeklyRows([]);
        return;
      }

      const week = weeks.find((item) => item.id === weekId);
      const ttlMs = week?.status === "ACTIVE" ? ACTIVE_WEEK_CACHE_TTL_MS : PASSIVE_WEEK_CACHE_TTL_MS;
      const cacheKey = `${LEADERBOARD_WEEKLY_CACHE_KEY_PREFIX}${weekId}`;

      if (!options?.force && typeof window !== "undefined") {
        try {
          const cachedRaw = localStorage.getItem(cacheKey);
          if (cachedRaw) {
            const cached = JSON.parse(cachedRaw) as {
              savedAt: string;
              rows: LeaderboardViewRow[];
            };
            const savedAtMs = new Date(cached.savedAt).getTime();
            if (Number.isFinite(savedAtMs) && Date.now() - savedAtMs <= ttlMs) {
              setWeeklyRows(cached.rows);
              setLastUpdated(cached.savedAt);
              setError(null);
              setLoading(false);
              return;
            }
          }
        } catch {
          // Ignore cache read errors.
        }
      }

      setLoading(true);
      setError(null);
      try {
        const allRows = await fetchAllPagedRows<WeeklyLeaderboardRow>(
          (page) => `/epochs/${weekId}/strategies?page=${page}&pageSize=${LEADERBOARD_PAGE_SIZE}`,
        );
        const mapped: LeaderboardViewRow[] = allRows.map((row) => ({
          rank: Number(row.rank),
          strategyId: row.strategy_id,
          address: row.address,
          weekScore: Number(row.score),
          swaps: Number(row.swaps ?? 0),
          displayName: row.display_name ?? null,
        }));
        const savedAt = new Date().toISOString();
        setWeeklyRows(mapped);
        setLastUpdated(savedAt);
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ savedAt, rows: mapped }));
          } catch {
            // Ignore cache write errors.
          }
        }
      } catch (err) {
        setWeeklyRows([]);
        setError(err instanceof Error ? err.message : "Failed to load leaderboard.");
      } finally {
        setLoading(false);
      }
    },
    [weeks],
  );

  const loadAllTimeLeaderboard = useCallback(async (options?: { force?: boolean }) => {
    const cacheKey = LEADERBOARD_ALL_TIME_CACHE_KEY;
    if (!options?.force && typeof window !== "undefined") {
      try {
        const cachedRaw = localStorage.getItem(cacheKey);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as {
            savedAt: string;
            rows: LeaderboardViewRow[];
          };
          const savedAtMs = new Date(cached.savedAt).getTime();
          if (Number.isFinite(savedAtMs) && Date.now() - savedAtMs <= ALL_TIME_CACHE_TTL_MS) {
            setAllTimeRows(cached.rows);
            setLastUpdated(cached.savedAt);
            setError(null);
            setLoading(false);
            return;
          }
        }
      } catch {
        // Ignore cache read errors.
      }
    }

    setLoading(true);
    setError(null);
    try {
      const allRows = await fetchAllPagedRows<AllTimeLeaderboardRow>(
        (page) => `/leaderboard/strategies?page=${page}&pageSize=${LEADERBOARD_PAGE_SIZE}`,
      );
      const mapped: LeaderboardViewRow[] = allRows.map((row) => ({
        rank: Number(row.rank),
        strategyId: row.strategy_id,
        address: row.address,
        totalScore: Number(row.total_score),
        avgScore: Number(row.avg_score),
        bestWeekScore: Number(row.best_score),
        weeksPlayed: Number(row.epochs_played),
        avgSwaps: Number(row.avg_swaps),
        displayName: row.display_name ?? null,
      }));
      const savedAt = new Date().toISOString();
      setAllTimeRows(mapped);
      setLastUpdated(savedAt);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ savedAt, rows: mapped }));
        } catch {
          // Ignore cache write errors.
        }
      }
    } catch (err) {
      setAllTimeRows([]);
      setError(err instanceof Error ? err.message : "Failed to load all-time strategy leaderboard.");
    } finally {
      setLoading(false);
    }
  }, []);
  const loadSeasonLeaderboard = useCallback(async (seasonId: string, options?: { force?: boolean }) => {
    const normalizedSeasonId = String(seasonId ?? "").trim();
    if (!normalizedSeasonId) {
      setSeasonRows([]);
      return;
    }

    const cacheKey = `${LEADERBOARD_SEASON_CACHE_KEY_PREFIX}${normalizedSeasonId}`;
    if (!options?.force && typeof window !== "undefined") {
      try {
        const cachedRaw = localStorage.getItem(cacheKey);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as {
            savedAt: string;
            rows: LeaderboardViewRow[];
          };
          const savedAtMs = new Date(cached.savedAt).getTime();
          if (Number.isFinite(savedAtMs) && Date.now() - savedAtMs <= SEASON_CACHE_TTL_MS) {
            setSeasonRows(cached.rows);
            setLastUpdated(cached.savedAt);
            setError(null);
            setLoading(false);
            return;
          }
        }
      } catch {
        // Ignore cache read errors.
      }
    }

    setLoading(true);
    setError(null);
    try {
      const allRows = await fetchAllPagedRows<SeasonLeaderboardRow>(
        (page) => `/leaderboard/strategies?scope=season&seasonId=${encodeURIComponent(normalizedSeasonId)}&page=${page}&pageSize=${LEADERBOARD_PAGE_SIZE}`,
      );
      const mapped: LeaderboardViewRow[] = allRows.map((row) => ({
        rank: Number(row.rank),
        strategyId: row.strategy_id,
        address: row.address,
        seasonId: row.season_id,
        seasonPoints: Number(row.season_points),
        weeksPlayed: Number(row.epochs_played),
        wins: Number(row.wins),
        top10: Number(row.top10),
        avgScore: Number(row.avg_score),
        totalScore: Number(row.total_score),
        displayName: row.display_name ?? null,
      }));
      const savedAt = new Date().toISOString();
      setSeasonRows(mapped);
      setLastUpdated(savedAt);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ savedAt, rows: mapped }));
        } catch {
          // Ignore cache write errors.
        }
      }
    } catch (err) {
      setSeasonRows([]);
      setError(err instanceof Error ? err.message : "Failed to load season strategy leaderboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStrategyDetail = useCallback(async (strategyId: string, options?: { force?: boolean }) => {
    const normalized = String(strategyId ?? "").trim();
    if (!normalized) {
      setStrategyDetail(null);
      setStrategyDetailError(null);
      return;
    }

    if (!options?.force) {
      const cached = strategyDetailCacheRef.current[normalized];
      if (cached) {
        setStrategyDetail(cached);
        setStrategyDetailError(null);
        return;
      }
    }

    setStrategyDetailLoading(true);
    setStrategyDetailError(null);
    try {
      const payload = await apiGet<StrategyDetailResponse>(`/strategies/${encodeURIComponent(normalized)}`);
      strategyDetailCacheRef.current[normalized] = payload;
      setStrategyDetail(payload);
    } catch (err) {
      setStrategyDetail(null);
      setStrategyDetailError(err instanceof Error ? err.message : "Failed to load strategy profile.");
    } finally {
      setStrategyDetailLoading(false);
    }
  }, []);

    useEffect(() => {
    void loadWeeks();
  }, [loadWeeks]);

  useEffect(() => {
    if (mode !== "weekly") return;
    if (!selectedWeekId) return;
    void loadWeeklyLeaderboard(selectedWeekId);
  }, [mode, selectedWeekId, loadWeeklyLeaderboard]);

  useEffect(() => {
    if (mode !== "season") return;
    if (!selectedSeasonId) return;
    void loadSeasonLeaderboard(selectedSeasonId);
  }, [mode, selectedSeasonId, loadSeasonLeaderboard]);

  useEffect(() => {
    if (mode !== "all_time") return;
    void loadAllTimeLeaderboard();
  }, [mode, loadAllTimeLeaderboard]);

  useEffect(() => {
    if (mode !== "weekly") return;
    if (!selectedWeekId) return;
    const week = weeks.find((item) => item.id === selectedWeekId);
    if (week?.status !== "ACTIVE") return;

    const timer = window.setInterval(() => {
      void loadWeeklyLeaderboard(selectedWeekId, { force: true });
    }, ACTIVE_WEEK_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mode, selectedWeekId, weeks, loadWeeklyLeaderboard]);

  useEffect(() => {
    if (mode !== "season") return;
    if (!selectedSeasonId) return;
    const timer = window.setInterval(() => {
      void loadSeasonLeaderboard(selectedSeasonId, { force: true });
    }, SEASON_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mode, selectedSeasonId, loadSeasonLeaderboard]);

  useEffect(() => {
    if (mode !== "all_time") return;
    const timer = window.setInterval(() => {
      void loadAllTimeLeaderboard({ force: true });
    }, ALL_TIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mode, loadAllTimeLeaderboard]);

  const rows = mode === "weekly" ? weeklyRows : mode === "season" ? seasonRows : allTimeRows;

  const seasonOptions = useMemo(() => {
    const mapped = weeks
      .map((week) => ({
        seasonId: getSeasonIdFromWeekStart(week.startAtUtc),
        startAtUtc: week.startAtUtc,
      }))
      .filter((row): row is { seasonId: string; startAtUtc: string } => Boolean(row.seasonId));

    const dedup = new Map<string, string>();
    for (const item of mapped) {
      if (!dedup.has(item.seasonId)) {
        dedup.set(item.seasonId, item.startAtUtc);
      }
    }

    return Array.from(dedup.entries())
      .map(([seasonId, startAtUtc]) => ({ seasonId, startAtUtc }))
      .sort((a, b) => Date.parse(b.startAtUtc) - Date.parse(a.startAtUtc));
  }, [weeks]);

  useEffect(() => {
    if (!seasonOptions.length) return;
    const exists = seasonOptions.some((option) => option.seasonId === selectedSeasonId);
    if (exists) return;
    setSelectedSeasonId(seasonOptions[0].seasonId);
  }, [seasonOptions, selectedSeasonId]);

  const discoveryRows = useMemo(() => {
    if (mode !== "all_time") return rows;

    const sorted = [...rows];
    if (discoveryMode === "consistent") {
      return sorted
        .filter((row) => Number(row.weeksPlayed ?? 0) >= 4)
        .sort((a, b) => {
          const avgDelta = Number(b.avgScore ?? 0) - Number(a.avgScore ?? 0);
          if (avgDelta !== 0) return avgDelta;
          return Number(b.totalScore ?? 0) - Number(a.totalScore ?? 0);
        });
    }

    if (discoveryMode === "volatile") {
      return sorted
        .filter((row) => Number(row.weeksPlayed ?? 0) >= 3)
        .sort((a, b) => {
          const aVol = Math.abs(Number(a.bestWeekScore ?? 0) - Number(a.avgScore ?? 0));
          const bVol = Math.abs(Number(b.bestWeekScore ?? 0) - Number(b.avgScore ?? 0));
          if (bVol !== aVol) return bVol - aVol;
          return Number(b.totalScore ?? 0) - Number(a.totalScore ?? 0);
        });
    }

    if (discoveryMode === "emerging") {
      return sorted
        .filter((row) => Number(row.weeksPlayed ?? 0) > 0 && Number(row.weeksPlayed ?? 0) <= 3)
        .sort((a, b) => Number(b.totalScore ?? 0) - Number(a.totalScore ?? 0));
    }

    return rows;
  }, [discoveryMode, mode, rows]);

  const normalizedAddress = address?.toLowerCase() ?? "";
  const myRow = useMemo(
    () => discoveryRows.find((row) => row.address.toLowerCase() === normalizedAddress) ?? null,
    [discoveryRows, normalizedAddress],
  );
  const myRank = myRow?.rank ?? null;

  useEffect(() => {
    if (!discoveryRows.length) {
      setSelectedStrategyId(null);
      setStrategyDetail(null);
      setStrategyDetailError(null);
      return;
    }

    const currentValid = selectedStrategyId && discoveryRows.some((row) => row.strategyId === selectedStrategyId);
    if (currentValid) return;

    const next = myRow?.strategyId ?? discoveryRows[0]?.strategyId ?? null;
    setSelectedStrategyId(next);
  }, [discoveryRows, myRow?.strategyId, selectedStrategyId]);

  useEffect(() => {
    if (!selectedStrategyId) {
      setStrategyDetail(null);
      setStrategyDetailError(null);
      return;
    }
    void loadStrategyDetail(selectedStrategyId);
  }, [loadStrategyDetail, selectedStrategyId]);

  const visibleRows = useMemo(() => {
    if (viewMode === "top10") return discoveryRows.slice(0, 10);
    if (viewMode === "top50") return discoveryRows.slice(0, 50);
    if (viewMode === "around_me") {
      if (!myRank) return discoveryRows.slice(0, 10);
      const start = Math.max(0, myRank - 4);
      const end = Math.min(discoveryRows.length, myRank + 3);
      return discoveryRows.slice(start, end);
    }
    return discoveryRows;
  }, [discoveryRows, viewMode, myRank]);

    const totalEpochsInVisibleBoard = useMemo(() => {
    if (!rows.length) return 0;
    return rows.reduce((sum, row) => sum + (Number(row.weeksPlayed ?? 0) || 0), 0);
  }, [rows]);

  const getRowPrimaryMetric = useCallback(
    (row: LeaderboardViewRow) => {
      if (mode === "weekly") return Number(row.weekScore);
      if (mode === "season") return Number(row.seasonPoints);
      return Number(row.totalScore);
    },
    [mode],
  );

  const scoreSeries = useMemo(() => {
    const values = discoveryRows.map((row) => getRowPrimaryMetric(row)).filter((value) => Number.isFinite(value));
    return values as number[];
  }, [discoveryRows, getRowPrimaryMetric]);

  const scoreDistribution = useMemo(() => {
    let wins = 0;
    let losses = 0;
    let neutral = 0;
    for (const value of scoreSeries) {
      if (value > 0) wins += 1;
      else if (value < 0) losses += 1;
      else neutral += 1;
    }
    return { wins, losses, neutral };
  }, [scoreSeries]);

  const quartiles = useMemo(() => {
    return {
      p25: percentile(scoreSeries, 0.25),
      median: percentile(scoreSeries, 0.5),
      p75: percentile(scoreSeries, 0.75),
    };
  }, [scoreSeries]);

  const scoreThresholds = useMemo(() => {
    if (!scoreSeries.length) {
      return { top1: null, top10: null, top50: null };
    }
    const sortedDesc = [...scoreSeries].sort((a, b) => b - a);
    return {
      top1: sortedDesc[0] ?? null,
      top10: sortedDesc[Math.min(9, sortedDesc.length - 1)] ?? null,
      top50: sortedDesc[Math.min(49, sortedDesc.length - 1)] ?? null,
    };
  }, [scoreSeries]);

  const averageSwaps = useMemo(() => {
    const values = discoveryRows
      .map((row) => (mode === "weekly" ? Number(row.swaps) : Number(row.avgSwaps)))
      .filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }, [discoveryRows, mode]);

  const myScoreGap = useMemo(() => {
    if (!myRow || !myRank || myRank <= 1) return null;
    const previous = discoveryRows.find((row) => row.rank === myRank - 1);
    if (!previous) return null;
    const myScore = getRowPrimaryMetric(myRow);
    const previousScore = getRowPrimaryMetric(previous);
    if (!Number.isFinite(myScore) || !Number.isFinite(previousScore)) return null;
    return previousScore - myScore;
  }, [discoveryRows, getRowPrimaryMetric, myRank, myRow]);

  const top10Gap = useMemo(() => {
    if (!myRow || !myRank || myRank <= 10) return 0;
    const myScore = getRowPrimaryMetric(myRow);
    const threshold = scoreThresholds.top10;
    if (!Number.isFinite(myScore) || threshold === null) return null;
    return Math.max(0, threshold - myScore);
  }, [getRowPrimaryMetric, myRank, myRow, scoreThresholds.top10]);

  const scoreDistributionPercent = useMemo(() => {
    const total = scoreDistribution.wins + scoreDistribution.losses + scoreDistribution.neutral;
    if (!total) {
      return { wins: 0, losses: 0, neutral: 0 };
    }
    return {
      wins: (scoreDistribution.wins / total) * 100,
      losses: (scoreDistribution.losses / total) * 100,
      neutral: (scoreDistribution.neutral / total) * 100,
    };
  }, [scoreDistribution]);

  const myCurrentScore = useMemo(() => {
    if (!myRow) return null;
    const value = getRowPrimaryMetric(myRow);
    return Number.isFinite(value) ? value : null;
  }, [getRowPrimaryMetric, myRow]);
  return (
    <main className="vc-page space-y-4">
      <Card className="rounded-[28px]">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Leaderboard</CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">
              <span>Last updated: {formatUtc(lastUpdated)}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {([
              ["weekly", "Epoch"],
              ["season", "Season"],
              ["all_time", "All Time"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={`rounded-full border px-4 py-1.5 text-[0.68rem] uppercase tracking-[0.14em] transition ${
                  mode === key
                    ? "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]"
                    : "border-[color:var(--arena-stroke)] text-[color:var(--arena-muted)] hover:border-[color:var(--arena-stroke-strong)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "weekly" ? (
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Epoch</div>
                <select
                  value={selectedWeekId}
                  onChange={(event) => setSelectedWeekId(event.target.value)}
                  className="mt-2 h-10 w-full rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-3 text-sm text-[color:var(--arena-ink)] outline-none"
                >
                  {weeks.map((week) => (
                    <option key={week.id} value={week.id}>
                      {formatWeekMondayUtc(week.startAtUtc)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Status</div>
                <div
                  className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.15em] ${weekStatusClass(
                    selectedWeek?.status,
                  )}`}
                >
                  {selectedWeek ? weekStatusLabel[selectedWeek.status] : "No Epoch"}
                </div>
              </div>

              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">My Rank</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">
                  {myRank ? `#${myRank}` : "-"}
                </div>
              </div>

              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Strategists</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">{rows.length}</div>
              </div>
            </div>
          ) : mode === "season" ? (
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Season</div>
                <select
                  value={selectedSeasonId}
                  onChange={(event) => setSelectedSeasonId(event.target.value)}
                  className="mt-2 h-10 w-full rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-3 text-sm text-[color:var(--arena-ink)] outline-none"
                >
                  {seasonOptions.map((season) => (
                    <option key={season.seasonId} value={season.seasonId}>
                      {season.seasonId}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Tracked Strategists</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">{rows.length}</div>
              </div>
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Played Epochs (sum)</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">{totalEpochsInVisibleBoard}</div>
              </div>
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">My Rank</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">
                  {myRank ? `#${myRank}` : "-"}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Tracked Strategists</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">{rows.length}</div>
              </div>
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">Played Epochs (sum)</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">{totalEpochsInVisibleBoard}</div>
              </div>
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel)] px-4 py-3">
                <div className="text-[0.65rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">My Rank</div>
                <div className="mt-2 text-2xl font-semibold text-[color:var(--arena-ink)]">
                  {myRank ? `#${myRank}` : "-"}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="rounded-[28px]">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">{mode === "weekly" ? "Epoch Strategy Ranking" : mode === "season" ? "Season Strategy Ranking" : "All-Time Strategy Ranking"}</CardTitle>
              <div className="flex flex-wrap gap-2">
                {mode === "all_time" ? (
                  ([
                    ["all", "All Strategies"],
                    ["consistent", "Consistent"],
                    ["volatile", "Volatile"],
                    ["emerging", "Emerging"],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setDiscoveryMode(key)}
                      className={`rounded-full border px-3 py-1 text-[0.65rem] uppercase tracking-[0.16em] transition ${
                        discoveryMode === key
                          ? "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]"
                          : "border-[color:var(--arena-stroke)] text-[color:var(--arena-muted)] hover:border-[color:var(--arena-stroke-strong)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))
                ) : (
                  ([
                    ["all", "All"],
                    ["top10", "Top 10"],
                    ["top50", "Top 50"],
                    ["around_me", "Around Me"],
                  ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setViewMode(key)}
                    className={`rounded-full border px-3 py-1 text-[0.65rem] uppercase tracking-[0.16em] transition ${
                      viewMode === key
                        ? "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]"
                        : "border-[color:var(--arena-stroke)] text-[color:var(--arena-muted)] hover:border-[color:var(--arena-stroke-strong)]"
                    }`}
                  >
                    {label}
                  </button>
                ))
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="rounded-2xl border border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] px-4 py-3 text-sm text-[color:var(--arena-danger)]">
                {error}
              </div>
            ) : null}

            {loading ? (
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] px-4 py-5 text-sm text-[color:var(--arena-muted)]">
                Loading strategy leaderboard...
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[70px]">Rank</TableHead>
                    <TableHead>Strategist</TableHead>
                    <TableHead>Strategy ID</TableHead>
                    {mode === "weekly" ? (
                      <>
                        <TableHead className="text-right">Week Score</TableHead>
                        <TableHead className="text-right">Swaps</TableHead>
                      </>
                    ) : mode === "season" ? (
                      <>
                        <TableHead className="text-right">Season Pts</TableHead>
                        <TableHead className="text-right">Avg Score</TableHead>
                        <TableHead className="text-right">Epochs</TableHead>
                        <TableHead className="text-right">Wins</TableHead>
                        <TableHead className="text-right">Top 10</TableHead>
                      </>
                    ) : (
                      <>
                        <TableHead className="text-right">Total Score</TableHead>
                        <TableHead className="text-right">Avg Score</TableHead>
                        <TableHead className="text-right">Epochs</TableHead>
                        <TableHead className="text-right">Best Week</TableHead>
                        <TableHead className="text-right">Avg Swaps</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => {
                    const isMine = normalizedAddress && row.address.toLowerCase() === normalizedAddress;

                    const displayName = String(row.displayName ?? "").trim();
                    const primaryLabel = displayName || shortAddress(row.address);
  return (
                      <TableRow
                        key={`${mode}-${row.rank}-${row.address}`}
                        className={`${isMine ? "outline outline-1 outline-[color:var(--arena-accent-soft)]" : ""} ${
                          selectedStrategyId && row.strategyId === selectedStrategyId
                            ? "bg-[color:var(--arena-panel-strong)]"
                            : ""
                        } ${row.strategyId ? "cursor-pointer" : ""}`}
                        onClick={() => {
                          if (!row.strategyId) return;
                          setSelectedStrategyId(row.strategyId);
                        }}
                      >
                        <TableCell className="font-semibold">#{row.rank}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <span className="font-medium text-[color:var(--arena-ink)]">{primaryLabel}</span>
                            <span className="text-[0.7rem] text-[color:var(--arena-muted)]">{shortAddress(row.address)}</span>
                            {isMine ? (
                              <span className="text-[0.7rem] uppercase tracking-[0.14em] text-[color:var(--arena-accent)]">
                                You
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-[0.72rem] uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">
                          {formatStrategyId(row.strategyId)}
                        </TableCell>
                        {mode === "weekly" ? (
                          <>
                            <TableCell className={`text-right font-semibold ${Number(row.weekScore) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                              {formatScore(Number(row.weekScore ?? 0))}
                            </TableCell>
                            <TableCell className="text-right">{Number(row.swaps ?? 0)}</TableCell>
                          </>
                        ) : mode === "season" ? (
                          <>
                            <TableCell className="text-right font-semibold text-[color:var(--arena-accent)]">
                              {formatPoints(row.seasonPoints)}
                            </TableCell>
                            <TableCell className={`text-right font-semibold ${Number(row.avgScore) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                              {formatScore(Number(row.avgScore ?? 0))}
                            </TableCell>
                            <TableCell className="text-right">{Number(row.weeksPlayed ?? 0)}</TableCell>
                            <TableCell className="text-right">{Number(row.wins ?? 0)}</TableCell>
                            <TableCell className="text-right">{Number(row.top10 ?? 0)}</TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell className={`text-right font-semibold ${Number(row.totalScore) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                              {formatScore(Number(row.totalScore ?? 0))}
                            </TableCell>
                            <TableCell className={`text-right font-semibold ${Number(row.avgScore) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                              {formatScore(Number(row.avgScore ?? 0))}
                            </TableCell>
                            <TableCell className="text-right">{Number(row.weeksPlayed ?? 0)}</TableCell>
                            <TableCell className={`text-right font-semibold ${Number(row.bestWeekScore) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                              {formatScore(Number(row.bestWeekScore ?? 0))}
                            </TableCell>
                            <TableCell className="text-right">{formatSwaps(row.avgSwaps)}</TableCell>
                          </>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-[28px]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{mode === "weekly" ? "Epoch Command View" : mode === "season" ? "Season Command View" : "All-Time Command View"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!rows.length ? (
              <div className="rounded-2xl border border-[color:var(--arena-stroke)] px-4 py-5 text-sm text-[color:var(--arena-muted)]">
                No ranking data yet.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[linear-gradient(140deg,rgba(14,32,54,0.75),rgba(16,18,24,0.85))] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">At a Glance</div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Participants</div>
                      <div className="mt-1 text-lg font-semibold">{rows.length}</div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Leader Score</div>
                      <div className="mt-1 text-lg font-semibold">{scoreThresholds.top1 === null ? "-" : formatScore(scoreThresholds.top1)}</div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Top 10 Cutoff</div>
                      <div className="mt-1 font-semibold">{scoreThresholds.top10 === null ? "-" : formatScore(scoreThresholds.top10)}</div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Avg Reallocations</div>
                      <div className="mt-1 font-semibold">{averageSwaps === null ? "-" : formatSwaps(averageSwaps)}</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[color:var(--arena-stroke)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">Where You Stand</div>
                  {myRow ? (
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">My Rank</div>
                        <div className="mt-1 text-lg font-semibold">#{myRank}</div>
                      </div>
                      <div>
                        <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">My Score</div>
                        <div className={`mt-1 text-lg font-semibold ${Number(myCurrentScore ?? 0) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                          {myCurrentScore === null ? "-" : formatScore(myCurrentScore)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Next Rank Gap</div>
                        <div className="mt-1 font-semibold">{myScoreGap === null ? "-" : formatScore(myScoreGap)}</div>
                      </div>
                      <div>
                        <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Top 10 Gap</div>
                        <div className="mt-1 font-semibold">{top10Gap === null ? "-" : formatScore(top10Gap)}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-sm text-[color:var(--arena-muted)]">
                      Connect wallet to track your current league position.
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-[color:var(--arena-stroke)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">Field Shape</div>
                  <div className="mt-3 space-y-2 text-xs">
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Positive</span>
                        <span className="text-[color:var(--arena-success)]">{scoreDistribution.wins} ({formatPercent(scoreDistributionPercent.wins)})</span>
                      </div>
                      <div className="h-2 rounded-full bg-[color:var(--arena-panel-strong)]">
                        <div className="h-2 rounded-full bg-[color:var(--arena-success)]" style={{ width: `${scoreDistributionPercent.wins}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Negative</span>
                        <span className="text-[color:var(--arena-danger)]">{scoreDistribution.losses} ({formatPercent(scoreDistributionPercent.losses)})</span>
                      </div>
                      <div className="h-2 rounded-full bg-[color:var(--arena-panel-strong)]">
                        <div className="h-2 rounded-full bg-[color:var(--arena-danger)]" style={{ width: `${scoreDistributionPercent.losses}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Neutral</span>
                        <span className="text-[color:var(--arena-muted)]">{scoreDistribution.neutral} ({formatPercent(scoreDistributionPercent.neutral)})</span>
                      </div>
                      <div className="h-2 rounded-full bg-[color:var(--arena-panel-strong)]">
                        <div className="h-2 rounded-full bg-[color:var(--arena-stroke-strong)]" style={{ width: `${scoreDistributionPercent.neutral}%` }} />
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-[color:var(--arena-muted)]">
                    <div>P25: {quartiles.p25 === null ? "-" : formatScore(quartiles.p25)}</div>
                    <div>Median: {quartiles.median === null ? "-" : formatScore(quartiles.median)}</div>
                    <div>P75: {quartiles.p75 === null ? "-" : formatScore(quartiles.p75)}</div>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-[color:var(--arena-stroke)] px-4 py-3">
              <div className="text-xs uppercase tracking-[0.14em] text-[color:var(--arena-muted)]">Selected Strategy</div>

              {!selectedStrategyId ? (
                <div className="mt-2 text-sm text-[color:var(--arena-muted)]">Select a strategy row to inspect profile and recent epochs.</div>
              ) : strategyDetailLoading ? (
                <div className="mt-2 text-sm text-[color:var(--arena-muted)]">Loading strategy profile...</div>
              ) : strategyDetailError ? (
                <div className="mt-2 text-sm text-[color:var(--arena-danger)]">{strategyDetailError}</div>
              ) : !strategyDetail ? (
                <div className="mt-2 text-sm text-[color:var(--arena-muted)]">No strategy profile found.</div>
              ) : (
                <div className="mt-3 space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Strategy ID</div>
                      <div className="mt-1 font-mono font-semibold uppercase tracking-[0.1em]">{formatStrategyId(strategyDetail.strategy_id)}</div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Strategist</div>
                      <div className="mt-1 font-semibold">{String(strategyDetail.display_name ?? "").trim() || shortAddress(strategyDetail.address)}</div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Epochs</div>
                      <div className="mt-1 font-semibold">{Number(strategyDetail.epochs_played || 0)}</div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Best Score</div>
                      <div className={`mt-1 font-semibold ${Number(strategyDetail.best_score || 0) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                        {formatScore(Number(strategyDetail.best_score || 0))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Avg Score</div>
                      <div className={`mt-1 font-semibold ${Number(strategyDetail.avg_score || 0) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                        {formatScore(Number(strategyDetail.avg_score || 0))}
                      </div>
                    </div>
                    <div>
                      <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Total Score</div>
                      <div className={`mt-1 font-semibold ${Number(strategyDetail.total_score || 0) >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                        {formatScore(Number(strategyDetail.total_score || 0))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Recent Epochs</div>
                    <div className="mt-2 space-y-1">
                      {(strategyDetail.recentEpochs ?? []).slice(0, 5).map((entry) => {
                        const score = Number(entry.score ?? 0);
                        const rank = Number(entry.rank ?? 0);
                        return (
                          <div key={`${entry.epoch_id}-${entry.created_at ?? ""}`} className="flex items-center justify-between rounded-lg border border-[color:var(--arena-stroke)] px-3 py-1.5 text-[0.76rem]">
                            <span className="font-mono">{entry.epoch_id}</span>
                            <span className="text-[color:var(--arena-muted)]">#{Number.isFinite(rank) && rank > 0 ? rank : "-"}</span>
                            <span className={`${score >= 0 ? "text-[color:var(--arena-success)]" : "text-[color:var(--arena-danger)]"}`}>
                              {formatScore(score)}
                            </span>
                          </div>
                        );
                      })}
                      {(strategyDetail.recentEpochs ?? []).length === 0 ? (
                        <div className="text-[0.76rem] text-[color:var(--arena-muted)]">No recent epochs yet.</div>
                      ) : null}
                    </div>
                  </div>

                  <div>
                    <div className="text-[0.68rem] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Recent Seasons</div>
                    <div className="mt-2 space-y-1">
                      {(strategyDetail.recentSeasons ?? []).slice(0, 4).map((entry) => (
                        <div key={entry.season_id} className="flex items-center justify-between rounded-lg border border-[color:var(--arena-stroke)] px-3 py-1.5 text-[0.76rem]">
                          <span className="font-mono">{entry.season_id}</span>
                          <span className="text-[color:var(--arena-accent)]">{formatPoints(entry.season_points)}</span>
                          <span className="text-[color:var(--arena-muted)]">W:{Number(entry.wins ?? 0)}</span>
                          <span className="text-[color:var(--arena-muted)]">T10:{Number(entry.top10 ?? 0)}</span>
                        </div>
                      ))}
                      {(strategyDetail.recentSeasons ?? []).length === 0 ? (
                        <div className="text-[0.76rem] text-[color:var(--arena-muted)]">No season history yet.</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

      </div>

      {!address ? (
        <Card className="rounded-[28px]">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
            <p className="text-sm text-[color:var(--arena-muted)]">
              Connect wallet to enable Around Me strategist tracking and identity match.
            </p>
            <Button
              type="button"
              className="rounded-full px-5"
              onClick={() => void connect()}
              disabled={!hasProvider}
            >
              Connect
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}













