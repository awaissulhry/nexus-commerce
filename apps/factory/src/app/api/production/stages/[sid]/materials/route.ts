/**
 * FP6 — actual material use at CUTTING finish. For each reserved material: OUT
 * the quantity truly used + RELEASE the reservation (the consume pair). Materials
 * reserved but not used are RELEASED (freed). The `use` map is stored on the
 * stage; the response carries the diff vs the BOM estimate. Behind materials.consume.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { Prisma } from "@/generated/prisma/client";
import { FEATURES } from "@/lib/auth/permissions";
import { consumeWorkOrder } from "@/lib/production/reserve-service";

export const permission = { GET: FEATURES.materialsConsume, POST: FEATURES.materialsConsume };

/** GET = the WO's reserved materials (the estimate) for the actual-use form. */
export const GET = guarded(FEATURES.materialsConsume, async (_req, { params }) => {
  const { sid } = await params;
  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, select: { workOrderId: true } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const moves = await prisma.movementLedger.findMany({ where: { refType: "WorkOrder", refId: stage.workOrderId, type: { in: ["RESERVE", "RELEASE"] } }, select: { materialId: true, type: true, qty: true } }); // bounded: per-stage/per-WO scope
  const reserved: Record<string, number> = {};
  for (const m of moves) reserved[m.materialId] = (reserved[m.materialId] ?? 0) + (m.type === "RESERVE" ? m.qty : -m.qty);
  const ids = Object.keys(reserved).filter((k) => reserved[k] > 0.0001);
  const mats = ids.length ? await prisma.material.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, unit: true } }) : []; // bounded: per-stage/per-WO scope
  return NextResponse.json({ reserved: mats.map((m) => ({ materialId: m.id, name: m.name, unit: m.unit, reservedQty: reserved[m.id] })) });
});

const Body = z.object({ use: z.record(z.string(), z.number().min(0)) });

export const POST = guarded(FEATURES.materialsConsume, async (req, { params, actor }) => {
  const { sid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, select: { id: true, workOrderId: true } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const moves = await prisma.movementLedger.findMany({ where: { refType: "WorkOrder", refId: stage.workOrderId, type: { in: ["RESERVE", "RELEASE"] } }, select: { materialId: true, type: true, qty: true } }); // bounded: per-stage/per-WO scope
  const reserved: Record<string, number> = {};
  for (const m of moves) reserved[m.materialId] = (reserved[m.materialId] ?? 0) + (m.type === "RESERVE" ? m.qty : -m.qty);

  // every material touched (reserved or used) gets OUT(used) + RELEASE(reserved)
  const touched = new Set([...Object.keys(reserved).filter((k) => reserved[k] > 0.0001), ...Object.keys(parsed.data.use)]);
  const diff: { materialId: string; reserved: number; used: number }[] = [];
  for (const materialId of touched) {
    const used = parsed.data.use[materialId] ?? 0;
    const res = Math.max(0, reserved[materialId] ?? 0);
    await consumeWorkOrder(stage.workOrderId, materialId, used, res, actor!.id);
    diff.push({ materialId, reserved: res, used });
  }

  await prisma.workOrderStage.update({ where: { id: sid }, data: { actualMaterialUse: parsed.data.use as Prisma.InputJsonValue } });
  void audit({ actorId: actor!.id, entityType: "workorder", entityId: stage.workOrderId, action: "material.consumed", after: { stageId: sid, diff } });
  await publishEventDurable("workorder.updated", { workOrderId: stage.workOrderId, consumed: true });
  return NextResponse.json({ ok: true, diff });
});
