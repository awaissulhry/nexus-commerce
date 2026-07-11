/**
 * FP8.4 — the day-sheet manifest PDF: every parcel shipped today, for the driver
 * handover. Operational (no money). "Today" is the server's local day (local-first).
 */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { renderManifestPdf } from "@/lib/shipping/render-manifest";

export const permission = PAGES.shipping;

export const GET = guarded(PAGES.shipping, async () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const shipments = await prisma.shipment.findMany({ // bounded: day-sheet: today's shipments
    where: { createdAt: { gte: start }, state: { not: "CANCELLED" } },
    orderBy: { createdAt: "asc" },
    select: { service: true, trackingNumber: true, order: { select: { number: true, party: { select: { name: true } } } } },
  });
  const rows = shipments.map((s) => ({ orderNumber: s.order.number, partyName: s.order.party.name, service: s.service, trackingNumber: s.trackingNumber }));

  const nameRow = await prisma.appSetting.findUnique({ where: { key: "factory.name" } });
  const factoryName = (nameRow?.value as { name?: string })?.name ?? "Nexus Factory";
  const dateLabel = start.toLocaleDateString();
  const pdf = await renderManifestPdf(rows, factoryName, dateLabel);

  return new NextResponse(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="day-sheet-${start.toISOString().slice(0, 10)}.pdf"`, "Cache-Control": "private, no-store" },
  });
});
