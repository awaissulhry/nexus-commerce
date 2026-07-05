/**
 * FP8 — the shipping state core: the ONE authority that turns a raw carrier
 * status string into our `ShipmentState`, advances a shipment forward-only
 * (a carrier's "announced" event must never drag a LABEL_PURCHASED parcel back
 * to CREATED), and answers whether that shipment should move the ORDER. Pure —
 * no Prisma, no network — so every mapping is unit-provable. The worker and the
 * buy/void routes call these; they never re-derive the rules inline.
 */

/** Mirrors the Prisma `ShipmentState` enum (kept local so this file stays pure/portable). */
export type ShipmentStateName = "CREATED" | "LABEL_PURCHASED" | "IN_TRANSIT" | "DELIVERED" | "EXCEPTION" | "CANCELLED";

export type OrderStateName = "CONFIRMED" | "IN_PRODUCTION" | "READY" | "SHIPPED" | "DELIVERED" | "CLOSED" | "CANCELLED";

/** Progress rank — higher wins when advancing. CANCELLED is set only by a void (never from tracking). */
const RANK: Record<ShipmentStateName, number> = { CREATED: 0, LABEL_PURCHASED: 1, IN_TRANSIT: 2, EXCEPTION: 3, DELIVERED: 4, CANCELLED: 5 };

/**
 * Map a carrier's status string to our state. Keyword-matched (case-insensitive)
 * so it survives Sendcloud's many phrasings AND a second carrier later. Tracking
 * never yields LABEL_PURCHASED (that's set at purchase) nor CANCELLED (that's a
 * void); an unknown status yields null = "no state change".
 */
export function mapCarrierStatus(raw: string): ShipmentStateName | null {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return null;
  // failure first — "delivery attempt failed" must not read as delivered
  if (/(fail|refus|exception|lost|not\s*deliver|undeliver|return to sender|returned)/.test(s)) return "EXCEPTION";
  // "out for delivery" contains "deliver" but is still in transit — catch it before the delivered check
  if (/(out for deliver|ready for deliver|delivering|en route for deliver)/.test(s)) return "IN_TRANSIT";
  if (/deliver/.test(s)) return "DELIVERED";
  if (/(transit|en route|route to|sorted|sorting|out for|picked up|collect|hub|depot|at .*cent|dispatch)/.test(s)) return "IN_TRANSIT";
  if (/(announc|ready to send|pre[-_ ]?transit|awaiting|label created|data received|no data|created)/.test(s)) return "CREATED";
  return null;
}

/**
 * Advance a shipment forward-only. A mapped state only sticks if it ranks higher
 * than where we are — except CANCELLED, which is terminal (a void). Returns the
 * resulting state (unchanged if the update is stale/backward/unknown).
 */
export function advanceShipmentState(current: ShipmentStateName, mapped: ShipmentStateName | null): ShipmentStateName {
  if (mapped === null) return current;
  if (current === "CANCELLED") return "CANCELLED"; // terminal
  if (mapped === "CANCELLED") return "CANCELLED";
  return RANK[mapped] > RANK[current] ? mapped : current;
}

/** Fold a batch of carrier statuses (chronological) onto a starting state, forward-only. */
export function deriveShipmentState(current: ShipmentStateName, rawStatuses: string[]): ShipmentStateName {
  return rawStatuses.reduce<ShipmentStateName>((st, raw) => advanceShipmentState(st, mapCarrierStatus(raw)), current);
}

/**
 * Does this shipment state move the ORDER? Buying a label ⇒ SHIPPED (the FP4
 * stopgap made real); a delivered parcel ⇒ DELIVERED. Forward-only and
 * conservative: returns the order's new state, or null for "leave it alone"
 * (so an EXCEPTION surfaces on the shipment without disturbing the order, and a
 * tracking replay never downgrades a CLOSED order).
 */
export function orderStateFromShipment(orderState: OrderStateName, shipmentState: ShipmentStateName): OrderStateName | null {
  if (shipmentState === "DELIVERED" && orderState === "SHIPPED") return "DELIVERED";
  if ((shipmentState === "LABEL_PURCHASED" || shipmentState === "IN_TRANSIT") && orderState === "READY") return "SHIPPED";
  return null;
}

/** Cheapest rate, stable on ties (first wins). Null on empty. */
export function cheapestRate<T extends { costCents: number }>(rates: T[]): T | null {
  if (!rates.length) return null;
  return rates.reduce((best, r) => (r.costCents < best.costCents ? r : best), rates[0]);
}

/** Is a shipment still cancellable (before it's really moving)? Void guard. */
export function isVoidable(state: ShipmentStateName): boolean {
  return state === "CREATED" || state === "LABEL_PURCHASED";
}

export const IN_FLIGHT_STATES: ShipmentStateName[] = ["LABEL_PURCHASED", "IN_TRANSIT"];
