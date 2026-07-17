/**
 * FP9.1 — the money page: headline tiles (outstanding / deposits due / this
 * month) over a per-order rollup — quoted → invoiced → paid → balance, and the
 * margin sliding from estimate to actual as the floor consumes material. Every
 * order number drills to /orders. This whole page is behind pages.financials,
 * so a worker never reaches it.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Euro, FilePlus, Send, ArrowUpRight, Printer, Upload, CreditCard, Download } from "lucide-react";
import { Card, DataGrid, Drawer, Modal, Listbox, useToast } from "@/design-system/components";
import { Button, Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { type BankProposal, type DepositRow, type DepositsResponse, type FinancialDetail, type FinancialsResponse, type ImportApplyResponse, type ImportResponse, type InvoiceRow, type OrderFin, type PartyAgg, type PartyResponse, type PaymentRow, type PeriodAgg, type PeriodResponse } from "./types";

const inp: React.CSSProperties = { width: "100%", border: "1px solid var(--h10-border)", borderRadius: 7, padding: "6px 8px", fontSize: 12.5, background: "var(--h10-surface)", color: "var(--h10-text)" };
const CONF_TONE: Record<string, "success" | "info" | "neutral"> = { high: "success", medium: "info", none: "neutral" };

const money = (c?: number) => (c == null ? "—" : eur(c));

export function FinancialsClient() {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const canInvoice = usePermission("invoices.manage");
  const canPay = usePermission("payments.record");
  const canImport = usePermission("imports.run");
  const [data, setData] = useState<FinancialsResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FinancialDetail | null>(null);
  const [tab, setTab] = useState<"orders" | "deposits" | "party" | "month">("orders");
  const [deposits, setDeposits] = useState<DepositRow[] | null>(null);
  const [parties, setParties] = useState<PartyAgg[] | null>(null);
  const [months, setMonths] = useState<PeriodAgg[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [payFor, setPayFor] = useState<{ id: string; number: string } | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiJson<FinancialsResponse>("/api/financials")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const loadDeposits = useCallback(async () => {
    try { setDeposits((await apiJson<DepositsResponse>("/api/financials/deposits")).deposits); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  const loadParties = useCallback(async () => {
    try { setParties((await apiJson<PartyResponse>("/api/financials/party")).parties); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  const loadMonths = useCallback(async () => {
    try { setMonths((await apiJson<PeriodResponse>("/api/financials/period")).months); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => {
    if (tab === "deposits" && deposits == null) void loadDeposits();
    if (tab === "party" && parties == null) void loadParties();
    if (tab === "month" && months == null) void loadMonths();
  }, [tab, deposits, parties, months, loadDeposits, loadParties, loadMonths]);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await apiJson<FinancialDetail>(`/api/financials/order/${id}`)); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  const openDetail = (id: string) => { setDetailId(id); setDetail(null); void loadDetail(id); };
  const refreshAll = () => { void load(); setDeposits(null); setParties(null); setMonths(null); if (detailId) void loadDetail(detailId); };

  const t = data?.tiles;
  return (
    <div className="factory-page factory-grid-grow-1">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Euro size={18} /> Financials</h1>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>Order-level money truth — who owes what, and what each order really made. Not accounting.</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {canImport && <Button onClick={() => setImportOpen(true)}><Upload size={13} /> Import bank CSV</Button>}
          <a href="/api/exports/financials" className="h10-ds-btn" style={{ textDecoration: "none", display: "inline-flex", gap: 6, alignItems: "center" }}><Download size={13} /> Export period</a>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 18 }}>
        <Tile label="Outstanding balance" value={money(t?.outstandingCents)} tone="warning" />
        <Tile label="Deposits due" value={money(t?.depositsDueCents)} tone="danger" />
        <Tile label="Invoiced this month" value={money(t?.monthInvoicedCents)} />
        <Tile label="Paid this month" value={money(t?.monthPaidCents)} tone="success" />
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid var(--h10-border-subtle)" }}>
        <TabBtn active={tab === "orders"} onClick={() => setTab("orders")}>By order</TabBtn>
        <TabBtn active={tab === "party"} onClick={() => setTab("party")}>By customer</TabBtn>
        <TabBtn active={tab === "month"} onClick={() => setTab("month")}>By month</TabBtn>
        <TabBtn active={tab === "deposits"} onClick={() => setTab("deposits")}>Deposits outstanding{deposits && deposits.length > 0 ? ` (${deposits.length})` : ""}</TabBtn>
      </div>

      {tab === "party" ? (
        <DataGrid
          columns={[
            { key: "party", label: "Customer", render: (r: PartyAgg) => <b>{r.partyName}</b> },
            { key: "orders", label: "Orders", align: "right" as const, render: (r: PartyAgg) => r.orders },
            { key: "net", label: "Revenue", align: "right" as const, render: (r: PartyAgg) => money(r.netCents) },
            { key: "paid", label: "Paid", align: "right" as const, render: (r: PartyAgg) => money(r.paidCents) },
            { key: "out", label: "Outstanding", align: "right" as const, render: (r: PartyAgg) => money(r.outstandingCents) },
            ...(canMargin ? [{ key: "margin", label: "Margin (actual)", align: "right" as const, render: (r: PartyAgg) => money(r.actualMarginCents) }] : []),
          ]}
          rows={parties ?? []}
          rowKey={(r: PartyAgg) => r.partyId}
          emptyState="No customers with orders yet."
        />
      ) : tab === "month" ? (
        <DataGrid
          columns={[
            { key: "month", label: "Month", render: (r: PeriodAgg) => <b>{r.monthKey}</b> },
            { key: "orders", label: "Orders", align: "right" as const, render: (r: PeriodAgg) => r.orders },
            { key: "net", label: "Revenue", align: "right" as const, render: (r: PeriodAgg) => money(r.netCents) },
            { key: "invoiced", label: "Invoiced", align: "right" as const, render: (r: PeriodAgg) => money(r.invoicedCents) },
            { key: "paid", label: "Paid", align: "right" as const, render: (r: PeriodAgg) => money(r.paidCents) },
            { key: "out", label: "Outstanding", align: "right" as const, render: (r: PeriodAgg) => money(r.outstandingCents) },
            ...(canMargin ? [{ key: "margin", label: "Margin (actual)", align: "right" as const, render: (r: PeriodAgg) => money(r.actualMarginCents) }] : []),
          ]}
          rows={months ?? []}
          rowKey={(r: PeriodAgg) => r.monthKey}
          emptyState="No months with orders yet."
        />
      ) : tab === "orders" ? (
        <DataGrid
          columns={[
            { key: "number", label: "Order", render: (r: OrderFin) => <button type="button" onClick={() => openDetail(r.orderId)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
            { key: "party", label: "Customer", render: (r: OrderFin) => r.partyName },
            { key: "state", label: "State", render: (r: OrderFin) => <span style={{ fontSize: 12, color: "var(--h10-text-3)" }}>{r.state.replace("_", " ").toLowerCase()}</span> },
            { key: "quoted", label: "Quoted", align: "right" as const, render: (r: OrderFin) => money(r.quotedNetCents) },
            { key: "invoiced", label: "Invoiced", align: "right" as const, render: (r: OrderFin) => money(r.invoicedCents) },
            { key: "paid", label: "Paid", align: "right" as const, render: (r: OrderFin) => money(r.paidCents) },
            { key: "balance", label: "Balance", align: "right" as const, render: (r: OrderFin) => (r.balanceCents === 0 ? <Pill tone="success">paid</Pill> : <span style={{ color: (r.balanceCents ?? 0) > 0 ? "var(--h10-warning-text, var(--h10-text))" : "var(--h10-text)", fontWeight: 600 }}>{money(r.balanceCents)}</span>) },
            ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: OrderFin) => <MarginCell r={r} /> }] : []),
          ]}
          rows={data?.orders ?? []}
          rowKey={(r: OrderFin) => r.orderId}
          emptyState="No orders yet — money lands here as quotes convert."
        />
      ) : null}
      {tab === "orders" && data && (data.ordersTotal ?? 0) > data.orders.length && (
        <div style={{ fontSize: 12, color: "var(--h10-text-2)", padding: "8px 2px" }}>
          Showing the {data.orders.length} most recent of {data.ordersTotal} orders — tiles and rollups cover all of them. Narrow the date range to drill in.
        </div>
      )}
      {tab === "deposits" && (
        <DataGrid
          columns={[
            { key: "number", label: "Order", render: (r: DepositRow) => <button type="button" onClick={() => openDetail(r.orderId)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
            { key: "party", label: "Customer", render: (r: DepositRow) => r.partyName },
            { key: "req", label: "Deposit required", align: "right" as const, render: (r: DepositRow) => money(r.depositRequiredCents) },
            { key: "paid", label: "Paid", align: "right" as const, render: (r: DepositRow) => money(r.depositPaidCents) },
            { key: "short", label: "Shortfall", align: "right" as const, render: (r: DepositRow) => <span style={{ color: "var(--h10-danger)", fontWeight: 600 }}>{money(r.shortfallCents)}</span> },
            { key: "blocked", label: "Blocked WOs", align: "right" as const, render: (r: DepositRow) => (r.blockedWorkOrders > 0 ? <Pill tone="warning">{r.blockedWorkOrders} blocked</Pill> : "—") },
          ]}
          rows={deposits ?? []}
          rowKey={(r: DepositRow) => r.orderId}
          emptyState="No deposits outstanding — nothing on the floor is waiting on money."
        />
      )}

      <MoneyDrawer id={detailId} detail={detail} canInvoice={canInvoice} canMargin={canMargin} canPay={canPay} onPay={(o) => setPayFor(o)} onClose={() => setDetailId(null)} onChanged={refreshAll} />
      <PaymentModal target={payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); refreshAll(); }} />
      <ImportModal open={importOpen} canPay={canPay} onClose={() => setImportOpen(false)} onApplied={() => { setImportOpen(false); refreshAll(); }} />
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} style={{ background: "none", border: "none", borderBottom: `2px solid ${active ? "var(--h10-primary)" : "transparent"}`, padding: "7px 12px", cursor: "pointer", fontSize: 13, fontWeight: active ? 700 : 500, color: active ? "var(--h10-text)" : "var(--h10-text-3)", marginBottom: -1 }}>{children}</button>;
}

function MoneyDrawer({ id, detail, canInvoice, canMargin, canPay, onPay, onClose, onChanged }: { id: string | null; detail: FinancialDetail | null; canInvoice: boolean; canMargin: boolean; canPay: boolean; onPay: (o: { id: string; number: string }) => void; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const createInvoice = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await apiJson<{ invoice: { number: string } }>("/api/invoices", { method: "POST", body: JSON.stringify({ orderId: detail.order.id }) });
      toast(`Invoice ${r.invoice.number} created`, "success");
      onChanged();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const invAction = async (invId: string, action: "send" | "paid") => {
    setBusy(true);
    try {
      await apiJson(`/api/invoices/${invId}`, { method: "PATCH", body: JSON.stringify({ action }) });
      toast(action === "paid" ? "Marked paid — a balance payment was recorded" : "Marked sent", "success");
      onChanged();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  const d = detail;
  const roll = d?.rollup;
  return (
    <Drawer open={!!id} onClose={onClose} title={d ? `Money · ${d.order.number}` : "Money"} footer={d ? (
      <div style={{ display: "flex", gap: 8, width: "100%", alignItems: "center" }}>
        {canInvoice && <Button variant="primary" onClick={createInvoice} disabled={busy}><FilePlus size={13} /> New invoice</Button>}
        {canPay && <Button onClick={() => onPay({ id: d.order.id, number: d.order.number })}><CreditCard size={13} /> Record payment</Button>}
        <a href={`/orders?o=${d.order.id}`} className="h10-ds-btn" style={{ marginLeft: "auto", textDecoration: "none", display: "inline-flex", gap: 6, alignItems: "center" }}>Open order <ArrowUpRight size={13} /></a>
      </div>
    ) : undefined}>
      {d && roll && (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Fig label="Quoted" value={money(roll.quotedNetCents)} />
            <Fig label="Invoiced" value={money(roll.invoicedCents)} />
            <Fig label="Paid" value={money(roll.paidCents)} />
            <Fig label="Balance" value={money(roll.balanceCents)} strong={roll.balanceCents !== 0} />
            {canMargin && <Fig label={roll.actualIsPending ? "Margin (est)" : "Margin (actual)"} value={money(roll.actualIsPending ? roll.estMarginCents : roll.actualMarginCents)} />}
          </div>

          <div>
            <div style={sub}>Invoices</div>
            {d.invoices.length === 0 ? <Empty>No invoices yet.</Empty> : d.invoices.map((iv: InvoiceRow) => (
              <div key={iv.id} style={row}>
                <a href={`/api/invoices/${iv.id}`} target="_blank" rel="noreferrer" style={{ color: "var(--h10-text-link)", fontWeight: 600, display: "inline-flex", gap: 4, alignItems: "center" }}><Printer size={12} /> {iv.number}</a>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(iv.amountCents)}</span>
                  {iv.paidAt ? <Pill tone="success">paid</Pill> : iv.sentAt ? <Pill tone="info">sent</Pill> : <Pill tone="neutral">draft</Pill>}
                  {canInvoice && !iv.paidAt && (
                    <>
                      {!iv.sentAt && <button type="button" disabled={busy} onClick={() => invAction(iv.id, "send")} style={miniBtn}><Send size={11} /> Send</button>}
                      <button type="button" disabled={busy} onClick={() => invAction(iv.id, "paid")} style={miniBtn}>Mark paid</button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          <div>
            <div style={sub}>Payments</div>
            {d.payments.length === 0 ? <Empty>No payments yet.</Empty> : d.payments.map((p: PaymentRow) => (
              <div key={p.id} style={row}>
                <span style={{ fontSize: 12.5 }}>{p.kind.toLowerCase()}{p.method ? <span style={{ color: "var(--h10-text-3)" }}> · {p.method}</span> : null}</span>
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(p.amountCents)}</span>
                  <span style={{ fontSize: 11, color: "var(--h10-text-3)" }}>{new Date(p.receivedAt).toLocaleDateString()}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

const sub: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 6 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--h10-border-subtle)", fontSize: 12.5 };
const miniBtn: React.CSSProperties = { border: "1px solid var(--h10-border)", borderRadius: 6, background: "var(--h10-surface)", cursor: "pointer", fontSize: 11, padding: "3px 7px", color: "var(--h10-text-2)", display: "inline-flex", gap: 4, alignItems: "center" };
function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 8, padding: "8px 10px" }}><div style={{ fontSize: 10.5, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div><div style={{ fontSize: 15, fontWeight: strong ? 700 : 600, fontVariantNumeric: "tabular-nums" }}>{value}</div></div>;
}
function Empty({ children }: { children: React.ReactNode }) { return <div style={{ fontSize: 12, color: "var(--h10-text-3)", padding: "4px 0" }}>{children}</div>; }
const lbl2: React.CSSProperties = { fontSize: 11.5, color: "var(--h10-text-3)", marginBottom: 3 };

function PaymentModal({ target, onClose, onDone }: { target: { id: string; number: string } | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState("DEPOSIT");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (target) { setKind("DEPOSIT"); setAmount(""); setMethod(""); } }, [target]);

  const submit = async () => {
    if (!target) return;
    const cents = Math.round(parseFloat(amount.replace(",", ".")) * 100);
    if (!(cents > 0)) { toast("Enter an amount", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<{ unblocked: number }>(`/api/orders/${target.id}/payments`, { method: "POST", body: JSON.stringify({ kind, amountCents: cents, method: method || undefined }) });
      toast(r.unblocked > 0 ? `Payment recorded — ${r.unblocked} work order(s) unblocked` : "Payment recorded", "success");
      onDone();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `Record payment — ${target.number}` : "Record payment"} size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>Record</Button></>}>
      <div style={{ display: "grid", gap: 10 }}>
        <div><div style={lbl2}>Kind</div><Listbox ariaLabel="Payment kind" options={[{ value: "DEPOSIT", label: "Deposit" }, { value: "BALANCE", label: "Balance" }, { value: "OTHER", label: "Other" }]} value={kind} onChange={setKind} /></div>
        <div><div style={lbl2}>Amount (€)</div><input style={inp} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
        <div><div style={lbl2}>Method (optional)</div><input style={inp} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="bank transfer, card…" /></div>
      </div>
    </Modal>
  );
}

function ImportModal({ open, canPay, onClose, onApplied }: { open: boolean; canPay: boolean; onClose: () => void; onApplied: () => void }) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [proposals, setProposals] = useState<BankProposal[] | null>(null);
  const [pick, setPick] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setCsv(""); setProposals(null); setPick({}); } }, [open]);

  const dryRun = async () => {
    setBusy(true);
    try {
      const r = await apiJson<ImportResponse>("/api/imports/payments", { method: "POST", body: JSON.stringify({ rawCsv: csv }) });
      setProposals(r.proposals);
      const p: Record<number, boolean> = {};
      // EPF1 (D-10): settled-order references (zeroBalance) start UNCHECKED
      r.proposals.forEach((x, i) => { if (x.orderId && !x.zeroBalance) p[i] = true; });
      setPick(p);
      if (r.proposals.length === 0) toast(r.note ?? "No rows parsed", "danger");
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!proposals) return;
    // EPF1 (D-10): the statement row's date + description travel with the apply —
    // they form the idempotency key and the payment's receivedAt.
    const applyList = proposals.flatMap((p, i) => (pick[i] && p.orderId && p.amountCents ? [{ orderId: p.orderId, amountCents: p.amountCents, date: p.row.date, description: p.row.description, note: `Bank: ${p.row.description}`.slice(0, 200) }] : []));
    if (applyList.length === 0) { toast("Select at least one matched row", "danger"); return; }
    setBusy(true);
    try {
      const r = await apiJson<ImportApplyResponse>("/api/imports/payments", { method: "POST", body: JSON.stringify({ apply: applyList }) });
      const extras = [r.skipped > 0 ? `${r.skipped} duplicate(s) skipped` : null, r.errors.length > 0 ? `${r.errors.length} row(s) errored` : null].filter(Boolean).join(", ");
      toast(`${r.created} payment(s) recorded${extras ? ` — ${extras}` : ""}`, r.errors.length > 0 ? "danger" : "success");
      onApplied();
    } catch (e) { toast((e as Error).message, "danger"); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import bank CSV" size="md" footer={proposals ? (
      <><Button onClick={() => setProposals(null)}>Back</Button>{canPay && <Button variant="primary" onClick={apply} disabled={busy}>Apply selected</Button>}</>
    ) : (
      <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={dryRun} disabled={busy || !csv.trim()}>Match</Button></>
    )}>
      {!proposals ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>Paste a statement with a header naming <b>date</b>, <b>amount</b>, <b>description</b> columns. We propose matches by reference or amount; nothing is recorded until you apply.</div>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} placeholder={"date,amount,description\n2026-07-01,500.00,Bonifico ORD-1"} style={{ ...inp, fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {proposals.length === 0 && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>No rows parsed.</div>}
          {proposals.map((p, i) => (
            <label key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 8px", border: "1px solid var(--h10-border-subtle)", borderRadius: 8, fontSize: 12.5, opacity: p.orderId ? 1 : 0.6 }}>
              <input type="checkbox" disabled={!p.orderId} checked={!!pick[i]} onChange={(e) => setPick((s) => ({ ...s, [i]: e.target.checked }))} style={{ accentColor: "var(--h10-primary)" }} />
              <span style={{ flex: 1 }}>{p.row.description || "(no description)"} <span style={{ color: "var(--h10-text-3)" }}>· {eur(p.row.amountCents ?? 0)}</span></span>
              {p.number ? <span style={{ color: "var(--h10-text-link)", fontWeight: 600 }}>{p.number}</span> : <span style={{ color: "var(--h10-text-3)" }}>{p.reason}</span>}
              <Pill tone={CONF_TONE[p.confidence]}>{p.confidence === "none" ? "no match" : p.confidence}</Pill>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "warning" | "danger" | "success" }) {
  const color = tone === "warning" ? "var(--h10-text)" : tone === "danger" ? "var(--h10-danger)" : tone === "success" ? "var(--h10-success-text, var(--h10-text))" : "var(--h10-text)";
  return (
    <Card>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 11.5, color: "var(--h10-text-3)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      </div>
    </Card>
  );
}

function MarginCell({ r }: { r: OrderFin }) {
  const cents = r.actualIsPending ? r.estMarginCents : r.actualMarginCents;
  const pctv = r.actualIsPending ? r.estMarginPct : r.actualMarginPct;
  if (cents == null) return <>—</>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{eur(cents)} <span style={{ color: "var(--h10-text-3)" }}>{pctv != null ? `${pctv.toFixed(0)}%` : ""}</span></span>
      <Pill tone={r.actualIsPending ? "neutral" : "info"}>{r.actualIsPending ? "est" : "actual"}</Pill>
    </span>
  );
}
