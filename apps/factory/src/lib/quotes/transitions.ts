/**
 * EPQ.1 — the Quote lifecycle state machine: the SINGLE authority on which
 * state edge is legal (mirrors src/lib/orders/transitions.ts). Forward-only
 * with named backward "revise" edges — the platform rule. The client renders
 * actions from `legalTargets`, but the server is the boundary: every mutation
 * re-checks `canTransition`.
 *
 * DRAFT → SENT is deliberately NOT a generic edge: it is reached only through
 * Send (which renders the PDF, emails the customer, and freezes a
 * QuoteVersion), so the generic PATCH route refuses it and points the caller
 * at that action. ACCEPTED is terminal here — an accepted quote only moves
 * forward through Convert (which creates the Order, not a state edge).
 * EXPIRED is written by the worker sweep (SENT past validity) and by nothing
 * else; Revise (→ DRAFT) is the only way back out.
 */
export type QuoteState = "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";

export const QUOTE_STATE_LABEL: Record<QuoteState, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

const ADJACENCY: Record<QuoteState, QuoteState[]> = {
  DRAFT: ["SENT"], // through Send only (see SEND_EDGE)
  SENT: ["DRAFT", "ACCEPTED", "REJECTED", "EXPIRED"], // →DRAFT = revise
  ACCEPTED: [], // terminal: convert-to-order only, never a state edge
  REJECTED: ["DRAFT"], // revise after a decline
  EXPIRED: ["DRAFT"], // revise a lapsed offer
};

/** The edge that must go through Send (it emails the customer and freezes a version). */
export const SEND_EDGE = { from: "DRAFT" as QuoteState, to: "SENT" as QuoteState };

/** Legal next states from `from` (drives client actions — advisory only). */
export function legalTargets(from: QuoteState): QuoteState[] {
  return ADJACENCY[from] ?? [];
}

export type TransitionCheck = { ok: boolean; reason?: string; useSend?: boolean };

/**
 * The authority. Pure: legality of the state edge alone. Side-effect gates
 * (field guards, lostReason rules) are enforced by the route on top.
 */
export function canTransition(from: QuoteState, to: QuoteState): TransitionCheck {
  if (from === to) return { ok: false, reason: `Already ${QUOTE_STATE_LABEL[to]?.toLowerCase() ?? to}` };
  if (from === SEND_EDGE.from && to === SEND_EDGE.to) {
    return { ok: false, useSend: true, reason: "Use Send — it emails the customer and freezes a version" };
  }
  if (from === "ACCEPTED") {
    return { ok: false, reason: "An accepted quote only moves forward — convert it to an order" };
  }
  if (!ADJACENCY[from]?.includes(to)) {
    return { ok: false, reason: `Can't move from ${QUOTE_STATE_LABEL[from] ?? from} to ${QUOTE_STATE_LABEL[to] ?? to}` };
  }
  return { ok: true };
}

/** Fields frozen outside DRAFT (lines are already frozen by the line routes). */
export const DRAFT_ONLY_FIELDS = ["depositPct", "validUntilAt", "promiseDateAt"] as const;

/** lostReason is only meaningful on a lost outcome. */
export function lostReasonAllowed(state: QuoteState): boolean {
  return state === "REJECTED" || state === "EXPIRED";
}

/**
 * The sweep/410 boundary, pinned: a quote lapses strictly AFTER validUntilAt
 * (validUntilAt === now is still valid; no validity means it never lapses).
 * Matches the DB `lt: now` sweep filter and the public 410 checks.
 */
export function isQuoteLapsed(validUntilAt: Date | null, now: Date): boolean {
  return validUntilAt !== null && validUntilAt.getTime() < now.getTime();
}

/**
 * Supersede selection: a token minted for `tokenVersion` is superseded once
 * any newer version has been sent. The latest token (and legacy pre-EPQ.1
 * tokens, which live on the Quote row itself) keep working as today.
 */
export function isSupersededToken(tokenVersion: number, latestVersion: number): boolean {
  return tokenVersion < latestVersion;
}
