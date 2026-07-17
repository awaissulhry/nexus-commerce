/**
 * EPQ.3 — discount reason codes: every adjustment can carry WHY as a coded
 * value (the free-text reason stays for the story). Enum lives in code —
 * SQLite enforces enums at Prisma-runtime only, so the zod schema at the
 * route boundary is the real guard. Feeds win/loss analytics (by-code tally
 * is an EPA handoff — the analytics page is unclaimed).
 */

export const ADJUSTMENT_REASON_CODES = ["LOYALTY", "COMPETITIVE", "VOLUME", "REWORK", "GOODWILL", "OTHER"] as const;

export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];

export function isReasonCode(v: unknown): v is AdjustmentReasonCode {
  return typeof v === "string" && (ADJUSTMENT_REASON_CODES as readonly string[]).includes(v);
}

/** Listbox copy — codes render sentence-case in the UI. */
export const REASON_CODE_LABEL: Record<AdjustmentReasonCode, string> = {
  LOYALTY: "Loyalty",
  COMPETITIVE: "Competitive",
  VOLUME: "Volume",
  REWORK: "Rework",
  GOODWILL: "Goodwill",
  OTHER: "Other",
};
