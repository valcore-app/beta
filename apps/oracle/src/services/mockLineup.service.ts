// @ts-nocheck
import { ethers } from "ethers";
import { getCoins, getLatestMockLineupSnapshotAt, getMockLineupSnapshotAggregate, getMockLineups, getWeekCoins, getWeeks, insertMockScoreAggregate, replaceMockLineups, } from "../store.js";
import { getWeeklyCoinPrices } from "./weekPricing.service.js";
import { getLivePrices } from "./priceOracle.service.js";
import { calculateLineupWeekScoreForModel, computeBenchmarkPnlPercent, getWeekScoreModel, isWeekScoreModelKey, WEEK_SCORE_CANDIDATE_KEYS, WEEK_SCORE_MODEL_ORDER, } from "./weekScore.service.js";
const formations = [
    {
        id: "4-4-2",
        roles: { core: 1, stabilizer: 4, amplifier: 4, wildcard: 2 },
    },
    {
        id: "4-3-3",
        roles: { core: 1, stabilizer: 4, amplifier: 3, wildcard: 3 },
    },
    {
        id: "3-4-3",
        roles: { core: 1, stabilizer: 3, amplifier: 4, wildcard: 3 },
    },
];
const roleOrder = ["core", "stabilizer", "amplifier", "wildcard"];
const roleToPosition = {
    core: "GK",
    stabilizer: "DEF",
    amplifier: "MID",
    wildcard: "FWD",
};
const roleFromSlotId = (slotId) => {
    const prefix = slotId.split("-")[0]?.toLowerCase();
    if (prefix === "core")
        return "core";
    if (prefix === "stabilizer")
        return "stabilizer";
    if (prefix === "amplifier")
        return "amplifier";
    if (prefix === "wildcard")
        return "wildcard";
    return null;
};
const createEmptyPreview = () => ({
    core: [],
    stabilizer: [],
    amplifier: [],
    wildcard: [],
});
const buildLineupPreview = (slots, coinById) => {
    const preview = createEmptyPreview();
    for (const slot of slots) {
        const role = roleFromSlotId(slot.slotId);
        if (!role)
            continue;
        const coin = coinById.get(slot.coinId);
        const symbol = coin?.symbol?.toUpperCase();
        if (!symbol)
            continue;
        preview[role].push(symbol);
    }
    return preview;
};
const shuffle = (items, random) => {
    const list = [...items];
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
    }
    return list;
};
const createDeterministicRandom = (seed) => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return () => {
        h += 0x6d2b79f5;
        let t = Math.imul(h ^ (h >>> 15), 1 | h);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};
const computeLineupHash = (weekId, address, slots) => {
    const payload = {
        weekId,
        address: address.toLowerCase(),
        slots,
    };
    return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(payload)));
};
const buildSlotsFromFormation = (selectedCoinIds) => {
    const slots = [];
    for (const role of roleOrder) {
        const coinIds = selectedCoinIds[role] ?? [];
        for (let i = 0; i < coinIds.length; i += 1) {
            slots.push({ slotId: `${role}-${i + 1}`, coinId: coinIds[i] });
        }
    }
    return slots;
};
const pickCoinsForLineup = (formation, pools, random) => {
    const selectedCoinIds = new Set();
    const selectedByRole = {
        core: [],
        stabilizer: [],
        amplifier: [],
        wildcard: [],
    };
    let totalSalary = 0;
    for (const role of roleOrder) {
        const position = roleToPosition[role];
        const needCount = formation.roles[role];
        const pool = shuffle(pools[position], random).filter((item) => !selectedCoinIds.has(item.coinId));
        if (pool.length < needCount) {
            return null;
        }
        const picked = pool.slice(0, needCount);
        for (const item of picked) {
            selectedCoinIds.add(item.coinId);
            selectedByRole[role].push(item.coinId);
            totalSalary += item.salary;
        }
    }
    return {
        slots: buildSlotsFromFormation(selectedByRole),
        totalSalary,
    };
};
const pickValidLineup = (lineupIndex, weekId, pools) => {
    const random = createDeterministicRandom(`mock:${weekId}:${lineupIndex}`);
    const formationsByFeasibility = formations.filter((formation) => roleOrder.every((role) => pools[roleToPosition[role]].length >= formation.roles[role]));
    if (!formationsByFeasibility.length) {
        throw new Error("Not enough week coins to generate mock lineup.");
    }
    let bestFallback = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
        const formation = formationsByFeasibility[Math.floor(random() * formationsByFeasibility.length)] ??
            formationsByFeasibility[0];
        const picked = pickCoinsForLineup(formation, pools, random);
        if (!picked)
            continue;
        if (!bestFallback || Math.abs(100000 - picked.totalSalary) < Math.abs(100000 - bestFallback.totalSalary)) {
            bestFallback = { formation, ...picked };
        }
        if (picked.totalSalary <= 100000) {
            return { formation, ...picked };
        }
    }
    if (bestFallback)
        return bestFallback;
    throw new Error("Failed to generate mock lineup within salary cap.");
};
export const generateMockLineups = async (weekId, count = 10) => {
    const safeCount = Math.max(1, Math.min(Math.floor(count), 100));
    const weekCoins = await getWeekCoins(weekId);
    const coins = await getCoins();
    const coinById = new Map(coins.map((coin) => [coin.id, coin]));
    const pools = {
        GK: [],
        DEF: [],
        MID: [],
        FWD: [],
    };
    for (const row of weekCoins) {
        const coin = coinById.get(row.coin_id);
        if (!coin)
            continue;
        const position = (row.position ?? "").toUpperCase();
        if (!(position in pools))
            continue;
        pools[position].push({
            coinId: row.coin_id,
            salary: Number(row.salary),
            rank: Number(row.rank),
        });
    }
    for (const position of Object.keys(pools)) {
        pools[position].sort((a, b) => a.rank - b.rank);
    }
    const rows = [];
    for (let i = 0; i < safeCount; i += 1) {
        const idx = i + 1;
        const picked = pickValidLineup(idx, weekId, pools);
        const pk = ethers.keccak256(ethers.toUtf8Bytes(`valcore-mock:${weekId}:${idx}`));
        const wallet = new ethers.Wallet(pk);
        const address = wallet.address.toLowerCase();
        const label = `MOCK-${String(idx).padStart(2, "0")}`;
        const lineupHash = computeLineupHash(weekId, address, picked.slots);
        rows.push({
            week_id: weekId,
            label,
            address,
            formation_id: picked.formation.id,
            total_salary: picked.totalSalary,
            lineup_hash: lineupHash,
            slots_json: JSON.stringify(picked.slots),
        });
    }
    await replaceMockLineups(weekId, rows);
    return rows;
};
export const getMockLineupLiveScores = async (weekId, modelKey = "model_a") => {
    const mockLineups = await getMockLineups(weekId);
    if (!mockLineups.length)
        return [];
    const weekCoins = await getWeekCoins(weekId);
    const coins = await getCoins();
    const coinById = new Map(coins.map((coin) => [coin.id, coin]));
    const weekCoinById = new Map(weekCoins.map((row) => [row.coin_id, row]));
    const weeklyPrices = await getWeeklyCoinPrices(weekId);
    const startPriceBySymbol = new Map(weeklyPrices
        .filter((row) => row.start_price !== null)
        .map((row) => [row.symbol.toUpperCase(), Number(row.start_price)]));
    const universeSymbols = weekCoins
        .map((weekCoin) => coinById.get(weekCoin.coin_id)?.symbol?.toUpperCase() ?? "")
        .filter(Boolean);
    const livePricesRaw = await getLivePrices(universeSymbols);
    const markPriceBySymbol = new Map(Object.entries(livePricesRaw)
        .map(([symbol, value]) => [symbol.toUpperCase(), Number(value)])
        .filter(([, value]) => Number.isFinite(value) && value > 0));
    const benchmarkPnlPercent = computeBenchmarkPnlPercent(universeSymbols, startPriceBySymbol, markPriceBySymbol);
    const rows = [];
    for (const lineup of mockLineups) {
        let slotsRaw;
        try {
            slotsRaw = JSON.parse(lineup.slots_json);
        }
        catch {
            continue;
        }
        if (!Array.isArray(slotsRaw))
            continue;
        const slots = slotsRaw
            .map((slot) => {
            const slotId = typeof slot?.slotId === "string" ? slot.slotId : "";
            const coinId = typeof slot?.coinId === "string" ? slot.coinId : "";
            return { slotId, coinId };
        })
            .filter((slot) => slot.slotId && slot.coinId);
        const score = calculateLineupWeekScoreForModel({
            slots,
            lineupPositions: [],
            coinById,
            weekCoinById,
            startPriceBySymbol,
            markPriceBySymbol,
            benchmarkPnlPercent,
            modelKey,
        });
        rows.push({
            label: lineup.label,
            address: lineup.address,
            formationId: lineup.formation_id,
            totalSalary: Number(lineup.total_salary),
            rawPerformance: score.rawPerformance,
            efficiencyMultiplier: score.efficiencyMultiplier,
            finalScore: score.finalScore,
            lineupPnlPercent: score.lineupPnlPercent,
            lineupAlphaPercent: score.lineupAlphaPercent,
            benchmarkPnlPercent: score.benchmarkPnlPercent,
            positions: score.positions,
            lineupPreview: buildLineupPreview(slots, coinById),
        });
    }
    rows.sort((a, b) => b.finalScore - a.finalScore);
    return rows;
};
export const mockScoreWindowOptions = [
    "5m",
    "15m",
    "30m",
    "1h",
    "4h",
    "12h",
    "24h",
    "3d",
    "1w",
];
const mockScoreWindowMs = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
};
const parseIsoDate = (value) => {
    if (!value)
        return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
        return null;
    return parsed;
};
const snapshotModelKeys = WEEK_SCORE_MODEL_ORDER;
const DEFAULT_AUTO_MOCK_LINEUP_COUNT = 100;

const LEGACY_MODEL_B_ALIAS = "model_s5";

const normalizeModelKey = (value) => {
    if (value === "model_b") return LEGACY_MODEL_B_ALIAS;
    if (isWeekScoreModelKey(value)) return value;
    return "model_a";
};

const resolveAnalyticsRange = (params) => {
    const now = new Date();
    let mode = "window";
    let window = params.window ?? "1h";
    let rangeStart;
    let rangeEnd;
    if (params.startAt || params.endAt) {
        mode = "custom";
        window = null;
        const start = parseIsoDate(params.startAt);
        const end = parseIsoDate(params.endAt);
        if (!start || !end) {
            throw new Error("Both startAt and endAt must be valid ISO dates");
        }
        if (start.getTime() > end.getTime()) {
            throw new Error("startAt cannot be after endAt");
        }
        rangeStart = start;
        rangeEnd = end;
    }
    else {
        const selectedWindow = params.window ?? "1h";
        rangeEnd = now;
        rangeStart = new Date(rangeEnd.getTime() - mockScoreWindowMs[selectedWindow]);
        window = selectedWindow;
    }
    return {
        mode,
        window,
        rangeStart,
        rangeEnd,
    };
};

const captureMockScoreForModel = async (weekId, modelKey, capturedAtIso) => {
    const scores = await getMockLineupLiveScores(weekId, modelKey);
    if (!scores.length) {
        return {
            modelKey,
            count: 0,
            wins: 0,
            losses: 0,
            neutral: 0,
        };
    }
    const wins = scores.filter((row) => row.finalScore > 0).length;
    const losses = scores.filter((row) => row.finalScore < 0).length;
    const neutral = scores.length - wins - losses;
    await insertMockScoreAggregate({
        week_id: weekId,
        model_key: modelKey,
        sample_count: scores.length,
        wins,
        losses,
        neutral,
        captured_at: capturedAtIso,
    });
    return {
        modelKey,
        count: scores.length,
        wins,
        losses,
        neutral,
    };
};

export const captureMockLineupScoreSnapshot = async (weekId, capturedAtIso = new Date().toISOString()) => {
    const captures = [];
    for (const modelKey of snapshotModelKeys) {
        const capture = await captureMockScoreForModel(weekId, modelKey, capturedAtIso);
        captures.push(capture);
    }
    const maxCount = Math.max(...captures.map((row) => row.count));
    if (maxCount <= 0) {
        return {
            captured: false,
            weekId,
            count: 0,
            capturedAt: null,
            reason: "No mock lineups to snapshot",
            models: captures,
        };
    }
    return {
        captured: true,
        weekId,
        count: maxCount,
        capturedAt: capturedAtIso,
        models: captures,
    };
};

export const captureActiveWeekMockLineupScoreSnapshot = async () => {
    const weeks = await getWeeks();
    const week = weeks[0];
    if (!week) {
        return {
            captured: false,
            weekId: null,
            count: 0,
            capturedAt: null,
            reason: "No active week",
        };
    }
    const normalizedStatus = (week.status ?? "").toUpperCase();
    if (normalizedStatus !== "WEEK_ACTIVE" && normalizedStatus !== "ACTIVE") {
        return {
            captured: false,
            weekId: week.id,
            count: 0,
            capturedAt: null,
            reason: `Week status is ${week.status}`,
        };
    }
    const existingMockLineups = await getMockLineups(week.id);
    if (!existingMockLineups.length) {
        await generateMockLineups(week.id, DEFAULT_AUTO_MOCK_LINEUP_COUNT);
    }
    return captureMockLineupScoreSnapshot(week.id);
};

export const getMockLineupSnapshotAnalytics = async (params) => {
    const modelKey = normalizeModelKey(params.modelKey);
    const weeks = await getWeeks();
    const weekId = params.weekId ?? weeks[0]?.id;
    if (!weekId)
        return null;

    const model = getWeekScoreModel(modelKey);
    const { mode, window, rangeStart, rangeEnd } = resolveAnalyticsRange(params);

    const aggregate = await getMockLineupSnapshotAggregate(
        weekId,
        modelKey,
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
    );
    const latestCaptureAt = await getLatestMockLineupSnapshotAt(weekId, modelKey);
    const signedCount = aggregate.wins + aggregate.losses;
    const averageSampleCount = aggregate.snapshot_count > 0
        ? Math.round(aggregate.sample_count_sum / aggregate.snapshot_count)
        : 0;
    const winRate = signedCount > 0 ? (aggregate.wins / signedCount) * 100 : 0;
    const lossRate = signedCount > 0 ? (aggregate.losses / signedCount) * 100 : 0;

    return {
        weekId,
        mode,
        modelKey,
        modelLabel: model.label,
        modelProfile: {
            key: model.key,
            label: model.label,
            strictnessRank: model.strictnessRank,
            alphaDeadZonePercent: model.alphaDeadZonePercent,
            multipliers: model.multipliers,
        },
        window,
        range: {
            from: rangeStart.toISOString(),
            to: rangeEnd.toISOString(),
        },
        snapshotPoints: aggregate.snapshot_count,
        sampleCount: averageSampleCount,
        wins: aggregate.wins,
        losses: aggregate.losses,
        neutral: aggregate.neutral,
        winRate,
        lossRate,
        latestCaptureAt,
    };
};

export const getMockLineupSnapshotComparison = async (params) => {
    const [modelA, modelBSource] = await Promise.all([
        getMockLineupSnapshotAnalytics({ ...params, modelKey: "model_a" }),
        getMockLineupSnapshotAnalytics({ ...params, modelKey: LEGACY_MODEL_B_ALIAS }),
    ]);

    if (!modelA || !modelBSource) {
        return null;
    }

    const modelB = {
        ...modelBSource,
        modelKey: "model_b",
        modelLabel: modelBSource.modelLabel + " (Legacy B alias)",
    };

    const latestCaptureAt = [modelA.latestCaptureAt, modelB.latestCaptureAt]
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;

    return {
        weekId: modelA.weekId,
        mode: modelA.mode,
        window: modelA.window,
        range: modelA.range,
        latestCaptureAt,
        models: {
            model_a: modelA,
            model_b: modelB,
        },
        delta: {
            winRateBminusA: modelB.winRate - modelA.winRate,
            lossRateBminusA: modelB.lossRate - modelA.lossRate,
            winsBminusA: modelB.wins - modelA.wins,
            lossesBminusA: modelB.losses - modelA.losses,
            neutralBminusA: modelB.neutral - modelA.neutral,
            snapshotPointsBminusA: modelB.snapshotPoints - modelA.snapshotPoints,
            sampleCountBminusA: modelB.sampleCount - modelA.sampleCount,
        },
    };
};

export const getMockLineupSnapshotModelMatrix = async (params) => {
    const baseline = await getMockLineupSnapshotAnalytics({ ...params, modelKey: "model_a" });
    if (!baseline) {
        return null;
    }

    const candidatesRaw = await Promise.all(
        WEEK_SCORE_CANDIDATE_KEYS.map((modelKey) =>
            getMockLineupSnapshotAnalytics({ ...params, modelKey }),
        ),
    );

    const candidates = candidatesRaw
        .filter(Boolean)
        .map((row) => ({
            ...row,
            deltaFromBaseline: {
                winRateDelta: row.winRate - baseline.winRate,
                lossRateDelta: row.lossRate - baseline.lossRate,
                winsDelta: row.wins - baseline.wins,
                lossesDelta: row.losses - baseline.losses,
                neutralDelta: row.neutral - baseline.neutral,
                snapshotPointsDelta: row.snapshotPoints - baseline.snapshotPoints,
                sampleCountDelta: row.sampleCount - baseline.sampleCount,
            },
        }));

    const latestCaptureAt = [baseline.latestCaptureAt, ...candidates.map((row) => row.latestCaptureAt)]
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;

    return {
        weekId: baseline.weekId,
        mode: baseline.mode,
        window: baseline.window,
        range: baseline.range,
        latestCaptureAt,
        baseline,
        candidates,
    };
};
