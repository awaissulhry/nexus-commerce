/**
 * FP6 — reserve a Work Order's material at production start (Katana verdict:
 * reserve here, never at quote). Idempotent — skip if the WO already has RESERVE
 * rows. The RESERVE quantity IS the demand snapshot the board reads back. Never
 * throws the caller: a missing BOM just means nothing to reserve.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { garmentDemand } from "./demand";

export async function reserveWorkOrder(woId: string, orderLineId: string | null, actorId: string | null): Promise<number> {
  if (!orderLineId) return 0;
  const already = await prisma.movementLedger.count({ where: { refType: "WorkOrder", refId: woId, type: "RESERVE" } });
  if (already > 0) return 0;
  const line = await prisma.orderLine.findUnique({ where: { id: orderLineId }, select: { selections: true } });
  const demand = await garmentDemand((line?.selections as string[] | null) ?? []);
  if (demand.length === 0) return 0;
  await prisma.movementLedger.createMany({
    data: demand.map((d) => ({ materialId: d.materialId, type: "RESERVE" as const, qty: d.qty, reason: "production start", refType: "WorkOrder", refId: woId, actorId: actorId ?? undefined })),
  });
  return demand.length;
}

/**
 * Consume actual material at CUTTING finish: OUT (used) + RELEASE (free the
 * reservation). FS4 (C-3) — accepts the caller's transaction client so the
 * whole consume set + the stage's actualMaterialUse commit together.
 */
export async function consumeWorkOrder(
  woId: string,
  materialId: string,
  usedQty: number,
  reservedQty: number,
  actorId: string | null,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  const rows: { materialId: string; type: "OUT" | "RELEASE"; qty: number; reason: string; refType: string; refId: string; actorId?: string }[] = [];
  if (usedQty > 0) rows.push({ materialId, type: "OUT", qty: usedQty, reason: "consumed at cutting", refType: "WorkOrder", refId: woId, actorId: actorId ?? undefined });
  if (reservedQty > 0) rows.push({ materialId, type: "RELEASE", qty: reservedQty, reason: "reservation cleared at cutting", refType: "WorkOrder", refId: woId, actorId: actorId ?? undefined });
  if (rows.length) await db.movementLedger.createMany({ data: rows });
}
