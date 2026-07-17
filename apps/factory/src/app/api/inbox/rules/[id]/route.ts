/** EPI3.4 — edit/reorder/delete one rule (inbox.views.manage). */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { CriteriaSchema, RuleActionsSchema } from "@/lib/inbox/views";

export const permission = FEATURES.inboxViewsManage;

const Patch = z.object({
  name: z.string().min(1).max(60).optional(),
  criteria: CriteriaSchema.optional(),
  actions: RuleActionsSchema.optional(),
  enabled: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export const PATCH = guarded(FEATURES.inboxViewsManage, async (req: NextRequest, { params, actor }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (parsed.data.criteria && parsed.data.criteria.all.length === 0 && parsed.data.criteria.any.length === 0) {
    return NextResponse.json({ error: "Add at least one condition" }, { status: 400 });
  }
  const existing = await prisma.inboxRule.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rule = await prisma.inboxRule.update({ where: { id }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "inboxRule", entityId: id, action: "updated", after: parsed.data });
  return NextResponse.json({ rule });
});

export const DELETE = guarded(FEATURES.inboxViewsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const existing = await prisma.inboxRule.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.inboxRule.delete({ where: { id } });
  void audit({ actorId: actor!.id, entityType: "inboxRule", entityId: id, action: "deleted", after: { name: existing.name } });
  return NextResponse.json({ ok: true });
});
