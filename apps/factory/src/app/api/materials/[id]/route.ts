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
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import { materialUsage } from "@/lib/products/material-usage";
import { materialStock, isLow } from "@/lib/materials/stock";

export const permission = { GET: PAGES.materials, PATCH: FEATURES.materialsManage, DELETE: FEATURES.materialsManage };

export const GET = guarded(PAGES.materials, async (_req, { params, resolved }) => {
  const { id } = await params;
  const material = await prisma.material.findUnique({ where: { id } });
  if (!material) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [moves, lots, openPos] = await Promise.all([
    prisma.movementLedger.findMany({ where: { materialId: id }, orderBy: { createdAt: "desc" }, take: 200, include: { actor: { select: { displayName: true } }, lot: { select: { lotCode: true } } } }),
    prisma.materialLot.findMany({ where: { materialId: id }, orderBy: { receivedAt: "desc" }, include: { supplier: { select: { name: true } } } }),
    prisma.purchaseOrder.findMany({ where: { state: { in: ["SENT", "PARTIAL"] } }, select: { id: true, lines: true } }),
  ]);

  // expected for this material
  let expected = 0;
  const poIns = moves.filter((m) => m.type === "IN" && m.refType === "PO");
  const recByPo: Record<string, number> = {};
  for (const m of poIns) recByPo[m.refId as string] = (recByPo[m.refId as string] ?? 0) + m.qty;
  for (const po of openPos) for (const l of (po.lines as { materialId: string; qty: number }[]) ?? []) if (l.materialId === id) expected += Math.max(0, l.qty - (recByPo[po.id] ?? 0));

  const s = materialStock(moves.map((m) => ({ type: m.type, qty: m.qty })), expected);
  // on-hand per lot = Σ IN(lot) − Σ OUT(lot)
  const lotOnHand: Record<string, number> = {};
  for (const m of moves) if (m.lotId) lotOnHand[m.lotId] = (lotOnHand[m.lotId] ?? 0) + (m.type === "IN" ? m.qty : m.type === "OUT" ? -m.qty : 0);

  return jsonStripped({
    material: { id: material.id, name: material.name, unit: material.unit, costCents: material.costCents, reorderLevel: material.reorderLevel, notes: material.notes, archivedAt: material.archivedAt },
    stock: { ...s, low: isLow(s.available, material.reorderLevel), short: s.committed > s.inStock },
    movements: moves.map((m) => ({ id: m.id, type: m.type, qty: m.qty, reason: m.reason, refType: m.refType, refId: m.refId, lot: m.lot?.lotCode ?? null, actor: m.actor?.displayName ?? null, at: m.createdAt })),
    lots: lots.map((l) => ({ id: l.id, lotCode: l.lotCode, supplier: l.supplier?.name ?? null, receivedAt: l.receivedAt, onHand: lotOnHand[l.id] ?? 0 })),
    usedByTemplates: (await materialUsage(id)).length,
  }, resolved);
});

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
