"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useAccount, useBalance } from "wagmi";
import { useHudContext } from "./hud-context";
import { useWallet } from "../../lib/wallet";
import { useRuntimeProfile } from "../../lib/runtime-profile";

const ORACLE_URL = "/api/oracle";
const FALLBACK_FAUCET_AMOUNT = Number(process.env.NEXT_PUBLIC_FAUCET_STABLECOIN_AMOUNT ?? "200");
const PLAYER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{1,22}[A-Za-z0-9])$/;
type PlayerNameAvailability = "idle" | "checking" | "available" | "taken" | "invalid";
type PlayerProfileLookupState = "idle" | "loading" | "found" | "missing" | "error";

export function Hud() {
  const { profile } = useRuntimeProfile();
  if (!profile) {
    return null;
  }
  const stablecoinAddress = profile.stablecoinAddress;
  const pathname = usePathname();
  const showMoves = pathname.startsWith("/strategy") || pathname.startsWith("/lineup");
  const { statusLabel, countdownText, moves, week, swapMode, setSwapMode } = useHudContext();
  const {
    address,
    connect,
    disconnect,
    hasProvider,
    walletSessionAddress,
    walletAuthStatus,
    refreshWalletSession,
    getWalletClient,
  } = useWallet();
  const { connector, isConnected: isWalletConnected } = useAccount();
  const { data: ethBalance } = useBalance({
    address: address ? (address as `0x${string}`) : undefined,
    query: { enabled: Boolean(address) },
  });
  const { data: stablecoinBalance } = useBalance({
    address: address ? (address as `0x${string}`) : undefined,
    token: stablecoinAddress,
    query: { enabled: Boolean(address) && Boolean(stablecoinAddress) },
  });
  const stablecoinSymbol = profile.stablecoinSymbol || "Stablecoin";
  const nativeSymbol = profile.nativeSymbol || "NATIVE";
  const faucetAmount = FALLBACK_FAUCET_AMOUNT;
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [faucetPending, setFaucetPending] = useState(false);
  const [toast, setToast] = useState<{ message: string; href?: string; tone?: "warn" | "info" } | null>(
    null,
  );
  const toastTimer = useRef<number | null>(null);
  const [playerDisplayName, setPlayerDisplayName] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [playerProfileLookupState, setPlayerProfileLookupState] =
    useState<PlayerProfileLookupState>("idle");
  const [playerNameModalOpen, setPlayerNameModalOpen] = useState(false);
  const [playerNameDraft, setPlayerNameDraft] = useState("");
  const [playerNameSaving, setPlayerNameSaving] = useState(false);
  const [playerNameAvailability, setPlayerNameAvailability] =
    useState<PlayerNameAvailability>("idle");

  useEffect(() => {
    if (!walletMenuOpen) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".hud-wallet")) {
        setWalletMenuOpen(false);
      }
    };
    document.addEventListener("click", handleOutside);
    return () => document.removeEventListener("click", handleOutside);
  }, [walletMenuOpen]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const showToast = (message: string, tone: "warn" | "info" = "info", href?: string) => {
    setToast({ message, href, tone });
    if (toastTimer.current) {
      window.clearTimeout(toastTimer.current);
    }
    const duration = tone === "warn" ? 12000 : href ? 8000 : 5000;
    toastTimer.current = window.setTimeout(() => setToast(null), duration);
  };

  const normalizeNameInput = (value: string) => value.trim().replace(/\s+/g, " ");
  const buildPlayerNameApprovalMessage = (walletAddress: string, displayName: string, nonce: string) =>
    [
      "Valcore Player Name Approval",
      `Address: ${walletAddress.toLowerCase()}`,
      `Display Name: ${displayName}`,
      `Nonce: ${nonce}`,
    ].join("\n");

  const fetchPlayerProfile = useCallback(async (walletAddress: string) => {
    setProfileLoading(true);
    setPlayerProfileLookupState("loading");
    try {
      const res = await fetch(`${ORACLE_URL}/players/${walletAddress.toLowerCase()}/profile`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) {
        if (res.status === 404) {
          setPlayerDisplayName(null);
          setPlayerProfileLookupState("missing");
          return null;
        }
        setPlayerProfileLookupState("error");
        return null;
      }
      const payload = (await res.json()) as { displayName?: string | null };
      const resolved = String(payload.displayName ?? "").trim();
      setPlayerDisplayName(resolved || null);
      setPlayerProfileLookupState(resolved ? "found" : "missing");
      return resolved || null;
    } catch {
      setPlayerProfileLookupState("error");
      return null;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!address) {
      setPlayerDisplayName(null);
      setPlayerProfileLookupState("idle");
      setPlayerNameModalOpen(false);
      setPlayerNameDraft("");
      setPlayerNameAvailability("idle");
      return;
    }
    void fetchPlayerProfile(address);
  }, [address, fetchPlayerProfile]);

  useEffect(() => {
    if (!address) return;
    if (playerProfileLookupState !== "error") return;
    const timer = window.setTimeout(() => {
      void fetchPlayerProfile(address);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [address, fetchPlayerProfile, playerProfileLookupState]);

  const normalizedPlayerNameDraft = useMemo(
    () => normalizeNameInput(playerNameDraft),
    [playerNameDraft],
  );
  const isPlayerNameFormatValid = useMemo(
    () => PLAYER_NAME_PATTERN.test(normalizedPlayerNameDraft),
    [normalizedPlayerNameDraft],
  );

  useEffect(() => {
    if (!playerNameModalOpen) {
      setPlayerNameAvailability("idle");
      return;
    }
    if (!isPlayerNameFormatValid) {
      setPlayerNameAvailability("invalid");
      return;
    }

    const normalizedCurrentName = String(playerDisplayName ?? "").trim().toLowerCase();
    if (normalizedCurrentName && normalizedCurrentName === normalizedPlayerNameDraft.toLowerCase()) {
      setPlayerNameAvailability("available");
      return;
    }

    const controller = new AbortController();
    setPlayerNameAvailability("checking");

    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          name: normalizedPlayerNameDraft,
        });
        if (address) {
          params.set("address", address);
        }
        const res = await fetch(`${ORACLE_URL}/players/name-availability?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok) {
          setPlayerNameAvailability("invalid");
          return;
        }
        const payload = (await res.json()) as { available?: boolean; reason?: string | null };
        if (payload.available) {
          setPlayerNameAvailability("available");
          return;
        }
        if (payload.reason === "taken") {
          setPlayerNameAvailability("taken");
          return;
        }
        setPlayerNameAvailability("invalid");
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") return;
        setPlayerNameAvailability("invalid");
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    address,
    isPlayerNameFormatValid,
    normalizedPlayerNameDraft,
    playerDisplayName,
    playerNameModalOpen,
  ]);

  const openPlayerNameModal = async () => {
    if (!address) return;
    setPlayerNameDraft(playerDisplayName ?? "");
    setPlayerNameModalOpen(true);
  };

  const signPlayerNameApproval = useCallback(
    async (walletAddress: string, message: string) => {
      const directClient = getWalletClient();
      if (directClient) {
        return directClient.signMessage({
          account: walletAddress as `0x${string}`,
          message,
        });
      }

      const injected = (window as Window & {
        ethereum?: {
          request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
        };
      }).ethereum;
      if (injected?.request) {
        try {
          const signature = await injected.request({
            method: "personal_sign",
            params: [message, walletAddress],
          });
          if (typeof signature === "string" && signature) {
            return signature;
          }
        } catch {
          // Fall through to null below.
        }
      }

      return null;
    },
    [getWalletClient],
  );

  const handleRegisterPlayerName = async () => {
    if (!address) return;
    if (!isWalletConnected) {
      showToast("Wallet disconnected. Reconnect and try again.", "warn");
      return;
    }
    if (!isPlayerNameFormatValid || playerNameAvailability !== "available") {
      return;
    }
    const displayName = normalizedPlayerNameDraft;

    setPlayerNameSaving(true);
    try {
      const nonceRes = await fetch(`${ORACLE_URL}/players/profile/nonce`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ address }),
      });
      const noncePayload = await nonceRes.json().catch(() => ({}));
      if (!nonceRes.ok) {
        showToast(noncePayload?.error ?? "Failed to prepare signature.", "warn");
        return;
      }

      const nonce = String(noncePayload?.nonce ?? "").trim();
      if (!nonce) {
        showToast("Failed to prepare signature.", "warn");
        return;
      }

      const approvalMessage = buildPlayerNameApprovalMessage(address, displayName, nonce);
      const signature = await signPlayerNameApproval(address, approvalMessage);
      if (!signature) {
        showToast("Wallet signer unavailable. Reconnect and try again.", "warn");
        return;
      }

      const res = await fetch(`${ORACLE_URL}/players/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          address,
          displayName,
          nonce,
          signature,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setPlayerNameAvailability("taken");
          return;
        }
        showToast(payload?.error ?? "Failed to save player name.", "warn");
        return;
      }
      const savedName = String(payload?.displayName ?? displayName).trim();
      setPlayerDisplayName(savedName || displayName);
      setPlayerNameModalOpen(false);
      showToast("Player name saved.");
    } catch {
      showToast("Failed to save player name.", "warn");
    } finally {
      setPlayerNameSaving(false);
    }
  };

  const handleFaucet = async () => {
    if (!address || faucetPending) return;
    const normalizedAddress = address.toLowerCase();
    if (walletSessionAddress !== normalizedAddress) {
      const ok = await refreshWalletSession({ force: true });
      if (!ok) {
        showToast("Please complete wallet signature first.", "warn");
        return;
      }
    }

    setFaucetPending(true);
    try {
      const sendRequest = () =>
        fetch(`${ORACLE_URL}/faucet`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ address }),
        });

      let res = await sendRequest();
      let payload = await res.json().catch(() => ({}));

      if ((res.status === 401 || res.status === 403) && (await refreshWalletSession({ force: true }))) {
        res = await sendRequest();
        payload = await res.json().catch(() => ({}));
      }

      if (!res.ok) {
        if (payload?.retryAfterSeconds) {
          const totalSeconds = Number(payload.retryAfterSeconds);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const parts = [] as string[];
          if (hours) parts.push(`${hours}h`);
          if (minutes) parts.push(`${minutes}m`);
          showToast(`Faucet cooldown. Try again in ${parts.join(" ") || "soon"}.`, "warn");
        } else {
          showToast(payload?.error ?? "Faucet failed.", "warn");
        }
        return;
      }
      const txHash = payload?.txHash as string | undefined;
      if (txHash) {
        showToast(
          `Faucet sent: ${payload?.amount ?? faucetAmount} ${stablecoinSymbol}`,
          "info",
          profile.explorerUrl ? `${profile.explorerUrl}/tx/${txHash}` : undefined,
        );
      } else {
        showToast(`Faucet sent: ${payload?.amount ?? faucetAmount} ${stablecoinSymbol}`, "info");
      }
    } catch {
      showToast("Faucet failed.", "warn");
    } finally {
      setFaucetPending(false);
    }
  };
  const walletLabel = useMemo(() => {
    if (!address) return "Connect wallet";
    const truncateMiddle = (value: string, lead: number, tail: number) => {
      if (value.length <= lead + tail + 3) return value;
      return `${value.slice(0, lead)}...${value.slice(-tail)}`;
    };
    if (playerDisplayName) {
      return truncateMiddle(playerDisplayName, 12, 8);
    }
    return truncateMiddle(address, 6, 4);
  }, [address, playerDisplayName]);

  const ethBalanceLabel = useMemo(() => {
    if (!ethBalance) return `-- ${nativeSymbol}`;
    const value = Number(ethBalance.formatted);
    return `${value.toFixed(4)} ${nativeSymbol}`;
  }, [ethBalance, nativeSymbol]);

  const stablecoinBalanceLabel = useMemo(() => {
    if (!address) return `-- ${stablecoinSymbol}`;
    if (!stablecoinBalance) return `$0 ${stablecoinSymbol}`;
    const value = Number(stablecoinBalance.formatted);
    return `$${Math.floor(value).toLocaleString()} ${stablecoinSymbol}`;
  }, [address, stablecoinBalance, stablecoinSymbol]);

  const isPlayerNameInputInvalid = !isPlayerNameFormatValid || playerNameAvailability === "taken";
  const canRegisterPlayerName =
    isPlayerNameFormatValid && playerNameAvailability === "available" && !playerNameSaving;
  const isPlayerNameUpdateMode = Boolean(playerDisplayName);

  const movesRemaining = moves?.remaining ?? 0;
  const movesTotal = moves?.total ?? 0;
  const isWeekActive = week?.status === "ACTIVE";
  const showGuideButton = showMoves;
  const showMovesPanel = showMoves && isWeekActive;

  const openProtocolGuide = (section: "tactical-moves" | "welcome", markSeen = false) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("valcore:open-protocol-guide", {
        detail: { section, markSeen },
      }),
    );
  };

  return (
    <>
      <header className="vc-hud">
        <div className="hud-left">
          <Link href="/lineup" className="hud-logo" aria-label="Go to lineup">
            <img src="/brand/logo.png" alt="Valcore" />
          </Link>
          <div className="hud-subtitle">Strategic lineup command</div>
        </div>

        <div className="hud-center">
          <div className="hud-status-panel">
            <div className="hud-status-label">Week Status</div>
            <div className="hud-status-value">{statusLabel}</div>
            <div className="hud-time">{countdownText}</div>
          </div>
        </div>

        <div className="hud-right">
          {showGuideButton ? (
            <button
              type="button"
              className="hud-guide-button"
              onClick={() => openProtocolGuide("welcome", true)}
            >
              <svg viewBox="0 0 24 24" className="hud-guide-icon" aria-hidden="true">
                <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v14.5a1.5 1.5 0 0 1-1.5 1.5H6.5A2.5 2.5 0 0 1 4 17.5v-11Z" />
                <path d="M8 8h7M8 11h7M8 14h5" />
              </svg>
              <span>How It Works</span>
            </button>
          ) : null}
          {showMovesPanel ? (
            <>
              <button
                type="button"
                className={`hud-swap-toggle ${swapMode ? "active" : ""} ${isWeekActive ? "" : "disabled"}`}
                disabled={!isWeekActive}
                onClick={() => setSwapMode((prev) => !prev)}
              >
                <span className="hud-swap-text">
                  <span>Swap</span>
                  <span>Mode</span>
                </span>
                <span className="hud-swap-switch" aria-hidden="true">
                  <span className="hud-swap-knob" />
                </span>
              </button>
              <div className="hud-moves" data-tip="Each swap costs 1 move. Resets next week.">
                <div className="hud-moves-head">
                  <span className="hud-moves-label">Tactical Moves</span>
                  <button
                    type="button"
                    className="hud-help-inline"
                    aria-label="How tactical moves work"
                    onClick={() => openProtocolGuide("tactical-moves")}
                  >
                    ?
                  </button>
                  <span className="hud-moves-value">
                    {movesRemaining}/{movesTotal}
                  </span>
                </div>
                <div className="hud-moves-bar" role="img" aria-label="Tactical moves remaining">
                  {Array.from({ length: movesTotal }).map((_, index) => {
                    const filled = index < movesRemaining;
                    return (
                      <span
                        key={`move-${index}`}
                        className={`hud-move-segment ${filled ? "filled" : ""}`}
                      />
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}
          <div className="hud-wallet">
            <button
              type="button"
              className={`hud-wallet-pill ${address ? "connected" : ""}`}
              onClick={() => {
                if (!address) {
                  setWalletMenuOpen(false);
                  if (hasProvider) {
                    void connect();
                    return;
                  }
                  window.open("https://walletconnect.network/wallets", "_blank", "noreferrer");
                  return;
                }
                setWalletMenuOpen((prev) => !prev);
              }}
            >
              {address ? (
                connector?.icon ? (
                  <img
                    src={connector.icon}
                    alt={connector.name ?? "Wallet"}
                    className="hud-wallet-icon"
                  />
                ) : (
                  <span className="hud-wallet-icon fallback">W</span>
                )
              ) : null}
              <span className="hud-wallet-label">{walletLabel}</span>
            </button>
            {address ? (
              <>
                <div className="hud-wallet-eth">{ethBalanceLabel}</div>
                <div className="hud-wallet-stablecoin">{stablecoinBalanceLabel}</div>
              </>
            ) : null}
            {address && walletMenuOpen ? (
              <div className="hud-wallet-menu" role="dialog" aria-modal="false">
                <button
                  type="button"
                  className="hud-wallet-action"
                  onClick={() => void handleFaucet()}
                  disabled={faucetPending}
                >
                  {faucetPending ? "Faucet pending..." : `Faucet ${faucetAmount} ${stablecoinSymbol}`}
                </button>
                <button
                  type="button"
                  className="hud-wallet-action"
                  onClick={async () => {
                    await openPlayerNameModal();
                    setWalletMenuOpen(false);
                  }}
                >
                  {playerDisplayName ? "Update player name" : "Set player name"}
                </button>
                <button
                  type="button"
                  className="hud-wallet-action"
                  onClick={async () => {
                    if (!address) return;
                    await navigator.clipboard.writeText(address);
                    setWalletMenuOpen(false);
                  }}
                >
                  Copy address
                </button>
                <button
                  type="button"
                  className="hud-wallet-action danger"
                  onClick={() => {
                    disconnect();
                    setWalletMenuOpen(false);
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {playerNameModalOpen ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onClick={() => {
            if (!isPlayerNameUpdateMode) return;
            setPlayerNameModalOpen(false);
            setPlayerNameDraft(playerDisplayName ?? "");
            setPlayerNameAvailability("idle");
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-[color:var(--border)] bg-[color:var(--bg-0)] p-5 shadow-[0_30px_90px_-45px_rgba(0,0,0,0.9)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-lg font-semibold text-[color:var(--text-primary)]">Player Name</div>
            <input
              type="text"
              value={playerNameDraft}
              onChange={(event) => setPlayerNameDraft(event.target.value)}
              maxLength={24}
              autoFocus
              className={`mt-4 h-11 w-full rounded-xl border bg-[color:var(--bg-1)] px-3 text-[color:var(--text-primary)] outline-none ${
                isPlayerNameInputInvalid ? "border-[color:var(--wildcard)]" : "border-[color:var(--border)]"
              }`}
              placeholder="Your player name"
            />
            {playerNameAvailability === "taken" ? (
              <p className="mt-2 text-xs text-[color:var(--wildcard)]">already taken</p>
            ) : null}
            <div className="mt-4 flex items-center justify-end">
              <button
                type="button"
                className="rounded-full border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 py-2 text-sm font-semibold text-[#06131e] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canRegisterPlayerName}
                onClick={() => void handleRegisterPlayerName()}
              >
                {playerNameSaving
                  ? isPlayerNameUpdateMode
                    ? "Updating..."
                    : "Registering..."
                  : isPlayerNameUpdateMode
                    ? "Update"
                    : "Register"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 w-[340px] max-w-[calc(100vw-1.5rem)]">
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
      ) : null}
    </>
  );
}
