/**
 * FP8.2 — the shipping queues. Ready-to-ship = orders the floor finished (state
 * READY, no label yet — buying one flips them to SHIPPED). In-flight = live
 * shipments with a tracking status. The carrier chip reports whether a real
 * account is connected (else the FakeCarrier stands in). Money grain-stripped.
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { resolveCarrier } from "@/lib/carriers/resolve";
import { resolvePresets } from "@/lib/shipping/parcel";

export const permission = PAGES.shipping;

export const GET = guarded(PAGES.shipping, async (_req, { resolved }) => {
  // FS1 — both queues bounded (S-12/payload diet): the day-sheet works newest-
  // first; totals surface so nothing hides. 5.8 MB → bounded at scale (FS0).
  const QUEUE_CAP = 500;
  const inflightWhere = { state: { in: ["LABEL_PURCHASED", "IN_TRANSIT", "EXCEPTION"] as never[] } };
  const [readyRows, inflightRows, readyTotal, inflightTotal, carrier, presetRow] = await Promise.all([
    prisma.order.findMany({
      where: { state: "READY" },
      select: { id: true, number: true, promiseDateAt: true, party: { select: { id: true, name: true, addressJson: true } }, _count: { select: { lines: true } } },
      orderBy: [{ promiseDateAt: "asc" }, { createdAt: "asc" }],
      take: QUEUE_CAP,
    }),
    prisma.shipment.findMany({
      where: inflightWhere,
      select: { id: true, state: true, service: true, trackingNumber: true, trackingUrl: true, costCents: true, createdAt: true, updatedAt: true, order: { select: { id: true, number: true, party: { select: { name: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: QUEUE_CAP,
    }),
    prisma.order.count({ where: { state: "READY" } }),
    prisma.shipment.count({ where: inflightWhere }),
    resolveCarrier(),
    prisma.appSetting.findUnique({ where: { key: "shipping.parcelPresets" } }),
  ]);
  const presets = resolvePresets(presetRow?.value ?? null);

  const ready = readyRows.map((o) => ({
    id: o.id,
    number: o.number,
    partyId: o.party.id,
    partyName: o.party.name,
    promiseDateAt: o.promiseDateAt,
    lineCount: o._count.lines,
    address: o.party.addressJson ?? null,
  }));
  const inflight = inflightRows.map((s) => ({
    id: s.id,
    orderId: s.order.id,
    orderNumber: s.order.number,
    partyName: s.order.party.name,
    service: s.service,
    trackingNumber: s.trackingNumber,
    trackingUrl: s.trackingUrl,
    state: s.state,
    costCents: s.costCents,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));

  return jsonStripped({ ready, inflight, readyTotal, inflightTotal, presets, carrier: { connected: carrier.live, label: carrier.account?.label ?? null, name: carrier.adapter.name } }, resolved);
});
