/** FP5 — edit (label / matchDomain) or remove a contact's email. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = { PATCH: FEATURES.contactsManage, DELETE: FEATURES.contactsManage };

const Body = z.object({ label: z.string().trim().max(80).nullable().optional(), matchDomain: z.boolean().optional() });

export const PATCH = guarded(FEATURES.contactsManage, async (req, { params, actor }) => {
  const { id, eid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const email = await prisma.partyEmail.findFirst({ where: { id: eid, partyId: id }, select: { id: true } });
  if (!email) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updated = await prisma.partyEmail.update({ where: { id: eid }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: "email-updated", after: { emailId: eid, ...parsed.data } });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations
  return NextResponse.json({ email: updated });
});

export const DELETE = guarded(FEATURES.contactsManage, async (_req, { params, actor }) => {
  const { id, eid } = await params;
  const email = await prisma.partyEmail.findFirst({ where: { id: eid, partyId: id }, select: { id: true, email: true } });
  if (!email) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.partyEmail.delete({ where: { id: eid } });
  void audit({ actorId: actor!.id, entityType: "party", entityId: id, action: "email-removed", after: { email: email.email } });
  await publishEventDurable("party.updated"); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
