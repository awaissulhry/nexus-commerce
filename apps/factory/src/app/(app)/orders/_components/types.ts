/** FP4 — shared shapes for the orders board + detail (money fields are optional: the grain strip removes them for callers without financials.*). */
import type { OrderState } from "@/lib/orders/transitions";

export type { OrderState };

export type OrderRow = {
  id: string;
  number: string;
  state: OrderState;
  party: { id: string; name: string; kind: string };
  promiseDateAt: string | null;
  updatedAt: string;
  lineCount: number;
  woCount: number;
  woBlocked: boolean;
  overdue: boolean;
  netCents?: number;
  costCents?: number;
  marginCents?: number;
  marginPct?: number;
  depositRequiredCents?: number;
  depositPaidCents?: number;
  paidCents?: number; // EPO.2 — per-row order-to-cash
  invoicedCents?: number;
  balanceCents?: number;
  originalPromiseDateAt?: string | null; // EPO.4 — promise integrity
  urgent?: boolean;
  promiseSlips?: number;
  atRisk?: boolean;
  attention?: AttentionReason[]; // cockpit mode only
};

export type AttentionReason = "late" | "at-risk" | "deposit-blocked" | "stalled"; // EPO.4 (M2: fulfillment-side only)

export type OrdersResponse = {
  orders: OrderRow[];
  nextCursor?: string | null; // FS1 — lane/grid cursor pagination
  counters: { inProduction: number; awaitingDeposit: number; overdue: number };
  counts: Record<string, number>;
  marginFloorPct?: number | null; // EPO.2 — low-margin flag threshold (margin-grain-stripped)
};

export type TimelineEvent = {
  kind: "email" | "quote" | "quote-sent" | "quote-accepted" | "order" | "payment" | "workorder" | "transition" | "shipment" | "review" | "invoice" | "promise" | "stage" | "amendment" | "return"; // EPO.3 + EPO.5 additions
  at: string;
  label: string;
  amountCents?: number;
  href?: string;
};

export type OrderLineDetail = { id: string; description: string; selections: unknown; sizeRun: unknown; qty: number; netPriceCents?: number; costCents?: number };
export type WorkOrderDetail = { id: string; number: string; state: string; blockedReason: string | null; label: string | null; priority: number; estCostCents?: number; stages: { id: string; stage: string; sort: number }[] };
export type PaymentDetail = { id: string; kind: string; amountCents?: number; method: string | null; receivedAt: string; notes: string | null };
export type InvoiceDetail = { id: string; number: string; amountCents?: number; sentAt: string | null; paidAt: string | null; createdAt: string }; // EPO.3

export type OrderDetailResponse = {
  order: {
    id: string;
    number: string;
    state: OrderState;
    promiseDateAt: string | null;
    originalPromiseDateAt: string | null; // EPO.4
    clientRef: string | null; // EPO.4 (D-9)
    urgent: boolean; // EPO.4 (D-9)
    reapprovalNeededAt: string | null; // EPO.5 — net-changing amendment voided acceptance
    cancelReason: string | null;
    createdAt: string;
    updatedAt: string;
    bornFromQuoteId: string | null;
    conversationId: string | null;
    party: { id: string; name: string; kind: string; depositDefaultPct: number | null; priceList: { name: string } | null };
    lines: OrderLineDetail[];
    payments: PaymentDetail[];
    workOrders: WorkOrderDetail[];
    invoices: InvoiceDetail[]; // EPO.3 — chain chip + timeline source
    shipments: { id: string }[]; // EPO.3 — chain chip count
    revisions: { rev: number; netDeltaCents?: number; reason: string; createdAt: string }[]; // EPO.5
    orderReturns: { id: string; number: string; createdAt: string; lines: { outcome: string; qty: number }[] }[]; // EPO.5
    bornFromQuote: { id: string; number: string; state: string; depositPct: number | null } | null;
    conversation: { id: string; subject: string | null } | null;
  };
  timeline: TimelineEvent[];
  promise: {
    originalPromiseDateAt: string | null;
    slips: number;
    atRisk: boolean;
    late: boolean;
    daysLeft: number | null;
    neededDays: number | null;
  }; // EPO.4
  money: {
    netCents?: number;
    costCents?: number;
    marginCents?: number;
    marginPct?: number;
    depositRequiredCents?: number;
    depositPaidCents?: number;
    depositMet: boolean;
    depositTermsMissing?: boolean; // EPO1.3 (C8) — no originating quote ⇒ FD13 gate off, said out loud
    invoicedCents?: number; // EPO.2 — the FP9 fold's order-to-cash surface
    paidCents?: number;
    balanceCents?: number;
    actualCostCents?: number;
    actualMarginCents?: number;
    actualMarginPct?: number;
    actualIsPending?: boolean;
    partyOutstandingCents?: number; // EPO.2 — credit awareness (other delivered/closed orders)
    partyOutstandingOrders?: number;
  };
};

export const STATE_TONE: Record<OrderState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  CONFIRMED: "info",
  IN_PRODUCTION: "warning",
  READY: "info",
  SHIPPED: "info",
  DELIVERED: "success",
  CLOSED: "neutral",
  CANCELLED: "danger",
};
