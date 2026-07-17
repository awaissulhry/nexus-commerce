/**
 * EPF2 — the four money grids, all on FS3 VirtualDataGrid (the registry
 * handoff: by-order, by-customer, by-month, deposits — windowed DOM, sortable
 * headers where honest). By-order deliberately has NO client sort: it is a
 * cursor page and sorting only the loaded rows would lie (EPO.7 precedent).
 * Customer and month rows drill into the filtered by-order view (D-07 close);
 * the deposits "blocked" pill deep-links the /production?wo= reader (EPO.3).
 */
"use client";

import { Pill, Skeleton } from "@/design-system/primitives";
import { eur } from "@/design-system/lib/format";
import { VirtualDataGrid } from "@/components/VirtualDataGrid";
import type { DepositRow, OrderFin, PartyAgg, PeriodAgg } from "./types";

export const money = (c?: number) => (c == null ? "—" : eur(c));
const drillBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", fontWeight: 700, color: "var(--h10-text-link)" };
const GRID_H = "calc(100dvh - 396px)";

/** EPF2 (D-08 close) — skeleton rows on first load; the false empty-state flash is dead. */
export function GridSkeleton() {
  return (
    <div style={{ display: "grid", gap: 8, padding: "4px 0" }} data-testid="grid-skeleton">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} height={34} />
      ))}
    </div>
  );
}

export function MarginCell({ r }: { r: OrderFin }) {
  const cents = r.actualIsPending ? r.estMarginCents : r.actualMarginCents;
  const pctv = r.actualIsPending ? r.estMarginPct : r.actualMarginPct;
  if (cents == null) return <>—</>;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>
        {eur(cents)} <span style={{ color: "var(--h10-text-3)" }}>{pctv != null ? `${pctv.toFixed(0)}%` : ""}</span>
      </span>
      <Pill tone={r.actualIsPending ? "neutral" : "info"}>{r.actualIsPending ? "est" : "actual"}</Pill>
    </span>
  );
}

export function OrdersGrid({ rows, canMargin, onOpen }: { rows: OrderFin[]; canMargin: boolean; onOpen: (id: string) => void }) {
  return (
    <VirtualDataGrid
      height={GRID_H}
      columns={[
        { key: "number", label: "Order", render: (r: OrderFin) => <button type="button" onClick={() => onOpen(r.orderId)} style={drillBtn}>{r.number}</button> },
        { key: "party", label: "Customer", render: (r: OrderFin) => r.partyName },
        { key: "state", label: "State", render: (r: OrderFin) => <span style={{ fontSize: 12, color: "var(--h10-text-3)" }}>{r.state.replace(/_/g, " ").toLowerCase()}</span> },
        { key: "quoted", label: "Quoted", align: "right" as const, render: (r: OrderFin) => money(r.quotedNetCents) },
        { key: "invoiced", label: "Invoiced", align: "right" as const, render: (r: OrderFin) => money(r.invoicedCents) },
        { key: "paid", label: "Paid", align: "right" as const, render: (r: OrderFin) => money(r.paidCents) },
        {
          key: "balance", label: "Balance", align: "right" as const,
          render: (r: OrderFin) =>
            r.balanceCents === 0 ? <Pill tone="success">paid</Pill> : (
              <span style={{ color: (r.balanceCents ?? 0) > 0 ? "var(--h10-warning-text, var(--h10-text))" : "var(--h10-text)", fontWeight: 600 }}>{money(r.balanceCents)}</span>
            ),
        },
        ...(canMargin ? [{ key: "margin", label: "Margin", align: "right" as const, render: (r: OrderFin) => <MarginCell r={r} /> }] : []),
      ]}
      rows={rows}
      rowKey={(r: OrderFin) => r.orderId}
      emptyState="No orders in this window — widen the dates, or money lands here as quotes convert."
    />
  );
}

export function PartyGrid({ rows, canMargin, onDrill }: { rows: PartyAgg[]; canMargin: boolean; onDrill: (partyId: string) => void }) {
  return (
    <VirtualDataGrid
      height={GRID_H}
      columns={[
        { key: "party", label: "Customer", sortable: true, sortValue: (r: PartyAgg) => r.partyName.toLowerCase(), render: (r: PartyAgg) => <button type="button" onClick={() => onDrill(r.partyId)} title="See this customer's orders" style={drillBtn}>{r.partyName}</button> },
        { key: "orders", label: "Orders", align: "right" as const, sortable: true, sortValue: (r: PartyAgg) => r.orders, render: (r: PartyAgg) => r.orders },
        { key: "net", label: "Revenue", align: "right" as const, sortable: true, sortValue: (r: PartyAgg) => r.netCents ?? 0, render: (r: PartyAgg) => money(r.netCents) },
        { key: "paid", label: "Paid", align: "right" as const, sortable: true, sortValue: (r: PartyAgg) => r.paidCents ?? 0, render: (r: PartyAgg) => money(r.paidCents) },
        { key: "out", label: "Outstanding", align: "right" as const, sortable: true, sortValue: (r: PartyAgg) => r.outstandingCents ?? 0, render: (r: PartyAgg) => money(r.outstandingCents) },
        ...(canMargin ? [{ key: "margin", label: "Margin (actual)", align: "right" as const, sortable: true, sortValue: (r: PartyAgg) => r.actualMarginCents ?? 0, render: (r: PartyAgg) => money(r.actualMarginCents) }] : []),
      ]}
      rows={rows}
      rowKey={(r: PartyAgg) => r.partyId}
      emptyState="No customers with orders in this window."
    />
  );
}

export function MonthGrid({ rows, canMargin, onDrill }: { rows: PeriodAgg[]; canMargin: boolean; onDrill: (monthKey: string) => void }) {
  return (
    <VirtualDataGrid
      height={GRID_H}
      columns={[
        { key: "month", label: "Month", sortable: true, sortValue: (r: PeriodAgg) => r.monthKey, render: (r: PeriodAgg) => <button type="button" onClick={() => onDrill(r.monthKey)} title="See this month's orders" style={drillBtn}>{r.monthKey}</button> },
        { key: "orders", label: "Orders", align: "right" as const, sortable: true, sortValue: (r: PeriodAgg) => r.orders, render: (r: PeriodAgg) => r.orders },
        { key: "net", label: "Revenue", align: "right" as const, sortable: true, sortValue: (r: PeriodAgg) => r.netCents ?? 0, render: (r: PeriodAgg) => money(r.netCents) },
        { key: "invoiced", label: "Invoiced", align: "right" as const, sortable: true, sortValue: (r: PeriodAgg) => r.invoicedCents ?? 0, render: (r: PeriodAgg) => money(r.invoicedCents) },
        { key: "paid", label: "Paid", align: "right" as const, sortable: true, sortValue: (r: PeriodAgg) => r.paidCents ?? 0, render: (r: PeriodAgg) => money(r.paidCents) },
        { key: "out", label: "Outstanding", align: "right" as const, sortable: true, sortValue: (r: PeriodAgg) => r.outstandingCents ?? 0, render: (r: PeriodAgg) => money(r.outstandingCents) },
        ...(canMargin ? [{ key: "margin", label: "Margin (actual)", align: "right" as const, sortable: true, sortValue: (r: PeriodAgg) => r.actualMarginCents ?? 0, render: (r: PeriodAgg) => money(r.actualMarginCents) }] : []),
      ]}
      rows={rows}
      rowKey={(r: PeriodAgg) => r.monthKey}
      emptyState="No months with money in this window."
    />
  );
}

export function DepositsGrid({ rows, onOpen }: { rows: DepositRow[]; onOpen: (id: string) => void }) {
  return (
    <VirtualDataGrid
      height={GRID_H}
      columns={[
        { key: "number", label: "Order", render: (r: DepositRow) => <button type="button" onClick={() => onOpen(r.orderId)} style={drillBtn}>{r.number}</button> },
        { key: "party", label: "Customer", render: (r: DepositRow) => r.partyName },
        { key: "req", label: "Deposit required", align: "right" as const, sortable: true, sortValue: (r: DepositRow) => r.depositRequiredCents ?? 0, render: (r: DepositRow) => money(r.depositRequiredCents) },
        { key: "paid", label: "Paid", align: "right" as const, sortable: true, sortValue: (r: DepositRow) => r.depositPaidCents ?? 0, render: (r: DepositRow) => money(r.depositPaidCents) },
        { key: "short", label: "Shortfall", align: "right" as const, sortable: true, sortValue: (r: DepositRow) => r.shortfallCents ?? 0, render: (r: DepositRow) => <span style={{ color: "var(--h10-danger)", fontWeight: 600 }}>{money(r.shortfallCents)}</span> },
        {
          key: "blocked", label: "Blocked WOs", align: "right" as const,
          render: (r: DepositRow) =>
            r.blockedWorkOrders > 0 ? (
              // EPF2 (P2: the pill had no link to the floor) — deep-link the EPO.3 ?wo= reader
              <a href={r.firstBlockedWoId ? `/production?wo=${r.firstBlockedWoId}` : "/production"} style={{ textDecoration: "none" }} title="See the blocked work on the production board">
                <Pill tone="warning">{r.blockedWorkOrders} blocked</Pill>
              </a>
            ) : ("—"),
        },
      ]}
      rows={rows}
      rowKey={(r: DepositRow) => r.orderId}
      emptyState="No deposits outstanding — nothing on the floor is waiting on money."
    />
  );
}
