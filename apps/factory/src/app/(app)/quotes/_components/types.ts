/** FP3 — shared client types for the Quotes workspace. */

export type QuoteState = "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";

export type QuoteRow = {
  id: string;
  number: string;
  state: QuoteState;
  party: { id: string; name: string; kind: string };
  depositPct: number | null;
  validUntilAt: string | null;
  promiseDateAt: string | null;
  convertedOrderId: string | null;
  updatedAt: string;
  netCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number;
  lineCount: number;
};

export type PipelineResponse = {
  quotes: QuoteRow[];
  counters: { drafts: number; awaiting: number; overdue: number };
  counts: Record<string, number>;
};

export type QuoteLine = {
  id: string;
  templateId: string | null;
  template: { id: string; name: string } | null;
  description: string | null;
  selections: string[] | null;
  qty: number;
  listPriceCents: number;
  adjustmentCents: number;
  adjustmentReason: string | null;
  netPriceCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number;
};

export type QuoteVersion = { id: string; version: number; pdfRef: string | null; sentAt: string };

export type QuoteDetail = {
  id: string;
  number: string;
  state: QuoteState;
  depositPct: number | null;
  promiseDateAt: string | null;
  validUntilAt: string | null;
  sentAt: string | null;
  convertedOrderId: string | null;
  lostReason: string | null;
  acceptTokenHash: string | null;
  party: { id: string; name: string; kind: string; paymentTerms?: string | null; priceListId: string | null; priceList: { name: string } | null };
  conversation: { id: string; subject: string | null } | null;
  lines: QuoteLine[];
  versions: QuoteVersion[];
};

export type ComposeResult = {
  listPriceCents?: number;
  costCents?: number;
  netPriceCents?: number;
  marginCents?: number;
  marginPct?: number;
  marginNegative?: boolean;
  lines?: { kind: string; label: string; optionId?: string; priceCents?: number; source: string }[];
  materials?: { materialId: string; qty: number; unit: string; name?: string }[];
  violations?: { kind: string; severity: string; message: string }[];
  hasBlockingViolation?: boolean;
};

export const STATE_TONE: Record<QuoteState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral",
  SENT: "info",
  ACCEPTED: "success",
  REJECTED: "danger",
  EXPIRED: "warning",
};
