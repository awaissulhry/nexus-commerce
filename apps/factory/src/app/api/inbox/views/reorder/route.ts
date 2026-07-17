/** EPI3.2 — reorder views: tab order IS claim priority (Superhuman law). */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.inboxViewsManage;

const Body = z.object({ ids: z.array(z.string().min(1)).min(1).max(50) });

export const POST = guarded(FEATURES.inboxViewsManage, async (req: NextRequest, { actor }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  await prisma.$transaction(
    parsed.data.ids.map((id, index) => prisma.inboxView.update({ where: { id }, data: { sortOrder: index } })),
  );
  void audit({ actorId: actor!.id, entityType: "inboxView", entityId: "order", action: "reordered", after: { ids: parsed.data.ids } });
  await publishEventDurable("conversation.updated", { viewsChanged: true });
  return NextResponse.json({ ok: true });
});
