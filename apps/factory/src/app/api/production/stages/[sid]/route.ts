/**
 * FP6 — run a stage: POST { action: start|pause|resume|finish } drives the pure
 * stage-timer; PATCH { assigneeId } assigns it. Forward-only floor: a stage can
 * only start once every earlier stage is finished. Finishing the last stage
 * completes the Work Order. (The QC→Packing cert gate lands in FP6.4.)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { start, pause, resume, finish, canStart, woComplete, type StageRow } from "@/lib/production/stage-timer";
import { certGateForWorkOrder, CERT_BLOCK_MESSAGE } from "@/lib/production/cert-gate";

export const permission = { POST: FEATURES.workordersAdvance, PATCH: FEATURES.workordersAssign };

const Act = z.object({ action: z.enum(["start", "pause", "resume", "finish"]) });
const TRANSITION = { start, pause, resume, finish } as const;

export const POST = guarded(FEATURES.workordersAdvance, async (req, { params, actor }) => {
  const { sid } = await params;
  const parsed = Act.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "action required" }, { status: 400 });

  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, include: { workOrder: { include: { stages: true } } } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const siblings = stage.workOrder.stages as unknown as StageRow[];

  if (parsed.data.action === "start" && !canStart(siblings, sid)) {
    return NextResponse.json({ error: "Finish the earlier stages first" }, { status: 400 });
  }

  // FD14 — the EN 17092 cert gate: QC can't finish (into Packing) without a valid cert
  if (parsed.data.action === "finish" && stage.stage === "QC") {
    const cs = await certGateForWorkOrder(stage.workOrderId, Date.now());
    if (cs === "missing" || cs === "expired") return NextResponse.json({ error: CERT_BLOCK_MESSAGE[cs], code: "cert_blocked" }, { status: 422 });
  }

  const now = Date.now();
  const patch = TRANSITION[parsed.data.action](stage, now);
  if (!patch) return NextResponse.json({ error: `Can't ${parsed.data.action} this stage now` }, { status: 400 });

  await prisma.workOrderStage.update({ where: { id: sid }, data: patch });

  // starting any stage puts a READY work order into progress
  if (parsed.data.action === "start" && stage.workOrder.state === "READY") {
    await prisma.workOrder.update({ where: { id: stage.workOrderId }, data: { state: "IN_PROGRESS" } });
  }

  // finishing the last stage completes the WO; all a WO done ⇒ the order is READY
  let woDone = false;
  let orderReady = false;
  if (parsed.data.action === "finish") {
    const after = siblings.map((s) => (s.id === sid ? { ...s, finishedAt: new Date(now) } : s));
    if (woComplete(after)) {
      await prisma.workOrder.update({ where: { id: stage.workOrderId }, data: { state: "DONE" } });
      woDone = true;
      const orderId = stage.workOrder.orderId;
      const siblingsWo = await prisma.workOrder.findMany({ where: { orderId }, select: { state: true } }); // bounded: per-order work orders (WorkOrder.orderId indexed in FS1)
      if (siblingsWo.every((s) => s.state === "DONE")) {
        const order = await prisma.order.findUnique({ where: { id: orderId }, select: { state: true } });
        if (order?.state === "IN_PRODUCTION") {
          await prisma.order.update({ where: { id: orderId }, data: { state: "READY" } });
          orderReady = true;
          void audit({ actorId: actor!.id, entityType: "order", entityId: orderId, action: "state-changed", before: { from: "IN_PRODUCTION" }, after: { to: "READY", via: "all-wos-done" } });
          await publishEventDurable("order.updated", { orderId, from: "IN_PRODUCTION", to: "READY" });
        }
      }
    }
  }

  void audit({ actorId: actor!.id, entityType: "workorder", entityId: stage.workOrderId, action: `stage.${parsed.data.action}`, after: { stage: stage.stage, woDone } });
  await publishEventDurable("workorder.updated", { workOrderId: stage.workOrderId, stage: stage.stage, action: parsed.data.action, woDone });
  return NextResponse.json({ ok: true, woDone, orderReady });
});

const Assign = z.object({ assigneeId: z.string().nullable() });

export const PATCH = guarded(FEATURES.workordersAssign, async (req, { params, actor }) => {
  const { sid } = await params;
  const parsed = Assign.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const stage = await prisma.workOrderStage.findUnique({ where: { id: sid }, select: { id: true, workOrderId: true } });
  if (!stage) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.workOrderStage.update({ where: { id: sid }, data: { assigneeId: parsed.data.assigneeId } });
  void audit({ actorId: actor!.id, entityType: "workorder", entityId: stage.workOrderId, action: "stage.assign", after: { stageId: sid, assigneeId: parsed.data.assigneeId } });
  return NextResponse.json({ ok: true });
});
