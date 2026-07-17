/** EPI3.2 — edit/delete one view (inbox.views.manage). Deleting returns its
 * conversations to the Inbox — nothing is deleted but the definition. */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { CriteriaSchema } from "@/lib/inbox/views";

export const permission = FEATURES.inboxViewsManage;

const Patch = z.object({
  name: z.string().min(1).max(60).optional(),
  emoji: z.string().max(8).nullable().optional(),
  color: z.string().max(24).nullable().optional(),
  exclusive: z.boolean().optional(),
  showElsewhere: z.boolean().optional(),
  criteria: CriteriaSchema.optional(),
});

export const PATCH = guarded(FEATURES.inboxViewsManage, async (req: NextRequest, { params, actor }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (parsed.data.criteria && parsed.data.criteria.all.length === 0 && parsed.data.criteria.any.length === 0) {
    return NextResponse.json({ error: "Add at least one condition" }, { status: 400 });
  }
  const existing = await prisma.inboxView.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const view = await prisma.inboxView.update({ where: { id }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "inboxView", entityId: id, action: "updated", after: parsed.data });
  await publishEventDurable("conversation.updated", { viewsChanged: true });
  return NextResponse.json({ view });
});

export const DELETE = guarded(FEATURES.inboxViewsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const existing = await prisma.inboxView.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.inboxView.delete({ where: { id } }); // overrides cascade
  void audit({ actorId: actor!.id, entityType: "inboxView", entityId: id, action: "deleted", after: { name: existing.name } });
  await publishEventDurable("conversation.updated", { viewsChanged: true });
  return NextResponse.json({ ok: true });
});
