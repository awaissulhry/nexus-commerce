/**
 * FP8.2 — stream a shipment's stored label PDF (behind guarded(); never a public
 * URL). The buy route wrote the bytes locally beside the DB; this hands them back
 * for printing. Path-traversal is guarded in the label store.
 */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { readLabel } from "@/lib/shipping/label-store";

export const permission = PAGES.shipping;

export const GET = guarded(PAGES.shipping, async (_req, { params }) => {
  const { id } = await params;
  const ship = await prisma.shipment.findUnique({ where: { id }, select: { labelRef: true, trackingNumber: true } });
  if (!ship?.labelRef) return NextResponse.json({ error: "No label for this shipment" }, { status: 404 });
  const file = readLabel(ship.labelRef);
  if (!file) return NextResponse.json({ error: "Label file missing" }, { status: 404 });
  return new NextResponse(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `inline; filename="label-${ship.trackingNumber ?? id}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
});
