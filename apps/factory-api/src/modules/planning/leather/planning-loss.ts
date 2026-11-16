import { wastageOfLoss } from '@nexus/factory-domain/planning/leather/loss'
import type { Reader } from '../store'

/**
 * B-W2b-GB29 (G226; PLN-109): an accepted cutting loss reaches the plan and new quotes without a new revision. The accept
 * (./loss.ts) records the loss for planning (StyleCuttingLoss) in the same command as its draft revision's change; until a
 * revision released AFTER the decision carries it, the plan run (the order lines' explosion and the multi-level one) and a
 * quote's cost read the RELEASED revision with its leather lines' wastage replaced by the loss's (loss ÷ (100 − loss) × 100,
 * as the accept writes into the draft). A DRAFT revision (a quote of a draft, a work order's own copy) is read as it is: the
 * accept wrote the loss into the draft already. The latest decision of a style counts; a revision released after it is read as
 * it is; one with no release time (released before W2b-4) takes the loss. The leather lines are those of a HIDE-tracked
 * material, as the accept changes them.
 */

export interface PlanningLoss {
  /** The wastage the revision's leather lines are read with, by revision id (only the revisions a loss overrides). */
  readonly wastageOf: ReadonlyMap<string, string>
  /** The HIDE-tracked materials among the lines asked. */
  readonly leather: ReadonlySet<string>
}

const NONE: PlanningLoss = { wastageOf: new Map(), leather: new Set() }

/** The losses that override these revisions, and which of these materials are leather (two to three reads). */
export async function planningLossOf(db: Reader, revisionIds: readonly string[], itemIds: readonly string[]): Promise<PlanningLoss> {
  const ids = [...new Set(revisionIds.filter((id): id is string => typeof id === 'string'))]
  if (ids.length === 0) return NONE
  const revisions = await db.styleRevision.findMany({ where: { id: { in: ids }, status: 'RELEASED' }, select: { id: true, styleId: true, releasedAt: true } })
  if (revisions.length === 0) return NONE
  const losses = await db.styleCuttingLoss.findMany({ where: { styleId: { in: [...new Set(revisions.map((row) => row.styleId))] } }, select: { styleId: true, lossPct: true, decidedAt: true }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }] })
  if (losses.length === 0) return NONE
  const latest = new Map<string, (typeof losses)[number]>()
  for (const loss of losses) if (!latest.has(loss.styleId)) latest.set(loss.styleId, loss)
  const wastageOf = new Map<string, string>()
  for (const revision of revisions) {
    const loss = latest.get(revision.styleId)
    if (!loss) continue
    if (revision.releasedAt !== null && revision.releasedAt.getTime() >= loss.decidedAt.getTime()) continue
    wastageOf.set(revision.id, wastageOfLoss(loss.lossPct.toString()))
  }
  if (wastageOf.size === 0) return NONE
  const wanted = [...new Set(itemIds)]
  const leather = new Set(wanted.length === 0 ? [] : (await db.item.findMany({ where: { id: { in: wanted }, tracking: 'HIDE' }, select: { id: true } })).map((row) => row.id))
  return { wastageOf, leather }
}

/** A revision's lines with its leather lines' wastage replaced by the loss for planning (unchanged when none overrides it). */
export function withPlanningLoss<Line extends { readonly itemId: string; readonly wastagePct: string }>(loss: PlanningLoss, revisionId: string, lines: readonly Line[]): Line[] {
  const wastagePct = loss.wastageOf.get(revisionId)
  if (wastagePct === undefined) return [...lines]
  return lines.map((line) => (loss.leather.has(line.itemId) ? { ...line, wastagePct } : line))
}
