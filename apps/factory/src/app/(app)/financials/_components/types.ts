/** FP9 — financials workspace shapes (all cents optional: grain-stripped for non-financial callers). */
export type OrderFin = {
  orderId: string;
  number: string;
  partyId: string;
  partyName: string;
  state: string;
  monthKey: string;
  quotedNetCents?: number;
  invoicedCents?: number;
  paidCents?: number;
  balanceCents?: number;
  depositRequiredCents?: number;
  depositPaidCents?: number;
  depositMet: boolean;
  estCostCents?: number;
  actualCostCents?: number;
  estMarginCents?: number;
  estMarginPct?: number;
  actualMarginCents?: number;
  actualMarginPct?: number;
  actualIsPending: boolean;
};

export type Tiles = { outstandingCents?: number; depositsDueCents?: number; monthInvoicedCents?: number; monthPaidCents?: number };
export type FinancialsResponse = { monthKey: string; tiles: Tiles; orders: OrderFin[] };
