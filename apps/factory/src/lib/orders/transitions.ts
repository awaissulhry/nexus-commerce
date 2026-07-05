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
 * Two edges are honest v1 STOPGAPS until the floor (FP6) and shipments (FP8)
 * drive them for real: IN_PRODUCTION→READY (real = all WOs DONE) and
 * READY→SHIPPED (real = a shipment exists). Flagged so the UI can say so.
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

/** Manual stopgaps until FP6 (floor) / FP8 (shipments) drive them automatically. */
const STOPGAP = new Set(["IN_PRODUCTION>READY", "READY>SHIPPED", "SHIPPED>DELIVERED"]);
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
