/**
 * FP8.2 — buy-and-print. Creates the shipment, asks the carrier for the label
 * (re-fetching rates so the authoritative COST comes from the carrier, never the
 * client), stores the label PDF locally, remembers the ship-to on the party, and
 * flips the order READY → SHIPPED (the FP4 stopgap made real) with a timeline
 * entry. The external label call sits outside any DB transaction; if it throws,
 * the half-made shipment row is cleaned up.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { resolveCarrier } from "@/lib/carriers/resolve";
import { AddressZ, ParcelZ } from "@/lib/shipping/validation";
import { saveLabel } from "@/lib/shipping/label-store";
import { canTransition } from "@/lib/orders/transitions";

export const permission = FEATURES.labelsPurchase;

const Body = z.object({ orderId: z.string().min(1), to: AddressZ, parcel: ParcelZ, rateCode: z.string().min(1), count: z.number().int().min(1).max(20).optional() });

export const POST = guarded(FEATURES.labelsPurchase, async (req, { actor, resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const { orderId, to, parcel, rateCode } = parsed.data;
  const count = parsed.data.count ?? 1; // bulk-buy: one parcel/shipment per box (size-runs)

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, state: true, party: { select: { id: true, currency: true } } } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.state !== "READY") return NextResponse.json({ error: "Only a Ready order can be shipped" }, { status: 400 });
  if (!canTransition("READY", "SHIPPED").ok) return NextResponse.json({ error: "Order can't move to shipped" }, { status: 400 });

  const carrier = await resolveCarrier();

  // validate the rate once (cost is authoritative from the carrier, not the client)
  const preview = { shipmentId: "rate-preview", orderNumber: order.number, to, parcel, currency: order.party.currency ?? "EUR" };
  let rate;
  try {
    rate = (await carrier.adapter.getRates(preview)).find((r) => r.code === rateCode);
  } catch (err) {
    return NextResponse.json({ error: `Could not fetch rates: ${(err as Error).message}` }, { status: 502 });
  }
  if (!rate) return NextResponse.json({ error: "That rate is no longer available — refresh rates" }, { status: 409 });

  // buy `count` labels — each its own Shipment (true multicollo is out; N boxes = N shipments)
  const bought: { shipmentId: string; trackingNumber: string; labelUrl: string }[] = [];
  for (let i = 0; i < count; i++) {
    const ship = await prisma.shipment.create({
      data: { orderId: order.id, carrierAccountId: carrier.account?.id ?? null, state: "CREATED", shipToJson: to as Prisma.InputJsonValue, parcelJson: parcel as Prisma.InputJsonValue },
      select: { id: true },
    });
    let label;
    try {
      label = await carrier.adapter.createShipment({ ...preview, shipmentId: ship.id }, rate);
    } catch (err) {
      await prisma.shipment.delete({ where: { id: ship.id } }).catch(() => {});
      if (bought.length === 0) return NextResponse.json({ error: `Label purchase failed: ${(err as Error).message}` }, { status: 502 });
      break; // some labels succeeded — keep them, stop here
    }
    const labelRef = saveLabel(ship.id, label.labelBase64, label.labelFormat);
    await prisma.shipment.update({
      where: { id: ship.id },
      data: { state: "LABEL_PURCHASED", trackingNumber: label.trackingNumber, trackingUrl: label.trackingUrl, service: `${label.carrier} · ${label.service}`, costCents: label.costCents, labelRef, labelFormat: label.labelFormat },
    });
    void audit({ actorId: actor!.id, entityType: "shipment", entityId: ship.id, action: "label.purchased", after: { orderId: order.id, carrier: label.carrier, service: label.service, trackingNumber: label.trackingNumber, live: carrier.live } });
    await publishEventDurable("shipment.updated", { shipmentId: ship.id, orderId: order.id, state: "LABEL_PURCHASED" });
    bought.push({ shipmentId: ship.id, trackingNumber: label.trackingNumber, labelUrl: `/api/shipping/${ship.id}/label` });
  }

  await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { state: "SHIPPED" } }),
    prisma.party.update({ where: { id: order.party.id }, data: { addressJson: to as Prisma.InputJsonValue } }),
  ]);
  void audit({ actorId: actor!.id, entityType: "order", entityId: order.id, action: "state-changed", before: { from: "READY" }, after: { to: "SHIPPED", shipments: bought.length } });
  await publishEventDurable("order.updated", { orderId: order.id, from: "READY", to: "SHIPPED" });

  const first = bought[0];
  return jsonStripped({ ok: true, count: bought.length, shipmentId: first.shipmentId, trackingNumber: first.trackingNumber, labelUrl: first.labelUrl, labels: bought, live: carrier.live }, resolved);
});
