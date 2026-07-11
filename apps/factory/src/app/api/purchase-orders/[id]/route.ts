/**
 * FP7 — one purchase order: GET the lines with material names + received-so-far
 * (from IN movements ref'd to this PO); PATCH sends or cancels it. Receiving is
 * its own route. Money grain-stripped.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES, FEATURES } from "@/lib/auth/permissions";

export const permission = { GET: PAGES.materials, PATCH: FEATURES.materialsManage };

type Line = { materialId: string; qty: number; unit: string; unitCostCents: number };

async function detail(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { supplier: { select: { id: true, name: true } } } });
  if (!po) return null;
  const lines = (po.lines as Line[]) ?? [];
  const ins = await prisma.movementLedger.findMany({ where: { refType: "PO", refId: id, type: "IN" }, select: { materialId: true, qty: true } }); // bounded: per-PO scope
  const received: Record<string, number> = {};
  for (const m of ins) received[m.materialId] = (received[m.materialId] ?? 0) + m.qty;
  const names = Object.fromEntries((await prisma.material.findMany({ where: { id: { in: lines.map((l) => l.materialId) } }, select: { id: true, name: true } })).map((m) => [m.id, m.name])); // bounded: per-PO scope
  return {
    purchaseOrder: {
      id: po.id, number: po.number, state: po.state, supplier: po.supplier, expectedAt: po.expectedAt, createdAt: po.createdAt,
      lines: lines.map((l) => ({ ...l, materialName: names[l.materialId] ?? "?", received: received[l.materialId] ?? 0, lineTotalCents: l.qty * (l.unitCostCents ?? 0) })),
      totalCents: lines.reduce((s, l) => s + l.qty * (l.unitCostCents ?? 0), 0),
    },
  };
}

export const GET = guarded(PAGES.materials, async (_req, { params, resolved }) => {
  const { id } = await params;
  const payload = await detail(id);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return jsonStripped(payload, resolved);
});

const Patch = z.object({ action: z.enum(["send", "cancel"]) });

export const PATCH = guarded(FEATURES.materialsManage, async (req, { params, actor, resolved }) => {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "action required" }, { status: 400 });
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, select: { state: true } });
  if (!po) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "send") {
    if (po.state !== "DRAFT") return NextResponse.json({ error: "Only a draft PO can be sent" }, { status: 400 });
    await prisma.purchaseOrder.update({ where: { id }, data: { state: "SENT" } });
  } else {
    if (po.state === "RECEIVED") return NextResponse.json({ error: "A received PO can't be cancelled" }, { status: 400 });
    await prisma.purchaseOrder.update({ where: { id }, data: { state: "CANCELLED" } });
  }
  void audit({ actorId: actor!.id, entityType: "purchaseorder", entityId: id, action: parsed.data.action });
  await publishEventDurable("workorder.updated", { purchaseOrderId: id, action: parsed.data.action });
  const payload = await detail(id);
  return jsonStripped(payload, resolved);
});
