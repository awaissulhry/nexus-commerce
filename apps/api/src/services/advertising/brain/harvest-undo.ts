/**
 * Batch 2 fix — AB-11's side of auto-undo's harvest pass (Owner 10-08 ~19:20 UTC: harvest = industry best practice plus
 * the safety net — judged after the attribution window + 72 h, auto-undo restores the source). AB-15's auto-undo
 * (brain/undo-run.ts on its own branch) reads the brain's harvest judgements through a provider it is handed with
 * `registerHarvestUndo(...)`; this is that provider, shaped exactly as its HarvestUndoProvider. The one line that hands it
 * over lives with the registrations once both branches are in one tree (not on this branch: undo-run.ts is not here).
 *
 *   judged     the pairs the brain wrote itself at AUTO (no approval: a pair a person approved is his, and AB-11's own
 *              judgement asks him for its undo), landed since `since`, with AB-11's verdict (WORSE · KEPT · WAITING) and
 *              its words; the destination campaign names the kill switch and the label
 *   undo       the pair put back as a pair, as auto-undo's actor (a safety owner at the gate): the source negatives retired,
 *              then the keyword paused (harvest-write.ts undoHarvest — both halves asked of the gate first); the harvest
 *              marked UNDONE with what landed, and AB-11's own undo request still waiting is withdrawn (one undo, not two)
 *   propose    AB-11's undo request (apply-brain-harvest op undo): one per harvest, the waiting one answered again
 *   isUndone   the harvest is UNDONE
 */
import prisma from '../../../db.js'
import { markUndone } from './harvest-request.js'
import { proposeUndo, undoHarvest } from './harvest-write.js'

/** One harvest pair the brain made that AB-11 judged, as auto-undo reads it (AB-15 HarvestUndoFact). */
export interface HarvestUndoFact {
  id: string
  productId: string
  market: string
  campaignId: string | null
  term: string
  landedAt: Date
  verdict: 'WORSE' | 'KEPT' | 'WAITING'
  why: string
}

/** AB-11's side of a harvest undo (AB-15 HarvestUndoProvider). */
export interface HarvestUndoSide {
  judged(since: Date): Promise<HarvestUndoFact[]>
  undo(id: string, run: { actor: string; reason: string }): Promise<{ ok: true; actionLogId: string | null } | { ok: false; reason: string }>
  propose(id: string, why: string): Promise<{ approvalId: string } | { error: string }>
  isUndone(id: string): Promise<boolean>
}

/** The reason AB-11's own waiting undo request carries when auto-undo put the harvest back first. */
export const UNDONE_BY_AUTO_UNDO = 'withdrawn: auto-undo put the harvest back first'

const verdictOf = (v: string | null): HarvestUndoFact['verdict'] => (v === 'WORSE' || v === 'KEPT' ? v : 'WAITING')

export const harvestUndoProvider: HarvestUndoSide = {
  async judged(since) {
    const rows = await prisma.adsBrainHarvest.findMany({
      where: { approvalId: null, landedAt: { gte: since }, status: { in: ['DONE', 'HALF_DONE', 'UNDO_PROPOSED', 'UNDONE'] } },
      select: { id: true, productId: true, marketplace: true, destCampaignId: true, term: true, landedAt: true, verdict: true, judgement: true, why: true },
      orderBy: { landedAt: 'asc' },
    })
    return rows.map((r) => ({
      id: r.id, productId: r.productId, market: r.marketplace, campaignId: r.destCampaignId ?? null, term: r.term, landedAt: r.landedAt!,
      verdict: verdictOf(r.verdict), why: String(((r.judgement ?? {}) as { why?: unknown }).why ?? r.why),
    }))
  },

  async undo(id, run) {
    const before = await prisma.adsBrainHarvest.findUnique({ where: { id }, select: { status: true, undoApprovalId: true } })
    if (!before) return { ok: false, reason: `harvest ${id} is no longer in Nexus` }
    if (before.status === 'UNDONE') return { ok: false, reason: 'it was put back already' }
    const u = await undoHarvest(id, { actor: run.actor, manual: false, changeSetId: null, reason: run.reason })
    if (!u.paused && !u.retired) return { ok: false, reason: u.complete ? 'nothing of it stands any more' : u.problems.join('; ') || 'nothing was put back' }
    await markUndone(id, { approvalId: null, by: 'auto-undo', paused: u.paused, retired: u.retired, problems: u.problems, now: new Date() })
    if (before.undoApprovalId) {
      await prisma.agentApproval.updateMany({ where: { id: before.undoApprovalId, status: 'pending' }, data: { status: 'rejected', reason: UNDONE_BY_AUTO_UNDO, decidedAt: new Date() } })
    }
    return { ok: true, actionLogId: u.actionLogIds[0] ?? null }
  },

  async propose(id, why) {
    return proposeUndo(id, why)
  },

  async isUndone(id) {
    const r = await prisma.adsBrainHarvest.findUnique({ where: { id }, select: { status: true } })
    return r?.status === 'UNDONE'
  },
}
