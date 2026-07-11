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
  // FS1 — the ledger is append-only and unbounded (1M+ rows at scale): fold it
  // in SQL. groupBy(materialId,type) yields ≤ materials×5 aggregate rows that
  // feed the SAME pure materialStock() fold (Σ per type is fold-equivalent
  // because IN/OUT/RESERVE/RELEASE add magnitudes and ADJUST alone is signed —
  // parity-checked by scripts/scale/parity.ts).
  const [materials, typeSums, openPos] = await Promise.all([
    prisma.material.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { name: "asc" } }), // bounded: materials catalog is config-sized
    prisma.movementLedger.groupBy({ by: ["materialId", "type"], _sum: { qty: true } }),
    prisma.purchaseOrder.findMany({ where: { state: { in: ["SENT", "PARTIAL"] } }, select: { id: true, lines: true } }), // bounded: open POs only (SENT/PARTIAL)
  ]);

  // aggregate pseudo-movements per material (one per movement type)
  const movesByMat: Record<string, { type: string; qty: number }[]> = {};
  for (const s of typeSums) (movesByMat[s.materialId] ??= []).push({ type: s.type, qty: s._sum.qty ?? 0 });

  // Expected per material = Σ over open POs of (ordered − received-via-PO-IN),
  // floored. PO receipts aggregated in SQL, bounded to the open POs.
  const poIds = openPos.map((po) => po.id);
  const poReceipts = poIds.length
    ? await prisma.movementLedger.groupBy({ by: ["refId", "materialId"], where: { type: "IN", refType: "PO", refId: { in: poIds } }, _sum: { qty: true } })
    : [];
  const receivedByPoMat: Record<string, Record<string, number>> = {};
  for (const r of poReceipts) if (r.refId) (receivedByPoMat[r.refId] ??= {})[r.materialId] = r._sum.qty ?? 0;
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
