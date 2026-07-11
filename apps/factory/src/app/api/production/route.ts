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
import { foldMovements } from "@/lib/ledger";
import { allocateByPriority } from "@/lib/production/reserve";

export const permission = PAGES.production;

export const GET = guarded(PAGES.production, async (req: NextRequest, { actor, resolved }) => {
  const p = req.nextUrl.searchParams;
  const workerView = p.get("worker") === "1" || (resolved && !resolved.isOwner && !resolved.permissions.has("financials.costs.view"));

  const stageRow = await prisma.appSetting.findUnique({ where: { key: "production.stages" } });
  const pipeline = (((stageRow?.value as { stages?: string[] } | null)?.stages ?? DEFAULT_STAGES) as string[]).filter((s) => typeof s === "string" && s.trim());

  // FS1 — the board is bounded (S-6): highest-priority 300 active WOs render;
  // the total count surfaces so nothing is silently hidden (the C-1 lesson).
  const BOARD_CAP = 300;
  const activeWhere = { state: { in: ["READY", "IN_PROGRESS", "BLOCKED"] as never[] } };
  const [wos, activeTotal] = await Promise.all([
    prisma.workOrder.findMany({
      where: activeWhere,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: BOARD_CAP,
      include: {
        order: { select: { number: true, promiseDateAt: true, party: { select: { name: true } } } },
        stages: { include: { assignee: { select: { id: true, displayName: true } } } },
      },
    }),
    prisma.workOrder.count({ where: activeWhere }),
  ]);

  // FP6 — material coverage: each WO's outstanding demand (RESERVE − RELEASE) vs
  // physical stock, greedily allocated in priority order (wos already priority-sorted).
  // FS1 — both sides fold in SQL: demand via groupBy over the WO refs (≤ cap ids),
  // stock via groupBy(materialId,type) bounded to the involved materials.
  const woIds = wos.map((w) => w.id);
  const demandSums = woIds.length
    ? await prisma.movementLedger.groupBy({ by: ["refId", "materialId", "type"], where: { refType: "WorkOrder", refId: { in: woIds }, type: { in: ["RESERVE", "RELEASE"] } }, _sum: { qty: true } })
    : [];
  const demandByWo: Record<string, Record<string, number>> = {};
  for (const m of demandSums) { const d = (demandByWo[m.refId as string] ??= {}); d[m.materialId] = (d[m.materialId] ?? 0) + (m.type === "RESERVE" ? (m._sum.qty ?? 0) : -(m._sum.qty ?? 0)); }
  const cleanDemand = (d: Record<string, number>) => Object.fromEntries(Object.entries(d).filter(([, q]) => q > 0.0001));
  const matIds = [...new Set(demandSums.map((m) => m.materialId))];
  const stockByMat: Record<string, number> = {};
  if (matIds.length) {
    const sums = await prisma.movementLedger.groupBy({ by: ["materialId", "type"], where: { materialId: { in: matIds } }, _sum: { qty: true } });
    const grouped: Record<string, { type: string; qty: number }[]> = {};
    for (const s of sums) (grouped[s.materialId] ??= []).push({ type: s.type, qty: s._sum.qty ?? 0 });
    for (const [mat, ms] of Object.entries(grouped)) stockByMat[mat] = foldMovements(ms).inStock;
  }
  const coverage = allocateByPriority(stockByMat, wos.map((w) => ({ id: w.id, demand: cleanDemand(demandByWo[w.id] ?? {}) })));
  // map short material ids → names for the UI
  const matNames = matIds.length ? Object.fromEntries((await prisma.material.findMany({ where: { id: { in: matIds } }, select: { id: true, name: true } })).map((m) => [m.id, m.name])) : {}; // bounded: children of the ≤300 board WOs

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
        coverage: coverage[wo.id]?.status ?? "OK",
        shortMaterials: (coverage[wo.id]?.short ?? []).map((m) => matNames[m] ?? m),
        column: cur ? cur.stage : "DONE",
        current: cur
          ? { id: cur.id, stage: cur.stage, status: stageStatus(cur), startedAt: cur.startedAt, pausedMs: cur.pausedMs, pausedAt: cur.pausedAt, assignee: (cur as { assignee?: { id: string; displayName: string } | null }).assignee ?? null }
          : null,
      };
    });

  const workers = await prisma.user.findMany({ where: { status: "active" }, orderBy: { displayName: "asc" }, select: { id: true, displayName: true } }); // bounded: active users ≈ team size; paged picker lands in FS3 (S-16)

  return jsonStripped({ pipeline, workOrders: cards, activeTotal, boardCap: BOARD_CAP, workers: workerView ? [] : workers, worker: !!workerView, nowIso: new Date(now).toISOString() }, resolved);
});
