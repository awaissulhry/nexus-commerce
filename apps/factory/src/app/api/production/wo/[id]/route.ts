/**
 * FP6 — one Work Order for the detail drawer: every stage with its timer + status
 * + assignee, in order. Materials/coverage (FP6.3), QC + est-vs-actual (FP6.4)
 * extend this payload. Money grain-gated.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { sortStages, stageStatus, currentStage, type StageRow } from "@/lib/production/stage-timer";

export const permission = PAGES.production;

export const GET = guarded(PAGES.production, async (_req, { params, resolved }) => {
  const { id } = await params;
  const wo = await prisma.workOrder.findUnique({
    where: { id },
    include: {
      order: { select: { number: true, party: { select: { name: true } } } },
      stages: { include: { assignee: { select: { id: true, displayName: true } } } },
    },
  });
  if (!wo) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ordered = sortStages(wo.stages as unknown as (StageRow & { assignee: unknown; scrapNotes: string | null; checklist: unknown; certCheckPassed: boolean | null })[]);
  const cur = currentStage(ordered as StageRow[]);
  const stages = ordered.map((s) => ({
    id: s.id,
    stage: s.stage,
    sort: s.sort,
    status: stageStatus(s),
    isCurrent: cur?.id === s.id,
    startedAt: s.startedAt,
    pausedMs: s.pausedMs,
    pausedAt: s.pausedAt,
    finishedAt: s.finishedAt,
    assignee: s.assignee ?? null,
    scrapNotes: (s as { scrapNotes: string | null }).scrapNotes,
  }));

  return jsonStripped({
    wo: {
      id: wo.id,
      number: wo.number,
      label: wo.label,
      orderNumber: wo.order.number,
      party: wo.order.party.name,
      priority: wo.priority,
      state: wo.state,
      blockedReason: wo.blockedReason,
      estCostCents: wo.estCostCents,
      actualCostCents: wo.actualCostCents,
      stages,
    },
  }, resolved);
});
