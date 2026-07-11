/** FP2.2 — patch / delete an option group (delete cascades its options). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = { PATCH: FEATURES.productsManage, DELETE: FEATURES.productsManage };

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(1).optional(),
});

export const PATCH = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { gid } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const group = await prisma.optionGroup.update({ where: { id: gid }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "group", entityId: gid, action: "updated", after: parsed.data });
  await publishEventDurable("pricing.updated", { templateId: group.templateId }); // FS2 — no silent mutations
  return NextResponse.json({ group });
});

export const DELETE = guarded(FEATURES.productsManage, async (_req, { params, actor }) => {
  const { gid } = await params;
  // clean constraints referencing this group's options (option ids are plain strings, not FKs)
  const optionIds = (await prisma.option.findMany({ where: { groupId: gid }, select: { id: true } })).map((o) => o.id); // bounded: per-group options
  if (optionIds.length) {
    await prisma.optionConstraint.deleteMany({
      where: { OR: [{ ifOptionId: { in: optionIds } }, { thenOptionId: { in: optionIds } }] },
    });
  }
  const group = await prisma.optionGroup.delete({ where: { id: gid } });
  void audit({ actorId: actor!.id, entityType: "group", entityId: gid, action: "deleted" });
  await publishEventDurable("pricing.updated", { templateId: group.templateId }); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
