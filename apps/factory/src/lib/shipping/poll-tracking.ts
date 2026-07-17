/**
 * FP8.3 — poll in-flight shipments and let the carrier drive the order. Read-only
 * against the carrier (safe to run unattended from the worker), forward-only on
 * our side (a stale replay can't undo a delivery). Appends a TrackingEvent only
 * when the status is new, advances the shipment, and flips the order
 * SHIPPED → DELIVERED when the parcel lands (system-actor audit so it shows on
 * the ONE-TIMELINE). Also called directly by the verify harness.
 */
import { prisma } from "../db";
import { publishEventDurable } from "../events";
import { resolveCarrier } from "../carriers/resolve";
import { transitionOrder } from "../orders/transition-service";
import type { OrderState } from "../orders/transitions";
import { notifyOwners } from "../quotes/notify-owners";
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
      // EPO1.2 (C2) — the carrier drives the order only through the ONE
      // transition writer (system actor); a racing/illegal move is a no-op.
      const outcome = await transitionOrder({ orderId: s.orderId, to: orderNext as OrderState, via: "tracking", actorId: null, note: `shipment ${s.id}` });
      if (outcome.ok && orderNext === "DELIVERED") {
        delivered++;
        // EPO.3 — worker-context bell (durable via the outbox inside notify())
        await notifyOwners({ title: `${outcome.number} delivered`, body: "Carrier tracking confirmed delivery.", entityType: "order", entityId: s.orderId, href: `/orders?o=${s.orderId}` });
      }
    }
  }
  return { polled: shipments.length, advanced, delivered };
}
