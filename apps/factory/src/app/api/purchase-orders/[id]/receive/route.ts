/**
 * FP7 — receive a purchase order. Each receipt upserts a MaterialLot and appends
 * an IN movement (ref'd to this PO + lot) — stock rises, the floor's short light
 * can go green. The PO advances by `poStateAfterReceive`: PARTIAL until every
 * line is fully in, then RECEIVED. Behind materials.receive.
 * FS4 (C-3) — lots + IN movements + the PO state advance are ONE short
 * transaction (bounded: one receive's receipts): stock can no longer rise
 * while the PO stays SENT, and a lot can't exist without its movement. The
 * per-movement ledger audits + the event fire after commit.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { validateMovement, type MovementInput } from "@/lib/ledger";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { poStateAfterReceive } from "@/lib/materials/stock";

export const permission = FEATURES.materialsReceive;

type Line = { materialId: string; qty: number; unit: string; unitCostCents: number };
const Body = z.object({ receipts: z.array(z.object({ materialId: z.string().min(1), qty: z.number().positive(), lotCode: z.string().trim().optional() })).min(1) });

export const POST = guarded(FEATURES.materialsReceive, async (req, { params, actor }) => {
  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "At least one receipt is required" }, { status: 400 });
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, select: { number: true, state: true, lines: true, supplierId: true } });
  if (!po) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (po.state !== "SENT" && po.state !== "PARTIAL") return NextResponse.json({ error: "Only a sent PO can be received" }, { status: 400 });

  // pre-validate every movement so the transaction never opens for bad input
  const movements: MovementInput[] = parsed.data.receipts.map((r) => ({
    materialId: r.materialId,
    type: "IN" as const,
    qty: r.qty,
    reason: `PO receipt ${po.number}`,
    refType: "PO",
    refId: id,
    actorId: actor!.id,
  }));
  for (const m of movements) {
    const invalid = validateMovement(m);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  }

  const lines = (po.lines as Line[]) ?? [];
  const lotIds: string[] = [];
  const newState = await prisma.$transaction(async (tx) => {
    // each receipt → a lot + an IN movement
    let n = 0;
    for (const r of parsed.data.receipts) {
      const m = movements[n];
      n += 1;
      const lotCode = r.lotCode?.trim() || `${po.number}/${n}`;
      let lot = await tx.materialLot.findFirst({ where: { materialId: r.materialId, lotCode }, select: { id: true } });
      if (!lot) lot = await tx.materialLot.create({ data: { materialId: r.materialId, lotCode, supplierId: po.supplierId, receivedAt: new Date() }, select: { id: true } });
      lotIds.push(lot.id);
      await tx.movementLedger.create({ data: { ...m, lotId: lot.id } });
    }

    // advance the PO state (reading the just-committed-in-txn movements)
    const ins = await tx.movementLedger.findMany({ where: { refType: "PO", refId: id, type: "IN" }, select: { materialId: true, qty: true } }); // bounded: per-PO scope
    const received: Record<string, number> = {};
    for (const m of ins) received[m.materialId] = (received[m.materialId] ?? 0) + m.qty;
    const state = poStateAfterReceive(lines, lines.map((l) => received[l.materialId] ?? 0));
    await tx.purchaseOrder.update({ where: { id }, data: { state } });
    return state;
  });

  // after commit: the ledger audit rows appendMovement would have written, + the PO's own
  movements.forEach((m, i) => {
    void audit({ actorId: m.actorId ?? null, entityType: "material", entityId: m.materialId, action: "ledger.in", after: { qty: m.qty, lotId: lotIds[i], reason: m.reason, refType: m.refType, refId: m.refId } });
  });
  void audit({ actorId: actor!.id, entityType: "purchaseorder", entityId: id, action: "received", after: { receipts: parsed.data.receipts.length, state: newState } });
  await publishEventDurable("workorder.updated", { purchaseOrderId: id, received: true, state: newState });
  return NextResponse.json({ ok: true, state: newState });
});
