/**
 * FP6 — run a stage: POST { action: start|pause|resume|finish } drives the pure
 * stage-timer; PATCH { assigneeId } assigns it. Forward-only floor: a stage can
 * only start once every earlier stage is finished. Finishing the last stage
 * completes the Work Order. (The QC→Packing cert gate lands in FP6.4.)
 * FS4 (C-3) — stage patch + implied WO state are one short transaction.
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
import { transitionOrder } from "@/lib/orders/transition-service";
import { notifyOwners } from "@/lib/quotes/notify-owners";

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

  // FS4 (C-3) — the stage-timer patch and the WO state it implies commit as
  // ONE short transaction: a crash can no longer finish the last stage while
  // the work order stays IN_PROGRESS (or start a stage on a WO still READY).
  // The order READY promotion stays OUTSIDE — it is transitionOrder's own
  // guarded transaction (EPO.1), with its audit/event after ITS commit.
  let woDone = false;
  if (parsed.data.action === "finish") {
    const after = siblings.map((s) => (s.id === sid ? { ...s, finishedAt: new Date(now) } : s));
    woDone = woComplete(after);
  }
  await prisma.$transaction(async (tx) => {
    await tx.workOrderStage.update({ where: { id: sid }, data: patch });
    // starting any stage puts a READY work order into progress
    if (parsed.data.action === "start" && stage.workOrder.state === "READY") {
      await tx.workOrder.update({ where: { id: stage.workOrderId }, data: { state: "IN_PROGRESS" } });
    }
    // finishing the last stage completes the WO
    if (woDone) {
      await tx.workOrder.update({ where: { id: stage.workOrderId }, data: { state: "DONE" } });
    }
  });

  // all of an order's WOs done ⇒ the order is READY
  let orderReady = false;
  if (woDone) {
    const orderId = stage.workOrder.orderId;
    const siblingsWo = await prisma.workOrder.findMany({ where: { orderId }, select: { state: true } }); // bounded: per-order work orders (WorkOrder.orderId indexed in FS1)
    if (siblingsWo.every((s) => s.state === "DONE")) {
      // EPO1.2 (C2) — through the ONE transition writer (legality + guard +
      // audit + event); a race that already moved the order is a clean no-op.
      const outcome = await transitionOrder({ orderId, to: "READY", via: "all-wos-done", actorId: actor!.id });
      orderReady = outcome.ok;
      if (outcome.ok) {
        // EPO.3 — the bell learns about orders (href = the ?o= contract)
        await notifyOwners({ title: `${outcome.number} is ready to ship`, body: "All work orders are done.", entityType: "order", entityId: orderId, href: `/orders?o=${orderId}`, excludeUserId: actor!.id });
      } else if (outcome.status !== 409 && outcome.status !== 422) {
        console.error("[production] order READY transition failed", orderId, outcome.error);
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
