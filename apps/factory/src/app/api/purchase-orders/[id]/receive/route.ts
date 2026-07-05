/**
 * FP7 — receive a purchase order. Each receipt upserts a MaterialLot and appends
 * an IN movement (ref'd to this PO + lot) — stock rises, the floor's short light
 * can go green. The PO advances by `poStateAfterReceive`: PARTIAL until every
 * line is fully in, then RECEIVED. Behind materials.receive.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { appendMovement } from "@/lib/ledger";
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

  // each receipt → a lot + an IN movement
  let n = 0;
  for (const r of parsed.data.receipts) {
    n += 1;
    const lotCode = r.lotCode?.trim() || `${po.number}/${n}`;
    let lot = await prisma.materialLot.findFirst({ where: { materialId: r.materialId, lotCode }, select: { id: true } });
    if (!lot) lot = await prisma.materialLot.create({ data: { materialId: r.materialId, lotCode, supplierId: po.supplierId, receivedAt: new Date() }, select: { id: true } });
    await appendMovement({ materialId: r.materialId, lotId: lot.id, type: "IN", qty: r.qty, reason: `PO receipt ${po.number}`, refType: "PO", refId: id, actorId: actor!.id });
  }

  // advance the PO state
  const lines = (po.lines as Line[]) ?? [];
  const ins = await prisma.movementLedger.findMany({ where: { refType: "PO", refId: id, type: "IN" }, select: { materialId: true, qty: true } });
  const received: Record<string, number> = {};
  for (const m of ins) received[m.materialId] = (received[m.materialId] ?? 0) + m.qty;
  const newState = poStateAfterReceive(lines, lines.map((l) => received[l.materialId] ?? 0));
  await prisma.purchaseOrder.update({ where: { id }, data: { state: newState } });

  void audit({ actorId: actor!.id, entityType: "purchaseorder", entityId: id, action: "received", after: { receipts: parsed.data.receipts.length, state: newState } });
  await publishEventDurable("workorder.updated", { purchaseOrderId: id, received: true, state: newState });
  return NextResponse.json({ ok: true, state: newState });
});
