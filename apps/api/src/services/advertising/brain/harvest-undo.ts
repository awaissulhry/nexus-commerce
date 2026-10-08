/**
 * ONE BRAIN AB-15 — auto-undo's side of a harvest (AB-11, brain/harvest*.ts; Owner 2026-10-08 ~19:20 UTC: the harvest's
 * safety net — "judge after window + 72 h, auto-undo restores the source"). AB-11 judges each harvest pair after its
 * attribution window + 72 hours (judgeHarvest) and, where its lever may write, asks a person for the undo
 * (apply-brain-harvest op undo). Auto-undo reads the WORSE judgements and acts at ITS own level:
 *
 *   OBSERVE  records that it would undo the pair; nothing changes
 *   PROPOSE  stands on AB-11's own request for the pair (one per harvest: a waiting one is the request)
 *   AUTO     puts the pair back itself — every source negative retired, then the keyword paused (AB-11's own undoHarvest,
 *            a pair: both halves asked of the gate first), as auto-undo through the mutation layer and the retire path — and
 *            marks the harvest UNDONE: the term then waits AB-11's cooldown (GRADUATION_COOLDOWN_DAYS) before the brain
 *            decides it again. That cooldown is the hold. Batch 2 fix — AB-11's own undo request for the same harvest that
 *            still waits for a person is withdrawn with it (one undo, never two), and a harvest a person's approved undo put
 *            back meanwhile is not put back again.
 *
 * A harvest a person declined to undo (undoDeclined) is left as he decided; one already UNDONE is not read. Read in the
 * business of the call.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import type { HarvestUndoFact, HarvestUndoProvider } from './undo-run.js'

/** The reason AB-11's own waiting undo request carries when auto-undo put the harvest back first (approval.tools reads `withdrawn:`). */
export const UNDONE_BY_AUTO_UNDO = 'withdrawn: auto-undo put the harvest back first'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})

export const harvestUndo: HarvestUndoProvider = {
  async judged(since: Date): Promise<HarvestUndoFact[]> {
    const rows = await prisma.adsBrainHarvest.findMany({
      where: { verdict: 'WORSE', judgedAt: { gte: since }, status: { in: ['DONE', 'HALF_DONE', 'UNDO_PROPOSED'] }, keywordTargetId: { not: null } },
      select: { id: true, productId: true, marketplace: true, destCampaignId: true, term: true, landedAt: true, judgedAt: true, judgement: true },
      orderBy: [{ judgedAt: 'asc' }, { id: 'asc' }],
      take: 500,
    })
    return rows
      .filter((r) => obj(r.judgement).undoDeclined !== true)
      .map((r) => ({
        id: r.id, productId: r.productId, market: r.marketplace, campaignId: r.destCampaignId, term: r.term,
        landedAt: r.landedAt ?? r.judgedAt ?? new Date(0), verdict: 'WORSE' as const,
        why: typeof obj(r.judgement).why === 'string' ? (obj(r.judgement).why as string) : 'AB-11 judged the harvest worse after its window',
      }))
  },

  async undo(id, run) {
    try {
      const before = await prisma.adsBrainHarvest.findUnique({ where: { id }, select: { status: true } })
      if (!before) return { ok: false, reason: `harvest ${id} is no longer in Nexus` }
      if (before.status === 'UNDONE') return { ok: false, reason: 'it was put back already (a person\'s approved undo ran first)' }
      const { HARVEST_TOOL, undoHarvest } = await import('./harvest-write.js')
      const out = await undoHarvest(id, { actor: run.actor, manual: false, changeSetId: null, reason: run.reason.slice(0, 480) })
      if (!out.paused && !out.retired) return { ok: false, reason: `nothing of the harvest was put back${out.problems.length ? `: ${out.problems.join('; ')}` : ''}` }
      const done = [out.retired ? `${out.retired} source negative${out.retired === 1 ? '' : 's'} retired` : '', out.paused ? 'the keyword paused' : ''].filter(Boolean).join(', ')
      const now = new Date()
      await prisma.adsBrainHarvest.update({
        where: { id },
        data: { status: 'UNDONE', why: `put back by auto-undo: ${done}`, lastError: out.problems.length ? out.problems.join('; ').slice(0, 2000) : null, changedAt: now },
      })
      // Batch 2 fix — AB-11's own undo request for this harvest that still waits is withdrawn: one undo, never two.
      await prisma.agentApproval.updateMany({
        where: { toolName: HARVEST_TOOL, status: { in: ['pending', 'scheduled'] }, AND: [{ args: { path: ['harvestId'], equals: id } }, { args: { path: ['op'], equals: 'undo' } }] },
        data: { status: 'rejected', reason: UNDONE_BY_AUTO_UNDO, decidedAt: now },
      })
      return { ok: true, actionLogId: out.actionLogIds?.[0] ?? null }
    } catch (err) {
      logger.warn('[ads-auto-undo] a harvest undo failed', { harvestId: id, error: String(err).slice(0, 200) })
      return { ok: false, reason: `the undo failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` }
    }
  },

  async propose(id, why) {
    const { proposeUndo } = await import('./harvest-write.js')
    return proposeUndo(id, why)
  },

  async isUndone(id) {
    const r = await prisma.adsBrainHarvest.findUnique({ where: { id }, select: { status: true } })
    return r?.status === 'UNDONE'
  },
}
