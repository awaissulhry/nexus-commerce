/**
 * FP7 — the materials workspace list: every material with the four-column math
 * (In stock / Committed / Expected / Available) from the append-only ledger +
 * open POs. `pages.materials` (the Workers' page too) — stock counts are NOT
 * financial (the floor needs them); supplier cost is grain-stripped by name.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { materialStock, isLow } from "@/lib/materials/stock";

export const permission = PAGES.materials;

export const GET = guarded(PAGES.materials, async (req: NextRequest, { resolved }) => {
  const includeArchived = req.nextUrl.searchParams.get("archived") === "1";
  const [materials, allMoves, openPos] = await Promise.all([
    prisma.material.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { name: "asc" } }),
    prisma.movementLedger.findMany({ select: { materialId: true, type: true, qty: true, refType: true, refId: true } }),
    prisma.purchaseOrder.findMany({ where: { state: { in: ["SENT", "PARTIAL"] } }, select: { id: true, lines: true } }),
  ]);

  // movements per material
  const movesByMat: Record<string, { type: string; qty: number }[]> = {};
  for (const m of allMoves) (movesByMat[m.materialId] ??= []).push({ type: m.type, qty: m.qty });

  // Expected per material = Σ over open POs of (ordered − received-via-PO-IN), floored
  const receivedByPoMat: Record<string, Record<string, number>> = {};
  for (const m of allMoves) if (m.type === "IN" && m.refType === "PO" && m.refId) ((receivedByPoMat[m.refId] ??= {})[m.materialId] = (receivedByPoMat[m.refId][m.materialId] ?? 0) + m.qty);
  const expectedByMat: Record<string, number> = {};
  for (const po of openPos) for (const l of (po.lines as { materialId: string; qty: number }[]) ?? []) {
    const rec = receivedByPoMat[po.id]?.[l.materialId] ?? 0;
    expectedByMat[l.materialId] = (expectedByMat[l.materialId] ?? 0) + Math.max(0, l.qty - rec);
  }

  const rows = materials.map((m) => {
    const s = materialStock(movesByMat[m.id] ?? [], expectedByMat[m.id] ?? 0);
    return { id: m.id, name: m.name, unit: m.unit, costCents: m.costCents, reorderLevel: m.reorderLevel, archivedAt: m.archivedAt, ...s, low: isLow(s.available, m.reorderLevel), short: s.committed > s.inStock };
  });
  return jsonStripped({ materials: rows }, resolved);
});
