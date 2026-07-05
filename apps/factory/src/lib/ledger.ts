/**
 * F1 — the immutable movement ledger (FD8). Stock is DERIVED, never stored:
 *   inStock   = Σ IN − Σ OUT + Σ ADJUST(signed)
 *   committed = Σ RESERVE − Σ RELEASE
 * Sign rules: IN/OUT/RESERVE/RELEASE take positive magnitudes (the type IS
 * the direction); ADJUST alone may be signed (correction up or down) and
 * REQUIRES a reason. Consumption of reserved material = OUT + RELEASE pair.
 * Corrections are compensating movements — rows are never updated or deleted.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export type MovementInput = {
  materialId: string;
  type: "IN" | "OUT" | "ADJUST" | "RESERVE" | "RELEASE";
  qty: number;
  lotId?: string;
  reason?: string;
  refType?: string;
  refId?: string;
  actorId?: string;
};

export function validateMovement(m: MovementInput): string | null {
  if (!Number.isFinite(m.qty) || m.qty === 0) return "qty must be a non-zero number";
  if (m.type !== "ADJUST" && m.qty < 0) return `${m.type} takes a positive magnitude`;
  if (m.type === "ADJUST" && !m.reason?.trim()) return "ADJUST requires a reason";
  return null;
}

export async function appendMovement(m: MovementInput) {
  const invalid = validateMovement(m);
  if (invalid) throw new Error(`ledger: ${invalid}`);
  const row = await prisma.movementLedger.create({ data: m });
  void audit({
    actorId: m.actorId ?? null,
    entityType: "material",
    entityId: m.materialId,
    action: `ledger.${m.type.toLowerCase()}`,
    after: { qty: m.qty, lotId: m.lotId, reason: m.reason, refType: m.refType, refId: m.refId },
  });
  return row;
}

export type StockSummary = { inStock: number; committed: number; available: number };

/** Pure fold over movements — unit-tested; the SQL view mirrors it. */
export function foldMovements(
  movements: { type: string; qty: number }[],
): StockSummary {
  let inStock = 0;
  let committed = 0;
  for (const m of movements) {
    switch (m.type) {
      case "IN":
        inStock += m.qty;
        break;
      case "OUT":
        inStock -= m.qty;
        break;
      case "ADJUST":
        inStock += m.qty; // signed
        break;
      case "RESERVE":
        committed += m.qty;
        break;
      case "RELEASE":
        committed -= m.qty;
        break;
    }
  }
  return { inStock, committed, available: inStock - committed };
}

export async function stockSummary(materialId: string): Promise<StockSummary> {
  const movements = await prisma.movementLedger.findMany({
    where: { materialId },
    select: { type: true, qty: true },
  });
  return foldMovements(movements);
}
