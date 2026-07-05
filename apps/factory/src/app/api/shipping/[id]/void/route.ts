/**
 * FP8.3 — void a label before dispatch: cancel it at the carrier (best-effort),
 * mark the shipment CANCELLED, and return its order to READY so it can be
 * re-shipped. Void is an action-owned transition (like Start production owns
 * CONFIRMED→IN_PRODUCTION), so it sets READY directly with a compensating audit.
 */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { resolveCarrier } from "@/lib/carriers/resolve";
import { isVoidable } from "@/lib/shipping/shipment-state";

export const permission = FEATURES.labelsVoid;

export const POST = guarded(FEATURES.labelsVoid, async (_req, { params, actor }) => {
  const { id } = await params;
  const s = await prisma.shipment.findUnique({ where: { id }, select: { id: true, state: true, trackingNumber: true, orderId: true, order: { select: { state: true } } } });
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isVoidable(s.state)) return NextResponse.json({ error: `A ${s.state.toLowerCase()} shipment can't be voided` }, { status: 400 });

  const carrier = await resolveCarrier();
  if (s.trackingNumber) await carrier.adapter.cancelShipment(s.trackingNumber).catch(() => {});

  const restoreOrder = s.order.state === "SHIPPED";
  await prisma.$transaction([
    prisma.shipment.update({ where: { id }, data: { state: "CANCELLED" } }),
    ...(restoreOrder ? [prisma.order.update({ where: { id: s.orderId }, data: { state: "READY" } })] : []),
  ]);

  void audit({ actorId: actor!.id, entityType: "shipment", entityId: id, action: "label.voided", after: { orderId: s.orderId } });
  await publishEventDurable("shipment.updated", { shipmentId: id, orderId: s.orderId, state: "CANCELLED" });
  if (restoreOrder) {
    void audit({ actorId: actor!.id, entityType: "order", entityId: s.orderId, action: "state-changed", before: { from: "SHIPPED" }, after: { to: "READY", reason: "label voided" } });
    await publishEventDurable("order.updated", { orderId: s.orderId, from: "SHIPPED", to: "READY" });
  }

  return NextResponse.json({ ok: true, orderRestored: restoreOrder });
});
