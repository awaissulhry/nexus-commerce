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
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { runStageAction } from "@/lib/production/stage-action";

export const permission = { POST: FEATURES.workordersAdvance, PATCH: FEATURES.workordersAssign };

const Act = z.object({ action: z.enum(["start", "pause", "resume", "finish"]) });

export const POST = guarded(FEATURES.workordersAdvance, async (req, { params, actor }) => {
  const { sid } = await params;
  const parsed = Act.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "action required" }, { status: 400 });

  // P12 — the stage moves in src/lib/production/stage-action.ts (Claude's factory-advance-work-order too).
  const result = await runStageAction({ stageId: sid, action: parsed.data.action, actorId: actor!.id });
  if (!result.ok) return NextResponse.json(result.body, { status: result.status });
  const { woDone, orderReady } = result;
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
