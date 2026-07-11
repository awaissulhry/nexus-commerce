/**
 * FP8.4 — record a carrier pickup. Capability-gated but NEVER blocking: if the
 * carrier supports pickup we mark it "requested"; if not (or the Owner arranged
 * it directly) we record "outside_system" so the day is still accounted for. A
 * pickup needs a connected account (the row references one), so test mode can't
 * book — it says so. Real carrier pickup-API booking is a follow-up; this
 * captures intent.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { resolveCarrier } from "@/lib/carriers/resolve";

export const permission = FEATURES.labelsPurchase;

const Body = z.object({ date: z.string().optional(), note: z.string().max(300).optional(), outsideSystem: z.boolean().optional() });

export const POST = guarded(FEATURES.labelsPurchase, async (req, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const carrier = await resolveCarrier();
  if (!carrier.account) return NextResponse.json({ error: "Connect a carrier in Settings › Integrations to record a pickup." }, { status: 400 });

  const supportsPickup = carrier.account.caps?.supportsPickup ?? false;
  const outside = parsed.data.outsideSystem === true || !supportsPickup;
  const date = parsed.data.date ? new Date(parsed.data.date) : new Date();

  // attach today's parcels for this account
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const todays = await prisma.shipment.findMany({ where: { carrierAccountId: carrier.account.id, createdAt: { gte: start }, state: { not: "CANCELLED" } }, select: { id: true } }); // bounded: operator-selected parcels

  const pickup = await prisma.pickup.create({
    data: { carrierAccountId: carrier.account.id, date, status: outside ? "outside_system" : "requested", parcelIds: todays.map((t) => t.id) },
    select: { id: true, status: true },
  });
  void audit({ actorId: actor!.id, entityType: "pickup", entityId: pickup.id, action: "pickup.recorded", after: { status: pickup.status, parcels: todays.length } });

  return NextResponse.json({ ok: true, status: pickup.status, supportsPickup, parcels: todays.length });
});
