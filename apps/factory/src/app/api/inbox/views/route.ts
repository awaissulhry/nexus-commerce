/**
 * EPI3.2 — inbox views: list (any inbox user) + create (inbox.views.manage).
 * A view is CRITERIA (zod-validated); empty criteria are refused — a view
 * must say something. Order = claim priority.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { CriteriaSchema } from "@/lib/inbox/views";

export const permission = { GET: PAGES.inbox, POST: FEATURES.inboxViewsManage };

const ViewBody = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().max(8).nullable().optional(),
  color: z.string().max(24).nullable().optional(),
  exclusive: z.boolean().optional(),
  showElsewhere: z.boolean().optional(),
  criteria: CriteriaSchema,
});

export const GET = guarded(PAGES.inbox, async () => {
  const views = await prisma.inboxView.findMany({ orderBy: { sortOrder: "asc" }, take: 50 }); // bounded: hand-authored config
  return NextResponse.json({ views });
});

export const POST = guarded(FEATURES.inboxViewsManage, async (req: NextRequest, { actor }) => {
  const parsed = ViewBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { criteria } = parsed.data;
  if (criteria.all.length === 0 && criteria.any.length === 0) {
    return NextResponse.json({ error: "Add at least one condition" }, { status: 400 });
  }
  const last = await prisma.inboxView.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const view = await prisma.inboxView.create({
    data: {
      name: parsed.data.name,
      emoji: parsed.data.emoji ?? null,
      color: parsed.data.color ?? null,
      exclusive: parsed.data.exclusive ?? true,
      showElsewhere: parsed.data.showElsewhere ?? false,
      criteria,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });
  void audit({ actorId: actor!.id, entityType: "inboxView", entityId: view.id, action: "created", after: { name: view.name } });
  await publishEventDurable("conversation.updated", { viewsChanged: true });
  return NextResponse.json({ view }, { status: 201 });
});
