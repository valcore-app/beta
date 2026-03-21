"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { apiGet, apiPost } from "../../../../lib/api";

type ErrorRow = {
  id: number;
  created_at: string;
  source: string;
  severity: "warn" | "error" | "fatal" | string;
  category: string;
  message: string;
  error_name: string | null;
  stack: string | null;
  fingerprint: string | null;
  path: string | null;
  method: string | null;
  status_code: number | null;
  context_json: string | null;
  tags_json: string | null;
  release: string | null;
  session_address: string | null;
  wallet_address: string | null;
  strategist_display_name: string | null;
  user_agent: string | null;
  acknowledged: number;
  incident_key: string | null;
  incident_state: "new" | "actionable" | "suppressed" | "fixed-monitoring" | "closed" | string;
  actionable: number;
  suppressed: number;
  regression: number;
  escalation_state: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
};

type ErrorListResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: ErrorRow[];
};

type ErrorSummaryResponse = {
  windowHours: number;
  windowStartAt: string;
  total: number;
  unacknowledged: number;
  windowTotal: number;
  windowUnacknowledged: number;
  lastEventAt: string | null;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
  byIncidentState?: Record<string, number>;
  actionableUnacknowledged?: number;
  windowActionableUnacknowledged?: number;
  alerts: {
    enabled: boolean;
    windowMinutes: number;
    threshold: number;
    minSeverity: string;
    cooldownMinutes: number;
    channelConfigured: {
      webhook: boolean;
      telegram: boolean;
    };
  };
};


type IncidentRow = {
  id: number;
  incident_key: string;
  source: string;
  fingerprint: string | null;
  category: string | null;
  path: string | null;
  method: string | null;
  status_code: number | null;
  current_state: "new" | "actionable" | "suppressed" | "fixed-monitoring" | "closed" | string;
  first_seen_at: string;
  last_seen_at: string;
  event_count: number;
  unacked_count: number;
  regression_count: number;
  escalation_state: string;
};

type IncidentListResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: IncidentRow[];
};

type IncidentSummaryResponse = {
  total: number;
  actionable: number;
  newCount: number;
  monitoring: number;
  suppressed: number;
  closed: number;
  windowTotal: number;
  windowActionable: number;
  byState: Record<string, number>;
};

type ActionableState = "all" | "actionable" | "non-actionable";
type IncidentState = "" | "new" | "actionable" | "suppressed" | "fixed-monitoring" | "closed";
type AckState = "all" | "acked" | "unacked";

const severityBadgeClass = (severity: string) => {
  const normalized = String(severity).toLowerCase();
  if (normalized === "fatal") {
    return "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";
  }
  if (normalized === "error") {
    return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  }
  return "border-[color:var(--arena-muted)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
};

const ackBadgeClass = (ack: number) =>
  ack
    ? "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]"
    : "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";

const incidentStateBadgeClass = (state: string | null | undefined) => {
  const normalized = String(state ?? "").toLowerCase();
  if (normalized === "actionable") return "border-[color:var(--arena-danger)] bg-[color:var(--arena-danger-soft)] text-[color:var(--arena-danger)]";
  if (normalized === "new") return "border-[color:var(--arena-gold)] bg-[color:var(--arena-gold-soft)] text-[color:var(--arena-gold)]";
  if (normalized === "fixed-monitoring") return "border-[color:var(--arena-accent)] bg-[rgba(80,180,255,0.18)] text-[color:var(--arena-accent)]";
  if (normalized === "suppressed") return "border-[color:var(--arena-muted)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
  if (normalized === "closed") return "border-[color:var(--arena-success)] bg-[color:var(--arena-success-soft)] text-[color:var(--arena-success)]";
  return "border-[color:var(--arena-stroke)] bg-[color:var(--arena-panel-strong)] text-[color:var(--arena-muted)]";
};

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace("T", " ").replace(".000Z", " UTC");
};

const shorten = (value: string | null | undefined, max = 100) => {
  const text = String(value ?? "").trim();
  if (!text) return "--";
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  const raw = String(value ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors in UI
  }
  return {};
};

const pickTechnicalError = (context: Record<string, unknown>) => {
  const candidates = [context.rawError, context.error, context.cause, context.reason, context.details];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
};

const toPrettyJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
};

export default function OpsErrorsPage() {
  const [summary, setSummary] = useState<ErrorSummaryResponse | null>(null);
  const [incidentSummary, setIncidentSummary] = useState<IncidentSummaryResponse | null>(null);

  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [incidentRows, setIncidentRows] = useState<IncidentRow[]>([]);

  const [severity, setSeverity] = useState("");
  const [source, setSource] = useState("");
  const [category, setCategory] = useState("");
  const [ack, setAck] = useState<AckState>("unacked");
  const [actionable, setActionable] = useState<ActionableState>("actionable");
  const [incidentState, setIncidentState] = useState<IncidentState>("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailsById, setDetailsById] = useState<Record<number, ErrorRow>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [ackLoadingId, setAckLoadingId] = useState<number | null>(null);

  const refreshSummary = useCallback(async () => {
    setLoadingSummary(true);
    try {
      const [errorSummary, incidentSummaryRes] = await Promise.all([
        apiGet<ErrorSummaryResponse>("/admin/errors/summary?windowHours=24"),
        apiGet<IncidentSummaryResponse>("/admin/errors/incidents/summary?windowHours=24"),
      ]);
      setSummary(errorSummary);
      setIncidentSummary(incidentSummaryRes);
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (severity) params.set("severity", severity);
      if (source) params.set("source", source);
      if (category) params.set("category", category);
      if (ack !== "all") params.set("ack", ack);
      if (actionable !== "all") params.set("actionable", actionable);
      if (incidentState) params.set("incidentState", incidentState);
      if (search) params.set("q", search);

      const incidentParams = new URLSearchParams({
        page: "1",
        pageSize: "10",
      });
      incidentParams.set("state", "actionable");
      if (source) incidentParams.set("source", source);
      if (search) incidentParams.set("q", search);

      const [data, incidents] = await Promise.all([
        apiGet<ErrorListResponse>(`/admin/errors?${params.toString()}`),
        apiGet<IncidentListResponse>(`/admin/errors/incidents?${incidentParams.toString()}`),
      ]);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(Math.max(1, data.totalPages ?? 1));
      setIncidentRows(incidents.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load errors");
    } finally {
      setLoadingList(false);
    }
  }, [ack, actionable, category, incidentState, page, pageSize, search, severity, source]);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshSummary();
      void refreshList();
    }, 30000);
    return () => clearInterval(timer);
  }, [refreshList, refreshSummary]);

  const applySearch = useCallback(() => {
    setPage(1);
    setSearch(searchInput.trim());
  }, [searchInput]);

  const clearFilters = useCallback(() => {
    setSeverity("");
    setSource("");
    setCategory("");
    setAck("unacked");
    setActionable("actionable");
    setIncidentState("");
    setSearch("");
    setSearchInput("");
    setPage(1);
  }, []);

  const onExpand = useCallback(
    async (id: number) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (detailsById[id]) {
        return;
      }
      setDetailLoadingId(id);
      try {
        const detail = await apiGet<ErrorRow>(`/admin/errors/${id}`);
        setDetailsById((prev) => ({ ...prev, [id]: detail }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load detail");
      } finally {
        setDetailLoadingId(null);
      }
    },
    [detailsById, expandedId],
  );

  const acknowledge = useCallback(async (id: number) => {
    setAckLoadingId(id);
    try {
      const payload = await apiPost<{ ok: boolean; row: ErrorRow }>(`/admin/errors/${id}/ack`, {
        acknowledgedBy: "ops-console",
      });
      if (payload?.row) {
        setDetailsById((prev) => ({ ...prev, [id]: payload.row }));
        setRows((prev) => prev.map((row) => (row.id === id ? payload.row : row)));
      }
      void refreshSummary();
      void refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Acknowledge failed");
    } finally {
      setAckLoadingId(null);
    }
  }, [refreshList, refreshSummary]);

  const startItem = useMemo(() => (total === 0 ? 0 : (page - 1) * pageSize + 1), [page, pageSize, total]);
  const endItem = useMemo(() => Math.min(total, page * pageSize), [page, pageSize, total]);

  return (
    <div className="grid gap-8">
      <section className="arena-panel rounded-[28px] p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2">
            <span className="arena-chip">Ops Console</span>
            <h1 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">Error Center</h1>
            <p className="text-sm text-[color:var(--arena-muted)] md:text-base">
              Tum istemci/sunucu hatalarini tek akista gor, filtrele, onayla.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/ops"
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Back to Ops
            </Link>
            <button
              type="button"
              onClick={() => {
                void refreshSummary();
                void refreshList();
              }}
              className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--arena-stroke-strong)] px-5 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Refresh
            </button>
          </div>
        </div>
        {error ? <p className="mt-4 text-sm text-[color:var(--arena-danger)]">{error}</p> : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Total</p>
            <CardTitle>{summary?.total ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">All captured events</CardContent>
        </Card>
        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Unacknowledged</p>
            <CardTitle>{summary?.unacknowledged ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">Pending review</CardContent>
        </Card>
        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Last 24h</p>
            <CardTitle>{summary?.windowTotal ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">
            Unacked: {summary?.windowUnacknowledged ?? 0}
          </CardContent>
        </Card>
        <Card className="arena-panel-strong">
          <CardHeader>
            <p className="arena-label">Alert Mode</p>
            <CardTitle>{summary?.alerts?.enabled ? "Enabled" : "Disabled"}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[color:var(--arena-muted)]">
            threshold {summary?.alerts?.threshold ?? "--"} / {summary?.alerts?.windowMinutes ?? "--"}m
          </CardContent>
        </Card>
      </section>

      <section className="arena-panel-strong rounded-2xl border border-[color:var(--arena-stroke)] p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)]">Actionable Incidents</h2>
          <span className="text-xs text-[color:var(--arena-muted)]">top 10</span>
        </div>
        {!incidentRows.length ? (
          <p className="text-xs text-[color:var(--arena-muted)]">No actionable incidents right now.</p>
        ) : (
          <div className="grid gap-2">
            {incidentRows.map((incident) => (
              <div
                key={incident.id}
                className="grid gap-2 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] p-3 text-xs md:grid-cols-[1fr_auto_auto_auto]"
              >
                <div className="min-w-0">
                  <p className="truncate text-[color:var(--arena-ink)]">{shorten(incident.incident_key, 120)}</p>
                  <p className="truncate text-[color:var(--arena-muted)]">
                    {shorten(incident.source, 20)} | {shorten(incident.path, 40)}
                  </p>
                </div>
                <div className="text-[color:var(--arena-muted)]">events: {incident.event_count}</div>
                <div className="text-[color:var(--arena-muted)]">unacked: {incident.unacked_count}</div>
                <Badge className={incidentStateBadgeClass(incident.current_state)}>{incident.current_state}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="arena-panel-strong rounded-2xl border border-[color:var(--arena-stroke)] p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-8">
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applySearch();
            }}
            placeholder="Search message/fingerprint/address"
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)] outline-none focus:border-[color:var(--arena-accent)]"
          />
          <select
            value={severity}
            onChange={(event) => {
              setSeverity(event.target.value);
              setPage(1);
            }}
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)]"
          >
            <option value="">All severities</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
            <option value="fatal">fatal</option>
          </select>
          <input
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(1);
            }}
            placeholder="Source"
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)] outline-none focus:border-[color:var(--arena-accent)]"
          />
          <input
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              setPage(1);
            }}
            placeholder="Category"
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)] outline-none focus:border-[color:var(--arena-accent)]"
          />
          <select
            value={ack}
            onChange={(event) => {
              setAck(event.target.value as AckState);
              setPage(1);
            }}
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)]"
          >
            <option value="all">All ack states</option>
            <option value="unacked">Unacked</option>
            <option value="acked">Acked</option>
          </select>
          <select
            value={actionable}
            onChange={(event) => {
              setActionable(event.target.value as ActionableState);
              setPage(1);
            }}
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)]"
          >
            <option value="all">All action states</option>
            <option value="actionable">Actionable only</option>
            <option value="non-actionable">Non-actionable only</option>
          </select>
          <select
            value={incidentState}
            onChange={(event) => {
              setIncidentState(event.target.value as IncidentState);
              setPage(1);
            }}
            className="h-10 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-3 text-sm text-[color:var(--arena-ink)]"
          >
            <option value="">All incident states</option>
            <option value="actionable">actionable</option>
            <option value="new">new</option>
            <option value="fixed-monitoring">fixed-monitoring</option>
            <option value="suppressed">suppressed</option>
            <option value="closed">closed</option>
          </select>
          <div className="flex items-center gap-2"> 
            <button
              type="button"
              onClick={applySearch}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-[color:var(--arena-stroke-strong)] px-4 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-[color:var(--arena-stroke)] px-4 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-muted)] transition hover:bg-[color:var(--arena-panel-strong)]"
            >
              Clear
            </button>
          </div>
        </div>
      </section>

      <section className="arena-panel-strong rounded-2xl border border-[color:var(--arena-stroke)] p-4">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs text-[color:var(--arena-muted)]">
            <thead>
              <tr className="border-b border-[color:var(--arena-stroke)] text-[0.68rem] uppercase tracking-[0.12em]">
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Message</th>
                <th className="px-3 py-2">Path</th>
                <th className="px-3 py-2">Strategist</th>
                <th className="px-3 py-2">Incident</th>
                <th className="px-3 py-2">Ack</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const detail = detailsById[row.id];
                const expanded = expandedId === row.id;
                const detailRow = detail ?? row;
                const detailContext = parseJsonObject(detailRow.context_json);
                const technicalError = pickTechnicalError(detailContext);
                return (
                  <Fragment key={`group-${row.id}`}>
                    <tr
                      key={`row-${row.id}`}
                      className="cursor-pointer border-b border-[color:var(--arena-stroke)] hover:bg-[rgba(20,24,36,0.45)]"
                      onClick={() => void onExpand(row.id)}
                    >
                      <td className="px-3 py-2">{formatDate(row.created_at)}</td>
                      <td className="px-3 py-2">
                        <Badge className={severityBadgeClass(row.severity)}>{row.severity}</Badge>
                      </td>
                      <td className="px-3 py-2">{shorten(row.source, 26)}</td>
                      <td className="px-3 py-2">{shorten(row.category, 24)}</td>
                      <td className="px-3 py-2 text-[color:var(--arena-ink)]">{shorten(row.message, 90)}</td>
                      <td className="px-3 py-2">{shorten(row.path, 36)}</td>
                      <td className="px-3 py-2 text-[color:var(--arena-ink)]">{shorten(row.strategist_display_name, 24)}</td>
                      <td className="px-3 py-2">
                        <Badge className={incidentStateBadgeClass(row.incident_state)}>{row.incident_state || "new"}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Badge className={ackBadgeClass(row.acknowledged)}>
                          {row.acknowledged ? "acked" : "pending"}
                        </Badge>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr key={`detail-${row.id}`} className="border-b border-[color:var(--arena-stroke)]">
                        <td colSpan={9} className="px-3 py-3">
                          {detailLoadingId === row.id ? (
                            <p className="text-xs text-[color:var(--arena-muted)]">Loading detail...</p>
                          ) : (
                            <div className="grid gap-2 rounded-xl border border-[color:var(--arena-stroke)] bg-[rgba(8,10,18,0.78)] p-3 text-xs">
                              <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-4">
                                <div>
                                  <span className="text-[color:var(--arena-muted)]">ID</span>
                                  <p className="font-semibold text-[color:var(--arena-ink)]">{detail?.id ?? row.id}</p>
                                </div>
                                <div>
                                  <span className="text-[color:var(--arena-muted)]">Error Name</span>
                                  <p className="font-semibold text-[color:var(--arena-ink)]">{detail?.error_name ?? "--"}</p>
                                </div>
                                <div>
                                  <span className="text-[color:var(--arena-muted)]">Method / Status</span>
                                  <p className="font-semibold text-[color:var(--arena-ink)]">
                                    {detail?.method ?? "--"} {detail?.status_code ? `/ ${detail.status_code}` : ""}
                                  </p>
                                </div>
                                <div>
                                  <span className="text-[color:var(--arena-muted)]">Fingerprint</span>
                                  <p className="font-semibold text-[color:var(--arena-ink)] break-all">{detail?.fingerprint ?? "--"}</p>
                                </div>
                              </div>

                              <div>
                                <span className="text-[color:var(--arena-muted)]">Full Message</span>
                                <p className="whitespace-pre-wrap text-[color:var(--arena-ink)]">{detail?.message ?? row.message}</p>
                              </div>

                              <div>
                                <span className="text-[color:var(--arena-muted)]">Technical Detail</span>
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--arena-stroke)] bg-[rgba(10,10,10,0.8)] p-2 text-[11px] text-[color:var(--arena-ink)]">
                                  {technicalError || "--"}
                                </pre>
                              </div>

                              <div>
                                <span className="text-[color:var(--arena-muted)]">Stack</span>
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--arena-stroke)] bg-[rgba(10,10,10,0.8)] p-2 text-[11px] text-[color:var(--arena-muted)]">
                                  {detailRow.stack ?? "--"}
                                </pre>
                              </div>

                              <div>
                                <span className="text-[color:var(--arena-muted)]">Context JSON</span>
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--arena-stroke)] bg-[rgba(10,10,10,0.8)] p-2 text-[11px] text-[color:var(--arena-muted)]">
                                  {toPrettyJson(detailContext)}
                                </pre>
                              </div>

                              <div className="flex flex-wrap items-center gap-3">
                                <span>Session: {detailRow.session_address ?? "--"}</span>
                                <span>Wallet: {detailRow.wallet_address ?? "--"}</span>
                                <span>Strategist: {detailRow.strategist_display_name ?? "--"}</span>
                                <span>Release: {detailRow.release ?? "--"}</span>
                                <span>User-Agent: {shorten(detailRow.user_agent, 120)}</span>
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={Boolean(detail?.acknowledged) || ackLoadingId === row.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void acknowledge(row.id);
                                  }}
                                  className="inline-flex h-9 items-center justify-center rounded-xl border border-[color:var(--arena-stroke-strong)] px-3 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {ackLoadingId === row.id ? "Acking..." : "Acknowledge"}
                                </button>
                                <span className="text-[color:var(--arena-muted)]">
                                  {detail?.acknowledged
                                    ? `Acked by ${detail.acknowledged_by ?? "--"} at ${formatDate(detail.acknowledged_at)}`
                                    : "Not acknowledged"}
                                </span>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-[color:var(--arena-muted)]">
                    {loadingList ? "Loading errors..." : "No errors found for current filters."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--arena-muted)]">
          <div>
            Showing {startItem}-{endItem} of {total}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={String(pageSize)}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              className="h-9 rounded-lg border border-[color:var(--arena-stroke)] bg-[rgba(8,12,24,0.75)] px-2 text-xs text-[color:var(--arena-ink)]"
            >
              <option value="10">10 / page</option>
              <option value="25">25 / page</option>
              <option value="50">50 / page</option>
              <option value="100">100 / page</option>
            </select>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[color:var(--arena-stroke)] px-3 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Prev
            </button>
            <span>
              Page {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-[color:var(--arena-stroke)] px-3 text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--arena-ink)] transition hover:bg-[color:var(--arena-panel-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Next
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-[color:var(--arena-stroke)] bg-[rgba(12,12,12,0.75)] p-4 text-xs text-[color:var(--arena-muted)]">
        Alert channels: webhook {summary?.alerts?.channelConfigured?.webhook ? "configured" : "missing"} / telegram {summary?.alerts?.channelConfigured?.telegram ? "configured" : "missing"}.
         Incidents actionable: {incidentSummary?.actionable ?? 0}.{loadingSummary ? " Refreshing summary..." : ""}
      </section>
    </div>
  );
}



















