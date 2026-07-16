/**
 * FP4 — the Order lifecycle state machine: the SINGLE authority on which state
 * edge is legal. Forward-only with named backward edges (cancel/reopen), the
 * platform rule. The client renders menus/lanes from `legalTargets`, but the
 * server is the boundary — every mutation re-checks `canTransition`.
 *
 * CONFIRMED → IN_PRODUCTION is deliberately NOT a generic edge: it is reached
 * only through Start production (which CREATES the work orders), so the generic
 * PATCH route refuses it and points the caller at that action.
 *
 * The once-stopgap edges now all have real drivers: IN_PRODUCTION→READY (FP6,
 * every WO DONE), READY→SHIPPED (FP8, a label is bought), SHIPPED→DELIVERED
 * (FP8, tracking says delivered). They stay legal as manual overrides (shipped
 * outside the system), but none is a placeholder anymore.
 */
export type OrderState =
  | "CONFIRMED"
  | "IN_PRODUCTION"
  | "READY"
  | "SHIPPED"
  | "DELIVERED"
  | "CLOSED"
  | "CANCELLED";

export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  CONFIRMED: "Confirmed",
  IN_PRODUCTION: "In production",
  READY: "Ready",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

/** The live board lanes, in flow order (Cancelled/Closed are filters, not lanes). */
export const BOARD_LANES: OrderState[] = ["CONFIRMED", "IN_PRODUCTION", "READY", "SHIPPED", "DELIVERED"];

const ADJACENCY: Record<OrderState, OrderState[]> = {
  CONFIRMED: ["IN_PRODUCTION", "CANCELLED"],
  IN_PRODUCTION: ["READY", "CANCELLED"],
  READY: ["SHIPPED", "IN_PRODUCTION", "CANCELLED"], // →IN_PRODUCTION = rework (WOs already exist)
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: ["CONFIRMED"], // reopen
};

/** The edge that must go through Start production (it creates the work orders). */
export const START_PRODUCTION_EDGE = { from: "CONFIRMED" as OrderState, to: "IN_PRODUCTION" as OrderState };

/** Edges that require a reason to be recorded. */
export function requiresReason(to: OrderState): boolean {
  return to === "CANCELLED";
}

/** Empty now that FP6 + FP8 drive every lifecycle edge for real (kept for the audit-trail shape). */
const STOPGAP = new Set<string>();
export function isStopgap(from: OrderState, to: OrderState): boolean {
  return STOPGAP.has(`${from}>${to}`);
}

/** Legal next states from `from` (drives the client menu/lanes — advisory only). */
export function legalTargets(from: OrderState): OrderState[] {
  return ADJACENCY[from] ?? [];
}

export type TransitionCheck = { ok: boolean; reason?: string; useStartProduction?: boolean };

/**
 * The authority. Pure: legality of the state edge alone. Side-effect gates
 * (deposit, reason) are enforced by the route on top of an `ok` result.
 */
export function canTransition(from: OrderState, to: OrderState): TransitionCheck {
  if (from === to) return { ok: false, reason: `Already ${ORDER_STATE_LABEL[to]?.toLowerCase() ?? to}` };
  if (from === START_PRODUCTION_EDGE.from && to === START_PRODUCTION_EDGE.to) {
    return { ok: false, useStartProduction: true, reason: "Use Start production — it creates the work order" };
  }
  if (!ADJACENCY[from]?.includes(to)) {
    return { ok: false, reason: `Can't move from ${ORDER_STATE_LABEL[from] ?? from} to ${ORDER_STATE_LABEL[to] ?? to}` };
  }
  return { ok: true };
}

/**
 * EPO1.1 — who is driving a transition. Every state write names its driver;
 * the audit row and the `order.updated` event carry it, so the timeline can
 * always answer "how did this happen".
 */
export type TransitionVia =
  | "manual" // an operator in the Change-status menu / grid pill
  | "reopen" // CANCELLED → CONFIRMED
  | "cancel" // the Cancel action (reason required)
  | "start-production" // the Start-production action (creates the WOs)
  | "all-wos-done" // FP6: last work order finished ⇒ READY
  | "label-purchased" // FP8: buy-and-print ⇒ SHIPPED
  | "tracking" // FP8: carrier poll ⇒ DELIVERED
  | "label-voided" // FP8: label voided pre-dispatch ⇒ back to READY
  | "promise-changed" // not a state edge — used on the order.updated event for promise edits
  | "line-edited"; // not a state edge — used on the order.updated event for line edits

/**
 * EPO1.1 — system-only edges: in the graph, but legal ONLY when driven by the
 * named action. Never offered in menus (`legalTargets` doesn't return them).
 * SHIPPED→READY existed only inside the void driver before — now the authority
 * knows it.
 */
const SYSTEM_EDGES: Record<string, TransitionVia> = {
  "SHIPPED>READY": "label-voided",
};

/**
 * EPO1.1 — the full authority: edge legality INCLUDING the action-owned edges.
 * `via` names the driver; `start-production` legalizes CONFIRMED→IN_PRODUCTION
 * (it creates the work orders), `label-voided` legalizes SHIPPED→READY.
 * Everything else defers to `canTransition`.
 */
export function canTransitionVia(from: OrderState, to: OrderState, via: TransitionVia): TransitionCheck {
  if (via === "start-production" && from === START_PRODUCTION_EDGE.from && to === START_PRODUCTION_EDGE.to) {
    return { ok: true };
  }
  const system = SYSTEM_EDGES[`${from}>${to}`];
  if (system) {
    return system === via
      ? { ok: true }
      : { ok: false, reason: `${ORDER_STATE_LABEL[from]} → ${ORDER_STATE_LABEL[to]} only happens when a label is voided` };
  }
  return canTransition(from, to);
}
