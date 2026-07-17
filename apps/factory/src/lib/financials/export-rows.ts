/**
 * EPF1.5 (D-01/D-12) — the accountant-export row builders, pure. Two sections:
 * per-INVOICE rows (VAT displayed on INVOICED amounts — the only basis that
 * can reconcile with the Fatture) and the per-ORDER rollup (operational money,
 * every column labeled with its date basis; VAT deliberately NOT repeated here
 * on quoted amounts — that was the D-01 defect). Financial columns carry an
 * EXPLICIT grain (prices vs margins) and are dropped wholesale for callers
 * without it — the strip-by-column-grain map D-12 demanded.
 */
import { vatDisplay, type OrderFinancials } from "./rollup";
import { romeDayKey, romeMonthKey } from "./rome-time";

export type ExportGrains = { prices: boolean; margins: boolean };

export type ExportColumn<T> = {
  label: string;
  /** null = identity column, always visible; otherwise the grain that must be held. */
  grain: keyof ExportGrains | null;
  value: (row: T) => string;
};

export function visibleColumns<T>(cols: ExportColumn<T>[], grains: ExportGrains): ExportColumn<T>[] {
  return cols.filter((c) => c.grain === null || grains[c.grain]);
}

export function buildRows<T>(cols: ExportColumn<T>[], rows: T[], grains: ExportGrains): { headers: string[]; rows: string[][] } {
  const vis = visibleColumns(cols, grains);
  return { headers: vis.map((c) => c.label), rows: rows.map((r) => vis.map((c) => c.value(r))) };
}

const e = (c: number) => (c / 100).toFixed(2);

export type InvoiceExportRow = {
  number: string;
  issuedAtISO: string;
  orderNumber: string;
  partyName: string;
  amountCents: number;
  sentAt: string | null;
  paidAt: string | null;
};

/** Section 1 — per-invoice, VAT on the INVOICED amount, dated by issue date (Rome). */
export function invoiceColumns(vatRatePct: number): ExportColumn<InvoiceExportRow>[] {
  return [
    { label: "invoice", grain: null, value: (r) => r.number },
    { label: "issued (Rome date)", grain: null, value: (r) => romeDayKey(r.issuedAtISO) },
    { label: "month (issue date · Rome)", grain: null, value: (r) => romeMonthKey(r.issuedAtISO) },
    { label: "order", grain: null, value: (r) => r.orderNumber },
    { label: "customer", grain: null, value: (r) => r.partyName },
    { label: "status", grain: null, value: (r) => (r.paidAt ? "paid" : r.sentAt ? "sent" : "draft") },
    { label: "net (invoiced)", grain: "prices", value: (r) => e(r.amountCents) },
    { label: "vat_rate", grain: "prices", value: () => `${vatRatePct}%` },
    { label: "vat (on invoiced)", grain: "prices", value: (r) => e(vatDisplay(r.amountCents, vatRatePct).vatCents) },
    { label: "gross (invoiced)", grain: "prices", value: (r) => e(vatDisplay(r.amountCents, vatRatePct).grossCents) },
  ];
}

/** Section 2 — per-order rollup, every money column labeled with its date basis. */
export function orderColumns(): ExportColumn<OrderFinancials>[] {
  return [
    { label: "order", grain: null, value: (r) => r.number },
    { label: "customer", grain: null, value: (r) => r.partyName },
    { label: "month (order created · Rome)", grain: null, value: (r) => r.monthKey },
    { label: "state", grain: null, value: (r) => r.state },
    { label: "quoted_net (order total)", grain: "prices", value: (r) => e(r.quotedNetCents) },
    { label: "invoiced (all invoices for the order)", grain: "prices", value: (r) => e(r.invoicedCents) },
    { label: "paid (all payments for the order)", grain: "prices", value: (r) => e(r.paidCents) },
    { label: "balance (net − paid)", grain: "prices", value: (r) => e(r.balanceCents) },
    { label: "est_margin", grain: "margins", value: (r) => e(r.estMarginCents) },
    { label: "actual_margin", grain: "margins", value: (r) => e(r.actualMarginCents) },
    { label: "margin_basis", grain: "margins", value: (r) => (r.actualIsPending ? "estimate (production not finished)" : "actual (all WOs done)") },
  ];
}
