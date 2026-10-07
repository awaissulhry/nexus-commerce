/**
 * ADS AUTONOMY — auto-undo's request (automation A19, services/advertising/ads-auto-undo.service.ts):
 *
 *   undo-worse-ad-change   puts back ONE automatic ad change auto-undo judged clearly worse (its judgementId, from
 *                          automation-detail A19 or automation-activity A19): the bid, the daily budget or the placement
 *                          goes back to what it was before that change, through the Undo's own path
 *                          (rollback.service.ts reverseJudgedWrite: compare-and-set, the ads audit, the 5-minute window
 *                          to cancel). At PROPOSE auto-undo asks for it itself; Claude may ask for one too (at OBSERVE, a
 *                          judgement it would undo). A person approves it in Nexus — never by rule (ceiling ask): what
 *                          runs alone is auto-undo at AUTO, inside its caps, which a person turned up.
 *
 * Refused, and not queued, when the change was not judged clearly worse, was undone already, waits in another request,
 * was superseded (a later write on the same entity, or its value moved), or Amazon's write gate would refuse the
 * put-back. An undo of a cut raises: it is listed in `raises` (a day-to-day change, no authenticator code), and past
 * auto-undo's own raise limit the card says so. Its writes carry the approval as their change set: undo-change of it puts
 * the engine's value back (undo-ad-change of that set, within 24 hours).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { changeSetStanding, planJudgedUndo, runJudgedUndo, AUTO_UNDO_TOOL } from '../../advertising/ads-auto-undo.service.js'
import { approvedRun, notRun, reachNote, reachRefusal, recheck, storedReach } from './ads-change-kit.js'
import { checkLiveReach } from './ads-tool-guards.js'
import { UNDO_AD_CHANGE_UNDO } from './ads-change.tools.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const LEVER_WORDS = (lever: string) => (lever === 'bid' ? 'bid' : lever === 'dailyBudget' ? 'daily budget' : `${lever.slice('placement:'.length)} placement adjustment`)
const valueWords = (lever: string, value: number) => (lever.startsWith('placement:') ? `${value} %` : `${value}`)

async function preview(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const judgementId = typeof args.judgementId === 'string' ? args.judgementId.trim() : ''
  if (!judgementId) return { ok: false, error: 'Name the auto-undo judgement to put back (judgementId, from automation-detail A19).' }
  const planned = await planJudgedUndo(judgementId, ctx?.approvalId ?? null)
  if ('error' in planned) return { ok: false, error: planned.error }
  const { judgement, restore, intent, raises } = planned.plan
  const reach = await checkLiveReach(intent)
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const what = LEVER_WORDS(restore.lever)
  const effect = `Puts the ${what} of ${restore.label} back from ${valueWords(restore.lever, restore.fromValue)} to ${valueWords(restore.lever, restore.toValue)} `
    + `(minor units of its currency; percent for a placement), the value before an automatic change by ${judgement.by} that auto-undo judged clearly worse`
    + `${judgement.why ? `: ${judgement.why}` : ''}. Through the Undo's own path, after its 5-minute window to cancel (a placement goes at once).`
  return {
    ok: true,
    preview: {
      action: AUTO_UNDO_TOOL,
      summary: `Undo an automatic ${what} change auto-undo judged clearly worse, on ${restore.label}.`,
      judgement,
      restore,
      changes: { [what]: { from: restore.fromValue, to: restore.toValue } },
      raises,
      reach: stored,
      reachNote: reachNote(stored),
      effect,
    },
  }
}

const undoWorseAdChange: AgentTool = {
  name: AUTO_UNDO_TOOL,
  title: 'Undo a worse automatic ad change',
  category: 'advertising',
  description:
    'Put back ONE automatic Amazon ad change that auto-undo (A19) judged clearly worse: an engine\'s, a rule\'s at AUTO, '
    + 'or a Claude change that ran by rule — never a person\'s own change or one a person approved. Name its judgementId '
    + '(automation-detail A19 lists the judgements, automation-activity A19 counts them). The bid, daily budget or placement '
    + 'goes back to its value before that change, through the Undo\'s own path, after its 5-minute window to cancel. '
    + 'Nothing changes until a person approves it in Nexus; it never runs by rule (auto-undo itself undoes at AUTO, inside '
    + 'its caps, once a person turned it up). Refused, and not queued, when the change was not judged clearly worse, was '
    + 'undone or superseded since (a later change on the same entity), already waits in another request, or Amazon\'s '
    + 'write gate would refuse it. Undoing a cut raises: it is listed in raises. Its writes are a change set of their own: '
    + 'undo-change of it puts the engine\'s value back.',
  input: z.object({
    judgementId: z.string().trim().min(1).max(64).describe('the auto-undo judgement to put back (id from automation-detail A19)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the approver and kept in the ads audit'),
  }),
  requires: [F.adsBidsEdit, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  restrictedFields: { fromValue: FIELDS.financialsAdspendView, toValue: FIELDS.financialsAdspendView, changes: FIELDS.financialsAdspendView },
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  // Its own writes carry its approval as their change set: undo-ad-change of it puts the engine's value back.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: UNDO_AD_CHANGE_UNDO,
  async handler(args, ctx) {
    return preview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await preview(args, ctx)
    const refusal = recheck(ctx, fresh, ['judgement', 'restore'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { judgement: { id: string }; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const out = await runJudgedUndo(p.judgement.id, { actor: run.actor, reason: run.reason, manual: run.manual, changeSetId: run.changeSetId })
    if ('error' in out) return notRun(out.error)
    return {
      ok: true,
      data: { undone: true, judgementId: p.judgement.id, actionLogId: out.actionLogId, changeSetId: run.changeSetId },
      // What undo-change of this request compares and asks for (UNDO_AD_CHANGE_UNDO: undo-ad-change of its change set).
      change: { before: { changeSetId: run.changeSetId, undid: { judgementId: p.judgement.id } }, after: await changeSetStanding(run.changeSetId) },
    }
  },
}

export const ADS_AUTO_UNDO_TOOLS: AgentTool[] = [undoWorseAdChange]
