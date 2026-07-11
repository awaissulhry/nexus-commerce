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
export type FinancialsResponse = { monthKey: string; tiles: Tiles; orders: OrderFin[]; ordersTotal?: number }; // FS1 — orders is a bounded page; tiles fold everything

export type InvoiceRow = { id: string; number: string; amountCents?: number; sentAt: string | null; paidAt: string | null };
export type PaymentRow = { id: string; kind: string; amountCents?: number; method: string | null; receivedAt: string; notes: string | null };
export type FinancialDetail = { order: { id: string; number: string; partyName: string }; rollup: OrderFin; invoices: InvoiceRow[]; payments: PaymentRow[] };

export type DepositRow = { orderId: string; number: string; partyName: string; depositRequiredCents?: number; depositPaidCents?: number; shortfallCents?: number; blockedWorkOrders: number };
export type DepositsResponse = { deposits: DepositRow[] };

export type BankProposal = { row: { date: string; amountCents?: number; description: string }; orderId: string | null; number: string | null; partyName: string | null; amountCents?: number; confidence: "high" | "medium" | "none"; reason: string };
export type ImportResponse = { proposals: BankProposal[]; note?: string };

export type PartyAgg = { partyId: string; partyName: string; orders: number; netCents?: number; paidCents?: number; outstandingCents?: number; actualMarginCents?: number };
export type PeriodAgg = { monthKey: string; orders: number; netCents?: number; invoicedCents?: number; paidCents?: number; outstandingCents?: number; actualMarginCents?: number };
export type PartyResponse = { parties: PartyAgg[] };
export type PeriodResponse = { months: PeriodAgg[] };
