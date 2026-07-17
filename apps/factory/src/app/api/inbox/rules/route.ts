/**
 * EPI3.4 — ingest rules CRUD (inbox.views.manage). Rules are ordered
 * when/if/then rows applied ONCE at conversation creation; Run-now handles
 * the retroactive sweep with a dry-run diff (the CSV-import idiom).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { CriteriaSchema, RuleActionsSchema } from "@/lib/inbox/views";

export const permission = FEATURES.inboxViewsManage;

const RuleBody = z.object({
  name: z.string().min(1).max(60),
  criteria: CriteriaSchema,
  actions: RuleActionsSchema,
  enabled: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
});

export const GET = guarded(FEATURES.inboxViewsManage, async () => {
  const rules = await prisma.inboxRule.findMany({ orderBy: { sortOrder: "asc" }, take: 50 }); // bounded: hand-authored config
  return NextResponse.json({ rules });
});

export const POST = guarded(FEATURES.inboxViewsManage, async (req: NextRequest, { actor }) => {
  const parsed = RuleBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (parsed.data.criteria.all.length === 0 && parsed.data.criteria.any.length === 0) {
    return NextResponse.json({ error: "Add at least one condition" }, { status: 400 });
  }
  const last = await prisma.inboxRule.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const rule = await prisma.inboxRule.create({
    data: {
      name: parsed.data.name,
      criteria: parsed.data.criteria,
      actions: parsed.data.actions,
      enabled: parsed.data.enabled ?? true,
      stopProcessing: parsed.data.stopProcessing ?? true,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });
  void audit({ actorId: actor!.id, entityType: "inboxRule", entityId: rule.id, action: "created", after: { name: rule.name } });
  return NextResponse.json({ rule }, { status: 201 });
});
