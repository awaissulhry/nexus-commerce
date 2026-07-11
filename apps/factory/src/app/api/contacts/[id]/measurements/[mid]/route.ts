/**
 * FP5.2 — delete a measurement profile version. Refused (409) if a quote line
 * references it — measurements a quote was built on are part of that record.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.contactsManage;

export const DELETE = guarded(FEATURES.contactsManage, async (_req, { params, actor }) => {
  const { id, mid } = await params;
  const profile = await prisma.measurementProfile.findFirst({ where: { id: mid, partyId: id }, select: { id: true, _count: { select: { quoteLines: true } } } });
  if (!profile) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (profile._count.quoteLines > 0) return NextResponse.json({ error: "In use by a quote — can't delete" }, { status: 409 });

  // detach any newer version that supersedes this one, then delete
  await prisma.measurementProfile.updateMany({ where: { supersedesId: mid }, data: { supersedesId: null } });
  await prisma.measurementProfile.delete({ where: { id: mid } });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: "measurement-deleted", after: { profileId: mid } });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
