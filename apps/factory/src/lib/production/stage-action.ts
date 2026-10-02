/**
 * FP6 — run a stage: start, pause, resume or finish one work-order stage through the pure stage-timer. Forward-only
 * floor: a stage can only start once every earlier stage is finished; finishing the last stage completes the Work
 * Order, and when every work order of the order is done the order becomes READY. QC can't finish without a valid
 * certificate (FD14). FS4 (C-3) — stage patch + implied WO state are one short transaction.
 *
 * P12 (MCP full control): moved verbatim from POST /api/production/stages/:sid so Claude's `factory-advance-work-order`
 * moves a stage exactly as the floor does. Returns the route's answer (status and body) when refused.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { publishEventDurable } from "@/lib/events";
import { start, pause, resume, finish, canStart, woComplete, type StageRow } from "@/lib/production/stage-timer";
import { certGateForWorkOrder, CERT_BLOCK_MESSAGE } from "@/lib/production/cert-gate";
import { transitionOrder } from "@/lib/orders/transition-service";
import { notifyOwners } from "@/lib/quotes/notify-owners";

export type StageAction = "start" | "pause" | "resume" | "finish";
const TRANSITION = { start, pause, resume, finish } as const;

export type StageActionResult =
  | { ok: true; woDone: boolean; orderReady: boolean; stage: string; workOrderId: string }
  | { ok: false; status: number; body: { error: string; code?: string } };

export async function runStageAction({ stageId, action, actorId }: { stageId: string; action: StageAction; actorId: string }): Promise<StageActionResult> {
  const stage = await prisma.workOrderStage.findUnique({ where: { id: stageId }, include: { workOrder: { include: { stages: true } } } });
  if (!stage) return { ok: false as const, status: 404, body: { error: "Not found" } };
  const siblings = stage.workOrder.stages as unknown as StageRow[];

  if (action === "start" && !canStart(siblings, stageId)) {
    return { ok: false as const, status: 400, body: { error: "Finish the earlier stages first" } };
  }

  // FD14 — the EN 17092 cert gate: QC can't finish (into Packing) without a valid cert
  if (action === "finish" && stage.stage === "QC") {
    const cs = await certGateForWorkOrder(stage.workOrderId, Date.now());
    if (cs === "missing" || cs === "expired") return { ok: false as const, status: 422, body: { error: CERT_BLOCK_MESSAGE[cs], code: "cert_blocked" } };
  }

  const now = Date.now();
  const patch = TRANSITION[action](stage, now);
  if (!patch) return { ok: false as const, status: 400, body: { error: `Can't ${action} this stage now` } };

  // FS4 (C-3) — the stage-timer patch and the WO state it implies commit as
  // ONE short transaction: a crash can no longer finish the last stage while
  // the work order stays IN_PROGRESS (or start a stage on a WO still READY).
  // The order READY promotion stays OUTSIDE — it is transitionOrder's own
  // guarded transaction (EPO.1), with its audit/event after ITS commit.
  let woDone = false;
  if (action === "finish") {
    const after = siblings.map((s) => (s.id === stageId ? { ...s, finishedAt: new Date(now) } : s));
    woDone = woComplete(after);
  }
  await prisma.$transaction(async (tx) => {
    await tx.workOrderStage.update({ where: { id: stageId }, data: patch });
    // starting any stage puts a READY work order into progress
    if (action === "start" && stage.workOrder.state === "READY") {
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
      const outcome = await transitionOrder({ orderId, to: "READY", via: "all-wos-done", actorId: actorId });
      orderReady = outcome.ok;
      if (outcome.ok) {
        // EPO.3 — the bell learns about orders (href = the ?o= contract)
        await notifyOwners({ title: `${outcome.number} is ready to ship`, body: "All work orders are done.", entityType: "order", entityId: orderId, href: `/orders?o=${orderId}`, excludeUserId: actorId });
      } else if (outcome.status !== 409 && outcome.status !== 422) {
        console.error("[production] order READY transition failed", orderId, outcome.error);
      }
    }
  }

  void audit({ actorId: actorId, entityType: "workorder", entityId: stage.workOrderId, action: `stage.${action}`, after: { stage: stage.stage, woDone } });
  await publishEventDurable("workorder.updated", { workOrderId: stage.workOrderId, stage: stage.stage, action: action, woDone });
  return { ok: true, woDone, orderReady, stage: stage.stage, workOrderId: stage.workOrderId };
}
