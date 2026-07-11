/**
 * FP2.2 — patch / delete an option. Delete also removes constraints that
 * reference it (plain-string option ids) and its price-list overrides cascade
 * (FK onDelete). materialDraws editing lands in FP2.3's BOM tab.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = { PATCH: FEATURES.productsManage, DELETE: FEATURES.productsManage };

const Patch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  costDeltaMode: z.enum(["ABSOLUTE", "PERCENT"]).optional(),
  costDelta: z.number().int().optional(),
  priceDeltaMode: z.enum(["ABSOLUTE", "PERCENT"]).optional(),
  priceDelta: z.number().int().optional(),
  materialDraws: z.array(z.object({ materialId: z.string(), qty: z.number(), unit: z.string() })).nullable().optional(),
});

export const PATCH = guarded(FEATURES.productsManage, async (req, { params, actor }) => {
  const { oid } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { materialDraws, ...rest } = parsed.data;
  const option = await prisma.option.update({
    where: { id: oid },
    data: { ...rest, ...(materialDraws !== undefined ? { materialDraws: materialDraws ?? undefined } : {}) },
  });
  void audit({ actorId: actor!.id, entityType: "option", entityId: oid, action: "updated", after: rest });
  const parent = await prisma.optionGroup.findUnique({ where: { id: option.groupId }, select: { templateId: true } });
  await publishEventDurable("pricing.updated", { templateId: parent?.templateId }); // FS2 — no silent mutations
  return NextResponse.json({ option });
});

export const DELETE = guarded(FEATURES.productsManage, async (_req, { params, actor }) => {
  const { oid } = await params;
  await prisma.optionConstraint.deleteMany({ where: { OR: [{ ifOptionId: oid }, { thenOptionId: oid }] } });
  const option = await prisma.option.delete({ where: { id: oid } });
  void audit({ actorId: actor!.id, entityType: "option", entityId: oid, action: "deleted" });
  const parent = await prisma.optionGroup.findUnique({ where: { id: option.groupId }, select: { templateId: true } });
  await publishEventDurable("pricing.updated", { templateId: parent?.templateId }); // FS2 — no silent mutations
  return NextResponse.json({ ok: true });
});
