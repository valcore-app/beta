"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatUnits, type WalletClient } from "viem";
import { apiGet } from "../../../lib/api";
import { valcoreAbi } from "../../../lib/contracts";
import { useWallet } from "../../../lib/wallet";
import { buildChain } from "../../../lib/chain";
import { useRuntimeProfile } from "../../../lib/runtime-profile";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";

type WeekStatus = "DRAFT_OPEN" | "LOCKED" | "ACTIVE" | "FINALIZE_PENDING" | "FINALIZED";

type WeekSummary = {
  id: string;
  startAtUtc: string;
  lockAtUtc: string;
  endAtUtc: string;
  status: WeekStatus;
};

type ClaimData = {
  address: string;
  principal: string;
  riskPayout: string;
  totalWithdraw: string;
  rewardAmount?: string;
  proof: `0x${string}`[];
};

type ClaimRowState = {
  loading: boolean;
  pending: boolean;
  claim: ClaimData | null;
  claimedOnChain: boolean;
  error: string | null;
  txHash?: `0x${string}`;
  claimedAt?: string;
};

type RowUiState = "not_ready" | "loading" | "not_eligible" | "claimable" | "claimed";
type ClaimableRowUiState = "claimable" | "claimed";
type HistoryRowView = { week: WeekSummary; state: ClaimRowState; uiState: ClaimableRowUiState };

const formatUtc = (iso?: string | null) => {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace(".000Z", "Z");
};

const formatWeekStartUtc = (iso?: string | null) => {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const midnightUtc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = midnightUtc.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() - daysFromMonday);
  return midnightUtc.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
};


const formatStableAmount = (wei?: string | null, decimals = 18) => {
  if (!wei) return "-";
  try {
    const value = Number(formatUnits(BigInt(wei), decimals));
    return `$${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } catch {
    return "-";
  }
};

const parseClaimedFlag = (position: unknown) => {
  if (Array.isArray(position)) {
    return Boolean(position[5] ?? position[position.length - 1]);
  }
  if (position && typeof position === "object" && "claimed" in position) {
    return Boolean((position as { claimed?: boolean }).claimed);
  }
  return false;
};

const statusBadgeClass = (state: RowUiState) => {
  if (state === "claimable") {
    return "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]";
  }
  if (state === "claimed") {
    return "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]";
  }
  if (state === "not_ready") {
    return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  }
  return "border-[color:var(--arena-stroke-strong)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
};

export default function HistoryPage() {
  const { profile } = useRuntimeProfile();
  if (!profile) {
    return null;
  }
  const valcoreAddress = profile.leagueAddress;
  const activeChain = useMemo(
    () =>
      buildChain({
        chainId: profile.chainId,
        label: profile.label,
        networkKey: profile.networkKey,
        rpcUrl: profile.rpcUrl,
        explorerUrl: profile.explorerUrl,
        nativeSymbol: profile.nativeSymbol,
      }),
    [
      profile.chainId,
      profile.label,
      profile.networkKey,
      profile.rpcUrl,
      profile.explorerUrl,
      profile.nativeSymbol,
    ],
  );
  const stablecoinDecimals = profile.stablecoinDecimals || 18;
  const router = useRouter();
  const {
    address,
    status,
    isConnected,
    connect,
    ensureChain,
    getWalletClient,
    publicClient,
    hasProvider,
    isCorrectNetwork,
  } = useWallet();

  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [weeksLoading, setWeeksLoading] = useState(true);
  const [weeksError, setWeeksError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, ClaimRowState>>({});
  const [notice, setNotice] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  const [claimAllPending, setClaimAllPending] = useState(false);

  const loadWeeks = useCallback(async () => {
    setWeeksLoading(true);
    setWeeksError(null);
    try {
      const result = await apiGet<WeekSummary[]>("/weeks?limit=36");
      setWeeks(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load weeks.";
      setWeeksError(message);
    } finally {
      setWeeksLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWeeks();
  }, [loadWeeks]);

  const setRow = useCallback((weekId: string, patch: Partial<ClaimRowState>) => {
    setRows((prev) => {
      const current =
        prev[weekId] ??
        ({
          loading: false,
          pending: false,
          claim: null,
          claimedOnChain: false,
          error: null,
        } as ClaimRowState);

      return {
        ...prev,
        [weekId]: {
          ...current,
          ...patch,
        },
      };
    });
  }, []);

  const refreshClaims = useCallback(async () => {
  if (!address) {
    setRows({});
    return;
  }

  const finalizedWeeks = weeks.filter((week) => week.status === "FINALIZED");
  if (!finalizedWeeks.length) {
    setRows({});
    return;
  }

  const nextRows: Record<string, ClaimRowState> = {};

  await Promise.all(
    finalizedWeeks.map(async (week) => {
      try {
        const claim = await apiGet<ClaimData>(`/weeks/${week.id}/claims/${address.toLowerCase()}`);
        let claimedOnChain = false;

        if (publicClient && valcoreAddress) {
          try {
            const position = await publicClient.readContract({
              address: valcoreAddress,
              abi: valcoreAbi,
              functionName: "positions",
              args: [BigInt(week.id), address as `0x${string}`],
            });
            claimedOnChain = parseClaimedFlag(position);
          } catch {
            claimedOnChain = false;
          }
        }

        nextRows[week.id] = {
          loading: false,
          pending: false,
          claim,
          claimedOnChain,
          error: null,
        };
      } catch {
        // Not participating in this week -> excluded from history list.
      }
    }),
  );

  setRows(nextRows);
}, [address, publicClient, valcoreAddress, weeks]);

useEffect(() => {
  void refreshClaims();
}, [refreshClaims]);

  const rowsView = useMemo<HistoryRowView[]>(() => {
    return weeks
      .filter((week) => week.status === "FINALIZED")
      .reduce<HistoryRowView[]>((acc, week) => {
        const state = rows[week.id];
        if (!state || !state.claim) return acc;
        const uiState: ClaimableRowUiState = state.claimedOnChain ? "claimed" : "claimable";
        acc.push({ week, state, uiState });
        return acc;
      }, []);
  }, [rows, weeks]);

  const claimableRows = useMemo(
    () => rowsView.filter((row) => row.uiState === "claimable" && row.state.claim && !row.state.pending),
    [rowsView],
  );

  const claimableTotalWei = useMemo(
    () =>
      claimableRows.reduce((sum, row) => {
        const total = row.state.claim?.totalWithdraw;
        return sum + (total ? BigInt(total) : 0n);
      }, 0n),
    [claimableRows],
  );

  const claimedCount = useMemo(
    () => rowsView.filter((row) => row.uiState === "claimed").length,
    [rowsView],
  );

  const lastClaimedAt = useMemo(() => {
    const values = Object.values(rows)
      .map((row) => row.claimedAt)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => (a > b ? -1 : 1));
    return values[0] ?? null;
  }, [rows]);

  const claimWeek = useCallback(
    async (weekId: string) => {
      if (!address) {
        setNotice({ tone: "warn", text: "Connect wallet first." });
        return false;
      }
      const row = rows[weekId];
      if (!row?.claim) {
        setNotice({ tone: "warn", text: "Claim data not available for this week." });
        return false;
      }
      if (!valcoreAddress) {
        setNotice({ tone: "warn", text: "Valcore contract address is missing." });
        return false;
      }

      const onCorrectChain = await ensureChain();
      if (!onCorrectChain) {
        setNotice({ tone: "warn", text: `Switch to ${profile.label} and retry.` });
        return false;
      }

      const walletClient = getWalletClient() as WalletClient | null;
      if (!walletClient) {
        setNotice({ tone: "warn", text: "Wallet signer not available." });
        return false;
      }

      const normalizeAddress = (value: unknown): `0x${string}` | null => {
        const text = String(value ?? "").trim();
        if (!/^0x[a-fA-F0-9]{40}$/u.test(text)) return null;
        return text as `0x${string}`;
      };

      let txAccount = normalizeAddress(walletClient.account?.address) ?? normalizeAddress(address);
      if (!txAccount) {
        try {
          const listed = await walletClient.request({ method: "eth_accounts" });
          if (Array.isArray(listed) && listed.length > 0) {
            txAccount = normalizeAddress(listed[0]);
          }
        } catch {
          txAccount = null;
        }
      }
      if (!txAccount) {
        setNotice({ tone: "warn", text: "Wallet account unavailable. Reconnect wallet and retry." });
        return false;
      }

      setRow(weekId, { pending: true, error: null });
      try {
        const request = {
          address: valcoreAddress,
          abi: valcoreAbi,
          functionName: "claim",
          args: [
            BigInt(weekId),
            BigInt(row.claim.principal),
            BigInt(row.claim.riskPayout),
            BigInt(row.claim.totalWithdraw),
            row.claim.proof,
          ],
          chain: activeChain,
          account: txAccount,
        };

        let hash: `0x${string}`;
        try {
          hash = await walletClient.writeContract(request);
        } catch (firstError) {
          const message = firstError instanceof Error ? firstError.message.toLowerCase() : "";
          const shouldRetryWithNonce =
            message.includes("unable to calculate nonce") ||
            message.includes("nonce") ||
            message.includes("unable to get transaction hash");

          if (!shouldRetryWithNonce) {
            throw firstError;
          }

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

          let nonce: number | null = null;
          try {
            const nonceRaw = await (walletClient as any).request({
              method: "eth_getTransactionCount",
              params: [txAccount, "pending"],
            });
            nonce = parseNonce(nonceRaw);
          } catch {
            nonce = null;
          }

          if (nonce === null && publicClient) {
            try {
              const nonceValue = await publicClient.getTransactionCount({
                address: txAccount,
                blockTag: "pending",
              });
              nonce = parseNonce(nonceValue);
            } catch {
              nonce = null;
            }
          }

          if (nonce === null) {
            throw firstError;
          }

          hash = await walletClient.writeContract({
            ...request,
            nonce,
          });
        }

        if (publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
        }

        setRow(weekId, {
          pending: false,
          claimedOnChain: true,
          txHash: hash,
          claimedAt: new Date().toISOString(),
          error: null,
        });
        setNotice({
          tone: "info",
          text: `Claim success for week ${weekId}. Tx: ${hash.slice(0, 10)}...${hash.slice(-8)}`,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Claim failed.";
        setRow(weekId, { pending: false, error: message });
        setNotice({ tone: "warn", text: `Claim failed for week ${weekId}.` });
        return false;
      }
    },
    [address, ensureChain, getWalletClient, publicClient, rows, setRow],
  );

  const claimAll = useCallback(async () => {
    if (!claimableRows.length || claimAllPending) return;
    setClaimAllPending(true);
    setNotice(null);
    let successCount = 0;
    for (const row of claimableRows) {
      const ok = await claimWeek(row.week.id);
      if (ok) successCount += 1;
    }
    setClaimAllPending(false);
    if (successCount === claimableRows.length) {
      setNotice({ tone: "info", text: `Claim all completed (${successCount}/${claimableRows.length}).` });
    } else {
      setNotice({
        tone: "warn",
        text: `Claim all finished with partial success (${successCount}/${claimableRows.length}).`,
      });
    }
  }, [claimAllPending, claimWeek, claimableRows]);

  const renderStatus = (state: RowUiState) => {
    if (state === "claimable") return "Claimable";
    if (state === "claimed") return "Claimed";
    return "Loading";
  };

  useEffect(() => {
    if (status === "connecting") return;
    if (!isConnected || !address) {
      router.replace("/lineup");
    }
  }, [address, isConnected, router, status]);

  return (
    <main id="claim-center" className="vc-page">
      <section className="mx-auto grid w-full max-w-[1320px] gap-6">
        <Card className="arena-panel rounded-[24px]">
          <CardHeader className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="arena-chip">Claim Center</div>
              <CardTitle className="mt-3">Withdraw finalized week payouts</CardTitle>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                variant="glow"
                onClick={() => void claimAll()}
                disabled={!address || !claimableRows.length || claimAllPending}
              >
                {claimAllPending ? "Claiming..." : "Claim All Ready Weeks"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-4">
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.6)] p-3">
              <div className="text-[0.7rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">
                Claimable Total
              </div>
              <div className="mt-2 text-xl font-semibold text-[color:var(--arena-ink)]">
                {formatStableAmount(claimableTotalWei.toString(), stablecoinDecimals)}
              </div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.6)] p-3">
              <div className="text-[0.7rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">
                Weeks Ready
              </div>
              <div className="mt-2 text-xl font-semibold text-[color:var(--arena-success)]">
                {claimableRows.length}
              </div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.6)] p-3">
              <div className="text-[0.7rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">
                Claimed Weeks
              </div>
              <div className="mt-2 text-xl font-semibold text-[color:var(--arena-accent)]">
                {claimedCount}
              </div>
            </div>
            <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.6)] p-3">
              <div className="text-[0.7rem] uppercase tracking-[0.16em] text-[color:var(--arena-muted)]">
                Last Claimed
              </div>
              <div className="mt-2 text-sm font-semibold text-[color:var(--arena-ink)]">
                {lastClaimedAt ? formatUtc(lastClaimedAt) : "-"}
              </div>
            </div>
          </CardContent>
        </Card>

        
        {notice ? (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              notice.tone === "warn"
                ? "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]"
                : "border-[color:var(--arena-accent)] bg-[color:var(--arena-accent-soft)] text-[color:var(--arena-accent)]"
            }`}
          >
            {notice.text}
          </div>
        ) : null}

{rowsView.length === 0 ? (
          <div className="rounded-xl border border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] p-4 text-sm text-[color:var(--arena-muted)]">
            You have not joined any finalized week yet. Your claim history will appear here after you play.
          </div>
        ) : (
        <Card className="arena-panel-strong rounded-[20px]">
          <CardHeader>
            <CardTitle>Week Claims</CardTitle>
          </CardHeader>
          <CardContent>
            {weeksError ? (
              <div className="rounded-xl border border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] p-3 text-sm text-[color:var(--arena-danger)]">
                {weeksError}
              </div>
            ) : weeksLoading ? (
              <div className="text-sm text-[color:var(--arena-muted)]">Loading weeks...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[color:var(--arena-stroke)] text-[0.68rem] uppercase tracking-[0.15em] text-[color:var(--arena-muted)]">
                      <th className="px-3 py-3">Week</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Principal</th>
                      <th className="px-3 py-3">Risk Return</th>
                      <th className="px-3 py-3">Reward</th>
                      <th className="px-3 py-3">Total Withdraw</th>
                      <th className="px-3 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rowsView.map(({ week, state, uiState }) => {
                      const claim = state.claim;
                      const rewardWei = claim?.rewardAmount ?? null;

                      return (
                        <tr
                          key={week.id}
                          className="border-b border-[color:var(--arena-stroke)] align-top text-[color:var(--arena-ink)]"
                        >
                          <td className="px-3 py-4">
                            <div className="font-semibold">{formatWeekStartUtc(week.startAtUtc)}</div>
                            <div className="mt-1 text-xs text-[color:var(--arena-muted)]">
                              Final: {formatUtc(week.endAtUtc)}
                            </div>
                          </td>
                          <td className="px-3 py-4">
                            <span
                              className={`inline-flex rounded-full border px-3 py-1 text-[0.65rem] uppercase tracking-[0.13em] ${statusBadgeClass(
                                uiState,
                              )}`}
                            >
                              {renderStatus(uiState)}
                            </span>
                            {state.error ? (
                              <div className="mt-2 text-xs text-[color:var(--arena-danger)]">{state.error}</div>
                            ) : null}
                          </td>
                          <td className="px-3 py-4">
                            {formatStableAmount(claim?.principal, stablecoinDecimals)}
                          </td>
                          <td className="px-3 py-4">
                            {formatStableAmount(claim?.riskPayout, stablecoinDecimals)}
                          </td>
                          <td className="px-3 py-4">
                            {formatStableAmount(rewardWei, stablecoinDecimals)}
                          </td>
                          <td className="px-3 py-4 font-semibold">
                            {formatStableAmount(claim?.totalWithdraw, stablecoinDecimals)}
                          </td>
                          <td className="px-3 py-4">
                            {uiState === "claimable" ? (
                              <Button
                                size="sm"
                                variant="glow"
                                onClick={() => void claimWeek(week.id)}
                                disabled={state.pending || claimAllPending || !isCorrectNetwork}
                              >
                                {state.pending ? "Claiming..." : "Claim"}
                              </Button>
                            ) : uiState === "claimed" && state.txHash ? (
                              <a
                                href={`${profile.explorerUrl}/tx/${state.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex h-8 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-4 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
                              >
                                View Tx
                              </a>
                            ) : (
                              <span className="text-xs text-[color:var(--arena-muted)]">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        )}
      </section>
    </main>
  );
}

