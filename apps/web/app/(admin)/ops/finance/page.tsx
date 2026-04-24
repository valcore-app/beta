
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { Badge } from "../../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../../components/ui/tabs";
import { apiGet, apiPost } from "../../../../lib/api";
import { useRuntimeProfile } from "../../../../lib/runtime-profile";

type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

type WeekSummary = {
  id: string;
  startAtUtc: string;
  lockAtUtc: string;
  endAtUtc: string;
  status: WeekStatus;
};

type WeekFinanceCoin = {
  slotId: string;
  coinId: string;
  symbol: string;
  name: string;
};

type WeekFinanceSwap = {
  txHash: string;
  removedSymbol: string;
  addedSymbol: string;
  timestamp: number;
  createdAt: string;
};

type WeekFinancePlayer = {
  address: string;
  depositWei: string;
  principalWei: string;
  riskWei: string;
  score: number;
  rawPerformance: number;
  multiplier: number;
  rewardWei: string;
  totalWithdrawWei: string;
  claimState: "claimed" | "unclaimed" | "unknown" | "n/a";
  claimed: boolean | null;
  swaps: number;
  coins: WeekFinanceCoin[];
  swapLog: WeekFinanceSwap[];
};

type WeekFinancePayload = {
  mode: "week";
  week: {
    id: string;
    status: WeekStatus;
    startAtUtc: string;
    lockAtUtc: string;
    endAtUtc: string;
  };
  summary: {
    totalCommittedWei: string;
    lossesWei: string;
    feeBps: number;
    feeWei: string;
    claimedWei: string;
    remainingWei: string;
    claimableWei: string;
    rewardSweepWindowOpen: boolean;
    rewardSweepAvailableAtUtc: string | null;
    expiredRewardWei: string;
    expiredRewardPlayers: number;
    asOf: string;
    isLive: boolean;
  };
  players: WeekFinancePlayer[];
};

type AllTimeFinanceWeek = {
  weekId: string;
  weekStartAtUtc: string | null;
  weekStatus: string;
  depositWei: string;
  wonWei: string;
  lostWei: string;
  claimState: "claimed" | "unclaimed" | "unknown" | "n/a";
  claimedWei: string;
  remainingWei: string;
  swaps: number;
  score: number;
  coins: WeekFinanceCoin[];
};

type AllTimeFinancePlayer = {
  address: string;
  weeksPlayed: number;
  wins: number;
  losses: number;
  totalCommittedWei: string;
  totalClaimedWei: string;
  totalRemainingWei: string;
  weeks: AllTimeFinanceWeek[];
};

type AllTimeFinancePayload = {
  mode: "all-time";
  summary: {
    totalCommittedWei: string;
    totalFeeWei: string;
    totalClaimedWei: string;
    totalRemainingWei: string;
    players: number;
    weeks: number;
    asOf: string;
  };
  players: AllTimeFinancePlayer[];
};

type WeekSortKey =
  | "address"
  | "depositWei"
  | "riskWei"
  | "score"
  | "rewardWei"
  | "totalWithdrawWei"
  | "claimState"
  | "swaps";

type AllTimeSortKey =
  | "address"
  | "weeksPlayed"
  | "wins"
  | "losses"
  | "totalClaimedWei"
  | "totalRemainingWei";

const REFRESH_MS = 10 * 60 * 1000;

const shortAddress = (value: string) => `${value.slice(0, 6)}...${value.slice(-4)}`;

const parseWei = (wei?: string | null) => {
  try {
    return BigInt(wei ?? "0");
  } catch {
    return 0n;
  }
};

const formatStableAmount = (wei?: string | null, decimals = 18) => {
  if (!wei) return "$0.00";
  try {
    const value = Number(formatUnits(parseWei(wei), decimals));
    return `$${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } catch {
    return "$0.00";
  }
};

const formatDate = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const formatWeekMonday = (value?: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = midnight.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  midnight.setUTCDate(midnight.getUTCDate() - daysFromMonday);
  return midnight.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};

const scoreClass = (value: number) =>
  value > 0
    ? "text-[color:var(--arena-success)]"
    : value < 0
      ? "text-[color:var(--arena-danger)]"
      : "text-[color:var(--arena-muted)]";

const claimBadgeClass = (state: string) => {
  if (state === "claimed") {
    return "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]";
  }
  if (state === "unclaimed") {
    return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  }
  if (state === "unknown") {
    return "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";
  }
  return "border-[color:var(--arena-stroke-strong)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
};

const compareBigInt = (a: string, b: string) => {
  const aBig = parseWei(a);
  const bBig = parseWei(b);
  if (aBig === bBig) return 0;
  return aBig > bBig ? 1 : -1;
};

export default function OpsFinancePage() {
  const { profile } = useRuntimeProfile();
  if (!profile) {
    return null;
  }
  const [tab, setTab] = useState<"weeks" | "all_time">("weeks");
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  const [weekData, setWeekData] = useState<WeekFinancePayload | null>(null);
  const [allTimeData, setAllTimeData] = useState<AllTimeFinancePayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadingWeek, setLoadingWeek] = useState(false);
  const [loadingAllTime, setLoadingAllTime] = useState(false);
  const [sweepingExpired, setSweepingExpired] = useState(false);

  const [weekSearch, setWeekSearch] = useState("");
  const [weekClaimFilter, setWeekClaimFilter] = useState<"all" | "claimed" | "unclaimed" | "unknown" | "n/a">("all");
  const [weekSort, setWeekSort] = useState<{ key: WeekSortKey; dir: "asc" | "desc" }>({
    key: "score",
    dir: "desc",
  });
  const [selectedWeekPlayer, setSelectedWeekPlayer] = useState<string>("");

  const [allSearch, setAllSearch] = useState("");
  const [allSort, setAllSort] = useState<{ key: AllTimeSortKey; dir: "asc" | "desc" }>({
    key: "totalClaimedWei",
    dir: "desc",
  });
  const [selectedAllTimePlayer, setSelectedAllTimePlayer] = useState<string>("");
  const stablecoinDecimals = profile.stablecoinDecimals || 18;
  const formatAmount = useCallback(
    (wei?: string | null) => formatStableAmount(wei, stablecoinDecimals),
    [stablecoinDecimals],
  );

  const loadWeeks = useCallback(async () => {
    const weekList = await apiGet<WeekSummary[]>("/weeks?limit=52");
    setWeeks(weekList);
    setSelectedWeekId((prev) => {
      if (prev && weekList.some((week) => week.id === prev)) {
        return prev;
      }
      const active = weekList.find((week) => week.status === "ACTIVE");
      return active?.id ?? weekList[0]?.id ?? "";
    });
  }, []);

  const loadWeekFinance = useCallback(async (weekId: string) => {
    if (!weekId) return;
    setLoadingWeek(true);
    try {
      const payload = await apiGet<WeekFinancePayload>(
        `/admin/finance/week?weekId=${encodeURIComponent(weekId)}`,
      );
      setWeekData(payload);
      setSelectedWeekPlayer((prev) => {
        if (prev && payload.players.some((player) => player.address === prev)) {
          return prev;
        }
        return payload.players[0]?.address ?? "";
      });
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load week finance.");
      setWeekData(null);
    } finally {
      setLoadingWeek(false);
    }
  }, []);

  const loadAllTimeFinance = useCallback(async () => {
    setLoadingAllTime(true);
    try {
      const payload = await apiGet<AllTimeFinancePayload>("/admin/finance/all-time");
      setAllTimeData(payload);
      setSelectedAllTimePlayer((prev) => {
        if (prev && payload.players.some((player) => player.address === prev)) {
          return prev;
        }
        return payload.players[0]?.address ?? "";
      });
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load all-time finance.");
      setAllTimeData(null);
    } finally {
      setLoadingAllTime(false);
    }
  }, []);

  const sweepExpiredRewards = useCallback(async () => {
    if (!selectedWeekId) return;
    setSweepingExpired(true);
    try {
      const response = await apiPost<{
        ok: boolean;
        result: {
          weekId: string;
          eligiblePlayers: number;
          sweptPlayers: number;
          skippedPlayers: number;
          failedPlayers: number;
          sweptWei: string;
        };
      }>("/admin/finance/week/sweep-expired", { weekId: selectedWeekId });
      const result = response.result;
      setMessage(
        `Sweep done · eligible ${result.eligiblePlayers}, swept ${result.sweptPlayers}, failed ${result.failedPlayers}, moved ${formatAmount(result.sweptWei)}.`,
      );
      await loadWeekFinance(selectedWeekId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to sweep expired rewards.");
    } finally {
      setSweepingExpired(false);
    }
  }, [selectedWeekId, loadWeekFinance]);

  useEffect(() => {
    void loadWeeks();
  }, [loadWeeks]);

  useEffect(() => {
    if (!selectedWeekId) return;
    if (tab !== "weeks") return;
    void loadWeekFinance(selectedWeekId);
  }, [selectedWeekId, tab, loadWeekFinance]);

  useEffect(() => {
    if (tab !== "all_time") return;
    if (allTimeData) return;
    void loadAllTimeFinance();
  }, [tab, allTimeData, loadAllTimeFinance]);

  useEffect(() => {
    if (tab !== "weeks") return;
    if (!weekData?.summary.isLive || !selectedWeekId) return;
    const timer = window.setInterval(() => {
      void loadWeekFinance(selectedWeekId);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [tab, weekData?.summary.isLive, selectedWeekId, loadWeekFinance]);

  useEffect(() => {
    if (tab !== "all_time") return;
    const timer = window.setInterval(() => {
      void loadAllTimeFinance();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [tab, loadAllTimeFinance]);

  const weekPlayers = useMemo(() => {
    const rows = [...(weekData?.players ?? [])];
    const term = weekSearch.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (term && !row.address.toLowerCase().includes(term)) return false;
      if (weekClaimFilter !== "all" && row.claimState !== weekClaimFilter) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const { key, dir } = weekSort;
      const direction = dir === "asc" ? 1 : -1;
      if (key === "address" || key === "claimState") {
        return direction * String(a[key]).localeCompare(String(b[key]));
      }
      if (key === "score") {
        return direction * (a.score - b.score);
      }
      if (key === "swaps") {
        return direction * (a.swaps - b.swaps);
      }
      return direction * compareBigInt(String(a[key]), String(b[key]));
    });

    return filtered;
  }, [weekData?.players, weekSearch, weekClaimFilter, weekSort]);

  const allTimePlayers = useMemo(() => {
    const rows = [...(allTimeData?.players ?? [])];
    const term = allSearch.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (term && !row.address.toLowerCase().includes(term)) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const { key, dir } = allSort;
      const direction = dir === "asc" ? 1 : -1;
      if (key === "address") {
        return direction * a.address.localeCompare(b.address);
      }
      if (key === "weeksPlayed" || key === "wins" || key === "losses") {
        return direction * (Number(a[key]) - Number(b[key]));
      }
      return direction * compareBigInt(String(a[key]), String(b[key]));
    });

    return filtered;
  }, [allTimeData?.players, allSearch, allSort]);

  const selectedWeekPlayerData = useMemo(
    () => weekPlayers.find((row) => row.address === selectedWeekPlayer) ?? null,
    [weekPlayers, selectedWeekPlayer],
  );

  const selectedAllTimePlayerData = useMemo(
    () => allTimePlayers.find((row) => row.address === selectedAllTimePlayer) ?? null,
    [allTimePlayers, selectedAllTimePlayer],
  );

  const setWeekSortKey = (key: WeekSortKey) => {
    setWeekSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: key === "address" || key === "claimState" ? "asc" : "desc" };
    });
  };

  const setAllSortKey = (key: AllTimeSortKey) => {
    setAllSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: key === "address" ? "asc" : "desc" };
    });
  };

  return (
    <div className="grid gap-6">
      <section className="arena-panel rounded-[28px] p-8">
        <div className="space-y-2">
          <span className="arena-chip">Ops Console</span>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Finance</h1>
          <p className="text-sm text-[color:var(--arena-muted)]">
            Week-level and all-time capital flow, claim state, and strategist-level finance breakdown.
          </p>
        </div>
        {message ? <p className="mt-4 text-sm text-[color:var(--arena-gold)]">{message}</p> : null}
      </section>

      <Tabs value={tab} onValueChange={(value) => setTab(value as "weeks" | "all_time")} className="grid gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="weeks">Weeks</TabsTrigger>
            <TabsTrigger value="all_time">All Time</TabsTrigger>
          </TabsList>
          {tab === "weeks" ? (
            <div className="flex items-center gap-2 text-xs text-[color:var(--arena-muted)]">
              <span>Week</span>
              <select
                className="h-9 rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-3 text-sm text-[color:var(--arena-ink)]"
                value={selectedWeekId}
                onChange={(event) => setSelectedWeekId(event.target.value)}
              >
                {weeks.map((week) => (
                  <option key={week.id} value={week.id}>
                    {formatWeekMonday(week.startAtUtc)} ({week.status})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <TabsContent value="weeks" className="grid gap-4">
          <Card className="arena-panel-strong">
            <CardHeader>
              <CardTitle>Week Summary</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-xs md:grid-cols-7">
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Week</div>
                <div className="text-base font-semibold">{weekData?.week.id ?? selectedWeekId ?? "-"}</div>
                <div className="mt-1 text-[color:var(--arena-muted)]">{formatWeekMonday(weekData?.week.startAtUtc)}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Status</div>
                <div className="mt-1">
                  <Badge variant={weekData?.week.status === "ACTIVE" ? "cool" : "default"}>
                    {weekData?.week.status ?? "-"}
                  </Badge>
                </div>
                <div className="mt-1 text-[color:var(--arena-muted)]">
                  {weekData?.summary.isLive ? "Live refresh: 10m" : "Finalized"}
                </div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Total Committed</div>
                <div className="text-base font-semibold">{formatAmount(weekData?.summary.totalCommittedWei)}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Loser Loss (Risk Pool)</div>
                <div className="text-base font-semibold text-[color:var(--arena-danger)]">
                  {formatAmount(weekData?.summary.lossesWei)}
                </div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Protocol Fee</div>
                <div className="text-base font-semibold">{formatAmount(weekData?.summary.feeWei)}</div>
                <div className="mt-1 text-[color:var(--arena-muted)]">
                  {weekData?.summary.feeBps ?? 0} bps
                </div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Claimed / Remaining</div>
                <div className="text-sm font-semibold">
                  {formatAmount(weekData?.summary.claimedWei)} / {formatAmount(weekData?.summary.remainingWei)}
                </div>
                <div className="mt-1 text-[color:var(--arena-muted)]">As of: {formatDate(weekData?.summary.asOf)}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Expired Unclaimed Reward</div>
                <div className="text-base font-semibold text-[color:var(--arena-gold)]">
                  {formatAmount(weekData?.summary.expiredRewardWei)}
                </div>
                <div className="mt-1 text-[color:var(--arena-muted)]">
                  Strategists: {weekData?.summary.expiredRewardPlayers ?? 0}
                </div>
                <button
                  type="button"
                  onClick={() => void sweepExpiredRewards()}
                  disabled={
                    sweepingExpired ||
                    !weekData?.summary.rewardSweepWindowOpen ||
                    (weekData?.summary.expiredRewardPlayers ?? 0) === 0
                  }
                  className="mt-2 inline-flex h-8 items-center justify-center rounded-lg border border-[color:var(--arena-accent)] px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--arena-accent)] transition hover:bg-[color:var(--arena-accent-soft)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {sweepingExpired ? "Transferring..." : "Transfer Expired Reward"}
                </button>
                <div className="mt-1 text-[10px] text-[color:var(--arena-muted)]">
                  Window:{" "}
                  {weekData?.summary.rewardSweepWindowOpen
                    ? "open"
                    : `opens ${formatDate(weekData?.summary.rewardSweepAvailableAtUtc)}`}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Card className="arena-panel-strong">
              <CardHeader className="space-y-3">
                <CardTitle>Week Strategists</CardTitle>
                <div className="grid gap-2 md:grid-cols-[1fr_180px]">
                  <Input
                    placeholder="Filter by wallet"
                    value={weekSearch}
                    onChange={(event) => setWeekSearch(event.target.value)}
                  />
                  <select
                    value={weekClaimFilter}
                    onChange={(event) => setWeekClaimFilter(event.target.value as typeof weekClaimFilter)}
                    className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-3 text-sm"
                  >
                    <option value="all">All claim states</option>
                    <option value="claimed">Claimed</option>
                    <option value="unclaimed">Unclaimed</option>
                    <option value="unknown">Unknown</option>
                    <option value="n/a">N/A</option>
                  </select>
                </div>
              </CardHeader>
              <CardContent>
                {loadingWeek ? (
                  <div className="rounded-xl border border-[color:var(--arena-stroke)] px-4 py-6 text-sm text-[color:var(--arena-muted)]">
                    Loading week finance...
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="cursor-pointer" onClick={() => setWeekSortKey("address")}>Strategist</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setWeekSortKey("depositWei")}>Deposit</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setWeekSortKey("riskWei")}>Risk</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setWeekSortKey("score")}>Score</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setWeekSortKey("totalWithdrawWei")}>Withdraw</TableHead>
                        <TableHead className="cursor-pointer" onClick={() => setWeekSortKey("claimState")}>Claim</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {weekPlayers.map((player) => {
                        const selected = player.address === selectedWeekPlayer;
                        return (
                          <TableRow
                            key={player.address}
                            onClick={() => setSelectedWeekPlayer(player.address)}
                            className={`cursor-pointer ${selected ? "bg-[color:var(--arena-panel)]" : ""}`}
                          >
                            <TableCell className="font-medium">{shortAddress(player.address)}</TableCell>
                            <TableCell className="text-right">{formatAmount(player.depositWei)}</TableCell>
                            <TableCell className="text-right">{formatAmount(player.riskWei)}</TableCell>
                            <TableCell className={`text-right font-semibold ${scoreClass(player.score)}`}>
                              {player.score >= 0 ? "+" : ""}
                              {player.score.toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">{formatAmount(player.totalWithdrawWei)}</TableCell>
                            <TableCell>
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${claimBadgeClass(player.claimState)}`}>
                                {player.claimState}
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card className="arena-panel-strong">
              <CardHeader>
                <CardTitle>Strategist Detail</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                {!selectedWeekPlayerData ? (
                  <div className="text-[color:var(--arena-muted)]">Select a strategist row.</div>
                ) : (
                  <>
                    <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                      <div className="text-xs text-[color:var(--arena-muted)]">Wallet</div>
                      <div className="break-all font-semibold">{selectedWeekPlayerData.address}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-xl border border-[color:var(--arena-stroke)] p-2">
                        <div className="text-[color:var(--arena-muted)]">Principal</div>
                        <div className="font-semibold">{formatAmount(selectedWeekPlayerData.principalWei)}</div>
                      </div>
                      <div className="rounded-xl border border-[color:var(--arena-stroke)] p-2">
                        <div className="text-[color:var(--arena-muted)]">Reward</div>
                        <div className="font-semibold">{formatAmount(selectedWeekPlayerData.rewardWei)}</div>
                      </div>
                      <div className="rounded-xl border border-[color:var(--arena-stroke)] p-2">
                        <div className="text-[color:var(--arena-muted)]">Raw Perf</div>
                        <div className="font-semibold">{selectedWeekPlayerData.rawPerformance.toFixed(4)}</div>
                      </div>
                      <div className="rounded-xl border border-[color:var(--arena-stroke)] p-2">
                        <div className="text-[color:var(--arena-muted)]">Multiplier</div>
                        <div className="font-semibold">x{selectedWeekPlayerData.multiplier.toFixed(2)}</div>
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Strategy Coins</div>
                      <div className="flex flex-wrap gap-2">
                        {selectedWeekPlayerData.coins.map((coin) => (
                          <span
                            key={`${coin.slotId}-${coin.coinId}`}
                            className="rounded-full border border-[color:var(--arena-stroke)] px-2 py-1 text-xs"
                          >
                            {coin.symbol}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Swaps</div>
                      {selectedWeekPlayerData.swapLog.length === 0 ? (
                        <div className="text-xs text-[color:var(--arena-muted)]">No swaps.</div>
                      ) : (
                        <div className="grid gap-2">
                          {selectedWeekPlayerData.swapLog.map((swap) => (
                            <div
                              key={swap.txHash}
                              className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2 text-xs"
                            >
                              <div className="font-semibold">
                                {swap.removedSymbol} ? {swap.addedSymbol}
                              </div>
                              <div className="text-[color:var(--arena-muted)]">{formatDate(swap.createdAt)}</div>
                              <div className="truncate text-[color:var(--arena-muted)]">{swap.txHash}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="all_time" className="grid gap-4">
          <Card className="arena-panel-strong">
            <CardHeader>
              <CardTitle>All-Time Summary</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-xs md:grid-cols-6">
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Strategists</div>
                <div className="text-lg font-semibold">{allTimeData?.summary.players ?? 0}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Weeks</div>
                <div className="text-lg font-semibold">{allTimeData?.summary.weeks ?? 0}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Total Committed</div>
                <div className="text-base font-semibold">{formatAmount(allTimeData?.summary.totalCommittedWei)}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Total Fee</div>
                <div className="text-base font-semibold">{formatAmount(allTimeData?.summary.totalFeeWei)}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Claimed</div>
                <div className="text-base font-semibold">{formatAmount(allTimeData?.summary.totalClaimedWei)}</div>
              </div>
              <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                <div className="text-[color:var(--arena-muted)]">Remaining</div>
                <div className="text-base font-semibold">{formatAmount(allTimeData?.summary.totalRemainingWei)}</div>
                <div className="mt-1 text-[color:var(--arena-muted)]">As of: {formatDate(allTimeData?.summary.asOf)}</div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Card className="arena-panel-strong">
              <CardHeader className="space-y-3">
                <CardTitle>Strategists</CardTitle>
                <Input
                  placeholder="Filter by wallet"
                  value={allSearch}
                  onChange={(event) => setAllSearch(event.target.value)}
                />
              </CardHeader>
              <CardContent>
                {loadingAllTime ? (
                  <div className="rounded-xl border border-[color:var(--arena-stroke)] px-4 py-6 text-sm text-[color:var(--arena-muted)]">
                    Loading all-time finance...
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="cursor-pointer" onClick={() => setAllSortKey("address")}>Strategist</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setAllSortKey("weeksPlayed")}>Weeks</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setAllSortKey("wins")}>Wins</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setAllSortKey("losses")}>Losses</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setAllSortKey("totalClaimedWei")}>Claimed</TableHead>
                        <TableHead className="cursor-pointer text-right" onClick={() => setAllSortKey("totalRemainingWei")}>Remaining</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allTimePlayers.map((player) => {
                        const selected = player.address === selectedAllTimePlayer;
                        return (
                          <TableRow
                            key={player.address}
                            onClick={() => setSelectedAllTimePlayer(player.address)}
                            className={`cursor-pointer ${selected ? "bg-[color:var(--arena-panel)]" : ""}`}
                          >
                            <TableCell className="font-medium">{shortAddress(player.address)}</TableCell>
                            <TableCell className="text-right">{player.weeksPlayed}</TableCell>
                            <TableCell className="text-right text-[color:var(--arena-success)]">{player.wins}</TableCell>
                            <TableCell className="text-right text-[color:var(--arena-danger)]">{player.losses}</TableCell>
                            <TableCell className="text-right">{formatAmount(player.totalClaimedWei)}</TableCell>
                            <TableCell className="text-right">{formatAmount(player.totalRemainingWei)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card className="arena-panel-strong">
              <CardHeader>
                <CardTitle>Strategist Weeks</CardTitle>
              </CardHeader>
              <CardContent>
                {!selectedAllTimePlayerData ? (
                  <div className="text-sm text-[color:var(--arena-muted)]">Select a strategist row.</div>
                ) : (
                  <div className="grid gap-3">
                    <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
                      <div className="text-xs text-[color:var(--arena-muted)]">Wallet</div>
                      <div className="break-all font-semibold">{selectedAllTimePlayerData.address}</div>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Week</TableHead>
                          <TableHead className="text-right">Deposit</TableHead>
                          <TableHead className="text-right">Won</TableHead>
                          <TableHead className="text-right">Lost</TableHead>
                          <TableHead>Claim</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedAllTimePlayerData.weeks.map((week) => (
                          <TableRow key={`${selectedAllTimePlayerData.address}-${week.weekId}`}>
                            <TableCell>{formatWeekMonday(week.weekStartAtUtc)}</TableCell>
                            <TableCell className="text-right">{formatAmount(week.depositWei)}</TableCell>
                            <TableCell className="text-right text-[color:var(--arena-success)]">{formatAmount(week.wonWei)}</TableCell>
                            <TableCell className="text-right text-[color:var(--arena-danger)]">{formatAmount(week.lostWei)}</TableCell>
                            <TableCell>
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${claimBadgeClass(week.claimState)}`}>
                                {week.claimState}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
