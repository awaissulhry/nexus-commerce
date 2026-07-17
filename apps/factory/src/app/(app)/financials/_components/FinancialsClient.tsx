/**
 * FP9 → EPF2 — the money page at design law. One container owning URL state
 * (`?tab` `?o` `?from` `?to` `?party` + `?range=all`; all read on load, all
 * written on change; the drawer is pushState so browser Back closes it — the
 * EPO.7 idiom), the Rome "last 12 months" default window with a one-click
 * All-time toggle, SSE freshness (payment.recorded / order.updated /
 * import.finished → debounced refetch + "money synced Ns ago"), the keyboard
 * map (1-4 tabs · / search · Esc closes), and the sibling surfaces: four FS3
 * grids, the money drawer, the consequence modals, the bank import and the
 * cancelled-money bucket. Whole page behind pages.financials; every cent
 * grain-stripped at the edge.
 */
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Euro, Upload } from "lucide-react";
import { PageHeader, GridToolbar } from "@/design-system/patterns";
import { DateField, Listbox, Modal, Tabs, useToast } from "@/design-system/components";
import { Button, Skeleton } from "@/design-system/primitives";
import { AsyncCombobox, type SearchLoader } from "@/components/AsyncCombobox"; // FS3 — paged party picker
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { useFactoryEvents } from "@/lib/use-factory-events";
import { defaultWindowFrom, monthDayWindow } from "@/lib/financials/money-ux";
import { GridSkeleton, DepositsGrid, MonthGrid, OrdersGrid, PartyGrid, money } from "./MoneyGrids";
import { MoneyDrawer } from "./MoneyDrawer";
import { NewInvoiceModal, MarkPaidModal } from "./InvoiceModals";
import { PaymentModal } from "./PaymentModal";
import { ImportModal } from "./ImportModal";
import { CancelledDrawer } from "./CancelledDrawer";
import { FIN_TABS, type DepositRow, type FinTab, type FinancialDetail, type FinancialsResponse, type InvoiceRow, type OrderFin, type PartyAgg, type PeriodAgg, type PartyResponse, type PeriodResponse, type DepositsResponse } from "./types";

const TAB_LABEL: Record<FinTab, string> = { orders: "By order", party: "By customer", month: "By month", deposits: "Deposits outstanding" };

// FS3 — paged type-to-find party filter over /api/parties-lite?q= (EPO.7 idiom)
const loadPartyOptions: SearchLoader = async (q, cursor) => {
  const usp = new URLSearchParams({ q });
  if (cursor) usp.set("cursor", cursor);
  const d = await apiJson<{ parties: { id: string; name: string }[]; nextCursor?: string | null }>(`/api/parties-lite?${usp}`);
  const options = d.parties.map((p) => ({ value: p.id, label: p.name }));
  return { options: !q && !cursor ? [{ value: "", label: "All customers" }, ...options] : options, nextCursor: d.nextCursor ?? null };
};

/** Live "money synced Ns ago" line — isolated so only IT re-renders on the tick. */
function Freshness({ at }: { at: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (at == null) return <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>syncing…</span>;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }} data-testid="freshness">money synced {s < 2 ? "just now" : `${s}s ago`}</span>;
}

const ORDER_STATES = ["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED", "CLOSED"];

function FinancialsInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const canInvoice = usePermission("invoices.manage");
  const canPay = usePermission("payments.record");
  const canImport = usePermission("imports.run");

  // ── URL state (single source of truth — EPO URL law) ─────────────
  const rawTab = params.get("tab");
  const tab: FinTab = FIN_TABS.includes(rawTab as FinTab) ? (rawTab as FinTab) : "orders";
  const openId = params.get("o");
  const partyId = params.get("party") ?? "";
  const allTime = params.get("range") === "all";
  const fromParam = params.get("from") ?? "";
  const toParam = params.get("to") ?? "";
  const defFrom = useRef(defaultWindowFrom(new Date().toISOString())).current;
  const effFrom = fromParam || (allTime ? "" : defFrom); // the 12-month Rome default — EPF.1's perf lever
  const effTo = toParam;
  const filterKey = `${effFrom}|${effTo}|${partyId}`;

  const nav = useCallback((patch: Record<string, string | null>, push = true) => {
    const usp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") usp.delete(k);
      else usp.set(k, v);
    }
    const url = `/financials${usp.toString() ? `?${usp}` : ""}`;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate")); // EPO.7 — useSearchParams re-reads
  }, []);

  const setTab = useCallback((t: string) => nav({ tab: t === "orders" ? null : t }), [nav]);
  const openDrawer = useCallback((id: string) => nav({ o: id }), [nav]); // pushState → Back closes (E12)
  const closeDrawer = useCallback(() => nav({ o: null }), [nav]);

  // ── data ─────────────────────────────────────────────────────────
  const [core, setCore] = useState<FinancialsResponse | null>(null);
  const [extraRows, setExtraRows] = useState<OrderFin[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [parties, setParties] = useState<PartyAgg[] | null>(null);
  const [months, setMonths] = useState<PeriodAgg[] | null>(null);
  const [deposits, setDeposits] = useState<DepositRow[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [stateFilter, setStateFilter] = useState("");
  const [detail, setDetail] = useState<FinancialDetail | null>(null);

  const winQuery = useCallback((extra?: Record<string, string>) => {
    const usp = new URLSearchParams();
    if (effFrom) usp.set("from", effFrom);
    if (effTo) usp.set("to", effTo);
    if (partyId) usp.set("party", partyId);
    for (const [k, v] of Object.entries(extra ?? {})) usp.set(k, v);
    const s = usp.toString();
    return s ? `?${s}` : "";
  }, [effFrom, effTo, partyId]);

  const loadCore = useCallback(async () => {
    try {
      const d = await apiJson<FinancialsResponse>(`/api/financials${winQuery()}`);
      setCore(d);
      setExtraRows([]);
      setCursor(d.nextCursor ?? null);
      setSyncedAt(Date.now());
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [winQuery, toast]);

  const loadTab = useCallback(async (t: FinTab) => {
    try {
      if (t === "party") setParties((await apiJson<PartyResponse>(`/api/financials/party${winQuery()}`)).parties);
      else if (t === "month") setMonths((await apiJson<PeriodResponse>(`/api/financials/period${winQuery()}`)).months);
      else if (t === "deposits") setDeposits((await apiJson<DepositsResponse>(`/api/financials/deposits${winQuery()}`)).deposits);
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [winQuery, toast]);

  // window/party changed (or first mount): drop every cache, reload what's visible
  useEffect(() => {
    setCore(null); setParties(null); setMonths(null); setDeposits(null); setExtraRows([]); setCursor(null);
    void loadCore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey is the reload trigger
  }, [filterKey]);
  // lazy per-tab loads
  useEffect(() => {
    if (tab === "party" && parties == null) void loadTab("party");
    if (tab === "month" && months == null) void loadTab("month");
    if (tab === "deposits" && deposits == null) void loadTab("deposits");
  }, [tab, parties, months, deposits, loadTab]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    try {
      const d = await apiJson<FinancialsResponse>(`/api/financials${winQuery({ cursor })}`);
      setExtraRows((prev) => [...prev, ...d.orders]);
      setCursor(d.nextCursor ?? null);
    } catch (e) { toast((e as Error).message, "danger"); }
  }, [cursor, winQuery, toast]);

  // drawer detail follows ?o=
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await apiJson<FinancialDetail>(`/api/financials/order/${id}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => {
    setDetail(null);
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  const refreshAll = useCallback(() => {
    void loadCore();
    setParties(null); setMonths(null); setDeposits(null);
    if (tab !== "orders") void loadTab(tab);
    if (openId) void loadDetail(openId);
  }, [loadCore, loadTab, loadDetail, tab, openId]);

  // FS2 SSE (cross-review M6: incl. import.finished) — live tiles + active tab
  useFactoryEvents(["payment.recorded", "order.updated", "import.finished"], refreshAll);

  // ── surfaces state ───────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [markPaidFor, setMarkPaidFor] = useState<{ inv: InvoiceRow; orderNumber: string } | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [cancelledOpen, setCancelledOpen] = useState(false);

  // ── keyboard: 1-4 tabs · / search · Esc handled by DS surfaces ──
  const partyBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        setTab(FIN_TABS[Number(e.key) - 1]);
      } else if (e.key === "/") {
        e.preventDefault();
        partyBoxRef.current?.querySelector("input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);

  // party label for the filter chip (deep-linked ?party= arrives label-less — EPO.7 idiom)
  const [partyLabel, setPartyLabel] = useState("");
  useEffect(() => {
    if (!partyId) { setPartyLabel(""); return; }
    if (partyLabel) return;
    apiJson<{ parties: { id: string; name: string }[] }>(`/api/parties-lite`).then((d) => setPartyLabel(d.parties.find((p) => p.id === partyId)?.name ?? "")).catch(() => {});
  }, [partyId, partyLabel]);

  // ── drill-throughs (D-07 close) ─────────────────────────────────
  const drillParty = (id: string) => nav({ tab: null, party: id });
  const drillMonth = (monthKey: string) => {
    const w = monthDayWindow(monthKey);
    if (w) nav({ tab: null, from: w.from, to: w.to, range: null });
  };

  const t = core?.tiles;
  const cancelled = core?.cancelledWithMoney;
  const orderRows = [...(core?.orders ?? []), ...extraRows];
  const shownRows = stateFilter ? orderRows.filter((r) => r.state === stateFilter) : orderRows;

  const windowLabel = allTime && !fromParam && !toParam
    ? "All time"
    : fromParam || toParam
      ? "Custom window (Rome days)"
      : `Last 12 months · since ${defFrom}`;
  const exportHref = `/api/exports/financials${winQuery()}`;

  const metrics = [
    { label: "Outstanding balance", value: core ? <span style={{ color: "var(--h10-text)" }}>{money(t?.outstandingCents)}</span> : <Skeleton width={90} height={22} /> },
    { label: "Deposits due", value: core ? <span style={{ color: (t?.depositsDueCents ?? 0) > 0 ? "var(--h10-danger)" : "var(--h10-text)" }}>{money(t?.depositsDueCents)}</span> : <Skeleton width={90} height={22} /> },
    { label: `Invoiced this month (${core?.monthKey ?? "…"})`, value: core ? <>{money(t?.monthInvoicedCents)}</> : <Skeleton width={90} height={22} /> },
    { label: "Paid this month", value: core ? <span style={{ color: "var(--h10-success-text, var(--h10-text))" }}>{money(t?.monthPaidCents)}</span> : <Skeleton width={90} height={22} /> },
    ...(cancelled && cancelled.count > 0
      ? [{
          label: "Cancelled w/ money",
          value: (
            <button type="button" onClick={() => setCancelledOpen(true)} title="See the cancelled orders still carrying money"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--h10-warning-text, var(--h10-text))", textDecoration: "underline", textUnderlineOffset: 3 }}>
              {money(cancelled.paidCents)} · {cancelled.count}
            </button>
          ),
        }]
      : []),
  ];

  return (
    <div className="factory-page factory-grid-grow-1">
      <PageHeader
        eyebrow="Factory OS"
        title={<span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Euro size={18} /> Financials</span>}
        subtitle="Order-level money truth — who owes what, and what each order really made. Not accounting."
        actions={
          <div style={{ display: "grid", justifyItems: "end", gap: 4 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {canImport && <Button onClick={() => setImportOpen(true)}><Upload size={13} /> Import bank CSV</Button>}
              <Button onClick={() => setExportOpen(true)}><Download size={13} /> Export period</Button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Freshness at={syncedAt} />
              <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>· all figures EUR</span>
            </div>
          </div>
        }
      />

      <div style={{ margin: "12px 0 14px" }}>
        {/* the DS KPI row (MetricStrip markup); the 5th tile appears only when cancelled money exists */}
        <div className="h10-ds-metrics">
          {metrics.map((m, i) => (
            <div key={i} className="h10-ds-metric">
              <div className="lbl">{m.label}</div>
              <div className="val" style={{ fontVariantNumeric: "tabular-nums" }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      <Tabs
        tabs={FIN_TABS.map((id) => ({ id, label: id === "deposits" && deposits && deposits.length > 0 ? `${TAB_LABEL[id]} (${deposits.length})` : TAB_LABEL[id] }))}
        active={tab}
        onChange={setTab}
      />

      <div style={{ margin: "10px 0" }}>
        <GridToolbar
          count={
            tab === "orders" ? (
              core ? <>Viewing <b>1–{shownRows.length}</b> of <b>{stateFilter ? `${orderRows.length} loaded` : core.ordersTotal ?? orderRows.length}</b> orders</> : <>Loading…</>
            ) : tab === "party" ? (parties ? <><b>{parties.length}</b> customers</> : <>Loading…</>)
            : tab === "month" ? (months ? <><b>{months.length}</b> months</> : <>Loading…</>)
            : (deposits ? <><b>{deposits.length}</b> deposits outstanding</> : <>Loading…</>)
          }
          right={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11.5, color: "var(--h10-text-2)", fontWeight: 600 }} data-testid="window-label">{windowLabel}</span>
              <div style={{ minWidth: 128 }}><DateField value={effFrom} onChange={(v) => nav({ from: v || null, range: v ? null : "all" }, false)} ariaLabel="Window from (Rome day)" placeholder="from" /></div>
              <span style={{ color: "var(--h10-text-3)" }}>–</span>
              <div style={{ minWidth: 128 }}><DateField value={effTo} onChange={(v) => nav({ to: v || null }, false)} ariaLabel="Window to (Rome day)" placeholder="today" /></div>
              {allTime || fromParam || toParam ? (
                <Button onClick={() => nav({ from: null, to: null, range: null })}>Last 12 months</Button>
              ) : (
                <Button onClick={() => nav({ from: null, to: null, range: "all" })}>All time</Button>
              )}
              {partyId ? (
                <button type="button" onClick={() => nav({ party: null })} title="Clear customer filter"
                  style={{ display: "inline-flex", gap: 5, alignItems: "center", border: "1px solid var(--h10-primary)", background: "var(--h10-wash-primary, rgba(31,111,222,0.08))", color: "var(--h10-primary)", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {partyLabel || "Customer"} <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>×</span>
                </button>
              ) : (
                <div style={{ minWidth: 190 }} ref={partyBoxRef}>
                  <AsyncCombobox loader={loadPartyOptions} value={partyId} placeholder="All customers ( / )" ariaLabel="Filter by customer" onChange={(v, opt) => { setPartyLabel(v ? opt.label : ""); nav({ party: v || null }); }} />
                </div>
              )}
              {tab === "orders" && (
                <div style={{ minWidth: 150 }}>
                  <Listbox ariaLabel="Filter by state" value={stateFilter}
                    options={[{ value: "", label: "All states" }, ...ORDER_STATES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))]}
                    onChange={setStateFilter} placeholder="All states" />
                </div>
              )}
            </div>
          }
        />
      </div>

      {tab === "orders" && (core == null ? <GridSkeleton /> : (
        <>
          <OrdersGrid rows={shownRows} canMargin={canMargin} onOpen={openDrawer} />
          {cursor && !stateFilter && (
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}>
              <button type="button" onClick={() => void loadMore()} style={{ border: "1px dashed var(--h10-border)", borderRadius: 8, background: "none", padding: "7px 16px", fontSize: 12, color: "var(--h10-text-2)", cursor: "pointer" }}>
                Load more orders ({orderRows.length} of {core.ordersTotal ?? "?"} loaded)
              </button>
            </div>
          )}
          {stateFilter && <div style={{ fontSize: 12, color: "var(--h10-text-3)", padding: "8px 2px" }}>State filter applies to the {orderRows.length} loaded rows — tiles and totals cover the whole window.</div>}
        </>
      ))}
      {tab === "party" && (parties == null ? <GridSkeleton /> : <PartyGrid rows={parties} canMargin={canMargin} onDrill={drillParty} />)}
      {tab === "month" && (months == null ? <GridSkeleton /> : <MonthGrid rows={months} canMargin={canMargin} onDrill={drillMonth} />)}
      {tab === "deposits" && (deposits == null ? <GridSkeleton /> : <DepositsGrid rows={deposits} onOpen={openDrawer} />)}

      <MoneyDrawer
        open={!!openId}
        detail={detail}
        busy={busy}
        setBusy={setBusy}
        canInvoice={canInvoice}
        canMargin={canMargin}
        canPay={canPay}
        onNewInvoice={() => setInvoiceOpen(true)}
        onMarkPaid={(iv) => detail && setMarkPaidFor({ inv: iv, orderNumber: detail.order.number })}
        onPay={() => setPayOpen(true)}
        onChanged={refreshAll}
        onClose={closeDrawer}
      />

      <NewInvoiceModal detail={detail} open={invoiceOpen} onClose={() => setInvoiceOpen(false)}
        onDone={(number) => { setInvoiceOpen(false); toast(`Invoice ${number} created`, "success"); refreshAll(); }} />
      <MarkPaidModal target={markPaidFor} open={!!markPaidFor} onClose={() => setMarkPaidFor(null)}
        onDone={() => { setMarkPaidFor(null); refreshAll(); }} />
      <PaymentModal detail={detail} open={payOpen} onClose={() => setPayOpen(false)}
        onDone={() => { setPayOpen(false); refreshAll(); }} />
      <ImportModal open={importOpen} canPay={canPay} onClose={() => setImportOpen(false)}
        onApplied={() => { setImportOpen(false); refreshAll(); }} />
      <CancelledDrawer bucket={cancelled ?? null} open={cancelledOpen} onClose={() => setCancelledOpen(false)}
        onOpenOrder={(id) => { setCancelledOpen(false); openDrawer(id); }} />

      {/* EPF2 (D-06 close) — export states exactly what it exports before it runs */}
      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title="Export period" size="sm"
        footer={<><Button onClick={() => setExportOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { window.location.assign(exportHref); setExportOpen(false); }}>Download CSV</Button></>}>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", lineHeight: 1.6 }} data-testid="export-confirm">
          Exports <b>the current view</b>: window <b>{windowLabel}</b>{effFrom || effTo ? <> ({effFrom || "start"} → {effTo || "today"}, Rome days)</> : null}
          {partyId ? <>, customer <b>{partyLabel || "selected"}</b></> : ", all customers"}.
          Two sections: per-invoice rows (VAT on invoiced amounts, issue-dated) + the per-order rollup. The run is audited.
        </div>
      </Modal>
    </div>
  );
}

export function FinancialsClient() {
  return (
    <Suspense fallback={null}>
      <FinancialsInner />
    </Suspense>
  );
}
