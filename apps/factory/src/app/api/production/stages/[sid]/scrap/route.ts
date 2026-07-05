/**
 * FP6 — record scrap at a stage: a reason (kept on the stage) + an optional
 * material OUT (scrap consumes material without producing). Behind
 * materials.consume. The ledger stays append-only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";

export const permission = FEATURES.materialsConsume;

const Body = z.object({ reason: z.string().trim().min(1, "A reason is required").max(500), materialId: z.string().optional(), qty: z.number().positive().optional() });

export const POST = guarded(FEATURES.materialsConsume, async (req, { params, actor }) => {
  const { sid } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A reason is required" }, { status: 400 });
  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, select: { workOrderId: true, scrapNotes: true, stage: true } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const note = `${stage.scrapNotes ? stage.scrapNotes + "\n" : ""}${parsed.data.reason}`;
  await prisma.workOrderStage.update({ where: { id: sid }, data: { scrapNotes: note } });

  if (parsed.data.materialId && parsed.data.qty && parsed.data.qty > 0) {
    await prisma.movementLedger.create({ data: { materialId: parsed.data.materialId, type: "OUT", qty: parsed.data.qty, reason: `scrap (${stage.stage}): ${parsed.data.reason}`.slice(0, 200), refType: "WorkOrder", refId: stage.workOrderId, actorId: actor!.id } });
  }
  void audit({ actorId: actor!.id, entityType: "workorder", entityId: stage.workOrderId, action: "scrap", after: { stage: stage.stage, reason: parsed.data.reason, materialId: parsed.data.materialId, qty: parsed.data.qty } });
  await publishEventDurable("workorder.updated", { workOrderId: stage.workOrderId, scrap: true });
  return NextResponse.json({ ok: true });
});
