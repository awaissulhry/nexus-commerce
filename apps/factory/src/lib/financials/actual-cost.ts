/**
 * FP9 — the FP6 actual cost, per order: Σ OUT movements (qty × material cost)
 * across the order's work orders. Shared by every financials route that needs
 * the real (consumed) cost. Not pure (reads the ledger), so it lives beside the
 * pure rollup rather than in it.
 */
import { prisma } from "../db";

export async function actualCostByOrder(orders: { id: string; woIds: string[] }[]): Promise<Map<string, number>> {
  const woToOrder = new Map<string, string>();
  for (const o of orders) for (const w of o.woIds) woToOrder.set(w, o.id);
  const woIds = [...woToOrder.keys()];
  const out = new Map<string, number>();
  if (woIds.length === 0) return out;

  const moves = await prisma.movementLedger.findMany({ where: { refType: "WorkOrder", refId: { in: woIds }, type: "OUT" }, select: { refId: true, materialId: true, qty: true } });
  if (moves.length === 0) return out;
  const costs = Object.fromEntries(
    (await prisma.material.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.materialId))] } }, select: { id: true, costCents: true } })).map((m) => [m.id, m.costCents]),
  );
  for (const m of moves) {
    const orderId = m.refId ? woToOrder.get(m.refId) : undefined;
    if (!orderId) continue;
    out.set(orderId, (out.get(orderId) ?? 0) + m.qty * (costs[m.materialId] ?? 0));
  }
  for (const [k, v] of out) out.set(k, Math.round(v));
  return out;
}
