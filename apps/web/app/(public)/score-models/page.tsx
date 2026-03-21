"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { apiGet } from "../../../lib/api";

type WindowKey = "5m" | "15m" | "30m" | "1h" | "4h" | "12h" | "24h" | "3d" | "1w";

type RoleMultiplier = {
  pos: number;
  neg: number;
};

type ModelProfile = {
  key: string;
  label: string;
  strictnessRank: number;
  alphaDeadZonePercent: number;
  multipliers: {
    core: RoleMultiplier;
    stabilizer: RoleMultiplier;
    amplifier: RoleMultiplier;
    wildcard: RoleMultiplier;
  };
};

type SnapshotAnalytics = {
  weekId: string;
  mode: "window" | "custom";
  modelKey: string;
  modelLabel: string;
  modelProfile: ModelProfile;
  window: WindowKey | null;
  range: {
    from: string;
    to: string;
  };
  snapshotPoints: number;
  sampleCount: number;
  wins: number;
  losses: number;
  neutral: number;
  winRate: number;
  lossRate: number;
  latestCaptureAt: string | null;
};

type CandidateSnapshot = SnapshotAnalytics & {
  deltaFromBaseline: {
    winRateDelta: number;
    lossRateDelta: number;
    winsDelta: number;
    lossesDelta: number;
    neutralDelta: number;
    snapshotPointsDelta: number;
    sampleCountDelta: number;
  };
};

type MatrixResponse = {
  weekId: string;
  mode: "window" | "custom";
  window: WindowKey | null;
  range: {
    from: string;
    to: string;
  };
  latestCaptureAt: string | null;
  baseline: SnapshotAnalytics;
  candidates: CandidateSnapshot[];
};

type MetaResponse = {
  weekId: string;
  count: number;
  modelKeys: string[];
  models: ModelProfile[];
};

const windowOptions: Array<{ value: WindowKey; label: string }> = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "12h", label: "12h" },
  { value: "24h", label: "1d" },
  { value: "3d", label: "3d" },
  { value: "1w", label: "1w" },
];

const formatPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const formatSigned = (value: number) => `${value >= 0 ? "+" : ""}${value}`;

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const toDateTimeLocalUtc = (date: Date) => {
  const pad = (v: number) => String(v).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

const parseDateTimeLocalUtc = (value: string): Date | null => {
  if (!value) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const parsed = new Date(`${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const buildMatrixPath = (params: {
  window?: WindowKey;
  startAt?: string;
  endAt?: string;
}) => {
  const search = new URLSearchParams();
  if (params.window) search.set("window", params.window);
  if (params.startAt) search.set("startAt", params.startAt);
  if (params.endAt) search.set("endAt", params.endAt);
  return `/score-models/snapshots/matrix?${search.toString()}`;
};

const rateClass = (value: number) => {
  if (value > 0) return "text-[color:var(--arena-success)]";
  if (value < 0) return "text-[color:var(--arena-danger)]";
  return "text-[color:var(--arena-ink)]";
};

const modelBadgeVariant = (modelKey: string) => (modelKey === "model_a" ? "default" : "cool");

const FormulaRows = ({ model }: { model: ModelProfile }) => (
  <div className="grid gap-1 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] p-3 text-[11px] text-[color:var(--arena-muted)]">
    <div className="uppercase tracking-[0.1em] text-[color:var(--arena-ink)]">Formula Params</div>
    <div>Alpha dead-zone: +{model.alphaDeadZonePercent.toFixed(2)}%</div>
    <div>
      Core +{model.multipliers.core.pos.toFixed(2)} / {model.multipliers.core.neg.toFixed(2)}
    </div>
    <div>
      Stabilizer +{model.multipliers.stabilizer.pos.toFixed(2)} / {model.multipliers.stabilizer.neg.toFixed(2)}
    </div>
    <div>
      Amplifier +{model.multipliers.amplifier.pos.toFixed(2)} / {model.multipliers.amplifier.neg.toFixed(2)}
    </div>
    <div>
      Wildcard +{model.multipliers.wildcard.pos.toFixed(2)} / {model.multipliers.wildcard.neg.toFixed(2)}
    </div>
  </div>
);

const BaselineCard = ({ stats }: { stats: SnapshotAnalytics }) => (
  <Card className="arena-panel-strong">
    <CardHeader className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="text-lg">{stats.modelLabel}</CardTitle>
        <Badge variant={modelBadgeVariant(stats.modelKey)}>{stats.modelKey.toUpperCase()}</Badge>
      </div>
      <p className="text-xs text-[color:var(--arena-muted)]">
        Snapshot points: {stats.snapshotPoints} | Avg sample: {stats.sampleCount}
      </p>
    </CardHeader>
    <CardContent className="grid gap-3">
      <FormulaRows model={stats.modelProfile} />
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Win Rate</div>
          <div className={`text-lg font-semibold ${rateClass(stats.winRate)}`}>{formatPct(stats.winRate)}</div>
        </div>
        <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Loss Rate</div>
          <div className="text-lg font-semibold text-[color:var(--arena-danger)]">{formatPct(stats.lossRate)}</div>
        </div>
      </div>
    </CardContent>
  </Card>
);

const CandidateCard = ({ stats }: { stats: CandidateSnapshot }) => {
  const proximityTo5050 = Math.abs(stats.winRate - 50);
  return (
    <Card className="arena-panel-strong">
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{stats.modelLabel}</CardTitle>
          <Badge variant={modelBadgeVariant(stats.modelKey)}>{stats.modelKey.toUpperCase()}</Badge>
        </div>
        <p className="text-xs text-[color:var(--arena-muted)]">
          Rank {stats.modelProfile.strictnessRank} | 50/50 distance: {proximityTo5050.toFixed(2)}%
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        <FormulaRows model={stats.modelProfile} />
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Win Rate</div>
            <div className={`text-base font-semibold ${rateClass(stats.winRate)}`}>{formatPct(stats.winRate)}</div>
            <div className="text-[10px] text-[color:var(--arena-muted)]">
              vs A: {formatPct(stats.deltaFromBaseline.winRateDelta)}
            </div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">Loss Rate</div>
            <div className="text-base font-semibold text-[color:var(--arena-danger)]">{formatPct(stats.lossRate)}</div>
            <div className="text-[10px] text-[color:var(--arena-muted)]">
              vs A: {formatPct(stats.deltaFromBaseline.lossRateDelta)}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
            <div className="text-[color:var(--arena-muted)]">Wins</div>
            <div className="font-semibold text-[color:var(--arena-success)]">{stats.wins}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
            <div className="text-[color:var(--arena-muted)]">Losses</div>
            <div className="font-semibold text-[color:var(--arena-danger)]">{stats.losses}</div>
          </div>
          <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.7)] px-3 py-2">
            <div className="text-[color:var(--arena-muted)]">Delta</div>
            <div className="font-semibold">
              {formatSigned(stats.deltaFromBaseline.winsDelta)} / {formatSigned(stats.deltaFromBaseline.lossesDelta)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default function ScoreModelsPage() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [windowData, setWindowData] = useState<MatrixResponse | null>(null);
  const [customData, setCustomData] = useState<MatrixResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>("24h");
  const [customStart, setCustomStart] = useState(() => {
    const end = new Date();
    return toDateTimeLocalUtc(new Date(end.getTime() - 24 * 60 * 60 * 1000));
  });
  const [customEnd, setCustomEnd] = useState(() => toDateTimeLocalUtc(new Date()));

  const refreshWindow = useCallback(async () => {
    try {
      const [nextMeta, nextMatrix] = await Promise.all([
        apiGet<MetaResponse>("/score-models/meta"),
        apiGet<MatrixResponse>(buildMatrixPath({ window: windowKey })),
      ]);
      setMeta(nextMeta);
      setWindowData(nextMatrix);
      setMessage(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to load score models";
      setMessage(text);
    }
  }, [windowKey]);

  useEffect(() => {
    void refreshWindow();
    const timer = setInterval(() => {
      void refreshWindow();
    }, 10000);
    return () => clearInterval(timer);
  }, [refreshWindow]);

  const runCustomRange = useCallback(async () => {
    if (!customStart || !customEnd) {
      setMessage("Select both start and end times.");
      return;
    }

    const start = parseDateTimeLocalUtc(customStart);
    const end = parseDateTimeLocalUtc(customEnd);
    if (!start || !end) {
      setMessage("Custom range dates are invalid.");
      return;
    }

    if (start.getTime() > end.getTime()) {
      setMessage("Start time cannot be after end time.");
      return;
    }

    try {
      const result = await apiGet<MatrixResponse>(
        buildMatrixPath({
          startAt: start.toISOString(),
          endAt: end.toISOString(),
        }),
      );
      setCustomData(result);
      setMessage(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Custom range query failed";
      setMessage(text);
    }
  }, [customEnd, customStart]);

  const activeData = customData ?? windowData;

  const candidates = useMemo(() => {
    if (!activeData?.candidates) return [];
    return [...activeData.candidates].sort(
      (a, b) => a.modelProfile.strictnessRank - b.modelProfile.strictnessRank,
    );
  }, [activeData]);

  return (
    <main className="vc-page">
      <section className="mx-auto grid w-full max-w-[1320px] gap-6">
        <section className="arena-panel rounded-[28px] p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-2">
              <span className="arena-chip">Public Analytics</span>
              <h1 className="font-display text-3xl font-semibold tracking-tight">Score Models</h1>
              <p className="text-sm text-[color:var(--arena-muted)]">
                Model A is main. S1-S10 are public candidate formulas for win/loss balancing.
              </p>
            </div>
            <Link
              href="/strategy"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-6 text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Back To Strategy Board
            </Link>
          </div>
          {message ? <p className="mt-4 text-sm text-[color:var(--arena-gold)]">{message}</p> : null}
        </section>

        <Card className="arena-panel-strong">
          <CardHeader>
            <CardTitle>Week Snapshot</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-xs md:grid-cols-4">
            <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
              <div className="text-[color:var(--arena-muted)]">Week ID</div>
              <div className="text-lg font-semibold">{meta?.weekId ?? activeData?.weekId ?? "--"}</div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
              <div className="text-[color:var(--arena-muted)]">Mock Strategies</div>
              <div className="text-lg font-semibold">{meta?.count ?? 0}</div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
              <div className="text-[color:var(--arena-muted)]">Analysis Range</div>
              <div className="text-sm font-semibold">
                {formatDate(activeData?.range.from)} - {formatDate(activeData?.range.to)}
              </div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] p-3">
              <div className="text-[color:var(--arena-muted)]">Latest Capture</div>
              <div className="text-sm font-semibold">{formatDate(activeData?.latestCaptureAt)}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="arena-panel-strong">
          <CardHeader>
            <CardTitle>Range Controls</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-xs md:grid-cols-2">
            <div className="rounded-xl border border-[color:var(--arena-stroke)] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Preset Window</div>
                <select
                  className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] px-3 text-sm"
                  value={windowKey}
                  onChange={(event) => setWindowKey(event.target.value as WindowKey)}
                >
                  {windowOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[color:var(--arena-muted)]">
                Auto-refreshes every 10 seconds using the selected rolling window.
              </p>
            </div>

            <div className="rounded-xl border border-[color:var(--arena-stroke)] p-4">
              <div className="mb-1 text-sm font-semibold">Custom Range</div>
              <div className="mb-3 text-[11px] uppercase tracking-[0.12em] text-[color:var(--arena-muted)]">
                Input timezone: UTC
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                <Input
                  type="datetime-local"
                  value={customStart}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
                <Input
                  type="datetime-local"
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
                <Button variant="outline" onClick={() => void runCustomRange()}>
                  Apply
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {activeData?.baseline ? <BaselineCard stats={activeData.baseline} /> : null}

        <section className="grid gap-4 lg:grid-cols-2">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.modelKey} stats={candidate} />
          ))}
        </section>

        <div className="flex flex-wrap gap-2">
          <Badge variant="default">Model A: live scoring reference</Badge>
          <Badge variant="cool">S1-S10: public testnet candidates</Badge>
          <Badge variant="default">Formula transparency: enabled</Badge>
        </div>
      </section>
    </main>
  );
}


