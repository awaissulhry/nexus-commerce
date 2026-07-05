/**
 * FP6 — the production board: the active Work Orders, each placed at its current
 * stage (first unfinished), with that stage's live timer fields so the client
 * can tick. `?worker=1` (or a WORKER caller) gets the cost-blind my-queue —
 * money is stripped by the grain filter either way. Coverage traffic lights
 * arrive in FP6.3.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { DEFAULT_STAGES } from "@/lib/orders/production";
import { currentStage, stageStatus, sortStages, type StageRow } from "@/lib/production/stage-timer";

export const permission = PAGES.production;

export const GET = guarded(PAGES.production, async (req: NextRequest, { actor, resolved }) => {
  const p = req.nextUrl.searchParams;
  const workerView = p.get("worker") === "1" || (resolved && !resolved.isOwner && !resolved.permissions.has("financials.costs.view"));

  const stageRow = await prisma.appSetting.findUnique({ where: { key: "production.stages" } });
  const pipeline = (((stageRow?.value as { stages?: string[] } | null)?.stages ?? DEFAULT_STAGES) as string[]).filter((s) => typeof s === "string" && s.trim());

  const wos = await prisma.workOrder.findMany({
    where: { state: { in: ["READY", "IN_PROGRESS", "BLOCKED"] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: {
      order: { select: { number: true, promiseDateAt: true, party: { select: { name: true } } } },
      stages: { include: { assignee: { select: { id: true, displayName: true } } } },
    },
  });

  const now = Date.now();
  const cards = wos
    .filter((wo) => (workerView ? wo.state !== "BLOCKED" : true)) // worker sees only workable WOs (my-queue narrows in FP6.5)
    .map((wo) => {
      const stages = sortStages(wo.stages as unknown as (StageRow & { assignee: { id: string; displayName: string } | null })[]);
      const cur = currentStage(stages);
      const doneCount = stages.filter((s) => s.finishedAt).length;
      return {
        id: wo.id,
        number: wo.number,
        label: wo.label,
        orderNumber: wo.order.number,
        party: wo.order.party.name,
        priority: wo.priority,
        promiseDateAt: wo.order.promiseDateAt,
        state: wo.state,
        blockedReason: wo.blockedReason,
        estCostCents: wo.estCostCents,
        stageCount: stages.length,
        doneCount,
        column: cur ? cur.stage : "DONE",
        current: cur
          ? { id: cur.id, stage: cur.stage, status: stageStatus(cur), startedAt: cur.startedAt, pausedMs: cur.pausedMs, pausedAt: cur.pausedAt, assignee: (cur as { assignee?: { id: string; displayName: string } | null }).assignee ?? null }
          : null,
      };
    });

  const workers = await prisma.user.findMany({ where: { status: "active" }, orderBy: { displayName: "asc" }, select: { id: true, displayName: true } });

  return jsonStripped({ pipeline, workOrders: cards, workers: workerView ? [] : workers, worker: !!workerView, nowIso: new Date(now).toISOString() }, resolved);
});
