/**
 * FP9.1 — the money page: headline tiles (outstanding / deposits due / this
 * month) over a per-order rollup — quoted → invoiced → paid → balance, and the
 * margin sliding from estimate to actual as the floor consumes material. Every
 * order number drills to /orders. This whole page is behind pages.financials,
 * so a worker never reaches it.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Euro } from "lucide-react";
import { Card, DataGrid, useToast } from "@/design-system/components";
import { Pill } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { apiJson } from "@/lib/api-client";
import { usePermission } from "@/lib/auth/client";
import { type FinancialsResponse, type OrderFin } from "./types";

const money = (c?: number) => (c == null ? "—" : eur(c));
const openOrder = (id: string) => { if (typeof window !== "undefined") window.location.href = `/orders?o=${id}`; };

export function FinancialsClient() {
  const { toast } = useToast();
  const canMargin = usePermission("financials.margins.view");
  const [data, setData] = useState<FinancialsResponse | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiJson<FinancialsResponse>("/api/financials")); }
    catch (e) { toast((e as Error).message, "danger"); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const t = data?.tiles;
  return (
    <div className="factory-page factory-grid-grow-1">
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Euro size={18} /> Financials</h1>
        <div style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginTop: 2 }}>Order-level money truth — who owes what, and what each order really made. Not accounting.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Tile label="Outstanding balance" value={money(t?.outstandingCents)} tone="warning" />
        <Tile label="Deposits due" value={money(t?.depositsDueCents)} tone="danger" />
        <Tile label="Invoiced this month" value={money(t?.monthInvoicedCents)} />
        <Tile label="Paid this month" value={money(t?.monthPaidCents)} tone="success" />
      </div>

      <DataGrid
        columns={[
          { key: "number", label: "Order", render: (r: OrderFin) => <button type="button" onClick={() => openOrder(r.orderId)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" }}>{r.number}</button> },
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
    </div>
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
