/**
 * FP8.3 — one shipment: the tracking timeline + whether it can be shared into a
 * thread or voided. The label path stays server-side (only a labelUrl leaves);
 * cost is grain-stripped.
 */
import { NextResponse } from "next/server";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { isVoidable } from "@/lib/shipping/shipment-state";

export const permission = PAGES.shipping;

export const GET = guarded(PAGES.shipping, async (_req, { params, resolved }) => {
  const { id } = await params;
  const s = await prisma.shipment.findUnique({
    where: { id },
    select: {
      id: true, state: true, service: true, trackingNumber: true, trackingUrl: true, costCents: true, labelRef: true, labelFormat: true, shipToJson: true, createdAt: true, updatedAt: true,
      events: { orderBy: { occurredAt: "asc" }, select: { id: true, status: true, message: true, occurredAt: true } },
      order: { select: { id: true, number: true, conversationId: true, party: { select: { name: true } } } },
    },
  });
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { labelRef, order, ...rest } = s;
  const shipment = {
    ...rest,
    orderId: order.id,
    orderNumber: order.number,
    partyName: order.party.name,
    hasThread: !!order.conversationId,
    hasLabel: !!labelRef,
    labelUrl: labelRef ? `/api/shipping/${id}/label` : null,
    voidable: isVoidable(s.state),
  };
  return jsonStripped({ shipment }, resolved);
});
