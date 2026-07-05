/**
 * FP8.3 — poll in-flight shipments and let the carrier drive the order. Read-only
 * against the carrier (safe to run unattended from the worker), forward-only on
 * our side (a stale replay can't undo a delivery). Appends a TrackingEvent only
 * when the status is new, advances the shipment, and flips the order
 * SHIPPED → DELIVERED when the parcel lands (system-actor audit so it shows on
 * the ONE-TIMELINE). Also called directly by the verify harness.
 */
import { prisma } from "../db";
import { audit } from "../audit";
import { publishEventDurable } from "../events";
import { resolveCarrier } from "../carriers/resolve";
import { mapCarrierStatus, advanceShipmentState, orderStateFromShipment, IN_FLIGHT_STATES, type OrderStateName } from "./shipment-state";

export type PollSummary = { polled: number; advanced: number; delivered: number };

export async function pollInflightShipments(): Promise<PollSummary> {
  const shipments = await prisma.shipment.findMany({
    where: { state: { in: IN_FLIGHT_STATES }, trackingNumber: { not: null } },
    select: {
      id: true, trackingNumber: true, state: true, orderId: true,
      events: { orderBy: { occurredAt: "desc" }, take: 1, select: { status: true } },
      order: { select: { state: true } },
    },
  });
  if (shipments.length === 0) return { polled: 0, advanced: 0, delivered: 0 };

  const carrier = await resolveCarrier();
  const byTn = new Map(shipments.map((s) => [s.trackingNumber as string, s]));
  const updates = await carrier.adapter.pollTracking(shipments.map((s) => s.trackingNumber as string));

  let advanced = 0;
  let delivered = 0;
  for (const u of updates) {
    const s = byTn.get(u.trackingNumber);
    if (!s) continue;

    // append a tracking event only when the status is genuinely new
    if (s.events[0]?.status !== u.status) {
      await prisma.trackingEvent.create({
        data: { shipmentId: s.id, status: u.status, message: u.message ?? null, occurredAt: new Date(u.occurredAt), raw: (u.raw as object | undefined) ?? undefined },
      });
    }

    const newState = advanceShipmentState(s.state, mapCarrierStatus(u.status));
    if (newState === s.state) continue;

    await prisma.shipment.update({ where: { id: s.id }, data: { state: newState } });
    advanced++;
    await publishEventDurable("shipment.updated", { shipmentId: s.id, orderId: s.orderId, state: newState });

    const orderNext = orderStateFromShipment(s.order.state as OrderStateName, newState);
    if (orderNext && orderNext !== s.order.state) {
      await prisma.order.update({ where: { id: s.orderId }, data: { state: orderNext } });
      void audit({ actorId: null, entityType: "order", entityId: s.orderId, action: "state-changed", before: { from: s.order.state }, after: { to: orderNext, via: "tracking", shipmentId: s.id } });
      await publishEventDurable("order.updated", { orderId: s.orderId, from: s.order.state, to: orderNext });
      if (orderNext === "DELIVERED") delivered++;
    }
  }
  return { polled: shipments.length, advanced, delivered };
}
