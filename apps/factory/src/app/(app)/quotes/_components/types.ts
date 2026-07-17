/** FP3 — shared client types for the Quotes workspace. */

import type { FollowUpRule } from "@/lib/quotes/followup";

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
  // EPQ.2 — view tracking for the compact "viewed" cell
  viewCount: number;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
};

/** EPQ.2 — one row of the Needs-follow-up queue. */
export type FollowUpRow = {
  id: string;
  number: string;
  party: { id: string; name: string; kind: string };
  rule: FollowUpRule;
  days: number;
  flaggedAt: string | null;
  sentAt: string | null;
  lastViewedAt: string | null;
  validUntilAt: string | null;
  netCents: number;
};

export type PipelineResponse = {
  quotes: QuoteRow[];
  counters: { drafts: number; awaiting: number; expiringSoon: number };
  counts: Record<string, number>;
  followups: FollowUpRow[];
  followupConfig: { unviewedDays: number; viewedDays: number; preExpiryDays: number };
};

export type QuoteLine = {
  id: string;
  templateId: string | null;
  template: { id: string; name: string } | null;
  description: string | null;
  /** raw stored shape — read through readSelections() (EPQ.3: array OR {options,sizeRun}) */
  selections: unknown;
  qty: number;
  listPriceCents: number;
  adjustmentCents: number;
  adjustmentReason: string | null;
  adjustmentReasonCode: string | null; // EPQ.3 — discount reason code
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
  // EPQ.2 — customer-views card + follow-up state
  viewCount: number;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  lastNudgeAt: string | null;
  followUpRule: string | null;
  // EPQ.5 — compliance snapshot (DRAFT-editable in the Tax & legal card)
  taxMode: string | null;
  naturaCode: string | null;
  depositKind: string;
  validityWording: string;
  party: {
    id: string; name: string; kind: string; paymentTerms?: string | null; priceListId: string | null; priceList: { name: string } | null;
    // EPQ.5 — tax posture + VIES proof for the rail
    taxMode: string | null; vatNumber: string | null; viesRequestId: string | null; viesCheckedAt: string | null;
  };
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

/** EPQ.3 — a similar-quote row (wasProduced ⇒ the "repeat" chip). */
export type SimilarQuote = {
  id: string;
  number: string;
  partyName: string;
  state: string;
  netCents: number;
  marginPct: number;
  wasProduced: boolean;
};

/** EPQ.3 — goal-seek response (per-unit adjustment + projected quote totals). */
export type GoalSeekResponse = {
  adjustmentCents: number;
  projected?: { netCents: number; costCents?: number; marginCents?: number; marginPct?: number };
};

export const STATE_TONE: Record<QuoteState, "neutral" | "info" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral",
  SENT: "info",
  ACCEPTED: "success",
  REJECTED: "danger",
  EXPIRED: "warning",
};
