/**
 * FP7 — a new purchase order, created as a DRAFT for a supplier. P12 (MCP full control): moved verbatim from
 * POST /api/purchase-orders so Claude's `factory-draft-purchase-order` creates one exactly as the page does. A draft
 * is never sent from here: sending it to the supplier stays a person's click.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { nextNumber } from "@/lib/counters";

export type DraftPurchaseOrderLine = { materialId: string; qty: number; unit: string; unitCostCents: number };

export async function createDraftPurchaseOrder(input: { supplierId: string; expectedAt?: string | null; lines: DraftPurchaseOrderLine[]; actorId: string }) {
  const supplier = await prisma.party.findUnique({ where: { id: input.supplierId }, select: { id: true } });
  if (!supplier) return { ok: false as const, status: 404, error: "Supplier not found" };

  const number = await nextNumber("po");
  const po = await prisma.purchaseOrder.create({
    data: { number, supplierId: input.supplierId, state: "DRAFT", lines: input.lines, expectedAt: input.expectedAt ? new Date(input.expectedAt) : null },
    select: { id: true, number: true },
  });
  void audit({ actorId: input.actorId, entityType: "purchaseorder", entityId: po.id, action: "created", after: { number, lines: input.lines.length } });
  await publishEventDurable("workorder.updated", { purchaseOrderId: po.id, created: true }); // FS2 — no silent mutations
  return { ok: true as const, purchaseOrder: po };
}
