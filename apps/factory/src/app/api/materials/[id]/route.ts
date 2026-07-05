/**
 * FP2.3 — patch / delete a material. A material cost edit returns the reprice
 * ripple (how many templates its composed cost just changed — the Craftybase
 * verdict). Delete → archive when referenced (BOM/draws/lots/movements), else
 * hard delete.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { materialUsage } from "@/lib/products/material-usage";

export const permission = { PATCH: FEATURES.materialsManage, DELETE: FEATURES.materialsManage };

const Patch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  unit: z.enum(["HIDE", "SQM", "PIECE", "M"]).optional(),
  costCents: z.number().int().min(0).optional(),
  reorderLevel: z.number().min(0).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const PATCH = guarded(FEATURES.materialsManage, async (req: NextRequest, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const before = await prisma.material.findUnique({ where: { id }, select: { costCents: true } });
  const material = await prisma.material.update({ where: { id }, data: parsed.data });
  void audit({ actorId: actor!.id, entityType: "material", entityId: id, action: "updated", before, after: parsed.data });

  // reprice ripple: only when the cost actually moved
  let ripple: { templates: number } | null = null;
  if (parsed.data.costCents !== undefined && before && parsed.data.costCents !== before.costCents) {
    ripple = { templates: (await materialUsage(id)).length };
    await publishEventDurable("pricing.updated", { materialId: id });
  }
  return jsonStripped({ material, ripple }, resolved);
});

export const DELETE = guarded(FEATURES.materialsManage, async (_req, { params, actor }) => {
  const { id } = await params;
  const [bom, lots, movements] = await Promise.all([
    prisma.bomLine.count({ where: { materialId: id } }),
    prisma.materialLot.count({ where: { materialId: id } }),
    prisma.movementLedger.count({ where: { materialId: id } }),
  ]);
  const draws = (await materialUsage(id)).length; // includes option-draw references
  if (bom > 0 || lots > 0 || movements > 0 || draws > 0) {
    await prisma.material.update({ where: { id }, data: { archivedAt: new Date() } });
    void audit({ actorId: actor!.id, entityType: "material", entityId: id, action: "archived", after: { reason: "referenced" } });
    return NextResponse.json({ ok: true, archived: true, reason: "Referenced by BOMs, lots or stock movements — archived, not deleted." });
  }
  await prisma.material.delete({ where: { id } });
  void audit({ actorId: actor!.id, entityType: "material", entityId: id, action: "deleted" });
  return NextResponse.json({ ok: true, archived: false });
});
