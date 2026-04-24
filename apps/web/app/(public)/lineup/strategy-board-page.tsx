"use client";

import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { encodeFunctionData, formatUnits, parseUnits, type WalletClient } from "viem";
import { apiGet } from "../../../lib/api";
import { reportClientError } from "../../../lib/error-report";
import {
  valcoreAbi,
  stablecoinAbi,
} from "../../../lib/contracts";
import { useWallet } from "../../../lib/wallet";
import { getStarknetWalletDebugState } from "../../../lib/starknet-wallet";
import { useHudContext } from "../../../components/site/hud-context";
import {
  normalizeProtocolGuideSection,
  type ProtocolGuideSectionId,
} from "../../../components/site/protocol-guide-sections";
import { buildChain } from "../../../lib/chain";
import { useRuntimeProfile } from "../../../lib/runtime-profile";
import {
  approveStarknetStablecoin,
  commitStarknetLineup,
  readStarknetPosition,
  readStarknetStablecoinAllowance,
  readStarknetStablecoinBalance,
  readStarknetTestMode,
  readStarknetWeekState,
  swapStarknetLineup,
  waitForStarknetTx,
} from "../../../lib/starknet-chain";

import type {
  Asset,
  ClaimData,
  ClaimableWeekSummary,
  DbLineupResponse,
  LadderEntry,
  LineupCache,
  RoleType,
  Slot,
  SortKey,
  WeekCoinRow,
  WeekShowcaseLineupResponse,
  WeekSummaryLite,
} from "./lineup-types";
import {
  budgetAlpha,
  budgetCap,
  budgetMinRatio,
  formations,
  ladderCount,
  ladderHysteresis,
  lineupCachePrefix,
  minDepositAmount,
  positionToRole,
  powerCap,
  principalRatioBps,
  roleBadgeMap,
  roleMeta,
  roleOrder,
  spectatorFormationId,
  totalMoves,
} from "./lineup-config";
import {
  buildLineupHash,
  buildSlots,
  createLineup,
  formatPct,
  formatPnl,
  formatPrice,
  formatSalary,
  formatScore,
  formatStableAmount,
  formatWeekStartUtc,
  parseClaimedFlag,
  parsePrincipalRisk,
  parseSwapsUsed,
} from "./lineup-utils";
import {
  applyLadderHysteresisOrder,
  type AssetMetrics,
  buildAssignedIds,
  buildHotLadderSlice,
  buildLadderBase,
  buildLadderDisplay,
  buildLadderFallbackOrder,
  buildSlotByAssetId,
  buildSlotGroups,
  calculateSpectatorWeekScore,
  computeAvailableBudget,
  computeProjectedMultiplier,
  computeUsedPower,
  countFilledSlots,
  deriveAssetMetrics,
  filterAndSortAssets,
} from "./lineup-derivations";

const EMPTY_FLASH_STATE: Record<string, boolean> = {};
const COINS_CACHE_VERSION = 1;
const COINS_CACHE_PREFIX = "valcore:week-coins";
const LIVE_PRICE_CACHE_VERSION = 1;
const LIVE_PRICE_CACHE_PREFIX = "valcore:live-prices";

const FALLBACK_RUNTIME_PROFILE = {
  networkKey: "starknet_sepolia",
  label: "Starknet",
  chainType: "starknet",
  chainId: 1,
  rpcUrl: "https://rpc.invalid",
  explorerUrl: "https://starkscan.co",
  nativeSymbol: "STRK",
  nativeTokenAddress: undefined,
  stablecoinSymbol: "Stablecoin",
  stablecoinName: "Stablecoin",
  stablecoinDecimals: 18,
  stablecoinAddress: undefined,
  leagueAddress: undefined,
} as const;

const extractErrorText = (error: unknown): string => {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error !== "object") return "";

  const seen = new Set<unknown>();
  const parts: string[] = [];

  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim();
    if (!normalized) return;
    if (!parts.includes(normalized)) parts.push(normalized);
  };

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      push(value);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    if (value instanceof Error) {
      push(value.message);
    }

    const record = value as Record<string, unknown>;
    push(record.shortMessage);
    push(record.details);
    push(record.message);
    push(record.reason);
    push(record.code);

    if (record.error) visit(record.error);
    if (record.cause) visit(record.cause);
    if (record.data) visit(record.data);
    if (Array.isArray(record.errors)) {
      for (const item of record.errors) visit(item);
    }
  };

  visit(error);

  if (parts.length > 0) {
    return parts.join(" | ");
  }

  try {
    const fallback = JSON.stringify(error);
    return fallback && fallback !== "{}" ? fallback : "";
  } catch {
    return "";
  }
};
const extractRevertSelector = (error: unknown): string => {
  if (!error || typeof error !== "object") return "";
  const candidate = error as {
    data?: unknown;
    details?: unknown;
    shortMessage?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  const values: unknown[] = [
    candidate.data,
    candidate.details,
    candidate.shortMessage,
    candidate.message,
  ];

  if (candidate.cause && typeof candidate.cause === "object") {
    const cause = candidate.cause as {
      data?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      message?: unknown;
    };
    values.push(cause.data, cause.details, cause.shortMessage, cause.message);
  }

  for (const value of values) {
    const text = typeof value === "string" ? value : "";
    if (!text) continue;
    const match = text.match(/0x[a-fA-F0-9]{8}/);
    if (match?.[0]) {
      return match[0].toLowerCase();
    }
  }

  return "";
};

const KNOWN_REVERT_SELECTOR_MESSAGES: Record<string, string> = {
  "0xc7c1f39e": "On-chain epoch is not Draft Open. Refresh and try again.",
  "0x70fe87b1": "Draft is already closed on-chain.",
  "0x0af806e0": "Strategy hash is invalid. Rebuild strategy allocation and retry.",
  "0xb2e532de": "Deposit amount is invalid.",
  "0x96ec8e54": "Deposit is below the on-chain minimum.",
  "0xc56d46d3": "Deposit exceeds on-chain limits.",
  "0x646cf558": "This strategy allocation is already claimed for the selected epoch.",
  "0xd93c0665": "Strategy commits are paused on-chain.",
  "0xe450d38c": "Stablecoin balance is not sufficient for this deposit.",
  "0xfb8f41b2": "Stablecoin allowance is not sufficient.",
};

const APPROVE_RECOVERY_MESSAGE =
  "Wallet could not complete the approval.\n" +
  "Recovery steps:\n" +
  "1) Open wallet and clear/cancel pending transactions.\n" +
  "2) Verify network and account.\n" +
  "3) Reconnect wallet.\n" +
  "4) Retry Approve.";

const STARKNET_MAIN_CHAIN_HEX = "0x534e5f4d41494e";
const STARKNET_SEPOLIA_CHAIN_HEX = "0x534e5f5345504f4c4941";

const normalizeStarknetChainHex = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === "sn_main" || lowered === "sn_mainnet") return STARKNET_MAIN_CHAIN_HEX;
  if (lowered === "sn_sepolia") return STARKNET_SEPOLIA_CHAIN_HEX;
  if (lowered.startsWith("0x")) return lowered;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return `0x${Math.trunc(parsed).toString(16)}`;
};

const expectedStarknetChainHex = (networkKey: string) => {
  const key = String(networkKey ?? "").toLowerCase();
  if (key.includes("mainnet") || key.endsWith("_main")) return STARKNET_MAIN_CHAIN_HEX;
  return STARKNET_SEPOLIA_CHAIN_HEX;
};

const STARKNET_WEEK_STATUS_LABELS: Record<number, string> = {
  0: "None",
  1: "Draft Open",
  2: "Locked",
  3: "Active",
  4: "Finalize Pending",
  5: "Finalized",
};

const describeStarknetWeekStatus = (status: number) =>
  STARKNET_WEEK_STATUS_LABELS[status] ?? `Unknown (${status})`;
const isWalletSessionApproveError = (text: string): boolean => {
  const lowered = text.toLowerCase();
  return (
    lowered.includes("unable to get transaction hash") ||
    lowered.includes("unable to calculate nonce") ||
    lowered.includes("nonce") ||
    lowered.includes("wallet client unavailable") ||
    lowered.includes("wallet provider unavailable") ||
    lowered.includes("account unavailable") ||
    lowered.includes("please complete wallet signature first") ||
    lowered.includes("unknown account")
  );
};

const mapLineupLockError = (error: unknown): string => {
  const selector = extractRevertSelector(error);
  if (selector && KNOWN_REVERT_SELECTOR_MESSAGES[selector]) {
    return KNOWN_REVERT_SELECTOR_MESSAGES[selector];
  }

  const message = extractErrorText(error);
  const lowered = message.toLowerCase();

  if (!message) return "Strategy lock failed.";
  if (lowered.includes("user rejected") || lowered.includes("user denied")) {
    return "Transaction cancelled in wallet.";
  }
  if (message.includes("DraftNotOpen")) {
    return "On-chain epoch is not in Draft Open. Refresh and try again.";
  }
  if (message.includes("DraftClosed")) {
    return "Draft is already closed on-chain.";
  }
  if (message.includes("BelowMinDeposit")) {
    return "Deposit is below the on-chain minimum.";
  }
  if (message.includes("InvalidDeposit")) {
    return "Deposit amount is invalid.";
  }
  if (message.includes("InvalidHash")) {
    return "Strategy hash is invalid. Rebuild strategy allocation and retry.";
  }
  if (lowered.includes("allowance")) {
    return "Stablecoin allowance is not sufficient.";
  }
  if (lowered.includes("insufficient funds")) {
    return "Insufficient gas or stablecoin balance.";
  }

  return message.length <= 180 ? message : "Strategy lock failed.";
};
const mapApproveError = (error: unknown): string => {
  const selector = extractRevertSelector(error);
  if (selector && KNOWN_REVERT_SELECTOR_MESSAGES[selector]) {
    return KNOWN_REVERT_SELECTOR_MESSAGES[selector];
  }

  const message = extractErrorText(error);
  const lowered = message.toLowerCase();

  if (!message) return "Approval failed. Reconnect wallet and retry.";
  if (lowered.includes("user rejected") || lowered.includes("user denied")) {
    return "Transaction cancelled in wallet.";
  }
  if (isWalletSessionApproveError(message)) {
    return APPROVE_RECOVERY_MESSAGE;
  }
  if (lowered.includes("unable to calculate gas limit")) {
    return "Approval simulation failed in wallet. Verify network and token settings, then retry.";
  }
  if (lowered.includes("insufficient funds")) {
    return "Insufficient gas for approval transaction.";
  }
  if (lowered.includes("chain") && lowered.includes("mismatch")) {
    return "Wallet network mismatch. Switch network and retry.";
  }
  if (lowered.includes("allowance") || message.includes("ERC20InsufficientAllowance")) {
    return "Stablecoin allowance update failed. Retry approve.";
  }
  if (lowered.includes("execution reverted")) {
    return "Approval reverted on-chain. Verify token balance and retry.";
  }

  const trimmed = message.length > 140 ? `${message.slice(0, 140)}...` : message;
  return trimmed
    ? `Approval failed: ${trimmed}`
    : "Approval failed in wallet. Retry, or reconnect wallet if the issue continues.";
};

const mapSwapError = (error: unknown): string => {
  const message = extractErrorText(error);
  const lowered = message.toLowerCase();

  if (!message) return "Swap failed.";
  if (lowered.includes("user rejected") || lowered.includes("user denied")) {
    return "Transaction cancelled in wallet.";
  }
  if (lowered.includes("wallet signer") || lowered.includes("wallet account is unavailable")) {
    return "Wallet signer unavailable. Reconnect wallet and retry.";
  }
  if (lowered.includes("switch to") || lowered.includes("wrong chain") || lowered.includes("chain mismatch")) {
    return "Wallet network mismatch. Switch network and retry.";
  }
  if (lowered.includes("no tactical moves") || lowered.includes("tactical move")) {
    return "No Tactical Moves remaining this epoch.";
  }

  return message.length <= 180 ? message : "Swap failed.";
};

const isReceiptWaitTimeoutError = (error: unknown): boolean => {
  const lowered = extractErrorText(error).toLowerCase();
  return (
    lowered.includes("waitfortransaction timed-out") ||
    lowered.includes("timed-out with retries") ||
    lowered.includes("transaction receipt is still unavailable") ||
    lowered.includes("receipt is still unavailable")
  );
};
const ProtocolGuideModal = dynamic(
  () => import("../../../components/site/protocol-guide-modal").then((mod) => mod.ProtocolGuideModal),
  {
    ssr: false,
  },
);

type DbLineupFetchState = "idle" | "found" | "not_found" | "error";

type ReactiveFlowEvent = {
  id: string;
  operation: string;
  status: string;
  sepoliaTxHash: string | null;
  sepoliaTxUrl: string | null;
  reactiveTxHash: string | null;
  reactiveTxUrl: string | null;
  updatedAt: string;
};

type ReactiveFlowResponse = {
  weekId: string;
  events: ReactiveFlowEvent[];
};

const shortenReactiveHash = (hash: string) => {
  if (!hash || hash.length < 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
};

type AssetPoolRowProps = {
  asset: Asset;
  metrics: AssetMetrics;
  isWeekActive: boolean;
  isDraftPassive: boolean;
  rowDisabled: boolean;
  onAssign: (asset: Asset) => void;
};

const AssetPoolRow = memo(function AssetPoolRow({
  asset,
  metrics,
  isWeekActive,
  isDraftPassive,
  rowDisabled,
  onAssign,
}: AssetPoolRowProps) {
  return (
    <button
      type="button"
      className={`recruit-row ${isWeekActive ? "week-active" : ""} ${
        isDraftPassive ? "passive" : ""
      }`}
      onClick={() => {
        if (isDraftPassive) return;
        onAssign(asset);
      }}
      disabled={rowDisabled}
    >
      <div className="recruit-asset">
        <div className="recruit-identity">
          <img
            src={asset.imagePath || "/coins/default.png"}
            alt={asset.symbol}
            className="recruit-logo"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
          <div className="recruit-text">
            <div className="recruit-name">{asset.name}</div>
            <div className="recruit-symbol">{asset.symbol}</div>
          </div>
        </div>
      </div>
      <div className="recruit-power">{asset.power}</div>
      <div className={`recruit-price ${metrics.flash ? "price-flash" : ""}`}>
        <span className={`price-dot ${metrics.priceDirection}`} />
        <span className="unit-live-price">${formatPrice(metrics.currentPrice)}</span>
      </div>
      {isWeekActive ? (
        <div
          className={`recruit-week-change ${
            metrics.pnl > 0 ? "up" : metrics.pnl < 0 ? "down" : "flat"
          }`}
        >
          {formatPnl(metrics.pnl)}
        </div>
      ) : null}
      <div className="recruit-salary">{formatSalary(asset.salary)}</div>
      <div className="recruit-risk">
        <span className={`risk-badge risk-${asset.risk.toLowerCase()}`}>{asset.risk}</span>
      </div>
      <div className="recruit-momentum">
        <span className={`momentum-badge ${metrics.momentumLive ?? metrics.momentum}`}>
          {(metrics.momentumLive ?? metrics.momentum).toUpperCase()}
        </span>
      </div>
    </button>
  );
}, (prev, next) => {
  return (
    prev.onAssign === next.onAssign &&
    prev.asset === next.asset &&
    prev.isWeekActive === next.isWeekActive &&
    prev.isDraftPassive === next.isDraftPassive &&
    prev.rowDisabled === next.rowDisabled &&
    prev.metrics.currentPrice === next.metrics.currentPrice &&
    prev.metrics.pnl === next.metrics.pnl &&
    prev.metrics.flash === next.metrics.flash &&
    prev.metrics.priceDirection === next.metrics.priceDirection &&
    prev.metrics.momentum === next.metrics.momentum &&
    prev.metrics.momentumLive === next.metrics.momentumLive
  );
});

export default function LineupPage() {
  const { profile: runtimeProfile } = useRuntimeProfile();
  const runtimeProfileReady = Boolean(runtimeProfile);
  const activeProfile = runtimeProfile ?? FALLBACK_RUNTIME_PROFILE;
  const router = useRouter();
  const {
    address: walletAddress,
    status: walletStatus,
    connect,
    ensureChain,
    refreshWalletSession,
    getWalletClient,
    getStarknetWallet,
    publicClient,
  } = useWallet();
  const { week, setMoves, swapMode, setSwapMode } = useHudContext();
  const weekId = week?.id ?? null;
  const weekStatus = week?.status ?? null;
  const valcoreAddress = activeProfile.leagueAddress;
  const stablecoinAddress = activeProfile.stablecoinAddress;
  const activeChain = useMemo(
    () =>
      buildChain({
        chainId: activeProfile.chainId,
        label: activeProfile.label,
        networkKey: activeProfile.networkKey,
        rpcUrl: activeProfile.rpcUrl,
        explorerUrl: activeProfile.explorerUrl,
        nativeSymbol: activeProfile.nativeSymbol,
      }),
    [
      activeProfile.chainId,
      activeProfile.label,
      activeProfile.networkKey,
      activeProfile.rpcUrl,
      activeProfile.explorerUrl,
      activeProfile.nativeSymbol,
    ],
  );
  const stablecoinSymbol = activeProfile.stablecoinSymbol || "Stablecoin";
  const stablecoinDecimals = activeProfile.stablecoinDecimals || 18;
  const chainLabel = activeProfile.label || "active network";
  const isStarknet = activeProfile.chainType.toLowerCase() === "starknet";
  const [formationId, setFormationId] = useState(formations[0].id);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [commitOpen, setCommitOpen] = useState(false);
  const [reactivePanelOpen, setReactivePanelOpen] = useState(true);
  const [reactiveFlowLoading, setReactiveFlowLoading] = useState(false);
  const [reactiveFlowEvents, setReactiveFlowEvents] = useState<ReactiveFlowEvent[]>([]);
  const [onchainDeposit, setOnchainDeposit] = useState<bigint | null>(null);
  const [onchainPositionResolved, setOnchainPositionResolved] = useState(false);
  const [allocation, setAllocation] = useState(0);
  const [allocationInput, setAllocationInput] = useState("0");
  const [lineup, setLineup] = useState<Record<string, Asset | null>>({});
  const [coins, setCoins] = useState<Asset[]>([]);
  const [coinsLoading, setCoinsLoading] = useState(true);
  const [coinsSyncing, setCoinsSyncing] = useState(false);
  const [coinsError, setCoinsError] = useState<string | null>(null);
  const coinsRef = useRef<Asset[]>([]);
  const [dbLineupIds, setDbLineupIds] = useState<Record<string, string | null> | null>(
    null,
  );
  const [showcaseLineupIds, setShowcaseLineupIds] = useState<Record<string, string | null> | null>(
    null,
  );
  const [dbLineupChecked, setDbLineupChecked] = useState(false);
  const [dbLineupFetchState, setDbLineupFetchState] = useState<DbLineupFetchState>("idle");
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [livePricesLoaded, setLivePricesLoaded] = useState(false);
  const [, startPriceTransition] = useTransition();
  const [, startUiTransition] = useTransition();
  const [toast, setToast] = useState<{
    message: string;
    tone?: "warn" | "info";
    href?: string;
  } | null>(null);
  const [toastHover, setToastHover] = useState(false);
  const showToast = useCallback((message: string, tone: "warn" | "info" = "info", href?: string) => {
    setToast({ message, tone, href });
  }, []);
  const [pendingAction, setPendingAction] = useState<
    | {
        type: "swap" | "remove";
        slotId: string;
        previous?: Asset;
        next?: Asset;
      }
    | null
  >(null);
  const [txPending, setTxPending] = useState(false);
  const [swapCount, setSwapCount] = useState(0);
  const [stablecoinBalance, setStablecoinBalance] = useState<bigint | null>(null);
  const [stablecoinAllowance, setStablecoinAllowance] = useState<bigint | null>(null);
  const [stablecoinLoading, setStablecoinLoading] = useState(false);
  const [priceFlash, setPriceFlash] = useState<Record<string, boolean>>({});
  const [ladderPulse, setLadderPulse] = useState<Record<string, boolean>>({});
  const [slotHotPulse, setSlotHotPulse] = useState<Record<string, "gain" | "loss">>({});
  const slotHotTimers = useRef<Record<string, number>>({});
  const hotGainerRanksRef = useRef<Record<string, number>>({});
  const hotLoserRanksRef = useRef<Record<string, number>>({});
  const [ladderGainerOrder, setLadderGainerOrder] = useState<string[]>([]);
  const [ladderLoserOrder, setLadderLoserOrder] = useState<string[]>([]);
  const [ladderFocusId, setLadderFocusId] = useState<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<LadderEntry | null>(null);
  const [targetingPulseRole, setTargetingPulseRole] = useState<RoleType | null>(null);
  const [executedRole, setExecutedRole] = useState<RoleType | null>(null);
  const [deployedCandidateId, setDeployedCandidateId] = useState<string | null>(null);
  const ladderPanelRef = useRef<HTMLDivElement | null>(null);
  const [hoverSwapSlotId, setHoverSwapSlotId] = useState<string | null>(null);
  const [swapConfirmSlotId, setSwapConfirmSlotId] = useState<string | null>(null);
  const lastPctSignRef = useRef<Record<string, number>>({});
  const [liveScore, setLiveScore] = useState(0);
  const lastPriceRef = useRef<Record<string, number>>({});
  const slotEffectTimers = useRef<Record<string, number>>({});
  const [slotEffects, setSlotEffects] = useState<Record<string, string>>({});
  const cacheAppliedRef = useRef(false);
  const lineupContextKeyRef = useRef<string>("");
  const [cacheReady, setCacheReady] = useState(false);
  const [protectionOpen, setProtectionOpen] = useState(false);
  const [multiplierOpen, setMultiplierOpen] = useState(false);
  const [ProtocolGuideOpen, setProtocolGuideOpen] = useState(false);
  const [ProtocolGuideSection, setProtocolGuideSection] = useState<ProtocolGuideSectionId>("welcome");
  const [spectatorPromptOpen, setSpectatorPromptOpen] = useState(false);
  const [openingHistory, setOpeningHistory] = useState(false);
  const [claimableWeeksCount, setClaimableWeeksCount] = useState(0);
  const [claimableTotalWithdrawWei, setClaimableTotalWithdrawWei] = useState<bigint>(0n);
  const [lastSettledWeekStartUtc, setLastSettledWeekStartUtc] = useState<string | null>(null);
  const [claimSummaryError, setClaimSummaryError] = useState<string | null>(null);
  const [nextClaimableSummary, setNextClaimableSummary] = useState<ClaimableWeekSummary | null>(
    null,
  );
  const hasDbLineupCommit = Boolean(
    dbLineupIds && Object.values(dbLineupIds).some((coinId) => Boolean(coinId)),
  );
  const isDraftOpen = weekStatus === "DRAFT_OPEN";
  const isWeekActive = weekStatus === "ACTIVE";
  const isWeekFinalized = weekStatus === "FINALIZED" || weekStatus === "FINALIZE_PENDING";
  const isWeekLockedTransition = weekStatus === "LOCKED";
  const isCooldownView = isWeekFinalized;
  const isBoardOverlayVisible = isCooldownView || isWeekLockedTransition;
  const walletIdentityResolved = walletStatus !== "connecting";
  const participationResolved = !walletAddress ? true : dbLineupChecked && onchainPositionResolved;
  const isParticipationKnown = isWeekActive
    ? walletIdentityResolved && participationResolved
    : true;
  const hasWeekParticipation =
    Boolean(walletAddress) &&
    (Boolean(onchainDeposit && onchainDeposit > 0n) || hasDbLineupCommit);
  const canUseWeekControls = isWeekActive && hasWeekParticipation;
  const isSpectatorWeekView = isWeekActive && isParticipationKnown && !canUseWeekControls;
  const isWeekPendingIdentity = isWeekActive && !isParticipationKnown;
  const [cooldownNowMs, setCooldownNowMs] = useState(() => Date.now());
  useLayoutEffect(() => {
    if (!weekId) return;

    const coinsCacheKey = `${COINS_CACHE_PREFIX}:v${COINS_CACHE_VERSION}:${weekId}`;
    try {
      const raw = localStorage.getItem(coinsCacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { version?: number; coins?: Asset[] };
      if (parsed?.version !== COINS_CACHE_VERSION || !Array.isArray(parsed.coins)) return;
      if (!parsed.coins.length) return;

      setCoins(parsed.coins);
      setCoinsLoading(false);
      setCoinsError(null);
    } catch {
      // Ignore coin cache read issues.
    }
  }, [weekId, weekStatus]);

  useLayoutEffect(() => {
    if (!weekId) {
      setLivePrices({});
      setLivePricesLoaded(false);
      return;
    }

    const livePriceCacheKey = `${LIVE_PRICE_CACHE_PREFIX}:v${LIVE_PRICE_CACHE_VERSION}:${weekId}`;
    try {
      const raw = localStorage.getItem(livePriceCacheKey);
      if (!raw) {
        setLivePrices({});
        setLivePricesLoaded(false);
        return;
      }
      const parsed = JSON.parse(raw) as {
        version?: number;
        prices?: Record<string, number>;
      };
      if (parsed?.version !== LIVE_PRICE_CACHE_VERSION || !parsed.prices) {
        setLivePrices({});
        setLivePricesLoaded(false);
        return;
      }

      const sanitized: Record<string, number> = {};
      for (const [symbol, value] of Object.entries(parsed.prices)) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) continue;
        sanitized[symbol] = numeric;
      }

      if (!Object.keys(sanitized).length) {
        setLivePrices({});
        setLivePricesLoaded(false);
        return;
      }

      setLivePrices(sanitized);
      setLivePricesLoaded(true);
    } catch {
      setLivePrices({});
      setLivePricesLoaded(false);
    }
  }, [weekId]);

  useEffect(() => {
    coinsRef.current = coins;
  }, [coins]);

  useEffect(() => {
    if (!isCooldownView) return;
    const timer = window.setInterval(() => setCooldownNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isCooldownView]);

  useEffect(() => {
    if (Number(activeProfile.chainId) !== 11155111) {
      setReactiveFlowEvents([]);
      setReactiveFlowLoading(false);
      return;
    }
    if (!weekId) {
      setReactiveFlowEvents([]);
      setReactiveFlowLoading(false);
      return;
    }

    let cancelled = false;
    const loadReactiveFlow = async () => {
      if (!cancelled) setReactiveFlowLoading(true);
      try {
        const response = await apiGet<ReactiveFlowResponse>(`/weeks/${weekId}/reactive-flow?limit=50`);
        if (cancelled) return;
        setReactiveFlowEvents(Array.isArray(response?.events) ? response.events : []);
      } catch {
        if (!cancelled) {
          setReactiveFlowEvents([]);
        }
      } finally {
        if (!cancelled) setReactiveFlowLoading(false);
      }
    };

    void loadReactiveFlow();
    const timer = window.setInterval(() => {
      void loadReactiveFlow();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeProfile.chainId, weekId]);

  const cooldownCountdownLabel = useMemo(() => {
    const cooldownEndsAt = week?.cooldownEndsAtUtc ? Date.parse(week.cooldownEndsAtUtc) : NaN;
    if (!Number.isFinite(cooldownEndsAt)) return "--:--";
    const remainingMs = Math.max(0, cooldownEndsAt - cooldownNowMs);
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }, [cooldownNowMs, week?.cooldownEndsAtUtc]);

  const openProtocolGuide = useCallback((section: ProtocolGuideSectionId = "welcome") => {
    setProtocolGuideSection(section);
    setProtocolGuideOpen(true);
  }, []);

  useEffect(() => {
    const handleOpenProtocolGuide = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: string | null }>).detail;
      const section = normalizeProtocolGuideSection(detail?.section ?? "welcome");
      setProtocolGuideSection(section);
      setProtocolGuideOpen(true);
    };
    window.addEventListener("valcore:open-protocol-guide", handleOpenProtocolGuide as EventListener);
    return () => {
      window.removeEventListener(
        "valcore:open-protocol-guide",
        handleOpenProtocolGuide as EventListener,
      );
    };
  }, []);

  const formation = useMemo(() => {
    return formations.find((item) => item.id === formationId) ?? formations[0];
  }, [formationId]);

  const slots = useMemo(() => buildSlots(formation), [formation]);

  const lineupCacheKey = useMemo(() => {
    if (!weekId || !walletAddress) return null;
    return `${lineupCachePrefix}:${weekId}:${walletAddress.toLowerCase()}`;
  }, [walletAddress, weekId]);
  const lineupContextKey = useMemo(
    () => `${weekId ?? "none"}:${walletAddress?.toLowerCase() ?? "guest"}`,
    [walletAddress, weekId],
  );
  const keepSelectedSlotIfPresent = useCallback((nextLineup: Record<string, Asset | null>) => {
    setSelectedSlotId((prev) =>
      prev && Object.prototype.hasOwnProperty.call(nextLineup, prev) ? prev : null,
    );
  }, []);

  useEffect(() => {
    setLineup((prev) => {
      if (!Object.keys(prev).length) return createLineup(slots);
      const byRole: Record<RoleType, Array<{ idx: number; asset: Asset }>> = {
        core: [],
        stabilizer: [],
        amplifier: [],
        wildcard: [],
      };
      for (const [slotId, asset] of Object.entries(prev)) {
        if (!asset) continue;
        const match = slotId.match(/-(\d+)$/);
        const idx = match ? Number(match[1]) : 0;
        byRole[asset.role].push({ idx, asset });
      }
      const queues: Record<RoleType, Asset[]> = {
        core: byRole.core.sort((a, b) => a.idx - b.idx).map((row) => row.asset),
        stabilizer: byRole.stabilizer.sort((a, b) => a.idx - b.idx).map((row) => row.asset),
        amplifier: byRole.amplifier.sort((a, b) => a.idx - b.idx).map((row) => row.asset),
        wildcard: byRole.wildcard.sort((a, b) => a.idx - b.idx).map((row) => row.asset),
      };
      const nextLineup: Record<string, Asset | null> = {};
      for (const slot of slots) {
        const nextAsset = queues[slot.role].shift() ?? null;
        nextLineup[slot.id] = nextAsset;
      }
      keepSelectedSlotIfPresent(nextLineup);
      return nextLineup;
    });
    setPendingAction(null);
    setSwapCount(0);
  }, [keepSelectedSlotIfPresent, slots]);

  useEffect(() => {
    cacheAppliedRef.current = false;
    setCacheReady(false);
  }, [lineupCacheKey]);

  useEffect(() => {
    if (lineupContextKeyRef.current === lineupContextKey) return;
    lineupContextKeyRef.current = lineupContextKey;
    setDbLineupIds(null);
    setDbLineupChecked(false);
    setSwapCount(0);
    setLineup(createLineup(slots));
    setSelectedSlotId(null);
    setPendingAction(null);
  }, [lineupContextKey, slots]);

  useEffect(() => {
    setOnchainPositionResolved(false);
  }, [weekId, walletAddress]);

  useEffect(() => {
    if (!lineupCacheKey) return;
    if (isSpectatorWeekView || isWeekFinalized) {
      setCacheReady(true);
      return;
    }
    try {
      const raw = localStorage.getItem(lineupCacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as LineupCache;
        if (
          parsed?.formationId &&
          formations.some((item) => item.id === parsed.formationId)
        ) {
          setFormationId(parsed.formationId);
        }
      }
    } catch {
      // Ignore cache read issues
    } finally {
      setCacheReady(true);
    }
  }, [isSpectatorWeekView, isWeekFinalized, lineupCacheKey]);

  const isNotFoundError = useCallback((error: unknown) => {
    const message =
      typeof error === "object" && error && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
    return message.includes("404") || /not\s*found/i.test(message);
  }, []);
  const fetchDbLineup = useCallback(async () => {
    if (isWeekFinalized) {
      setDbLineupIds(null);
      setDbLineupChecked(true);
      setSwapCount(0);
      setDbLineupFetchState("idle");
      if (lineupCacheKey) {
        localStorage.removeItem(lineupCacheKey);
      }
      return;
    }
    if (!weekId || !walletAddress) {
      setDbLineupChecked(true);
      setDbLineupFetchState("idle");
      return;
    }
    try {
      const data = await apiGet<DbLineupResponse>(
        `/weeks/${weekId}/lineups/${walletAddress}`,
      );

      const record: Record<string, string | null> = {};
      data.slots.forEach((slot) => {
        record[slot.slotId] = slot.coinId || null;
      });

      const roleCounts: Record<RoleType, number> = {
        core: 0,
        stabilizer: 0,
        amplifier: 0,
        wildcard: 0,
      };
      data.slots.forEach((slot) => {
        const prefix = slot.slotId.split("-")[0] as RoleType;
        if (prefix in roleCounts) {
          roleCounts[prefix] += 1;
        }
      });
      const inferredFormation = formations.find((formation) =>
        roleOrder.every((role) => formation.roles[role] === roleCounts[role]),
      );
      if (inferredFormation) {
        setFormationId(inferredFormation.id);
      }

      setDbLineupIds(record);
      setDbLineupFetchState("found");
      setSwapCount(Number.isFinite(data.swaps) ? data.swaps : 0);
      setDbLineupChecked(true);
      if (lineupCacheKey) {
        localStorage.removeItem(lineupCacheKey);
      }
    } catch (error) {
      setDbLineupIds(null);
      setSwapCount(0);
      setDbLineupChecked(true);
      setDbLineupFetchState(isNotFoundError(error) ? "not_found" : "error");
    }
  }, [isNotFoundError, isWeekFinalized, lineupCacheKey, walletAddress, weekId]);

  useEffect(() => {
    void fetchDbLineup();
  }, [fetchDbLineup]);
  useEffect(() => {
    if (dbLineupFetchState !== "error") return;
    if (!weekId || !walletAddress) return;

    void reportClientError({
      source: "web-client",
      severity: "error",
      category: "lineup-db-sync",
      message: "DB lineup read failed",
      fingerprint: "lineup:db:read-failed",
      path: window.location.pathname,
      walletAddress,
      context: {
        weekId,
        rpcUrl: activeProfile.rpcUrl,
      },
    });

    showToast("Strategy sync error: lineup database read failed. Refresh and retry.", "warn");
  }, [activeProfile.rpcUrl, dbLineupFetchState, showToast, walletAddress, weekId]);

  useEffect(() => {
    if (!walletAddress || !weekId || isWeekFinalized) return;
    if (!onchainPositionResolved) return;
    if (!onchainDeposit || onchainDeposit <= 0n) return;
    if (!dbLineupChecked || dbLineupIds) return;

    const retryTimer = window.setInterval(() => {
      void fetchDbLineup();
    }, 2000);

    return () => {
      window.clearInterval(retryTimer);
    };
  }, [
    dbLineupChecked,
    dbLineupIds,
    fetchDbLineup,
    isWeekFinalized,
    onchainDeposit,
    onchainPositionResolved,
    walletAddress,
    weekId,
  ]);
  useEffect(() => {
    if (!isWeekFinalized) return;
    setLineup(createLineup(slots));
    setSelectedSlotId(null);
    setPendingAction(null);
    setShowcaseLineupIds(null);
  }, [isWeekFinalized, slots]);

  useEffect(() => {
    if (!weekId || !isSpectatorWeekView || isWeekPendingIdentity) {
      setShowcaseLineupIds(null);
      return;
    }
    let active = true;
    let refreshTimer: number | null = null;

    const fetchShowcaseLineup = async () => {
      try {
        const data = await apiGet<WeekShowcaseLineupResponse>(`/weeks/${weekId}/showcase-lineup`);
        if (!active) return;
        const record: Record<string, string | null> = {};
        data.slots.forEach((slot) => {
          record[slot.slotId] = slot.coinId || null;
        });
        setShowcaseLineupIds(record);
      } catch {
        if (!active) return;
        setShowcaseLineupIds(null);
      }
    };

    void fetchShowcaseLineup();
    refreshTimer = window.setInterval(fetchShowcaseLineup, 60 * 1000);

    return () => {
      active = false;
      if (refreshTimer) {
        window.clearInterval(refreshTimer);
      }
    };
  }, [isSpectatorWeekView, isWeekPendingIdentity, weekId]);

  useEffect(() => {
    if (!isSpectatorWeekView || !coins.length) return;
    const nextLineup = createLineup(slots);
    if (showcaseLineupIds) {
      const assetMap = new Map(coins.map((asset) => [asset.id, asset]));
      Object.entries(showcaseLineupIds).forEach(([slotId, assetId]) => {
        if (!(slotId in nextLineup) || !assetId) return;
        const asset = assetMap.get(assetId);
        if (asset) {
          nextLineup[slotId] = asset;
        }
      });
    }
    setLineup(nextLineup);
    setSelectedSlotId(null);
    setPendingAction(null);
  }, [coins, isSpectatorWeekView, showcaseLineupIds, slots]);


  useEffect(() => {
    if (!isWeekPendingIdentity) return;
    setLineup(createLineup(slots));
    setSelectedSlotId(null);
    setPendingAction(null);
    setShowcaseLineupIds(null);
  }, [isWeekPendingIdentity, slots]);

  useEffect(() => {
    if (isWeekPendingIdentity) return;
    if (!dbLineupIds || !coins.length) return;
    const nextLineup = createLineup(slots);
    const assetMap = new Map(coins.map((asset) => [asset.id, asset]));
    Object.entries(dbLineupIds).forEach(([slotId, assetId]) => {
      if (!(slotId in nextLineup)) return;
      if (!assetId) {
        nextLineup[slotId] = null;
        return;
      }
      const asset = assetMap.get(assetId);
      if (asset) {
        nextLineup[slotId] = asset;
      }
    });
    setLineup(nextLineup);
    keepSelectedSlotIfPresent(nextLineup);
    setPendingAction(null);
    cacheAppliedRef.current = true;
  }, [coins, dbLineupIds, isWeekPendingIdentity, keepSelectedSlotIfPresent, slots]);

  useEffect(() => {
    if (!lineupCacheKey || !cacheReady || cacheAppliedRef.current) return;
    if (isSpectatorWeekView || isWeekPendingIdentity || isWeekFinalized) return;
    if (!dbLineupChecked || dbLineupIds) return;
    if (dbLineupFetchState !== "not_found") return;
    if (!onchainPositionResolved) return;
    if (!coins.length) return;
    try {
      const raw = localStorage.getItem(lineupCacheKey);
      if (!raw) {
        const nextLineup = createLineup(slots);
        setLineup(nextLineup);
        keepSelectedSlotIfPresent(nextLineup);
        setPendingAction(null);
        cacheAppliedRef.current = true;
        return;
      }
      const parsed = JSON.parse(raw) as LineupCache;
      if (!parsed?.lineup) {
        const nextLineup = createLineup(slots);
        setLineup(nextLineup);
        keepSelectedSlotIfPresent(nextLineup);
        setPendingAction(null);
        cacheAppliedRef.current = true;
        return;
      }
      const nextLineup = createLineup(slots);
      const assetMap = new Map(coins.map((asset) => [asset.id, asset]));
      Object.entries(parsed.lineup).forEach(([slotId, assetId]) => {
        if (!(slotId in nextLineup)) return;
        if (!assetId) {
          nextLineup[slotId] = null;
          return;
        }
        const asset = assetMap.get(assetId);
        if (asset) {
          nextLineup[slotId] = asset;
        }
      });
      setLineup(nextLineup);
      keepSelectedSlotIfPresent(nextLineup);
      setPendingAction(null);
    } catch {
      // Ignore cache parse issues
    } finally {
      cacheAppliedRef.current = true;
    }
  }, [
    cacheReady,
    coins,
    dbLineupChecked,
    dbLineupIds,
    dbLineupFetchState,
    isSpectatorWeekView,
    isWeekPendingIdentity,
    isWeekFinalized,
    onchainDeposit,
    onchainPositionResolved,
    keepSelectedSlotIfPresent,
    lineupCacheKey,
    slots,
  ]);

  useEffect(() => {
    if (!lineupCacheKey || !cacheReady || !cacheAppliedRef.current) return;
    if (isSpectatorWeekView || isWeekPendingIdentity || isWeekFinalized) return;
    if (!dbLineupChecked || dbLineupIds) return;
    if (dbLineupFetchState !== "not_found") return;
    if (!onchainPositionResolved) return;
    try {
      const payload: LineupCache = {
        version: 1,
        formationId,
        lineup: Object.fromEntries(
          Object.entries(lineup).map(([slotId, asset]) => [slotId, asset?.id ?? null]),
        ),
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(lineupCacheKey, JSON.stringify(payload));
    } catch {
      // Ignore cache write issues
    }
  }, [dbLineupChecked, dbLineupIds, dbLineupFetchState, formationId, isSpectatorWeekView, isWeekPendingIdentity, isWeekFinalized, lineup, lineupCacheKey, onchainDeposit, onchainPositionResolved]);

  useEffect(() => {
    let active = true;

    const fetchClaimSummary = async () => {
      if (!walletAddress || !valcoreAddress) {
        setClaimableWeeksCount(0);
        setClaimableTotalWithdrawWei(0n);
        setLastSettledWeekStartUtc(null);
        setClaimSummaryError(null);
        setNextClaimableSummary(null);
        return;
      }
      if (!isStarknet && !publicClient) {
        setClaimableWeeksCount(0);
        setClaimableTotalWithdrawWei(0n);
        setLastSettledWeekStartUtc(null);
        setClaimSummaryError(null);
        setNextClaimableSummary(null);
        return;
      }

      try {
        setClaimSummaryError(null);
        const weeks = await apiGet<WeekSummaryLite[]>("/weeks?limit=36");
        if (!active) return;

        const finalized = weeks
          .filter((week) => week.status === "FINALIZED")
          .sort((a, b) => Number(b.id) - Number(a.id));
        if (!finalized.length) {
          setClaimableWeeksCount(0);
          setClaimableTotalWithdrawWei(0n);
          setNextClaimableSummary(null);
          return;
        }
        setLastSettledWeekStartUtc(finalized[0]?.startAtUtc ?? null);

        const claimable: ClaimableWeekSummary[] = [];
        let totalWithdrawAggregate = 0n;
for (const week of finalized) {
          let claim: ClaimData | null = null;
          try {
            claim = await apiGet<ClaimData>(`/weeks/${week.id}/claims/${walletAddress.toLowerCase()}`);
          } catch {
            claim = null;
          }
          if (!claim) continue;

          let claimedOnChain = false;
          try {
            if (isStarknet) {
              const position = await readStarknetPosition(activeProfile.rpcUrl, valcoreAddress, week.id, walletAddress);
              claimedOnChain = position.claimed;
            } else if (publicClient) {
              const position = await publicClient.readContract({
                address: valcoreAddress,
                abi: valcoreAbi,
                functionName: "positions",
                args: [BigInt(week.id), walletAddress as `0x${string}`],
              });
              claimedOnChain = parseClaimedFlag(position);
            }
          } catch (error) {
            const details = extractErrorText(error) || "unknown on-chain read error";
            throw new Error(`On-chain claim state read failed for week ${week.id}: ${details}`);
          }
          if (claimedOnChain) continue;

          let riskWei = 0n;
          try {
            const lineupData = await apiGet<DbLineupResponse>(
              `/weeks/${week.id}/lineups/${walletAddress.toLowerCase()}`,
            );
            riskWei = BigInt(lineupData.riskWei || "0");
          } catch {
            riskWei = 0n;
          }

          const principalWei = BigInt(claim.principal || "0");
          const totalWithdrawWei = BigInt(claim.totalWithdraw || "0");
          const netResultWei = totalWithdrawWei - principalWei - riskWei;
          totalWithdrawAggregate += totalWithdrawWei;

          claimable.push({
            weekId: week.id,
            weekStartAtUtc: week.startAtUtc,
            netResultWei,
            guaranteedWei: principalWei,
            performanceWei: netResultWei,
            historyUrl: `/history?week=${encodeURIComponent(week.id)}&focus=claim`,
          });
        }

        if (!active) return;
        setClaimableWeeksCount(claimable.length);
        setClaimableTotalWithdrawWei(totalWithdrawAggregate);
        setNextClaimableSummary(claimable[0] ?? null);
      } catch (error) {
        if (!active) return;
        setClaimableWeeksCount(0);
        setClaimableTotalWithdrawWei(0n);
        setNextClaimableSummary(null);
        setClaimSummaryError("On-chain claim status unavailable. Refresh and retry.");
        void reportClientError({
          source: "web-client",
          severity: "error",
          category: "lineup-claim-summary",
          message: "Claim summary sync failed",
          fingerprint: "lineup:claim-summary:sync-failed",
          path: window.location.pathname,
          walletAddress,
          context: {
            weekId,
            rpcUrl: activeProfile.rpcUrl,
            rawError: extractErrorText(error),
          },
        });
      }
    };

    void fetchClaimSummary();
    return () => {
      active = false;
    };
  }, [isStarknet, publicClient, activeProfile.rpcUrl, valcoreAddress, walletAddress, weekId]);

  const openHistoryToClaim = useCallback(() => {
    const target = nextClaimableSummary?.historyUrl ?? "/history";
    setOpeningHistory(true);
    router.push(target);
    window.setTimeout(() => setOpeningHistory(false), 1200);
  }, [nextClaimableSummary, router]);

  const nextSundayLabel = useMemo(() => {
    const nowUtc = new Date();
    const day = nowUtc.getUTCDay();
    const daysUntilSunday = (7 - day) % 7;
    const nextSunday = new Date(
      Date.UTC(
        nowUtc.getUTCFullYear(),
        nowUtc.getUTCMonth(),
        nowUtc.getUTCDate() + daysUntilSunday,
      ),
    );
    return nextSunday.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }, []);

  useEffect(() => {
    if (!weekId) return;
    let active = true;
    let retryTimer: number | null = null;
    let refreshTimer: number | null = null;
    const coinsCacheKey = `${COINS_CACHE_PREFIX}:v${COINS_CACHE_VERSION}:${weekId}`;

    setCoinsError(null);
    setCoinsSyncing(false);

    let warmedByCache = false;
    try {
      const raw = localStorage.getItem(coinsCacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { version?: number; coins?: Asset[] };
        if (parsed?.version === COINS_CACHE_VERSION && Array.isArray(parsed.coins)) {
          setCoins(parsed.coins);
          coinsRef.current = parsed.coins;
          setCoinsLoading(false);
          warmedByCache = parsed.coins.length > 0;
        }
      }
    } catch {
      // Ignore coin cache read issues.
    }

    if (!warmedByCache) {
      setCoins([]);
      coinsRef.current = [];
      setCoinsLoading(true);
    }

    const fetchCoins = async () => {
      if (coinsRef.current.length > 0) {
        setCoinsSyncing(true);
      } else {
        setCoinsLoading(true);
      }
      setCoinsError(null);

      try {
        const rows = await apiGet<WeekCoinRow[]>(`/weeks/${weekId}/coins`);
        if (!active) return;
        const mapped: Asset[] = rows.map((row) => ({
          id: row.coinId,
          symbol: row.coin.symbol.toUpperCase(),
          name: row.coin.name,
          imagePath: row.coin.imagePath,
          role: positionToRole[row.position],
          position: row.position,
          rank: row.rank,
          salary: row.salary,
          snapshotPrice: row.snapshotPrice,
          risk: row.risk ?? "Medium",
          power: Number.isFinite(row.power) ? row.power : 50,
          momentum: row.momentum ?? "Steady",
          momentumLive: row.momentumLive ?? null,
        }));

        if (mapped.length > 0) {
          setCoins(mapped);
          coinsRef.current = mapped;
          try {
            localStorage.setItem(
              coinsCacheKey,
              JSON.stringify({
                version: COINS_CACHE_VERSION,
                updatedAt: new Date().toISOString(),
                coins: mapped,
              }),
            );
          } catch {
            // Ignore coin cache write issues.
          }
        }

        setCoinsLoading(false);
        setCoinsSyncing(false);
        setCoinsError(null);

        if (mapped.length === 0) {
          retryTimer = window.setTimeout(fetchCoins, 5000);
        }
      } catch {
        if (!active) return;
        setCoinsLoading(false);
        setCoinsSyncing(false);
        if (!coinsRef.current.length) {
          setCoinsError("Unable to load market data.");
        }
      }
    };

    void fetchCoins();
    refreshTimer = window.setInterval(() => {
      void fetchCoins();
    }, 4 * 60 * 60 * 1000);

    return () => {
      active = false;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
      if (refreshTimer) {
        window.clearInterval(refreshTimer);
      }
    };
  }, [weekId]);
  const refreshStablecoinBalance = useCallback(async () => {
    if (!walletAddress || !stablecoinAddress || !valcoreAddress) {
      setStablecoinBalance(null);
      setStablecoinAllowance(null);
      return;
    }

    setStablecoinLoading(true);
    try {
      if (isStarknet) {
        const [balance, allowance] = await Promise.all([
          readStarknetStablecoinBalance(activeProfile.rpcUrl, stablecoinAddress, walletAddress),
          readStarknetStablecoinAllowance(activeProfile.rpcUrl, stablecoinAddress, walletAddress, valcoreAddress),
        ]);
        setStablecoinBalance(balance);
        setStablecoinAllowance(allowance);
        return;
      }

      if (!publicClient) {
        setStablecoinBalance(null);
        setStablecoinAllowance(null);
        return;
      }

      const [balance, allowance] = await Promise.all([
        publicClient.readContract({
          address: stablecoinAddress,
          abi: stablecoinAbi,
          functionName: "balanceOf",
          args: [walletAddress as `0x${string}`],
        }),
        publicClient.readContract({
          address: stablecoinAddress,
          abi: stablecoinAbi,
          functionName: "allowance",
          args: [
            walletAddress as `0x${string}`,
            valcoreAddress as `0x${string}`,
          ],
        }),
      ]);
      setStablecoinBalance(balance as bigint);
      setStablecoinAllowance(allowance as bigint);
    } catch (error) {
      setStablecoinBalance(null);
      setStablecoinAllowance(null);
      void reportClientError({
        source: "web-client",
        severity: "error",
        category: "wallet-balance-sync",
        message: "Stablecoin balance sync failed",
        fingerprint: "wallet:balance:sync-failed",
        path: window.location.pathname,
        walletAddress,
        context: {
          rpcUrl: activeProfile.rpcUrl,
          stablecoinAddress,
          valcoreAddress,
          rawError: extractErrorText(error),
        },
      });
    } finally {
      setStablecoinLoading(false);
    }
  }, [isStarknet, activeProfile.rpcUrl, valcoreAddress, publicClient, stablecoinAddress, walletAddress]);

  const refreshPosition = useCallback(async () => {
    if (!walletAddress || !valcoreAddress || !weekId) {
      setOnchainDeposit(null);
      setSwapCount(0);
      setOnchainPositionResolved(false);
      return;
    }

    try {
      if (isStarknet) {
        const position = await readStarknetPosition(activeProfile.rpcUrl, valcoreAddress, weekId, walletAddress);
        setOnchainDeposit(position.principal + position.risk);
        setSwapCount(Number.isFinite(position.swaps) ? Math.max(0, Math.min(totalMoves, position.swaps)) : 0);
        setOnchainPositionResolved(true);
        return;
      }

      if (!publicClient) {
        setOnchainDeposit(null);
        setSwapCount(0);
        setOnchainPositionResolved(false);
        return;
      }

      const position = await publicClient.readContract({
        address: valcoreAddress,
        abi: valcoreAbi,
        functionName: "positions",
        args: [BigInt(weekId), walletAddress as `0x${string}`],
      });
      const { principal, risk } = parsePrincipalRisk(position);
      const swapsUsed = parseSwapsUsed(position);
      setOnchainDeposit(principal + risk);
      setSwapCount(Number.isFinite(swapsUsed) ? Math.max(0, Math.min(totalMoves, swapsUsed)) : 0);
      setOnchainPositionResolved(true);
    } catch {
      setOnchainDeposit(null);
      setOnchainPositionResolved(false);
    }
  }, [isStarknet, activeProfile.rpcUrl, publicClient, valcoreAddress, walletAddress, weekId]);

  useEffect(() => {
    void refreshStablecoinBalance();
  }, [refreshStablecoinBalance]);

  useEffect(() => {
    void refreshPosition();
  }, [refreshPosition]);

  useEffect(() => {
    if (!isWeekActive || !walletAddress || onchainPositionResolved) return;
    const retry = window.setInterval(() => {
      void refreshPosition();
    }, 2000);
    return () => window.clearInterval(retry);
  }, [isWeekActive, onchainPositionResolved, refreshPosition, walletAddress]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const livePriceCacheKey = weekId
      ? `${LIVE_PRICE_CACHE_PREFIX}:v${LIVE_PRICE_CACHE_VERSION}:${weekId}`
      : null;

    const fetchLivePrices = async () => {
      if (!active || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      inFlight = true;
      try {
        const prices = await apiGet<Record<string, number>>("/prices/live");
        if (!active) return;

        const positivePrices: Record<string, number> = {};
        for (const [symbol, value] of Object.entries(prices)) {
          const numeric = Number(value);
          if (!Number.isFinite(numeric) || numeric <= 0) continue;
          positivePrices[symbol] = numeric;
        }

        startPriceTransition(() => {
          setLivePrices((prev) => {
            let changed = false;
            let next = prev;
            for (const [symbol, numeric] of Object.entries(positivePrices)) {
              const current = Number(prev[symbol]);
              if (current === numeric) continue;
              if (!changed) {
                next = { ...prev };
                changed = true;
              }
              next[symbol] = numeric;
            }
            return changed ? next : prev;
          });
        });

        if (Object.keys(positivePrices).length > 0) {
          setLivePricesLoaded((prev) => prev || true);
          if (livePriceCacheKey) {
            try {
              const raw = localStorage.getItem(livePriceCacheKey);
              const parsed = raw
                ? (JSON.parse(raw) as {
                    version?: number;
                    prices?: Record<string, number>;
                  })
                : null;
              const base =
                parsed?.version === LIVE_PRICE_CACHE_VERSION && parsed.prices
                  ? parsed.prices
                  : {};
              localStorage.setItem(
                livePriceCacheKey,
                JSON.stringify({
                  version: LIVE_PRICE_CACHE_VERSION,
                  updatedAt: new Date().toISOString(),
                  prices: {
                    ...base,
                    ...positivePrices,
                  },
                }),
              );
            } catch {
              // Ignore live price cache write issues.
            }
          }
        }
      } catch {
        // Ignore live price fetch failures
      } finally {
        inFlight = false;
      }
    };

    void fetchLivePrices();
    const interval = window.setInterval(() => {
      void fetchLivePrices();
    }, 10000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchLivePrices();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [startPriceTransition, weekId, weekStatus]);

  useEffect(() => {
    const prev = lastPriceRef.current;
    const updates: string[] = [];
    for (const [symbol, price] of Object.entries(livePrices)) {
      if (!Number.isFinite(price)) continue;
      if (prev[symbol] !== undefined && prev[symbol] !== price) {
        updates.push(symbol);
      }
    }
    lastPriceRef.current = { ...prev, ...livePrices };
    if (!updates.length) return;
    setPriceFlash((current) => {
      const next = { ...current };
      updates.forEach((symbol) => {
        next[symbol] = true;
      });
      return next;
    });
    const timeout = setTimeout(() => {
      setPriceFlash((current) => {
        const next = { ...current };
        updates.forEach((symbol) => {
          delete next[symbol];
        });
        return next;
      });
    }, 500);
    return () => clearTimeout(timeout);
  }, [livePrices]);

  useEffect(() => {
    if (!toast || pendingAction || toastHover) return;
    const duration = toast.tone === "warn" ? 12000 : toast.href ? 8000 : 5000;
    const timeout = setTimeout(() => setToast(null), duration);
    return () => clearTimeout(timeout);
  }, [toast, pendingAction, toastHover]);

  useEffect(() => {
    if (!protectionOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".protection-card")) {
        setProtectionOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [protectionOpen]);

  useEffect(() => {
    if (!multiplierOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".multiplier-card")) {
        setMultiplierOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [multiplierOpen]);


  // Keep selected slot active while interacting with the board or asset pool.

  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId) ?? null;
  const selectedRole = selectedSlot?.role ?? null;

  useEffect(() => {
    if (!selectedRole) {
      if (sortKey === "rank") {
        setSortDir("asc");
      }
      return;
    }
    if (sortKey === "rank") {
      setSortKey("power");
      setSortDir("desc");
    }
  }, [selectedRole, sortKey]);

  const slotGroups = useMemo(() => buildSlotGroups(slots), [slots]);

  const assignedIds = useMemo(() => buildAssignedIds(lineup), [lineup]);

  const filledCount = useMemo(() => countFilledSlots(slots, lineup), [lineup, slots]);

  const usedPower = useMemo(
    () => computeUsedPower(slots, lineup, isSpectatorWeekView),
    [isSpectatorWeekView, lineup, slots],
  );

  const availableBudget = useMemo(
    () => computeAvailableBudget(selectedSlot, lineup, usedPower, powerCap),
    [lineup, selectedSlot, usedPower],
  );

  const powerPercent = Math.min((usedPower / powerCap) * 100, 100);

  const projectedMultiplier = useMemo(
    () =>
      computeProjectedMultiplier({
        isSpectatorWeekView,
        filledCount,
        usedPower,
        powerCap,
        budgetMinRatio,
        budgetAlpha,
        budgetCap,
      }),
    [filledCount, isSpectatorWeekView, usedPower],
  );

  const isSwapModeActive = canUseWeekControls && swapMode;
  const showLiveChange = isWeekActive;
  const showLadderPanel = isWeekActive && canUseWeekControls && !swapMode;
  const swapsRemaining = Math.max(totalMoves - swapCount, 0);
  const isTargeting = canUseWeekControls && Boolean(selectedCandidate && !selectedCandidate.inLineup);
  const targetRole = isTargeting ? selectedCandidate?.role ?? null : null;
  const candidateAsset = useMemo(() => {
    if (!selectedCandidate) return null;
    return coins.find((asset) => asset.id === selectedCandidate.id) ?? null;
  }, [coins, selectedCandidate]);


  const tacticalMoves = {
    remaining: Math.max(totalMoves - swapCount, 0),
    total: totalMoves,
  };

  
  useEffect(() => {
    if (!isWeekActive && sortKey === "weekChange") {
      setSortKey("rank");
      setSortDir("desc");
    }
  }, [isWeekActive, sortKey]);

  useEffect(() => {
    if (!canUseWeekControls) {
      setMoves(null);
      return;
    }
    setMoves({
      remaining: swapsRemaining,
      total: tacticalMoves.total,
      swapCount,
    });
  }, [canUseWeekControls, setMoves, swapCount, swapsRemaining, tacticalMoves.total]);

  useEffect(() => {
    return () => setMoves(null);
  }, [setMoves]);
  const isLockReady = filledCount === slots.length && isDraftOpen;
  const canChangeFormation = !weekStatus || isDraftOpen;

  useEffect(() => {
    if (!isSpectatorWeekView) return;
    if (formationId !== spectatorFormationId) {
      setFormationId(spectatorFormationId);
    }
  }, [formationId, isSpectatorWeekView]);

  useEffect(() => {
    if (weekStatus !== "ACTIVE" || !canUseWeekControls) {
      setSwapMode(false);
      setPendingAction(null);
    }
    if (weekStatus === "ACTIVE") {
      setSelectedSlotId(null);
      setPendingAction(null);
    }
    if (!canUseWeekControls) {
      setSelectedCandidate(null);
      setLadderFocusId(null);
      setHoverSwapSlotId(null);
      setSwapConfirmSlotId(null);
    }
  }, [canUseWeekControls, setSwapMode, weekStatus]);

  useEffect(() => {
    if (!swapMode) {
      setPendingAction(null);
    }
  }, [swapMode]);

  const clearCandidate = useCallback(() => {
    setSelectedCandidate(null);
    setLadderFocusId(null);
    setHoverSwapSlotId(null);
    setSwapConfirmSlotId(null);
  }, []);

  useEffect(() => {
    if (!selectedCandidate) {
      setTargetingPulseRole(null);
      setSwapConfirmSlotId(null);
      return;
    }
    setTargetingPulseRole(selectedCandidate.role);
    setSwapConfirmSlotId(null);
    const timeout = setTimeout(() => {
      setTargetingPulseRole(null);
    }, 1100);
    return () => clearTimeout(timeout);
  }, [selectedCandidate?.id]);

  useEffect(() => {
    if (weekStatus !== "ACTIVE") {
      clearCandidate();
    }
  }, [clearCandidate, weekStatus]);

  useEffect(() => {
    if (!selectedCandidate) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearCandidate();
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (ladderPanelRef.current?.contains(target)) return;
      if (target.closest("[data-swap-target='true']")) return;
      clearCandidate();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearCandidate, selectedCandidate]);

  const slotByAssetId = useMemo(() => buildSlotByAssetId(lineup), [lineup]);

  const ladderBase = useMemo(
    () => buildLadderBase({ coins, livePrices, assignedIds }),
    [assignedIds, coins, livePrices],
  );

  const ladderById = useMemo(() => {
    return new Map(ladderBase.map((item) => [item.id, item]));
  }, [ladderBase]);

  const ladderGainers = useMemo(
    () => ladderBase.filter((item) => item.pctSinceEntry >= 0),
    [ladderBase],
  );
  const ladderLosers = useMemo(
    () => ladderBase.filter((item) => item.pctSinceEntry < 0),
    [ladderBase],
  );

  const applyHysteresisOrder = useCallback(
    (prevOrder: string[], items: LadderEntry[], direction: "asc" | "desc") =>
      applyLadderHysteresisOrder(prevOrder, items, direction, ladderHysteresis),
    [ladderHysteresis],
  );

  useEffect(() => {
    if (!showLadderPanel) return;
    setLadderGainerOrder((prev) => applyHysteresisOrder(prev, ladderGainers, "desc"));
    setLadderLoserOrder((prev) => applyHysteresisOrder(prev, ladderLosers, "asc"));
  }, [applyHysteresisOrder, ladderGainers, ladderLosers, showLadderPanel]);

  useEffect(() => {
    if (!showLadderPanel) return;
    const pulses: string[] = [];
    const nextSigns = { ...lastPctSignRef.current };
    ladderBase.forEach((item) => {
      const sign = item.pctSinceEntry > 0 ? 1 : item.pctSinceEntry < 0 ? -1 : 0;
      const prev = nextSigns[item.symbol];
      if (prev && sign && prev !== sign) {
        pulses.push(item.symbol);
      }
      nextSigns[item.symbol] = sign;
    });
    lastPctSignRef.current = nextSigns;
    if (!pulses.length) return;
    setLadderPulse((current) => {
      const next = { ...current };
      pulses.forEach((symbol) => {
        next[symbol] = true;
      });
      return next;
    });
    const timeout = setTimeout(() => {
      setLadderPulse((current) => {
        const next = { ...current };
        pulses.forEach((symbol) => {
          delete next[symbol];
        });
        return next;
      });
    }, 220);
    return () => clearTimeout(timeout);
  }, [ladderBase, showLadderPanel]);

  const ladderGainerOrderFallback = useMemo(
    () => buildLadderFallbackOrder(ladderGainerOrder, ladderGainers, "desc"),
    [ladderGainerOrder, ladderGainers],
  );

  const ladderLoserOrderFallback = useMemo(
    () => buildLadderFallbackOrder(ladderLoserOrder, ladderLosers, "asc"),
    [ladderLoserOrder, ladderLosers],
  );

  const gainersDisplay = useMemo(
    () =>
      buildLadderDisplay({
        ids: ladderGainerOrderFallback,
        ladderById,
        count: ladderCount,
        reverse: true,
      }),
    [ladderById, ladderGainerOrderFallback],
  );

  const losersDisplay = useMemo(
    () =>
      buildLadderDisplay({
        ids: ladderLoserOrderFallback,
        ladderById,
        count: ladderCount,
      }),
    [ladderById, ladderLoserOrderFallback],
  );
  const hotGainers = useMemo(
    () => buildHotLadderSlice(ladderGainers, "desc", 3),
    [ladderGainers],
  );

  const hotLosers = useMemo(
    () => buildHotLadderSlice(ladderLosers, "asc", 3),
    [ladderLosers],
  );

  const triggerSlotHotPulse = useCallback((slotId: string, tone: "gain" | "loss") => {
    if (!slotId) return;
    setSlotHotPulse((prev) => ({ ...prev, [slotId]: tone }));
    if (slotHotTimers.current[slotId]) {
      window.clearTimeout(slotHotTimers.current[slotId]);
    }
    const duration = tone === "gain" ? 650 : 850;
    slotHotTimers.current[slotId] = window.setTimeout(() => {
      setSlotHotPulse((prev) => {
        const next = { ...prev };
        delete next[slotId];
        return next;
      });
      delete slotHotTimers.current[slotId];
    }, duration);
  }, []);

  useEffect(() => {
    if (!isWeekActive) {
      hotGainerRanksRef.current = {};
      hotLoserRanksRef.current = {};
      setSlotHotPulse({});
      return;
    }
    const nextGainers: Record<string, number> = {};
    const nextLosers: Record<string, number> = {};
    hotGainers.forEach((item, index) => {
      if (!item.inLineup) return;
      nextGainers[item.id] = index;
    });
    hotLosers.forEach((item, index) => {
      if (!item.inLineup) return;
      nextLosers[item.id] = index;
    });
    const prevGainers = hotGainerRanksRef.current;
    const prevLosers = hotLoserRanksRef.current;
    Object.entries(nextGainers).forEach(([assetId, rank]) => {
      const prevRank = prevGainers[assetId];
      if (prevRank === undefined || rank < prevRank) {
        const slotId = slotByAssetId.get(assetId);
        if (slotId) triggerSlotHotPulse(slotId, "gain");
      }
    });
    Object.entries(nextLosers).forEach(([assetId, rank]) => {
      const prevRank = prevLosers[assetId];
      if (prevRank === undefined || rank < prevRank) {
        const slotId = slotByAssetId.get(assetId);
        if (slotId) triggerSlotHotPulse(slotId, "loss");
      }
    });
    hotGainerRanksRef.current = nextGainers;
    hotLoserRanksRef.current = nextLosers;
  }, [hotGainers, hotLosers, isWeekActive, slotByAssetId, triggerSlotHotPulse]);


  const handleLadderRowClick = useCallback(
    (item: LadderEntry) => {
      setLadderFocusId(item.id);
      if (!isWeekActive) return;
      if (!canUseWeekControls) {
        showToast("Read-only epoch view. Connect and commit strategy to enable reallocation.", "warn");
        return;
      }
      if (item.inLineup) {
        clearCandidate();
        showToast("Asset already in your strategy allocation.", "warn");
        return;
      }
      if (swapMode) {
        setSwapMode(false);
      }
      if (selectedCandidate && selectedCandidate.id === item.id) {
        clearCandidate();
        return;
      }
      if (swapsRemaining <= 0) {
        showToast("No Tactical Moves remaining this epoch", "warn");
        return;
      }
      setSelectedCandidate(item);
    },
    [
      canUseWeekControls,
      clearCandidate,
      isWeekActive,
      selectedCandidate,
      setSwapMode,
      showToast,
      swapMode,
      swapsRemaining,
    ],
  );

  const handleCandidateSwap = useCallback(
    (slotId: string) => {
      if (!candidateAsset || !selectedCandidate) return;
      if (swapsRemaining <= 0) {
        showToast("No Tactical Moves remaining this epoch", "warn");
        return;
      }
      const slotAsset = lineup[slotId];
      if (!slotAsset) {
        showToast("No asset to replace", "warn");
        return;
      }
      if (slotAsset.id === candidateAsset.id) {
        showToast("Candidate already in this slot", "warn");
        return;
      }
      setPendingAction({
        type: "swap",
        slotId,
        previous: slotAsset,
        next: candidateAsset,
      });
    },
    [candidateAsset, lineup, selectedCandidate, showToast, swapsRemaining],
  );

  useEffect(() => {
    if (!isWeekActive || !walletAddress || !weekId) {
      setLiveScore(0);
      return;
    }
    let active = true;
    let inFlight = false;

    const fetchLiveScore = async () => {
      if (inFlight || !active) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      inFlight = true;
      try {
        const data = await apiGet<{
          score?: { finalScore?: number };
        }>(`/weeks/${weekId}/lineups/${walletAddress}/score`);
        if (!active) return;
        const nextScore = Number(data?.score?.finalScore ?? 0);
        setLiveScore(Number.isFinite(nextScore) ? nextScore : 0);
      } catch {
        if (!active) return;
        setLiveScore(0);
      } finally {
        inFlight = false;
      }
    };

    void fetchLiveScore();
    const interval = window.setInterval(() => {
      void fetchLiveScore();
    }, 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchLiveScore();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isWeekActive, walletAddress, weekId]);

  const walletStablecoinBalance = useMemo(() => {
    if (!stablecoinBalance) return 0;
    try {
      return Number(formatUnits(stablecoinBalance, stablecoinDecimals));
    } catch {
      return 0;
    }
  }, [stablecoinBalance, stablecoinDecimals]);
  const committedStablecoinBalance = useMemo(() => {
    if (!onchainDeposit || onchainDeposit <= 0n) return 0;
    try {
      return Number(formatUnits(onchainDeposit, stablecoinDecimals));
    } catch {
      return 0;
    }
  }, [onchainDeposit, stablecoinDecimals]);

  const maxAllocation = Math.max(
    0,
    Math.floor(walletStablecoinBalance + committedStablecoinBalance),
  );
  const minAllocation = Math.max(0, Math.floor(minDepositAmount));
  const needsFaucetTopup = Boolean(walletAddress) && maxAllocation < minAllocation;

  useEffect(() => {
    if (allocation > maxAllocation) {
      setAllocation(maxAllocation);
      setAllocationInput(String(maxAllocation));
    }
  }, [allocation, maxAllocation]);

  const setAllocationValue = useCallback(
    (value: number, raw?: string) => {
      const clamped = Math.min(Math.max(Math.floor(value), 0), maxAllocation);
      setAllocation(clamped);
      setAllocationInput(raw ?? String(clamped));
    },
    [maxAllocation],
  );

  useEffect(() => {
    if (!commitOpen) return;
    if (allocation !== 0) return;
    if (!onchainDeposit || onchainDeposit <= 0n) return;
    try {
      const value = Number(formatUnits(onchainDeposit, stablecoinDecimals));
      if (Number.isFinite(value) && value > 0) {
        setAllocationValue(value, String(Math.floor(value)));
      }
    } catch {
      // ignore parse failures
    }
  }, [allocation, commitOpen, onchainDeposit, setAllocationValue]);

  const depositWei = useMemo(() => {
    if (!allocation || allocation <= 0) return 0n;
    try {
      return parseUnits(String(Math.floor(allocation)), stablecoinDecimals);
    } catch {
      return 0n;
    }
  }, [allocation, stablecoinDecimals]);
  const committedDepositWei = useMemo(() => {
    if (!onchainDeposit || onchainDeposit <= 0n) return 0n;
    return onchainDeposit;
  }, [onchainDeposit]);
  const topUpRequiredWei = useMemo(() => {
    if (depositWei <= committedDepositWei) return 0n;
    return depositWei - committedDepositWei;
  }, [committedDepositWei, depositWei]);

  const isBelowMinDeposit = allocation > 0 && allocation < minAllocation;
  const hasValidDeposit = depositWei > 0n && !isBelowMinDeposit;
  const isOverBalance =
    stablecoinBalance !== null && topUpRequiredWei > 0n && topUpRequiredWei > stablecoinBalance;
  const hasAllowance =
    hasValidDeposit &&
    (topUpRequiredWei === 0n ||
      (stablecoinAllowance !== null && stablecoinAllowance >= topUpRequiredWei));
  const needsApproval =
    Boolean(walletAddress) &&
    hasValidDeposit &&
    topUpRequiredWei > 0n &&
    !isOverBalance &&
    !hasAllowance;
  const canAssign = Boolean(selectedSlot) && !txPending && !isWeekFinalized;

  const baseAssetMetricsById = useMemo(() => {
    const next = new Map<string, ReturnType<typeof deriveAssetMetrics>>();
    for (const asset of coins) {
      next.set(asset.id, deriveAssetMetrics(asset, livePrices, EMPTY_FLASH_STATE));
    }
    return next;
  }, [coins, livePrices]);

  const getAssetCoreMetrics = useCallback(
    (asset: Asset) => {
      const metrics = baseAssetMetricsById.get(asset.id);
      return metrics ?? deriveAssetMetrics(asset, livePrices, EMPTY_FLASH_STATE);
    },
    [baseAssetMetricsById, livePrices],
  );

  const getAssetMetrics = useCallback(
    (asset: Asset) => {
      const coreMetrics = getAssetCoreMetrics(asset);
      const flash = Boolean(priceFlash[asset.symbol.toUpperCase()]);
      if (!flash) {
        return coreMetrics;
      }
      return { ...coreMetrics, flash: true };
    },
    [getAssetCoreMetrics, priceFlash],
  );
  const hasLivePrice = useCallback(
    (asset: Asset) => {
      const value = Number(livePrices[asset.symbol.toUpperCase()]);
      return Number.isFinite(value) && value > 0;
    },
    [livePrices],
  );

  const livePriceCoverage = useMemo(() => {
    if (!coins.length) {
      return { covered: 0, total: 0, missing: 0, ready: false };
    }
    let covered = 0;
    for (const asset of coins) {
      const value = Number(livePrices[asset.symbol.toUpperCase()]);
      if (Number.isFinite(value) && value > 0) {
        covered += 1;
      }
    }
    const total = coins.length;
    const missing = Math.max(total - covered, 0);
    return {
      covered,
      total,
      missing,
      ready: livePricesLoaded && missing === 0,
    };
  }, [coins, livePrices, livePricesLoaded]);

  const spectatorWeekScore = useMemo(
    () =>
      calculateSpectatorWeekScore({
        isSpectatorWeekView,
        slots,
        lineup,
        powerCap,
        getAssetMetrics: getAssetCoreMetrics,
      }),
    [getAssetCoreMetrics, isSpectatorWeekView, lineup, slots],
  );

  const filteredAssets = useMemo(
    () =>
      filterAndSortAssets({
        coins,
        selectedRole,
        search: deferredSearch,
        sortKey,
        sortDir,
        roleOrder,
        getAssetMetrics: getAssetCoreMetrics,
      }),
    [coins, selectedRole, deferredSearch, sortKey, sortDir, getAssetCoreMetrics],
  );
  const assetPoolAssets = useMemo(() => {
    if (!isDraftOpen) {
      return filteredAssets;
    }
    return filteredAssets.filter(hasLivePrice);
  }, [filteredAssets, hasLivePrice, isDraftOpen]);


  const walletBalanceValueLabel = useMemo(() => {
    if (!walletAddress) return "--";
    if (!stablecoinBalance) return `0 ${stablecoinSymbol}`;
    const value = Number(formatUnits(stablecoinBalance, stablecoinDecimals));
    return `${Math.floor(value).toLocaleString()} ${stablecoinSymbol}`;
  }, [stablecoinBalance, stablecoinDecimals, stablecoinSymbol, walletAddress]);

  const depositValue = Math.max(0, allocation);
  const principalValue = Math.max(0, (depositValue * principalRatioBps) / 10000);
  const riskValue = Math.max(0, depositValue - principalValue);
  const hasOnchainCommit = Boolean(onchainDeposit && onchainDeposit > 0n);
  const isWeekLocked = Boolean(weekStatus && weekStatus !== "DRAFT_OPEN" && weekStatus !== "ACTIVE");


  const persistDbLineupSnapshot = useCallback(
    (
      slotsPayload: Array<{ slotId: string; coinId: string }>,
      swapsValue: number,
    ) => {
      const record: Record<string, string | null> = {};
      slotsPayload.forEach((slot) => {
        record[slot.slotId] = slot.coinId || null;
      });
      setDbLineupIds(record);
      setDbLineupFetchState("found");
      setDbLineupChecked(true);
      setSwapCount(swapsValue);
      if (lineupCacheKey) {
        localStorage.removeItem(lineupCacheKey);
      }
    },
    [lineupCacheKey],
  );

  const resolveWalletTxAccount = useCallback(
    async (walletClient: WalletClient): Promise<`0x${string}` | null> => {
      const normalize = (value: unknown): `0x${string}` | null => {
        const text = String(value ?? "").trim();
        if (!/^0x[a-fA-F0-9]{40}$/u.test(text)) return null;
        return text as `0x${string}`;
      };

      const fromClient = normalize(walletClient.account?.address);
      if (fromClient) {
        return fromClient;
      }

      try {
        const listed = await walletClient.request({ method: "eth_accounts" });
        if (Array.isArray(listed) && listed.length > 0) {
          const account = normalize(listed[0]);
          if (account) return account;
        }
      } catch {
        // ignore and try explicit request below
      }

      try {
        const requested = await walletClient.request({ method: "eth_requestAccounts" });
        if (Array.isArray(requested) && requested.length > 0) {
          const account = normalize(requested[0]);
          if (account) return account;
        }
      } catch {
        return null;
      }

      return null;
    },
    [],
  );

  const resolveTxOverrides = useCallback(
    async (walletClient: WalletClient, account: `0x${string}`) => {
      const parseNonce = (value: unknown): number | null => {
        if (typeof value === "number") {
          if (!Number.isFinite(value) || value < 0) return null;
          return Math.floor(value);
        }
        if (typeof value === "bigint") {
          if (value < 0n) return null;
          return Number(value);
        }
        if (typeof value === "string") {
          const raw = value.trim();
          if (!raw) return null;
          const parsed = raw.startsWith("0x") ? Number.parseInt(raw, 16) : Number(raw);
          if (!Number.isFinite(parsed) || parsed < 0) return null;
          return Math.floor(parsed);
        }
        return null;
      };

      try {
        const nonceRaw = await (walletClient as any).request({
          method: "eth_getTransactionCount",
          params: [account, "pending"],
        });
        const nonce = parseNonce(nonceRaw);
        if (nonce !== null) {
          return { nonce };
        }
      } catch {
        // ignore and try public client fallback
      }

      if (!publicClient) {
        return {};
      }
      try {
        const nonceValue = await publicClient.getTransactionCount({
          address: account,
          blockTag: "pending",
        });
        const nonce = parseNonce(nonceValue);
        if (nonce === null) return {};
        return { nonce };
      } catch {
        return {};
      }
    },
    [publicClient],
  );

  const parseWalletTxHash = useCallback((value: unknown): `0x${string}` | null => {
    const parseHash = (candidate: unknown): `0x${string}` | null => {
      const text = typeof candidate === "string" ? candidate.trim() : "";
      if (!/^0x[a-fA-F0-9]{64}$/u.test(text)) return null;
      return text as `0x${string}`;
    };
    const direct = parseHash(value);
    if (direct) return direct;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return parseHash(record.hash) ?? parseHash(record.txHash) ?? parseHash(record.result);
    }
    return null;
  }, []);

  const sendContractWithRawRequest = useCallback(
    async (
      walletClient: WalletClient,
      request: Record<string, unknown> & { account?: `0x${string}`; nonce?: number },
    ): Promise<`0x${string}` | null> => {
      const account = request.account;
      const to = String(request.address ?? "").trim();
      const functionName = String(request.functionName ?? "").trim();
      const abi = request.abi as readonly unknown[] | undefined;
      if (!account || !to || !functionName || !abi?.length) {
        return null;
      }

      let data: `0x${string}`;
      try {
        data = (encodeFunctionData as any)({
          abi: abi as never,
          functionName: functionName as never,
          args: (request.args as readonly unknown[] | undefined) ?? [],
        });
      } catch {
        return null;
      }

      const tx: Record<string, unknown> = { from: account, to, data };
      const nonceValue = request.nonce;
      if (typeof nonceValue === "number" && Number.isFinite(nonceValue) && nonceValue >= 0) {
        tx.nonce = `0x${Math.floor(nonceValue).toString(16)}`;
      }

      const value = request.value;
      if (typeof value === "bigint" && value >= 0n) {
        tx.value = `0x${value.toString(16)}`;
      } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        tx.value = `0x${Math.floor(value).toString(16)}`;
      } else if (typeof value === "string" && value.trim()) {
        tx.value = value.trim();
      }

      try {
        const result = await (walletClient as any).request({
          method: "eth_sendTransaction",
          params: [tx],
        });
        return parseWalletTxHash(result);
      } catch {
        return null;
      }
    },
    [parseWalletTxHash],
  );

  const readAllowanceViaWallet = useCallback(
    async (
      walletClient: WalletClient,
      token: `0x${string}`,
      owner: `0x${string}`,
      spender: `0x${string}`,
    ): Promise<bigint | null> => {
      let data: `0x${string}`;
      try {
        data = (encodeFunctionData as any)({
          abi: stablecoinAbi as never,
          functionName: "allowance" as never,
          args: [owner, spender],
        });
      } catch {
        return null;
      }

      const parseHexBigint = (value: unknown): bigint | null => {
        if (typeof value === "string") {
          const hex = value.trim();
          if (!/^0x[0-9a-fA-F]+$/u.test(hex)) return null;
          try {
            return BigInt(hex);
          } catch {
            return null;
          }
        }
        if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          return parseHexBigint(record.result ?? record.data ?? record.value);
        }
        return null;
      };

      try {
        const result = await (walletClient as any).request({
          method: "eth_call",
          params: [{ to: token, data }, "latest"],
        });
        return parseHexBigint(result);
      } catch {
        return null;
      }
    },
    [],
  );
  const sendWriteContract = useCallback(
    async (
      walletClient: WalletClient,
      request: Record<string, unknown> & { account?: `0x${string}` },
    ): Promise<`0x${string}`> => {
      try {
        return await walletClient.writeContract(request as never);
      } catch (firstError) {
        const message = extractErrorText(firstError).toLowerCase();
        const shouldRetryWithNonce =
          message.includes("unable to calculate nonce") ||
          message.includes("nonce") ||
          message.includes("unable to get transaction hash");

        if (!shouldRetryWithNonce || !request.account) {
          throw firstError;
        }

        const txOverrides = await resolveTxOverrides(walletClient, request.account);
        if (!("nonce" in txOverrides)) {
          if (message.includes("unable to get transaction hash")) {
            const manualHash = await sendContractWithRawRequest(walletClient, request);
            if (manualHash) return manualHash;
          }
          throw firstError;
        }

        try {
          return await walletClient.writeContract({
            ...request,
            ...txOverrides,
          } as never);
        } catch (secondError) {
          const secondMessage = extractErrorText(secondError).toLowerCase();
          if (secondMessage.includes("unable to get transaction hash")) {
            const manualHash = await sendContractWithRawRequest(walletClient, { ...request, ...txOverrides });
            if (manualHash) return manualHash;
          }
          throw secondError;
        }
      }
    },
    [resolveTxOverrides, sendContractWithRawRequest],
  );

  const postOracleWithWalletRetry = useCallback(
    async (path: string, body: unknown) => {
      const sendRequest = () =>
        fetch(`/api/oracle${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });

      let response = await sendRequest();
      let payload = await response.json().catch(() => ({}));

      if ((response.status === 401 || response.status === 403) && walletAddress) {
        const refreshed = await refreshWalletSession({ force: true });
        if (refreshed) {
          response = await sendRequest();
          payload = await response.json().catch(() => ({}));
        }
      }

      return { response, payload };
    },
    [refreshWalletSession, walletAddress],
  );
  const prepareLineupIntent = useCallback(
    async (input: {
      source: "commit" | "swap";
      slotsPayload: Array<{ slotId: string; coinId: string }>;
      swap?: {
        slotId: string;
        removedSymbol: string;
        addedSymbol: string;
      };
    }) => {
      if (!weekId || !walletAddress) {
        throw new Error("Wallet or week not ready");
      }
      const { response, payload } = await postOracleWithWalletRetry("/lineups/intents", {
        weekId,
        address: walletAddress,
        source: input.source,
        slots: input.slotsPayload,
        swap: input.source === "swap" ? input.swap : undefined,
      });
      if (!response.ok) {
        throw new Error((payload as { error?: string })?.error ?? `Intent create failed (${response.status})`);
      }
      const intentId = String((payload as { intent?: { id?: string } })?.intent?.id ?? "").trim();
      if (!intentId) {
        throw new Error("Intent id missing");
      }
      return intentId;
    },
    [postOracleWithWalletRetry, walletAddress, weekId],
  );

  const submitLineupIntent = useCallback(
    async (input: {
      intentId: string;
      txHash: `0x${string}`;
      slotsPayload: Array<{ slotId: string; coinId: string }>;
      swaps: number;
      txConfirmed?: boolean;
    }) => {
      if (!walletAddress) return false;
      const txConfirmed = Boolean(input.txConfirmed);
      try {
        const { response, payload } = await postOracleWithWalletRetry(
          `/lineups/intents/${encodeURIComponent(input.intentId)}/submit`,
          {
            address: walletAddress,
            txHash: input.txHash,
          },
        );

        if (!response.ok) {
          throw new Error((payload as { error?: string })?.error ?? `Strategy sync failed (${response.status})`);
        }

        const syncPayload = payload as {
          ok: boolean;
          synced: boolean;
          healing: boolean;
          requiresAttention?: boolean;
          task?: { id?: number; status?: string };
        };

        if (syncPayload.synced) {
          persistDbLineupSnapshot(input.slotsPayload, input.swaps);
        }
        void fetchDbLineup();

        if (syncPayload.requiresAttention) {
          showToast("On-chain update confirmed. Oracle sync needs manual attention.", "warn");
          return false;
        }

        if (!syncPayload.synced || syncPayload.healing) {
          showToast(
            txConfirmed
              ? "On-chain update confirmed. Syncing data in background."
              : "Transaction submitted. Syncing data after confirmation.",
            "info",
          );
          return false;
        }

        return true;
      } catch {
        void fetchDbLineup();
        showToast(
          `${
            txConfirmed ? "On-chain update confirmed." : "Transaction submitted."
          } Sync submit failed (intent ${input.intentId.slice(0, 8)}).`,
          "warn",
        );
        return false;
      }
    },
    [fetchDbLineup, persistDbLineupSnapshot, postOracleWithWalletRetry, showToast, walletAddress],
  );
  const cancelLineupIntent = useCallback(
    async (intentId: string, reason: string) => {
      if (!walletAddress || !intentId) return;
      try {
        await postOracleWithWalletRetry(`/lineups/intents/${encodeURIComponent(intentId)}/cancel`, {
          address: walletAddress,
          reason,
        });
      } catch {
        // best-effort cleanup only
      }
    },
    [postOracleWithWalletRetry, walletAddress],
  );
  const handleSlotClick = useCallback((slotId: string) => {
    if (txPending || isWeekFinalized) return;
    if (isWeekActive && !canUseWeekControls) return;
    if (pendingAction && pendingAction.slotId !== slotId) {
      setPendingAction(null);
    }
    startUiTransition(() => {
      setSelectedSlotId(slotId);
    });
  }, [canUseWeekControls, isWeekActive, pendingAction, startUiTransition, txPending, weekStatus]);

  const commitSlot = useCallback((slotId: string, asset: Asset) => {
    setLineup((prev) => ({ ...prev, [slotId]: asset }));
    setPendingAction(null);
    setToast(null);
    setSlotEffects((prev) => ({ ...prev, [slotId]: "added" }));
    if (slotEffectTimers.current[slotId]) {
      window.clearTimeout(slotEffectTimers.current[slotId]);
    }
    slotEffectTimers.current[slotId] = window.setTimeout(() => {
      setSlotEffects((prev) => {
        const next = { ...prev };
        delete next[slotId];
        return next;
      });
      delete slotEffectTimers.current[slotId];
    }, 1000);
  }, []);

  const handleAssignAsset = useCallback((asset: Asset) => {
    if (isSpectatorWeekView) return;
    if (txPending || isWeekFinalized) return;
    if (!selectedSlot) {
      if (isDraftOpen) {
        return;
      }
      showToast("Select a slot to begin.");
      return;
    }
    if (assignedIds.has(asset.id)) {
      showToast("This asset is already assigned.", "warn");
      return;
    }
    const selectedSlotAsset = selectedSlot ? lineup[selectedSlot.id] : null;
    if (asset.salary > availableBudget) {
      return;
    }

    if (selectedSlotAsset) {
      if (weekStatus === "LOCKED") {
        showToast("Epoch locked. Reallocations start when the epoch is active.", "warn");
        return;
      }
      if (weekStatus === "ACTIVE") {
        if (!swapMode) {
          showToast("Enable Reallocation Mode to update your strategy allocation.", "warn");
          return;
        }
        if (swapsRemaining <= 0) {
          showToast("No Tactical Moves remaining this epoch", "warn");
          return;
        }
        setPendingAction({
          type: "swap",
          slotId: selectedSlot.id,
          previous: selectedSlotAsset,
          next: asset,
        });
        return;
      }
      commitSlot(selectedSlot.id, asset);
      return;
    }

    commitSlot(selectedSlot.id, asset);
  }, [
    assignedIds,
    availableBudget,
    commitSlot,
    isDraftOpen,
    isSpectatorWeekView,
    lineup,
    selectedSlot,
    showToast,
    swapMode,
    swapsRemaining,
    txPending,
    weekStatus,
  ]);

  const handleClearSlot = (slotId: string) => {
    if (txPending || isWeekFinalized) return;
    const slotAsset = lineup[slotId];
    if (!slotAsset) return;
    if (weekStatus === "LOCKED") {
      showToast("Epoch locked. Reallocations start when the epoch is active.", "warn");
      return;
    }
    if (weekStatus === "ACTIVE") {
      showToast("Use Reallocation Mode to replace assets during the active epoch.", "warn");
      return;
    }
    performRemove(slotId);
  };
  const assetPoolRows = useMemo(() => {
    if (coinsLoading && coins.length === 0) {
      return <div className="recruit-empty">Loading assets...</div>;
    }
    if (coinsError && coins.length === 0) {
      return <div className="recruit-empty">{coinsError}</div>;
    }
    if (isDraftOpen && filteredAssets.length > 0 && assetPoolAssets.length === 0) {
      return (
        <div className="recruit-empty">
          Live prices syncing ({livePriceCoverage.covered}/{livePriceCoverage.total})
        </div>
      );
    }
    if (assetPoolAssets.length === 0) {
      return <div className="recruit-empty">No assets match this role.</div>;
    }
    return assetPoolAssets.map((asset) => {
      const metrics = getAssetMetrics(asset);
      const isAssigned = assignedIds.has(asset.id);
      const isDraftPassive =
        !isSpectatorWeekView && isDraftOpen && !selectedSlot && !txPending;
      const rowDisabled =
        !isSpectatorWeekView &&
        !isDraftPassive &&
        (isAssigned || asset.salary > availableBudget || !canAssign);
      return (
        <AssetPoolRow
          key={asset.id}
          asset={asset}
          metrics={metrics}
          isWeekActive={isWeekActive}
          isDraftPassive={isDraftPassive}
          rowDisabled={rowDisabled}
          onAssign={handleAssignAsset}
        />
      );
    });
  }, [
    assetPoolAssets,
    assignedIds,
    availableBudget,
    canAssign,
    coins.length,
    coinsError,
    coinsLoading,
    filteredAssets.length,
    getAssetMetrics,
    handleAssignAsset,
    isDraftOpen,
    isSpectatorWeekView,
    isWeekActive,
    livePriceCoverage.covered,
    livePriceCoverage.total,
    selectedSlot,
    txPending,
  ]);

  const confirmAction = async () => {
    if (!pendingAction) return;
    const requiresMove = Boolean(weekStatus && weekStatus !== "DRAFT_OPEN");
    if (requiresMove && swapsRemaining <= 0) {
      showToast("No Tactical Moves remaining this epoch", "warn");
      setPendingAction(null);
      return;
    }

    if (pendingAction.type === "remove") {
      performRemove(pendingAction.slotId);
      setPendingAction(null);
      return;
    }

    if (!pendingAction.next || !pendingAction.previous) {
      setPendingAction(null);
      return;
    }

    if (weekStatus === "ACTIVE") {
      if (!walletAddress || !weekId || !valcoreAddress) {
        showToast("Wallet or week not ready.", "warn");
        return;
      }
      const chainReady = await ensureChain();
      if (!chainReady) {
        if (isStarknet) {
          const wallet = getStarknetWallet();
          const maybeAddress = String(wallet?.provider.account?.address ?? wallet?.provider.selectedAddress ?? walletAddress ?? "").trim();
          if (!maybeAddress) {
            showToast("Reconnect Starknet wallet to continue.", "warn");
            return;
          }
        }
        showToast(`Switch to ${chainLabel} to continue.`, "warn");
        return;
      }

      if (isStarknet) {
        const starknetWallet = getStarknetWallet();
        if (!starknetWallet) {
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "wallet-starknet-signer",
            message: "Starknet wallet signer unavailable",
            fingerprint: "wallet:starknet:signer-unavailable",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast("Starknet wallet signer unavailable. Reconnect and retry.", "warn");
          return;
        }

        const nextLineup = { ...lineup, [pendingAction.slotId]: pendingAction.next };
        const lineupHash = buildLineupHash(weekId, walletAddress, nextLineup, slots);
        const slotsPayload = slots.map((slot) => ({
          slotId: slot.id,
          coinId: nextLineup[slot.id]?.id ?? "",
        }));

        let intentId = "";
        try {
          intentId = await prepareLineupIntent({
            source: "swap",
            slotsPayload,
            swap: {
              slotId: pendingAction.slotId,
              removedSymbol: pendingAction.previous.symbol,
              addedSymbol: pendingAction.next.symbol,
            },
          });
        } catch {
          showToast("Swap intent could not be created.", "warn");
          return;
        }

        setTxPending(true);
        let swapHash: `0x${string}` | null = null;
        let txConfirmed = false;
        try {
          swapHash = await swapStarknetLineup(starknetWallet, valcoreAddress, weekId, lineupHash);
          await submitLineupIntent({
            intentId,
            txHash: swapHash,
            slotsPayload,
            swaps: swapCount + 1,
            txConfirmed: false,
          });

          try {
            await waitForStarknetTx(activeProfile.rpcUrl, swapHash);
            txConfirmed = true;
          } catch (waitError) {
            if (!isReceiptWaitTimeoutError(waitError)) {
              throw waitError;
            }
            showToast("Transaction submitted. Confirmation is delayed; sync continues in background.", "info");
          }

          if (txConfirmed) {
            const nextSwapCount = swapCount + 1;
            setSwapCount(nextSwapCount);
            performSwap(pendingAction.slotId, pendingAction.next);
            setPendingAction(null);
            setSwapConfirmSlotId(null);
            if (selectedCandidate) {
              setDeployedCandidateId(selectedCandidate.id);
              setTimeout(() => {
                setDeployedCandidateId(null);
              }, 800);
              setExecutedRole(selectedCandidate.role);
              setTimeout(() => {
                setExecutedRole(null);
              }, 600);
            }
            clearCandidate();
            showToast("Swap confirmed.");
            void refreshStablecoinBalance();
          }
        } catch (error) {
          if (!swapHash) {
            await cancelLineupIntent(intentId, "swap_send_failed_before_hash");
          }
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "lineup-swap",
            message: mapSwapError(error),
            fingerprint: "lineup:swap:write-failed:starknet",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              slotId: pendingAction.slotId,
              removedSymbol: pendingAction.previous.symbol,
              addedSymbol: pendingAction.next.symbol,
              rawError: extractErrorText(error),
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast(mapSwapError(error), "warn");
        } finally {
          setTxPending(false);
        }
        return;
      }

      const walletClient = getWalletClient() as WalletClient | null;
      if (!walletClient) {
        showToast("Wallet provider unavailable. Reconnect and retry.", "warn");
        return;
      }
      const txAccount = await resolveWalletTxAccount(walletClient);
      if (!txAccount) {
        showToast("Wallet account unavailable. Reconnect wallet and retry.", "warn");
        await connect();
        return;
      }

      const nextLineup = { ...lineup, [pendingAction.slotId]: pendingAction.next };
      const lineupHash = buildLineupHash(weekId, walletAddress, nextLineup, slots);
      const slotsPayload = slots.map((slot) => ({
        slotId: slot.id,
        coinId: nextLineup[slot.id]?.id ?? "",
      }));

      let intentId = "";
      try {
        intentId = await prepareLineupIntent({
          source: "swap",
          slotsPayload,
          swap: {
            slotId: pendingAction.slotId,
            removedSymbol: pendingAction.previous.symbol,
            addedSymbol: pendingAction.next.symbol,
          },
        });
      } catch {
        showToast("Swap intent could not be created.", "warn");
        return;
      }

      setTxPending(true);
      let swapHash: `0x${string}` | null = null;
      let txConfirmed = false;
      try {
        const league = valcoreAddress as `0x${string}`;
        swapHash = await sendWriteContract(walletClient, {
          address: league,
          abi: valcoreAbi,
          functionName: "swapLineup",
          args: [BigInt(weekId), lineupHash],
          account: txAccount,
          chain: activeChain,
        });

        const syncOk = await submitLineupIntent({
          intentId,
          txHash: swapHash,
          slotsPayload,
          swaps: swapCount + 1,
          txConfirmed: false,
        });

        if (publicClient) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
            if (receipt.status !== "success") {
              throw new Error("Swap reverted");
            }
            txConfirmed = true;
          } catch (waitError) {
            if (!isReceiptWaitTimeoutError(waitError)) {
              throw waitError;
            }
            showToast("Transaction submitted. Confirmation is delayed; sync continues in background.", "info");
          }
        } else {
          txConfirmed = true;
        }

        if (txConfirmed) {
          const nextSwapCount = swapCount + 1;
          setSwapCount(nextSwapCount);
          performSwap(pendingAction.slotId, pendingAction.next);
          setPendingAction(null);
          setSwapConfirmSlotId(null);
          if (selectedCandidate) {
            setDeployedCandidateId(selectedCandidate.id);
            setTimeout(() => {
              setDeployedCandidateId(null);
            }, 800);
            setExecutedRole(selectedCandidate.role);
            setTimeout(() => {
              setExecutedRole(null);
            }, 600);
          }
          clearCandidate();

          if (syncOk) {
            showToast("Swap confirmed.");
          }
          void refreshStablecoinBalance();
        }
      } catch (error) {
        if (!swapHash) {
          await cancelLineupIntent(intentId, "swap_send_failed_before_hash");
        }
        void reportClientError({
          source: "web-client",
          severity: "error",
          category: "lineup-swap",
          message: mapSwapError(error),
          fingerprint: "lineup:swap:write-failed:evm",
          path: window.location.pathname,
          walletAddress,
          context: {
            weekId,
            chainId: activeProfile.chainId,
            slotId: pendingAction.slotId,
            removedSymbol: pendingAction.previous.symbol,
            addedSymbol: pendingAction.next.symbol,
            rawError: extractErrorText(error),
          },
        });
        showToast(mapSwapError(error), "warn");
      } finally {
        setTxPending(false);
      }
      return;
    }

    if (requiresMove) {
      setSwapCount((prev) => Math.min(prev + 1, totalMoves));
    }
    performSwap(pendingAction.slotId, pendingAction.next);
    setPendingAction(null);
  };
  const cancelAction = () => {
    setPendingAction(null);
  };

  const handleApprove = async () => {
    if (!walletAddress) {
      showToast("Connect your wallet first.", "warn");
      return;
    }
    const chainReady = await ensureChain();
    if (!chainReady) {
      if (isStarknet) {
        const wallet = getStarknetWallet();
        const maybeAddress = String(wallet?.provider.account?.address ?? wallet?.provider.selectedAddress ?? walletAddress ?? "").trim();
        const expectedChain = expectedStarknetChainHex(activeProfile.networkKey);
        const connectedChain = normalizeStarknetChainHex(wallet?.provider.chainId);

        if (!maybeAddress) {
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "wallet-starknet-ready",
            message: "Starknet wallet connect not completed in extension",
            fingerprint: "wallet:starknet:connect-incomplete",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast("Complete Starknet wallet connect in extension, then retry.", "warn");
          return;
        }

        if (connectedChain && connectedChain !== expectedChain) {
          showToast(`Switch to ${chainLabel} to continue.`, "warn");
          return;
        }

        void reportClientError({
          source: "web-client",
          severity: "error",
          category: "wallet-starknet-ready",
          message: "Starknet wallet is not ready",
          fingerprint: "wallet:starknet:not-ready",
          path: window.location.pathname,
          walletAddress,
          context: {
            weekId,
            chainId: activeProfile.chainId,
            expectedChain,
            connectedChain,
            walletDebug: getStarknetWalletDebugState(),
          },
        });
        showToast("Starknet wallet is not ready. Open the extension and retry.", "warn");
        return;
      }

      showToast(`Switch to ${chainLabel} to continue.`, "warn");
      return;
    }
    if (!stablecoinAddress || !valcoreAddress) {
      showToast("Contract addresses are missing.", "warn");
      return;
    }
    if (isBelowMinDeposit) {
      showToast(`Minimum deposit is ${minAllocation.toLocaleString()} ${stablecoinSymbol}.`, "warn");
      return;
    }
    if (!hasValidDeposit) {
      showToast("Enter a valid deposit amount.", "warn");
      return;
    }
    if (isOverBalance) {
      showToast("Deposit exceeds your stablecoin balance.", "warn");
      return;
    }

    if (isStarknet) {
      const starknetWallet = getStarknetWallet();
      if (!starknetWallet) {
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "wallet-starknet-signer",
            message: "Starknet wallet signer unavailable",
            fingerprint: "wallet:starknet:signer-unavailable",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast("Starknet wallet signer unavailable. Reconnect and retry.", "warn");
          return;
        }

      setTxPending(true);
      const amount = topUpRequiredWei;
      try {
        if (amount <= 0n) {
          showToast("No additional approval required.", "info");
          return;
        }

        const hash = await approveStarknetStablecoin(starknetWallet, stablecoinAddress, valcoreAddress, amount);
        await waitForStarknetTx(activeProfile.rpcUrl, hash);
        showToast("Approval confirmed.");
        void refreshStablecoinBalance();
      } catch (error) {
        try {
          if (walletAddress && stablecoinAddress && valcoreAddress && amount > 0n) {
            const firstRead = await readStarknetStablecoinAllowance(
              activeProfile.rpcUrl,
              stablecoinAddress,
              walletAddress,
              valcoreAddress,
            );
            if (firstRead >= amount) {
              showToast("Approval confirmed.");
              void refreshStablecoinBalance();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 1200));
            const secondRead = await readStarknetStablecoinAllowance(
              activeProfile.rpcUrl,
              stablecoinAddress,
              walletAddress,
              valcoreAddress,
            );
            if (secondRead >= amount) {
              showToast("Approval confirmed.");
              void refreshStablecoinBalance();
              return;
            }
          }
        } catch {
          // ignore allowance recovery read errors and fall through to mapped error
        }

        const mappedError = mapApproveError(error);
        void reportClientError({
          source: "web-client",
          severity: "error",
          category: "wallet-approve",
          message: mappedError,
          fingerprint: "lineup:approve:write-failed",
          path: window.location.pathname,
          walletAddress,
          context: {
            walletAddress,
            txAccount: null,
            chainId: activeProfile.chainId,
            stablecoinAddress,
            valcoreAddress,
            topUpRequiredWei: topUpRequiredWei.toString(),
            rawError: extractErrorText(error),
          },
        });
        showToast(mappedError, "warn");
      } finally {
        setTxPending(false);
      }
      return;
    }

    const walletClient = getWalletClient() as WalletClient | null;
    if (!walletClient) {
      showToast("Wallet provider unavailable. Reconnect and retry.", "warn");
      return;
    }
    if (!publicClient) {
      showToast("RPC not ready.", "warn");
      return;
    }
    const txAccount = await resolveWalletTxAccount(walletClient);
    if (!txAccount) {
      showToast("Wallet account unavailable. Reconnect wallet and retry.", "warn");
      await connect();
      return;
    }

    setTxPending(true);
    try {
      const amount = topUpRequiredWei;
      if (amount <= 0n) {
        showToast("No additional approval required.", "info");
        return;
      }

      const stablecoinToken = stablecoinAddress as `0x${string}`;
      const league = valcoreAddress as `0x${string}`;

      const readLiveAllowance = async (): Promise<bigint> => {
        try {
          const value = await publicClient.readContract({
            address: stablecoinToken,
            abi: stablecoinAbi,
            functionName: "allowance",
            args: [txAccount, league],
          });
          return (value as bigint) ?? 0n;
        } catch {
          const viaWallet = await readAllowanceViaWallet(walletClient, stablecoinToken, txAccount, league);
          return viaWallet ?? 0n;
        }
      };

      const sendApprove = async (value: bigint) => {
        let gas: bigint | undefined;
        try {
          gas = await publicClient.estimateContractGas({
            address: stablecoinToken,
            abi: stablecoinAbi,
            functionName: "approve",
            args: [league, value],
            account: txAccount,
          });
        } catch {
          gas = 120000n;
        }

        const hash = await sendWriteContract(walletClient, {
          address: stablecoinToken,
          abi: stablecoinAbi,
          functionName: "approve",
          args: [league, value],
          account: txAccount,
          chain: activeChain,
          ...(gas ? { gas } : {}),
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error("Approval reverted");
        }
      };

      try {
        await sendApprove(amount);
      } catch (approveError) {
        if (isWalletSessionApproveError(extractErrorText(approveError))) {
          const firstRead = await readLiveAllowance();
          if (firstRead >= amount) {
            showToast("Approval confirmed.");
            void refreshStablecoinBalance();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const secondRead = await readLiveAllowance();
          if (secondRead >= amount) {
            showToast("Approval confirmed.");
            void refreshStablecoinBalance();
            return;
          }
          throw new Error(APPROVE_RECOVERY_MESSAGE);
        }
        throw approveError;
      }

      showToast("Approval confirmed.");
      void refreshStablecoinBalance();
    } catch (error) {
      const mappedError = mapApproveError(error);
      void reportClientError({
        source: "web-client",
        severity: "error",
        category: "wallet-approve",
        message: mappedError,
        fingerprint: "lineup:approve:write-failed",
        path: window.location.pathname,
        walletAddress,
        context: {
          walletAddress,
          txAccount,
          chainId: activeProfile.chainId,
          stablecoinAddress,
          valcoreAddress,
          topUpRequiredWei: topUpRequiredWei.toString(),
          rawError: extractErrorText(error),
        },
      });
      showToast(mappedError, "warn");
    } finally {
      setTxPending(false);
    }
  };
  const handleLockLineup = async () => {
    if (!walletAddress) {
      showToast("Connect your wallet first.", "warn");
      return;
    }
    const chainReady = await ensureChain();
    if (!chainReady) {
      if (isStarknet) {
        const wallet = getStarknetWallet();
        const maybeAddress = String(wallet?.provider.account?.address ?? wallet?.provider.selectedAddress ?? walletAddress ?? "").trim();
        const expectedChain = expectedStarknetChainHex(activeProfile.networkKey);
        const connectedChain = normalizeStarknetChainHex(wallet?.provider.chainId);

        if (!maybeAddress) {
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "wallet-starknet-ready",
            message: "Starknet wallet connect not completed in extension",
            fingerprint: "wallet:starknet:connect-incomplete",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast("Complete Starknet wallet connect in extension, then retry.", "warn");
          return;
        }

        if (connectedChain && connectedChain !== expectedChain) {
          showToast(`Switch to ${chainLabel} to continue.`, "warn");
          return;
        }

        void reportClientError({
          source: "web-client",
          severity: "error",
          category: "wallet-starknet-ready",
          message: "Starknet wallet is not ready",
          fingerprint: "wallet:starknet:not-ready",
          path: window.location.pathname,
          walletAddress,
          context: {
            weekId,
            chainId: activeProfile.chainId,
            expectedChain,
            connectedChain,
            walletDebug: getStarknetWalletDebugState(),
          },
        });
        showToast("Starknet wallet is not ready. Open the extension and retry.", "warn");
        return;
      }

      showToast(`Switch to ${chainLabel} to continue.`, "warn");
      return;
    }
    if (!weekId) {
      showToast("Epoch data not ready.", "warn");
      return;
    }
    if (!valcoreAddress) {
      showToast("Valcore contract missing.", "warn");
      return;
    }
    if (!isLockReady) {
      showToast("Fill all slots before locking.", "warn");
      return;
    }
    if (isBelowMinDeposit) {
      showToast(`Minimum deposit is ${minAllocation.toLocaleString()} ${stablecoinSymbol}.`, "warn");
      return;
    }
    if (!hasValidDeposit) {
      showToast("Enter a valid deposit amount.", "warn");
      return;
    }
    if (isOverBalance) {
      showToast("Deposit exceeds your stablecoin balance.", "warn");
      return;
    }
    if (!hasAllowance) {
      showToast("Approve stablecoin before locking strategy.", "warn");
      return;
    }

    if (isStarknet) {
      const starknetWallet = getStarknetWallet();
      if (!starknetWallet) {
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "wallet-starknet-signer",
            message: "Starknet wallet signer unavailable",
            fingerprint: "wallet:starknet:signer-unavailable",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast("Starknet wallet signer unavailable. Reconnect and retry.", "warn");
          return;
        }

      try {
        const [onchainWeekState, onchainTestMode] = await Promise.all([
          readStarknetWeekState(activeProfile.rpcUrl, valcoreAddress, weekId),
          readStarknetTestMode(activeProfile.rpcUrl, valcoreAddress),
        ]);

        if (onchainWeekState.status !== 1) {
          if (onchainWeekState.status !== 0) {
            const label = describeStarknetWeekStatus(onchainWeekState.status);
            showToast(`On-chain epoch state is ${label}. Refresh and try again.`, "warn");
            return;
          }
          // status=0 can be a stale RPC read; continue and let tx decide with canonical chain error.
        }

        if (onchainWeekState.status === 1) {
          const nowSeconds = Math.floor(Date.now() / 1000);
          if (!onchainTestMode && onchainWeekState.lockAt > 0 && nowSeconds >= onchainWeekState.lockAt) {
            showToast("Draft is already closed on-chain.", "warn");
            return;
          }
        }
      } catch (error) {
        const details = extractErrorText(error);
        showToast(details ? `On-chain draft check failed: ${details}` : "On-chain draft check failed.", "warn");
        return;
      }

      const lineupHash = buildLineupHash(weekId, walletAddress, lineup, slots);
      const slotsPayload = slots.map((slot) => ({
        slotId: slot.id,
        coinId: lineup[slot.id]?.id ?? "",
      }));

      let intentId = "";
      try {
        intentId = await prepareLineupIntent({
          source: "commit",
          slotsPayload,
        });
      } catch {
        showToast("Strategy intent could not be created.", "warn");
        return;
      }

      setTxPending(true);
      let commitHash: `0x${string}` | null = null;
      let txConfirmed = false;
      try {
        const amount = depositWei;
        commitHash = await commitStarknetLineup(starknetWallet, valcoreAddress, weekId, lineupHash, amount);

        await submitLineupIntent({
          intentId,
          txHash: commitHash,
          slotsPayload,
          swaps: 0,
          txConfirmed: false,
        });

        try {
          await waitForStarknetTx(activeProfile.rpcUrl, commitHash);
          txConfirmed = true;
        } catch (waitError) {
          if (!isReceiptWaitTimeoutError(waitError)) {
            throw waitError;
          }
          showToast("Transaction submitted. Confirmation is delayed; sync continues in background.", "info");
        }

        if (txConfirmed) {
          showToast("Strategy committed on-chain.");
        }
        setOnchainDeposit(amount);
        setCommitOpen(false);
        void refreshStablecoinBalance();
        void refreshPosition();
      } catch (error) {
        if (!commitHash) {
          await cancelLineupIntent(intentId, "commit_send_failed_before_hash");
        }
        showToast(mapLineupLockError(error), "warn");
      } finally {
        setTxPending(false);
      }
      return;
    }

    const walletClient = getWalletClient() as WalletClient | null;
    if (!walletClient) {
      showToast("Wallet provider unavailable. Reconnect and retry.", "warn");
      return;
    }
    if (!publicClient) {
      showToast("RPC not ready.", "warn");
      return;
    }
    const txAccount = await resolveWalletTxAccount(walletClient);
    if (!txAccount) {
      showToast("Wallet account unavailable. Reconnect wallet and retry.", "warn");
      await connect();
      return;
    }
    const chainClient = publicClient;

    try {
      const leagueAddress = valcoreAddress as `0x${string}`;
      const [onchainWeekState, onchainTestMode] = await Promise.all([
        chainClient.readContract({
          address: leagueAddress,
          abi: valcoreAbi,
          functionName: "weekStates",
          args: [BigInt(weekId)],
        }),
        chainClient.readContract({
          address: leagueAddress,
          abi: valcoreAbi,
          functionName: "testMode",
        }),
      ]);

      const status = Number(
        (onchainWeekState as { status?: bigint | number } | null)?.status ??
          (Array.isArray(onchainWeekState) ? onchainWeekState[4] : 0),
      );

      if (status !== 1) {
        showToast("On-chain epoch is not Draft Open. Refresh and try again.", "warn");
        return;
      }

      const lockAt = Number(
        (onchainWeekState as { lockAt?: bigint | number } | null)?.lockAt ??
          (Array.isArray(onchainWeekState) ? onchainWeekState[1] : 0),
      );
      const latestBlock = await chainClient.getBlock({ blockTag: "latest" });
      const nowSeconds = Number(latestBlock.timestamp);
      if (!Boolean(onchainTestMode) && lockAt > 0 && nowSeconds >= lockAt) {
        showToast("Draft is already closed on-chain.", "warn");
        return;
      }
    } catch (error) {
      const details = extractErrorText(error);
      showToast(details ? `On-chain draft check failed: ${details}` : "On-chain draft check failed.", "warn");
      return;
    }

    const lineupHash = buildLineupHash(weekId, walletAddress, lineup, slots);
    const slotsPayload = slots.map((slot) => ({
      slotId: slot.id,
      coinId: lineup[slot.id]?.id ?? "",
    }));

    let intentId = "";
    try {
      intentId = await prepareLineupIntent({
        source: "commit",
        slotsPayload,
      });
    } catch {
      showToast("Strategy intent could not be created.", "warn");
      return;
    }

    setTxPending(true);
    let commitHash: `0x${string}` | null = null;
    let txConfirmed = false;
    try {
      const amount = depositWei;
      const league = valcoreAddress as `0x${string}`;
      commitHash = await sendWriteContract(walletClient, {
        address: league,
        abi: valcoreAbi,
        functionName: "commitLineup",
        args: [BigInt(weekId), lineupHash, amount],
        account: txAccount,
        chain: activeChain,
      });

      const syncOk = await submitLineupIntent({
        intentId,
        txHash: commitHash,
        slotsPayload,
        swaps: 0,
        txConfirmed: false,
      });

      try {
        const receipt = await chainClient.waitForTransactionReceipt({ hash: commitHash });
        if (receipt.status !== "success") {
          throw new Error("Commit reverted");
        }
        txConfirmed = true;
      } catch (waitError) {
        if (!isReceiptWaitTimeoutError(waitError)) {
          throw waitError;
        }
        showToast("Transaction submitted. Confirmation is delayed; sync continues in background.", "info");
      }

      if (txConfirmed) {
        if (syncOk) {
          showToast("Strategy committed on-chain.");
        }
        setOnchainDeposit(amount);
        setCommitOpen(false);
        void refreshStablecoinBalance();
        void refreshPosition();
      }
    } catch (error) {
      if (!commitHash) {
        await cancelLineupIntent(intentId, "commit_send_failed_before_hash");
      }
      showToast(mapLineupLockError(error), "warn");
    } finally {
      setTxPending(false);
    }
  };

  const handleRequestFaucet = async () => {
    if (!walletAddress) {
      showToast("Connect your wallet first.", "warn");
      return;
    }
    const chainReady = await ensureChain();
    if (!chainReady) {
      if (isStarknet) {
        const wallet = getStarknetWallet();
        const maybeAddress = String(wallet?.provider.account?.address ?? wallet?.provider.selectedAddress ?? walletAddress ?? "").trim();
        const expectedChain = expectedStarknetChainHex(activeProfile.networkKey);
        const connectedChain = normalizeStarknetChainHex(wallet?.provider.chainId);

        if (!maybeAddress) {
          void reportClientError({
            source: "web-client",
            severity: "error",
            category: "wallet-starknet-ready",
            message: "Starknet wallet connect not completed in extension",
            fingerprint: "wallet:starknet:connect-incomplete",
            path: window.location.pathname,
            walletAddress,
            context: {
              weekId,
              chainId: activeProfile.chainId,
              walletDebug: getStarknetWalletDebugState(),
            },
          });
          showToast("Complete Starknet wallet connect in extension, then retry.", "warn");
          return;
        }

        if (connectedChain && connectedChain !== expectedChain) {
          showToast(`Switch to ${chainLabel} to continue.`, "warn");
          return;
        }

        void reportClientError({
          source: "web-client",
          severity: "error",
          category: "wallet-starknet-ready",
          message: "Starknet wallet is not ready",
          fingerprint: "wallet:starknet:not-ready",
          path: window.location.pathname,
          walletAddress,
          context: {
            weekId,
            chainId: activeProfile.chainId,
            expectedChain,
            connectedChain,
            walletDebug: getStarknetWalletDebugState(),
          },
        });
        showToast("Starknet wallet is not ready. Open the extension and retry.", "warn");
        return;
      }

      showToast(`Switch to ${chainLabel} to continue.`, "warn");
      return;
    }
    if (txPending) {
      return;
    }

    setTxPending(true);
    try {
      const { response, payload } = await postOracleWithWalletRetry("/faucet", {
        address: walletAddress,
      });

      const faucetPayload = payload as {
        error?: string;
        retryAfterSeconds?: number;
        txHash?: string;
        amount?: string;
      };
      if (!response.ok) {
        if (faucetPayload.retryAfterSeconds) {
          const totalSeconds = Number(faucetPayload.retryAfterSeconds);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const parts: string[] = [];
          if (hours > 0) parts.push(`${hours}h`);
          if (minutes > 0) parts.push(`${minutes}m`);
          showToast(`Faucet cooldown. Try again in ${parts.join(" ") || "soon"}.`, "warn");
        } else {
          showToast(faucetPayload.error ?? "Faucet failed.", "warn");
        }
        return;
      }

      const txHash = typeof faucetPayload.txHash === "string" ? faucetPayload.txHash : null;
      if (txHash) {
        try {
          if (isStarknet) {
            await waitForStarknetTx(activeProfile.rpcUrl, txHash as `0x${string}`);
          } else if (publicClient) {
            await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
          }
        } catch {
          // Continue with balance refresh attempts even if receipt polling fails.
        }
      }

      showToast(
        `Faucet sent: ${faucetPayload.amount ?? "200"} ${stablecoinSymbol}`,
        "info",
        txHash && activeProfile.explorerUrl
          ? `${activeProfile.explorerUrl}/tx/${txHash}`
          : undefined,
      );

      const refreshDelaysMs = [0, 1200, 2500, 5000, 9000];
      for (const delayMs of refreshDelaysMs) {
        if (delayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        }
        await refreshStablecoinBalance();
      }
    } catch {
      showToast("Faucet failed.", "warn");
    } finally {
      setTxPending(false);
    }
  };

  const handleCommitAction = async () => {
    if (!walletAddress) {
      await connect();
      return;
    }
    if (needsFaucetTopup) {
      await handleRequestFaucet();
      return;
    }
    if (needsApproval) {
      await handleApprove();
      return;
    }
    await handleLockLineup();
  };

  const commitActionLabel = useMemo(() => {
    if (!walletAddress) return "CONNECT WALLET";
    if (txPending) return "PROCESSING...";
    if (needsFaucetTopup) return "GET FAUCET";
    if (isBelowMinDeposit) return `MIN ${minAllocation.toLocaleString()} ${stablecoinSymbol}`;
    if (!hasValidDeposit) return "SET AMOUNT";
    if (isOverBalance) return "INSUFFICIENT STABLECOIN";
    if (needsApproval) return "APPROVE STABLECOIN";
    return hasOnchainCommit || hasDbLineupCommit ? "UPDATE COMMIT" : "COMMIT & LOCK";
  }, [
    walletAddress,
    txPending,
    needsFaucetTopup,
    isBelowMinDeposit,
    minAllocation,
    hasValidDeposit,
    isOverBalance,
    needsApproval,
    hasOnchainCommit,
    hasDbLineupCommit,
  ]);

  const handleSort = useCallback((key: SortKey) => {
    startUiTransition(() => {
      if (key === sortKey) {
        setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
        return;
      }
      const defaultDir = key === "asset" || key === "role" ? "asc" : "desc";
      setSortKey(key);
      setSortDir(defaultDir);
    });
  }, [sortKey, startUiTransition]);

  const applySlotEffect = useCallback((slotId: string, effect: string, duration: number) => {
    setSlotEffects((prev) => ({ ...prev, [slotId]: effect }));
    if (slotEffectTimers.current[slotId]) {
      window.clearTimeout(slotEffectTimers.current[slotId]);
    }
    slotEffectTimers.current[slotId] = window.setTimeout(() => {
      setSlotEffects((prev) => {
        const next = { ...prev };
        delete next[slotId];
        return next;
      });
      delete slotEffectTimers.current[slotId];
    }, duration);
  }, []);

  const performRemove = useCallback(
    (slotId: string) => {
      applySlotEffect(slotId, "removing", 180);
      window.setTimeout(() => {
        setLineup((prev) => ({ ...prev, [slotId]: null }));
        if (selectedSlotId === slotId) {
          setSelectedSlotId(null);
        }
      }, 180);
    },
    [applySlotEffect, selectedSlotId],
  );

  const performSwap = useCallback(
    (slotId: string, nextAsset: Asset) => {
      applySlotEffect(slotId, "swap-out", 180);
      window.setTimeout(() => {
        setLineup((prev) => ({ ...prev, [slotId]: nextAsset }));
        applySlotEffect(slotId, "swap-in", 180);
      }, 180);
    },
    [applySlotEffect],
  );

  const lockReady = isLockReady;

  const renderSlot = (slot: Slot) => {
    const asset = lineup[slot.id];
    const isSelected = selectedSlotId === slot.id && (!isWeekActive || isSwapModeActive);
    const isLarge = slot.role === "core";
    const isSwapReady = canUseWeekControls && isSwapModeActive && Boolean(asset);
    const isSwapTarget = canUseWeekControls && isSwapModeActive && isSelected;
    const isTargetEligible = canUseWeekControls && Boolean(isTargeting && targetRole === slot.role);
    const isTargetDimmed = Boolean(isTargeting && targetRole !== slot.role);
    const metrics = asset ? getAssetMetrics(asset) : null;
    const logoSrc = asset?.imagePath || "/coins/default.png";
    const showClear = Boolean(asset) && isSelected;
    const removeTooltip =
      weekStatus && weekStatus !== "DRAFT_OPEN"
        ? "Remove from strategy allocation (Costs 1 Tactical Move)"
        : "Remove from strategy allocation";
    const clearDisabled =
      Boolean(weekStatus && weekStatus !== "DRAFT_OPEN") && swapsRemaining <= 0;

    return (
      <div
        key={slot.id}
        className={`slot ${isLarge ? "slot-large" : "slot-small"} ${isSelected ? "selected" : ""} ${
          asset ? "filled" : ""
        } ${isWeekLocked ? "locked" : ""} ${isSwapReady ? "swap-ready" : ""} ${
          isSwapTarget ? "swap-target" : ""
        } ${isTargetEligible ? "target-eligible" : isTargetDimmed ? "target-dim" : ""} ${
          slotEffects[slot.id] ?? ""
        } ${slotHotPulse[slot.id] ? `hot-${slotHotPulse[slot.id]}` : ""} ${
          pendingAction && pendingAction.slotId === slot.id ? "popover-open" : ""
        }`}
        data-role={slot.role}
        data-swap-target={isTargetEligible ? "true" : undefined}
        onClick={() => {
          if (isWeekActive && !canUseWeekControls) {
            return;
          }
          if (isWeekActive && isTargetEligible) {
            setSwapConfirmSlotId((prev) => (prev === slot.id ? null : slot.id));
            return;
          }
          handleSlotClick(slot.id);
        }}
      >
        <div className="slot-role">{roleMeta[slot.role].label}</div>
        {isTargetEligible ? <span className="slot-target-dot" /> : null}

        {isTargetEligible && swapConfirmSlotId === slot.id ? (
          <div
            className="slot-swap-overlay"
            data-swap-target="true"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="slot-swap-card">
              <div className="slot-swap-label">REPLACE?</div>
              <div className="slot-swap-actions">
                <button
                  type="button"
                  className="slot-swap-action confirm"
                  data-swap-target="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCandidateSwap(slot.id);
                  }}
                  aria-label="Confirm swap"
                >
                  <span className="swap-icon check" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="slot-swap-action cancel"
                  data-swap-target="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSwapConfirmSlotId(null);
                  }}
                  aria-label="Cancel swap"
                >
                  <span className="swap-icon cross" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {isTargetEligible && hoverSwapSlotId == slot.id && candidateAsset ? (
          <div className="slot-ghost">
            <img
              src={candidateAsset.imagePath || "/coins/default.png"}
              alt={candidateAsset.symbol}
              className="slot-ghost-logo"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
            <span className="slot-ghost-ticker">{candidateAsset.symbol}</span>
          </div>
        ) : null}
        {showClear ? (
          <button
            type="button"
            className={`slot-clear ${clearDisabled ? "disabled" : ""}`}
            data-tip={removeTooltip}
            aria-label="Remove from strategy allocation"
            onClick={(event) => {
              event.stopPropagation();
              if (clearDisabled) {
                showToast("No Tactical Moves remaining this epoch", "warn");
                return;
              }
              handleClearSlot(slot.id);
            }}
          >
            x
          </button>
        ) : null}
        {asset && metrics ? (
          slot.role === "core" ? (
            <div className="anchor-card">
              <div className="anchor-left">
                <div className="anchor-identity">
                  <img
                    src={logoSrc}
                    alt={asset.symbol}
                    className="anchor-logo"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                  <div className="anchor-text">
                    <div className="anchor-name">{asset.name}</div>
                    <div className="anchor-ticker">{asset.symbol}</div>
                  </div>
                </div>
                <div
                  className={`anchor-live-line ${metrics.priceDirection} ${
                    metrics.flash ? "price-flash" : ""
                  }`}
                >
                  <span className={`price-dot ${metrics.priceDirection}`} />
                  <span className="anchor-live-price">
                    ${formatPrice(metrics.currentPrice)}
                  </span>
                  {showLiveChange ? (
                    <span className={`anchor-live-pnl ${metrics.pnl >= 0 ? "up" : "down"}`}>
                      {formatPnl(metrics.pnl)}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="anchor-middle">
                <div className="anchor-motto">PEG STABILITY MATTERS</div>
                <div className="anchor-desc">
                  Defensive anchor. Losses here impact score the most.
                </div>
                <div className="anchor-badges">
                  <span className={`unit-badge risk-${asset.risk.toLowerCase()}`} data-tip="Risk">
                    {asset.risk}
                  </span>
                  <span
                    className={`unit-badge momentum ${metrics.momentum}`}
                    data-tip="Momentum"
                  >
                    {metrics.momentum}
                  </span>
                </div>
              </div>
              <div className="anchor-right">
                <div className="anchor-power" data-tip="Power">
                  {asset.power}
                </div>
                <div className="anchor-salary">{formatSalary(asset.salary)}</div>
              </div>
            </div>
          ) : (
            <div className="unit unit-small">
              <div className="unit-top">
                <div className="unit-identity">
                  <img
                    src={logoSrc}
                    alt={asset.symbol}
                    className="unit-logo"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                  <div className="unit-name">{asset.name}</div>
                </div>
                <div className="unit-power" data-tip="Power">
                  {asset.power}
                </div>
              </div>
              <div
                className={`unit-live-line ${metrics.priceDirection} ${
                  metrics.flash ? "price-flash" : ""
                }`}
              >
                <span className={`price-dot ${metrics.priceDirection}`} />
                <span className="unit-live-price">${formatPrice(metrics.currentPrice)}</span>
                {showLiveChange ? (
                  <span className={`unit-live-pnl ${metrics.pnl >= 0 ? "up" : "down"}`}>
                    {formatPnl(metrics.pnl)}
                  </span>
                ) : null}
              </div>
              <div className="unit-bottom">
                <div className="unit-badges">
                  <span className={`unit-badge risk-${asset.risk.toLowerCase()}`} data-tip="Risk">
                    {asset.risk}
                  </span>
                  <span
                    className={`unit-badge momentum ${metrics.momentum}`}
                    data-tip="Momentum"
                  >
                    {metrics.momentum}
                  </span>
                </div>
                <div className="unit-salary">{formatSalary(asset.salary)}</div>
              </div>
            </div>
          )
        ) : slot.role === "core" ? (
          <div className="slot-empty slot-empty-core">
            <div className="slot-plus">+</div>
            <div className="slot-label">Select Anchor Asset</div>
            <div className="slot-note">Anchor capital position</div>
          </div>
        ) : (
          <div className="slot-empty">
            <div className="slot-plus">+</div>
            <div className="slot-label">{slot.label}</div>
            <div className="slot-note">{slot.note}</div>
          </div>
        )}
        {pendingAction && pendingAction.slotId === slot.id ? (
          <div
            className="slot-popover"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="slot-popover-title">
              {pendingAction.type === "remove"
                ? `Remove ${pendingAction.previous?.name ?? "asset"} from strategy allocation?`
                : `Replace ${pendingAction.previous?.name ?? "asset"} with ${
                    pendingAction.next?.name ?? "asset"
                  }?`}
            </div>
            <div className="slot-popover-sub">This will consume 1 Tactical Move.</div>
            <div className="slot-popover-actions">
              <button type="button" className="slot-popover-ghost" onClick={cancelAction}>
                Cancel
              </button>
              <button type="button" className="slot-popover-danger" onClick={confirmAction}>
                {pendingAction.type === "remove" ? "Confirm Remove" : "Confirm Swap"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };
  if (!runtimeProfileReady) {
    return null;
  }


  return (
    <>
      <main className={`vc-stage ${isSwapModeActive ? "swap-mode-active" : ""} ${isWeekActive ? "active-week" : ""} ${isDraftOpen ? "draft-week" : ""} ${isSpectatorWeekView ? "spectator-week" : ""}`}>
        <aside className="vc-intel">
          <div className="rail-title">Strategy Intel</div>
          <div className="intel-card">
            <div className="intel-row">
              <span className="intel-label">Power Cap</span>
              <span className="intel-value">
                {usedPower.toLocaleString()} / {powerCap.toLocaleString()}
              </span>
            </div>
            <div className="intel-progress">
              <div className="intel-progress-bar" style={{ width: `${powerPercent}%` }} />
            </div>
            <div className="intel-note">Cap discipline keeps the strategy coherent.</div>
          </div>
          <div className="intel-card">
            <div className="intel-row">
              <span className="intel-label">Budget Multiplier</span>
              <div className="intel-row">
                <span className="intel-value">x{projectedMultiplier.toFixed(2)}</span>
                <button
                  type="button"
                  className="intel-info"
                  aria-label="How the budget multiplier works"
                  onClick={() => openProtocolGuide("relative-scoring")}
                >
                  ?
                </button>
              </div>
            </div>
            <div className="intel-note">
              Boosts positive score when you leave budget unused.
            </div>
          </div>
          <div className="intel-card">
            <div className="intel-row">
              <span className="intel-label">Capital Protection</span>
              <button
                type="button"
                className="intel-info"
                aria-label="How capital protection works"
                onClick={() => openProtocolGuide("capital-protection")}
              >
                ?
              </button>
            </div>
            <div className="protection-bar" role="img" aria-label="Capital protection split">
              <span className="protection-segment protection-principal" />
              <span className="protection-segment protection-risk" />
            </div>
            <div className="protection-rows">
              <div className="protection-row">
                <span>Principal Protected</span>
                <strong>{Math.round(principalRatioBps / 100)}%</strong>
              </div>
              <div className="protection-row risk">
                <span>Performance Risk</span>
                <strong>{100 - Math.round(principalRatioBps / 100)}%</strong>
              </div>
            </div>
            <div className="protection-note">Downside capped - Upside amplified</div>
          </div>

          <div className="intel-divider" />

          {walletAddress ? (
            <div className={`intel-card rewards-card ${claimableWeeksCount > 0 ? "claimable" : ""}`}>
              <div className="intel-row rewards-head">
                <span className="intel-label">Epoch Yields</span>
                <a className="rewards-link" href="/history">
                  View history -&gt;
                </a>
              </div>

              {claimableWeeksCount === 0 || !nextClaimableSummary ? (
                <div className="rewards-body">
                  <div className="rewards-empty">No rewards available.</div>
                  {claimSummaryError ? (
                    <div className="rewards-sub text-[color:var(--arena-danger,#ff6b6b)]">{claimSummaryError}</div>
                  ) : null}
                  {lastSettledWeekStartUtc ? (
                    <div className="rewards-sub">
                      Last settled epoch: {formatWeekStartUtc(lastSettledWeekStartUtc)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rewards-body">
                  <div className="rewards-metrics">
                    <div className="rewards-metric-row">
                      <span>Claimable</span>
                      <strong className="amount-neutral">
                        {formatStableAmount(claimableTotalWithdrawWei, stablecoinDecimals)}
                      </strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rewards-claim-button"
                    onClick={openHistoryToClaim}
                    disabled={openingHistory}
                  >
                    {openingHistory ? "Opening History..." : "Claim Reward"}
                  </button>
                </div>
              )}
            </div>
          ) : null}

          <div className="intel-card">
            <div className="intel-label nav-title">Navigation</div>
            <div className="intel-nav-list">
              <a className="intel-nav-link" href="/leaderboard">
                <span>Leaderboard</span>
                <span className="intel-nav-trailing intel-nav-trailing--leaderboard" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M7 4h10v2.5A5 5 0 0 1 12 11.5A5 5 0 0 1 7 6.5V4Z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <path
                      d="M12 11.5V15M9 19h6"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </a>
              {walletAddress ? (
                <a className="intel-nav-link" href="/history">
                  <span>History</span>
                  <span className="intel-nav-trailing intel-nav-trailing--history" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <path
                        d="M4 12a8 8 0 1 0 2.3-5.7"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                      <path
                        d="M4 5v3.5h3.5M12 8.5V12l2.4 1.6"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </a>
              ) : null}
              <a className="intel-nav-link" href="/score-models">
                <span>Score Models</span>
                <span className="intel-nav-arrow">-&gt;</span>
              </a>
            </div>
          </div>
        </aside>

        <section
          className={`vc-board ${isTargeting ? "targeting" : ""}`}
          data-target-role={targetRole ?? ""}
        >
          <div className="board-header">
            <div className="board-title-row">
              <div className="board-title">Strategy Board</div>
              <div className="board-sub">
                {isSpectatorWeekView
                  ? "This epoch strategy tracks top live performers in each role."
                  : "Build a system, not a coin list. Select a slot and assign a unit."}
              </div>
            </div>
            <div className="board-header-right">
              {isSwapModeActive ? (
                <div className="swap-mode-banner">
                  Swap Mode Active - {swapsRemaining} moves left
                </div>
              ) : null}
            </div>
          </div>

          <div className="command-strip">
            {isSpectatorWeekView ? (
              <div className="command-week-squad-wrap">
                <div className="command-week-squad">
                  <span className="command-week-squad-label">Epoch Top Strategy Score</span>
                </div>
                <button
                  type="button"
                  className={`command-pnl week-squad-score ${spectatorWeekScore >= 0 ? "positive" : "negative"}`}
                  onClick={() => setSpectatorPromptOpen(true)}
                >
                  <div className="command-pnl-values">
                    <strong>{formatScore(spectatorWeekScore)}</strong>
                  </div>
                  <span className="week-squad-cta">Build your own strategy</span>
                </button>
              </div>
            ) : (
              <>
                <div className="command-group command-left">
                  <div className="control-label">Formation</div>
                  <div className="control-group">
                  {formations.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`control-button ${formationId === option.id ? "active" : ""} ${
                        canChangeFormation ? "" : "disabled"
                      }`}
                      disabled={!canChangeFormation}
                      onClick={() => {
                        if (!canChangeFormation) return;
                        startUiTransition(() => {
                          setFormationId(option.id);
                        });
                      }}
                    >
                      <span className="control-title">{option.hint}</span>
                    </button>
                  ))}
                  </div>
                </div>
                <div className="command-group command-right">
                  {isWeekActive ? (
                    <div
                      className={`command-pnl ${liveScore >= 0 ? "positive" : "negative"}`}
                    >
                      <div>WEEK SCORE</div>
                      <div className="command-pnl-values">
                        <strong>{formatScore(liveScore)}</strong>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>

          <div
            className={`board-shell ${isCooldownView ? "is-cooldown" : ""} ${
              isWeekLockedTransition ? "is-lock-transition" : ""
            }`}
          >
            {isBoardOverlayVisible ? (
              <div className="board-cooldown-overlay" aria-live="polite">
                <div className="board-cooldown-title">
                  {isWeekLockedTransition ? "NEW CHALLENGE INCOMING" : "NEW CHALLENGE PREPARING"}
                </div>
                <div className="board-cooldown-sub">
                  {isWeekLockedTransition
                    ? "Draft locked. Initializing the next epoch."
                    : "Validation + cooldown in progress"}
                </div>
                {!isWeekLockedTransition ? (
                  <div className="board-cooldown-timer">{cooldownCountdownLabel}</div>
                ) : null}
              </div>
            ) : null}
            <div className="board-grid">
              <div className="zone zone-core" data-role="core">
                <div className="zone-head role-info-wrap">
                  <div className="zone-title-row">
                    <div className="zone-title">ANCHOR</div>
                    {isTargeting && targetRole === "core" ? (
                      <span className="zone-target-dot" />
                    ) : null}
                    <button
                      type="button"
                      className="role-info"
                      aria-label="About role"
                      onClick={(event) => {
                        event.stopPropagation();
                        openProtocolGuide("formation-roles");
                      }}
                    >
                      i
                    </button>
                  </div>
                  {isTargeting && targetRole === "core" ? (
                    <div
                      className={`zone-targeting ${targetingPulseRole === "core" ? "pulse" : ""}`}
                    >
                      TARGETING: ANCHOR
                    </div>
                  ) : null}
                  {executedRole === "core" ? (
                    <div className="zone-executed">EXECUTED</div>
                  ) : null}
                  <div className="zone-sub">{roleMeta.core.subtitle}</div>
                </div>
                <div className="zone-slots">{slotGroups.core.map(renderSlot)}</div>
              </div>

              <div className="zone zone-stabilizer" data-role="stabilizer">
                <div className="zone-head role-info-wrap">
                  <div className="zone-title-row">
                    <div className="zone-title">GUARDIANS</div>
                    {isTargeting && targetRole === "stabilizer" ? (
                      <span className="zone-target-dot" />
                    ) : null}
                    <button
                      type="button"
                      className="role-info"
                      aria-label="About role"
                      onClick={(event) => {
                        event.stopPropagation();
                        openProtocolGuide("formation-roles");
                      }}
                    >
                      i
                    </button>
                  </div>
                  {isTargeting && targetRole === "stabilizer" ? (
                    <div
                      className={`zone-targeting ${targetingPulseRole === "stabilizer" ? "pulse" : ""}`}
                    >
                      TARGETING: GUARDIANS
                    </div>
                  ) : null}
                  {executedRole === "stabilizer" ? (
                    <div className="zone-executed">EXECUTED</div>
                  ) : null}
                  <div className="zone-sub">{roleMeta.stabilizer.subtitle}</div>
                </div>
                <div className="zone-slots">{slotGroups.stabilizer.map(renderSlot)}</div>
              </div>

              <div className="zone zone-amplifier" data-role="amplifier">
                <div className="zone-head role-info-wrap">
                  <div className="zone-title-row">
                    <div className="zone-title">OPERATORS</div>
                    {isTargeting && targetRole === "amplifier" ? (
                      <span className="zone-target-dot" />
                    ) : null}
                    <button
                      type="button"
                      className="role-info"
                      aria-label="About role"
                      onClick={(event) => {
                        event.stopPropagation();
                        openProtocolGuide("formation-roles");
                      }}
                    >
                      i
                    </button>
                  </div>
                  {isTargeting && targetRole === "amplifier" ? (
                    <div
                      className={`zone-targeting ${targetingPulseRole === "amplifier" ? "pulse" : ""}`}
                    >
                      TARGETING: OPERATORS
                    </div>
                  ) : null}
                  {executedRole === "amplifier" ? (
                    <div className="zone-executed">EXECUTED</div>
                  ) : null}
                  <div className="zone-sub">{roleMeta.amplifier.subtitle}</div>
                </div>
                <div className="zone-slots">{slotGroups.amplifier.map(renderSlot)}</div>
              </div>

              <div className="zone zone-wildcard" data-role="wildcard">
                <div className="zone-head role-info-wrap">
                  <div className="zone-title-row">
                    <div className="zone-title">RAIDERS</div>
                    {isTargeting && targetRole === "wildcard" ? (
                      <span className="zone-target-dot" />
                    ) : null}
                    <button
                      type="button"
                      className="role-info"
                      aria-label="About role"
                      onClick={(event) => {
                        event.stopPropagation();
                        openProtocolGuide("formation-roles");
                      }}
                    >
                      i
                    </button>
                  </div>
                  {isTargeting && targetRole === "wildcard" ? (
                    <div
                      className={`zone-targeting ${targetingPulseRole === "wildcard" ? "pulse" : ""}`}
                    >
                      TARGETING: RAIDERS
                    </div>
                  ) : null}
                  {executedRole === "wildcard" ? (
                    <div className="zone-executed">EXECUTED</div>
                  ) : null}
                  <div className="zone-sub">{roleMeta.wildcard.subtitle}</div>
                </div>
                <div className="zone-slots">{slotGroups.wildcard.map(renderSlot)}</div>
              </div>
            </div>
          </div>
          {!(isWeekActive && !swapMode) ? (
          <div className="commit-dock">
            <div>
              <div className="commit-title">Commit Strategy</div>
              <div className="commit-sub">Locking binds capital and reduces tactical moves.</div>
            </div>
            <button
              type="button"
              className="commit-button"
              disabled={!lockReady}
              data-ready={lockReady ? "true" : "false"}
              onClick={() => setCommitOpen(true)}
            >
              {isWeekLocked ? "DRAFT CLOSED" : hasOnchainCommit || hasDbLineupCommit ? "UPDATE COMMIT" : "LOCK STRATEGY"}
            </button>
          </div>
          ) : null}
        </section>

        {showLadderPanel ? (
          <aside className="vc-recruit ladder-panel" ref={ladderPanelRef}>
            <div className="ladder-head">
              <div>
                <div className="ladder-title">WATCHLIST MOVERS</div>
                <div className="ladder-sub">Live since lock - updates 10s</div>
              </div>
              <span className="ladder-live-badge">LIVE</span>
            </div>

            <div className="ladder-list">
              <div className="ladder-half gainers">
                {gainersDisplay.length ? (
                  gainersDisplay.map((item, index) => {
                    const isFocused = ladderFocusId === item.id;
                    const pct = item.pctSinceEntry;
                    const isPositive = pct >= 0;
                    const priceBlink = Boolean(priceFlash[item.symbol]);
                    const pctPulse = Boolean(ladderPulse[item.symbol]);
                    const rankIndex = gainersDisplay.length - 1 - index;
                    const tierClass =
                      rankIndex <= 1 ? "tier-a" : rankIndex <= 4 ? "tier-b" : "tier-c";
                    const isHot = rankIndex === 0;
                    const hotClass = isHot ? (isPositive ? "hot-gain" : "hot-loss") : "";
                    return (
                      <div
                        key={item.id}
                        className={`ladder-row ${isPositive ? "gain" : "loss"} ${tierClass} role-${
                          item.role
                        } ${isFocused ? "focused" : ""} ${selectedCandidate?.id === item.id ? "selected-candidate" : ""} ${isHot ? "hot" : ""} ${hotClass}`}
                                                role="button"
                        tabIndex={0}
                        onClick={() => handleLadderRowClick(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleLadderRowClick(item);
                          }
                        }}
                      >
                        <div className="ladder-left">
                          <img
                            src={item.imagePath || "/coins/default.png"}
                            alt={item.symbol}
                            className="ladder-logo"
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                          />
                          <span className="ladder-ticker">{item.symbol}</span>
                          {item.inLineup ? <span className="ladder-inline-dot" /> : null}

                          </div>
                        {deployedCandidateId === item.id ? (
                          <span className="ladder-deployed">DEPLOYED</span>
                        ) : null}
                        <div
                          className={`ladder-pct ${isPositive ? "gain" : "loss"} ${
                            pctPulse ? "pulse" : ""
                          }`}
                        >
                          {formatPct(pct)}
                        </div>
                        <div className={`ladder-price ${priceBlink ? "blink" : ""}`}>
                          ${formatPrice(item.livePrice)}
                        </div>
                        <div className="ladder-role-end">
                          <span className={`ladder-role-badge role-${item.role}`}>
                            {roleBadgeMap[item.role] ?? "?"}
                          </span>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="ladder-empty">No gainers</div>
                )}
              </div>

              <div className="ladder-pivot">
                <span>PIVOT</span>
              </div>

              <div className="ladder-half losers">
                {losersDisplay.length ? (
                  losersDisplay.map((item, index) => {
                    const isFocused = ladderFocusId === item.id;
                    const pct = item.pctSinceEntry;
                    const isPositive = pct >= 0;
                    const priceBlink = Boolean(priceFlash[item.symbol]);
                    const pctPulse = Boolean(ladderPulse[item.symbol]);
                    const rankIndex = index;
                    const tierClass =
                      rankIndex <= 1 ? "tier-a" : rankIndex <= 4 ? "tier-b" : "tier-c";
                    const isHot = rankIndex === 0;
                    const hotClass = isHot ? (isPositive ? "hot-gain" : "hot-loss") : "";
                    return (
                      <div
                        key={item.id}
                        className={`ladder-row ${isPositive ? "gain" : "loss"} ${tierClass} role-${
                          item.role
                        } ${isFocused ? "focused" : ""} ${selectedCandidate?.id === item.id ? "selected-candidate" : ""} ${isHot ? "hot" : ""} ${hotClass}`}
                                                role="button"
                        tabIndex={0}
                        onClick={() => handleLadderRowClick(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleLadderRowClick(item);
                          }
                        }}
                      >
                        <div className="ladder-left">
                          <img
                            src={item.imagePath || "/coins/default.png"}
                            alt={item.symbol}
                            className="ladder-logo"
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                          />
                          <span className="ladder-ticker">{item.symbol}</span>
                          {item.inLineup ? <span className="ladder-inline-dot" /> : null}

                          </div>
                        {deployedCandidateId === item.id ? (
                          <span className="ladder-deployed">DEPLOYED</span>
                        ) : null}
                        <div
                          className={`ladder-pct ${isPositive ? "gain" : "loss"} ${
                            pctPulse ? "pulse" : ""
                          }`}
                        >
                          {formatPct(pct)}
                        </div>
                        <div className={`ladder-price ${priceBlink ? "blink" : ""}`}>
                          ${formatPrice(item.livePrice)}
                        </div>
                        <div className="ladder-role-end">
                          <span className={`ladder-role-badge role-${item.role}`}>
                            {roleBadgeMap[item.role] ?? "?"}
                          </span>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="ladder-empty">No losers</div>
                )}
              </div>
            </div>
          </aside>
        ) : (
                <aside className="vc-recruit">
                  <div className="rail-title">Recruitment Bay</div>
                  <div className="recruit-head">
                    <div>
                      <div className="recruit-title">Asset Pool</div>
                      <div className="recruit-sub">
                        {isSpectatorWeekView
                          ? "Epoch market view updates from cached live performers."
                          : "Assign units to the selected role."}
                        {coinsSyncing ? " Live market sync in progress." : ""}
                      </div>
                    </div>
                    <div
                      className={`recruit-focus ${selectedRole ? `role-${selectedRole}` : "role-all"}`}
                    >
                      {isSpectatorWeekView
                        ? "Epoch View"
                        : selectedRole
                          ? roleMeta[selectedRole].label
                          : "All Roles"}
                    </div>
                  </div>
        
                  <div className="recruit-search">
                    <input
                      type="text"
                      placeholder="Search assets"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
        
                  <div className="recruit-list">
                    <div className={`recruit-row header ${isWeekActive ? "week-active" : ""}`}>
                      <button
                        type="button"
                        className={`recruit-sort ${sortKey === "asset" ? "active" : ""}`}
                        onClick={() => handleSort("asset")}
                      >
                        Asset
                        <span className="sort-indicator">
                          {sortKey === "asset" ? (sortDir === "asc" ? "^" : "v") : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`recruit-sort ${sortKey === "power" ? "active" : ""}`}
                        onClick={() => handleSort("power")}
                      >
                        Power
                        <span className="sort-indicator">
                          {sortKey === "power" ? (sortDir === "asc" ? "^" : "v") : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`recruit-sort ${sortKey === "price" ? "active" : ""}`}
                        onClick={() => handleSort("price")}
                      >
                        Price
                        <span className="sort-indicator">
                          {sortKey === "price" ? (sortDir === "asc" ? "^" : "v") : ""}
                        </span>
                      </button>
                      {isWeekActive ? (
                        <button
                          type="button"
                          className={`recruit-sort ${sortKey === "weekChange" ? "active" : ""}`}
                          onClick={() => handleSort("weekChange")}
                        >
                          Epoch %
                          <span className="sort-indicator">
                            {sortKey === "weekChange" ? (sortDir === "asc" ? "^" : "v") : ""}
                          </span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`recruit-sort ${sortKey === "salary" ? "active" : ""}`}
                        onClick={() => handleSort("salary")}
                      >
                        Salary
                        <span className="sort-indicator">
                          {sortKey === "salary" ? (sortDir === "asc" ? "^" : "v") : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`recruit-sort ${sortKey === "risk" ? "active" : ""}`}
                        onClick={() => handleSort("risk")}
                      >
                        Risk
                        <span className="sort-indicator">
                          {sortKey === "risk" ? (sortDir === "asc" ? "^" : "v") : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`recruit-sort ${sortKey === "momentum" ? "active" : ""}`}
                        onClick={() => handleSort("momentum")}
                      >
                        Momentum
                        <span className="sort-indicator">
                          {sortKey === "momentum" ? (sortDir === "asc" ? "^" : "v") : ""}
                        </span>
                      </button>
                    </div>
                    {assetPoolRows}
                  </div>
                </aside>
        )}

      </main>
      {Number(activeProfile.chainId) === 11155111 ? (
        <div
          style={{
            position: "fixed",
            left: 12,
            bottom: 12,
            zIndex: 65,
            width: reactivePanelOpen ? "min(92vw, 760px)" : 190,
            borderRadius: 12,
            border: "1px solid rgba(67, 200, 141, 0.35)",
            background: "rgba(16, 43, 34, 0.28)",
            boxShadow: "0 10px 36px rgba(0,0,0,0.28)",
            backdropFilter: "blur(12px)",
            color: "#d8f8e8",
          }}
        >
          <button
            type="button"
            onClick={() => setReactivePanelOpen((prev) => !prev)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "transparent",
              border: "none",
              color: "inherit",
              padding: "10px 12px",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            <span>Reactive Flow</span>
            <span>{reactivePanelOpen ? "Hide" : "Show"}</span>
          </button>
          {reactivePanelOpen ? (
            <div style={{ maxHeight: "60vh", overflowY: "auto", overflowX: "hidden", padding: "0 10px 10px" }}>
              {reactiveFlowLoading ? (
                <div style={{ fontSize: 11, opacity: 0.8, padding: "6px 2px" }}>Syncing...</div>
              ) : null}
              {(reactiveFlowEvents || []).map((event) => (
                <div
                  key={event.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 11,
                    padding: "6px 4px",
                    borderTop: "1px solid rgba(124, 235, 175, 0.16)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {event.operation} | {event.status}
                    </div>
                    <div style={{ opacity: 0.66, fontSize: 10 }}>{event.updatedAt}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, minWidth: 320, whiteSpace: "nowrap" }}>
                    {event.reactiveTxHash && event.reactiveTxUrl ? (
                      <a
                        href={event.reactiveTxUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "#9fffd6", textDecoration: "underline" }}
                      >
                        Reactive: {shortenReactiveHash(event.reactiveTxHash)}
                      </a>
                    ) : (
                      <span style={{ opacity: 0.58 }}>Reactive: --</span>
                    )}
                  </div>
                </div>
              ))}
              {!reactiveFlowLoading && (!reactiveFlowEvents || reactiveFlowEvents.length === 0) ? (
                <div style={{ fontSize: 11, opacity: 0.72, padding: "8px 4px" }}>No reactive tx yet.</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {commitOpen ? (
        <div className="commit-modal">
          <div className="commit-backdrop" onClick={() => setCommitOpen(false)} />
          <div className="commit-panel" role="dialog" aria-modal="true">
            <div className="commit-header">
              <div>
                <div className="board-title">Commit Strategy</div>
                <div className="board-sub">Confirm the epoch commitment.</div>
              </div>
              <button type="button" className="commit-close" onClick={() => setCommitOpen(false)}>
                Close
              </button>
            </div>

            <div className="commit-grid">
              <div className="commit-card">
                <div className="commit-label">
                  Power Usage {usedPower <= powerCap ? "OK" : "High"}
                </div>
                <div className="commit-value">
                  {usedPower.toLocaleString()} / {powerCap.toLocaleString()}
                </div>
                <div className="intel-progress">
                  <div className="intel-progress-bar" style={{ width: `${powerPercent}%` }} />
                </div>
              </div>
              <div className="commit-card">
                <div className="commit-label">Budget Multiplier</div>
                <div className="commit-value">x{projectedMultiplier.toFixed(2)}</div>
              </div>
              <div className="commit-card">
                <div className="commit-label">Tactical Moves After Lock</div>
                <div className="commit-value">{Math.max(totalMoves - swapCount, 0)}</div>
              </div>
              <div className="commit-card">
                <div className="commit-label">Expected Behavior</div>
                <div className="commit-text">Balanced tempo with defined upside pressure.</div>
              </div>
            </div>

            <div className="commit-allocate">
              <div className="commit-label">Lock Stablecoin Balance</div>
              <div className="commit-range">
                <input
                  type="range"
                  min={0}
                  max={maxAllocation}
                  step={1}
                  value={allocation}
                  onChange={(event) => setAllocationValue(Number(event.target.value))}
                  disabled={!walletAddress || maxAllocation <= 0}
                />
                <input
                  type="text"
                  min={0}
                  max={maxAllocation}
                  step={1}
                  value={allocationInput}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className={isOverBalance ? "commit-input error" : "commit-input"}
                  onKeyDown={(event) => {
                    if (["-", "+", "e", "E", ".", ","].includes(event.key)) {
                      event.preventDefault();
                    }
                  }}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue === "") {
                      setAllocationInput("");
                      setAllocation(0);
                      return;
                    }
                    if (!/^\d+$/.test(nextValue)) {
                      return;
                    }
                    if (nextValue.length > 1 && nextValue.startsWith("0")) {
                      return;
                    }
                    const numeric = Math.min(Number(nextValue), maxAllocation);
                    setAllocationValue(numeric, String(numeric));
                  }}
                  onFocus={(event) => {
                    if (event.target.value === "0") {
                      event.target.value = "";
                      setAllocationInput("");
                    }
                  }}
                  onBlur={(event) => {
                    if (event.target.value.trim() === "") {
                      setAllocationInput("0");
                      setAllocation(0);
                    }
                  }}
                  placeholder="0"
                  disabled={!walletAddress || maxAllocation <= 0}
                />
                <div className="commit-balance">
                  <span className="commit-balance-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                      <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h11a3 3 0 0 1 3 3v2.2a2.8 2.8 0 0 1 0 5.6V17a3 3 0 0 1-3 3H6a2.5 2.5 0 0 1-2.5-2.5V6.5Z" />
                      <path d="M18 11.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
                    </svg>
                  </span>
                  <span>{walletBalanceValueLabel}</span>
                </div>
              </div>
              {isOverBalance ? (
                <div className="commit-text warning">Insufficient stablecoin balance for this amount.</div>
              ) : null}
              {isBelowMinDeposit ? (
                <div className="commit-text warning">
                  Minimum deposit is {minAllocation.toLocaleString()} {stablecoinSymbol}.
                </div>
              ) : null}
              {stablecoinLoading ? <div className="commit-text">Refreshing wallet balance...</div> : null}
            </div>

            <div className="commit-split">
              <div className="commit-metric">
                <div className="commit-metric-value">${depositValue.toLocaleString()}</div>
                <div className="commit-metric-label">Deposit (Stablecoin)</div>
              </div>
              <div className="commit-metric">
                <div className="commit-metric-value">
                  ${Math.floor(principalValue).toLocaleString()}
                </div>
                <div className="commit-metric-label">Principal Protected</div>
              </div>
              <div className="commit-metric">
                <div className="commit-metric-value">
                  ${Math.floor(riskValue).toLocaleString()}
                </div>
                <div className="commit-metric-label">Risk Allocation</div>
              </div>
            </div>

            <div className="commit-actions">
              <button
                type="button"
                className="commit-button"
                data-ready={lockReady ? "true" : "false"}
                disabled={!lockReady || txPending}
                onClick={() => void handleCommitAction()}
              >
                {commitActionLabel}
              </button>
              <button type="button" className="commit-ghost" onClick={() => setCommitOpen(false)}>
                BACK TO EDIT
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {spectatorPromptOpen ? (
        <div className="spectator-prompt-modal" role="dialog" aria-modal="true">
          <div className="spectator-prompt-backdrop" onClick={() => setSpectatorPromptOpen(false)} />
          <div className="spectator-prompt-panel">
            <div className="spectator-prompt-title">Build your own strategy</div>
            {!walletAddress ? (
              <>
                <div className="spectator-prompt-text">
                  Connect your wallet to join the live cycle and lock your own strategy allocation.
                </div>
                <div className="spectator-prompt-actions">
                  <button
                    type="button"
                    className="spectator-prompt-primary"
                    onClick={async () => {
                      await connect();
                      setSpectatorPromptOpen(false);
                    }}
                  >
                    Connect wallet
                  </button>
                  <button
                    type="button"
                    className="spectator-prompt-secondary"
                    onClick={() => setSpectatorPromptOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="spectator-prompt-text">
                  This epoch is already in progress. Next entry window opens on <strong>{nextSundayLabel}</strong> (UTC).
                  You can join the next round then.
                </div>
                <div className="spectator-prompt-actions">
                  <button
                    type="button"
                    className="spectator-prompt-secondary"
                    onClick={() => setSpectatorPromptOpen(false)}
                  >
                    Got it
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      <ProtocolGuideModal
        open={ProtocolGuideOpen}
        initialSection={ProtocolGuideSection}
        onClose={() => setProtocolGuideOpen(false)}
      />

      {toast && (
        <div
          className="fixed bottom-6 right-6 z-50 w-[360px] max-w-[calc(100vw-1.5rem)]"
          onMouseEnter={() => setToastHover(true)}
          onMouseLeave={() => setToastHover(false)}
        >
          <div
            role="status"
            aria-live="polite"
            className={`rounded-2xl border p-4 shadow-[0_24px_80px_-40px_rgba(0,0,0,0.8)] backdrop-blur-sm ${
              toast.tone === "warn"
                ? "border-[color:rgba(255,107,107,0.45)] bg-[color:rgba(34,10,14,0.88)] text-[color:#ffd7d7]"
                : "border-[color:rgba(54,211,190,0.35)] bg-[color:rgba(6,17,27,0.9)] text-[color:var(--text-primary)]"
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] opacity-80">
                {toast.tone === "warn" ? "Action needed" : "Update"}
              </div>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="text-xs opacity-70 transition hover:opacity-100"
                aria-label="Dismiss notification"
              >
                Close
              </button>
            </div>
            <div className="whitespace-pre-line text-sm leading-relaxed">
              {toast.href ? (
                <a
                  href={toast.href}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-4"
                >
                  {toast.message}
                </a>
              ) : (
                toast.message
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}















































