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
};

export type OrdersResponse = {
  orders: OrderRow[];
  nextCursor?: string | null; // FS1 — lane/grid cursor pagination
  counters: { inProduction: number; awaitingDeposit: number; overdue: number };
  counts: Record<string, number>;
};

export type TimelineEvent = {
  kind: "email" | "quote" | "quote-sent" | "quote-accepted" | "order" | "payment" | "workorder" | "transition" | "shipment" | "review" | "invoice" | "promise" | "stage"; // EPO.3 added the last three
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
    bornFromQuote: { id: string; number: string; state: string; depositPct: number | null } | null;
    conversation: { id: string; subject: string | null } | null;
  };
  timeline: TimelineEvent[];
  money: {
    netCents?: number;
    costCents?: number;
    marginCents?: number;
    marginPct?: number;
    depositRequiredCents?: number;
    depositPaidCents?: number;
    depositMet: boolean;
    depositTermsMissing?: boolean; // EPO1.3 (C8) — no originating quote ⇒ FD13 gate off, said out loud
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
