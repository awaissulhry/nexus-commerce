/**
 * BID BRAIN BB-6 — `set-bid-brain-enrollment`: put one Amazon campaign under the bid brain (LIVE: the brain becomes its
 * one bid writer), hold it, release it, take it back to shadow, or give it back (its bids and placements as they were
 * when it went LIVE). The rules of each op are in bid-brain/enrollment.ts.
 *
 * THE OWNER'S CODE RULE (ads-code-rule.ts) — going LIVE is a big door (a new writer starts spending decisions on the
 * campaign): approving it needs the approver's authenticator code. A hold and the way back to shadow are brakes; a
 * release and a give-back are day-to-day (they can raise bids, and the card lists them). Every op waits for a person:
 * this tool never runs by rule (ceiling ask).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { updateAdGroupWithSync, updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { giveBackStopMemory } from '../../advertising/bid-brain/stop-memory.js'
import { updatePlacementBidding } from '../../advertising/ads-create.service.js'
import { recordCampaignBidsChoice } from '../../advertising/brain/enrollment.js'
import {
  DEFAULT_HOLD_DAYS, ENROLL_OPS, enrollRefusal as refusalOf, enrollmentBasis, enrollmentFacts, giveBackAgain, giveBackPlan, nextMode, PLANS_JOIN_THE_BRAIN, readSnapshot,
  setEnrollment, type EnrollMode, type EnrollOp,
} from '../../advertising/bid-brain/enrollment.js'
import { STEP_UP_NEEDS, type StepUp } from '../step-up-approval.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { ADDS_NO_SPEND, codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const TOOL = 'set-bid-brain-enrollment'
// Batch 2 fix — its ceiling is ask: never confirmed in Claude, so the card names only the Approvals page.
const BIG_DOOR_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code.'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** BB-7 — an hourly plan joins as the brain's input instead of blocking LIVE (held in bid-brain/enrollment.ts since AB-1). */
export { PLANS_JOIN_THE_BRAIN }

function stepUpFor(op: EnrollOp, name: string): { stepUp?: StepUp } {
  if (op !== 'live' || !needsCode('set-bid-brain-enrollment: live')) return {}
  return { stepUp: { what: `puts ${name} under the bid brain (it becomes the campaign's one bid writer)`, raises: ['Bid writer'], needs: STEP_UP_NEEDS, how: BIG_DOOR_HOW } }
}

async function preview(args: Record<string, unknown>): Promise<ToolResult> {
  const campaignId = String(args.campaignId ?? '')
  const op = (ENROLL_OPS as readonly string[]).includes(String(args.op)) ? (args.op as EnrollOp) : 'live'
  const f = await enrollmentFacts(campaignId, { plansJoin: PLANS_JOIN_THE_BRAIN, checkOwnerBrake: op === 'live' || op === 'release' })
  if (!f) return { ok: false, error: `campaign ${campaignId} not found` }
  const refusal = refusalOf(f, op)
  if (refusal) return { ok: false, error: refusal }
  const from = f.enrollment?.mode ?? null
  // AB-2 follow-up — a give-back run again from shadow (its placement write was refused; the saved lanes kept): stays SHADOW.
  const again = op === 'give-back' && giveBackAgain(f)
  const to = again ? 'SHADOW' : (nextMode(op, from) as { to: EnrollMode }).to
  const c = f.campaign
  const warnings: string[] = []
  if (f.ceiling !== 'live' && (to === 'LIVE' || to === 'HELD')) warnings.push(`The server switch NEXUS_BID_BRAIN_MODE is ${f.ceiling}: the brain owns ${c.name} only once that switch is live; until then it stays in shadow and today's engines keep writing.`)
  if (c.status !== 'ENABLED' && to === 'LIVE') warnings.push(`${c.name} is ${c.status.toLowerCase()}: the brain writes nothing while it does not run.`)
  if (c.pinBids && to === 'LIVE') warnings.push(`${c.name}'s bids are pinned by hand: the brain leaves pinned bids alone until the pin is lifted.`)
  const back = op === 'give-back' && f.enrollment?.snapshot ? await giveBackPlan(c.id, f.enrollment.snapshot) : null
  const holdDays = op === 'hold' ? Math.max(1, Math.min(60, Number(args.holdDays ?? DEFAULT_HOLD_DAYS))) : null
  // AB-2 — what a stop's memory still owes the campaign: op shadow and op live give it back (as the approver) before the
  // campaign changes hands; give-back puts the LIVE-time placements back itself and the saved strategy from the memory.
  const owed = op === 'shadow' || op === 'live' ? f.stopMemory ?? null : null
  const owedBack = owed ? ` First it puts back what a stop saved, as the person who approves it: ${[owed.lanes ? 'the placements it set to 0 %' : '', owed.strategy ? `the bidding strategy, ${owed.savedStrategy === 'AUTO_FOR_SALES' ? 'up and down' : owed.savedStrategy} (it is down only now)` : ''].filter(Boolean).join(' and ')}.` : ''
  // AB-2 — up and down given back is a raise of its own (Amazon may then lift a bid up to +100 %), said apart.
  const upAndDown = back?.biddingStrategy?.to === 'AUTO_FOR_SALES' || (owed?.strategy && owed.savedStrategy === 'AUTO_FOR_SALES') ? 1 : 0
  const bidRaises = (back?.raises ?? 0) - (back?.biddingStrategy?.to === 'AUTO_FOR_SALES' ? 1 : 0)
  const raises = [
    ...(bidRaises ? [`${plural(bidRaises, 'bid or placement')} back up to ${bidRaises === 1 ? 'its' : 'their'} value when the campaign went LIVE`] : []),
    ...(owed?.lanes ? ['the placements a stop set to 0 % back to their value before it'] : []),
    ...(upAndDown ? ['the bidding strategy back to up and down (Amazon may raise a bid up to +100 %)'] : []),
    ...(op === 'release' ? ['the brain may raise bids again'] : []),
  ]
  const effect = {
    live: `Puts ${c.name} (${c.market ?? c.marketplace ?? '?'}) under the bid brain: from its next run it is the campaign's one bid writer — keyword bids toward the goal at most once per new data day, inside the limits; auto-bid, rules and other engines leave the campaign, and a person's own edit still passes and holds that bid. Every bid and placement is kept now for a give-back.${owedBack}`,
    shadow: `Takes ${c.name} back to shadow: the brain stops writing; every bid stays where it is and today's engines resume. When its product is enrolled in the brain, this is kept as a campaign choice there (the product's bids lever leaves it in shadow).${owedBack}`,
    'give-back': `${again ? `Runs the give-back of ${c.name} again (its placements were not restored the last time; it is in shadow already) and puts back` : `Takes ${c.name} back to shadow and puts back`} what it held when it went LIVE: ${plural(back?.targets.length ?? 0, 'keyword bid')}, ${plural(back?.adGroups.length ?? 0, 'ad group default bid')}${back?.placements ? ' and its placements' : ''}${back?.biddingStrategy ? `, and the bidding strategy a stop switched to down only back to ${back.biddingStrategy.to === 'AUTO_FOR_SALES' ? 'up and down' : back.biddingStrategy.to}` : ''}, as the person who approves it.`,
    hold: `Holds ${c.name} for ${plural(holdDays ?? DEFAULT_HOLD_DAYS, 'day')}: the brain raises no bid (a stop still lowers); then it runs again.`,
    release: `Releases the hold on ${c.name}: the brain runs it again, raises included.`,
  }[op]
  const code = stepUpFor(op, c.name)
  return {
    ok: true,
    preview: {
      action: TOOL,
      op,
      campaign: { id: c.id, name: c.name, market: c.market, marketplace: c.market ?? c.marketplace, status: c.status },
      enrollment: { from, to },
      ...(again ? { giveBackAgain: true } : {}),
      basis: enrollmentBasis(f),
      ceiling: f.ceiling,
      ...(holdDays ? { holdDays } : {}),
      ...(back ? { giveBack: { keywordBids: back.targets.length, adGroupBids: back.adGroups.length, placements: !!back.placements, ...(back.biddingStrategy ? { biddingStrategy: back.biddingStrategy } : {}), raises: back.raises } } : {}),
      raises,
      ...(warnings.length ? { warnings } : {}),
      ...code,
      ...(code.stepUp ? {} : { noCode: raises.length ? DAY_TO_DAY_NO_CODE : ADDS_NO_SPEND }),
      reachNote: op === 'give-back' ? `It writes bids${back?.biddingStrategy ? ', placements and the bidding strategy' : ' and placements'} at Amazon (the write gate judges each).`
        : owed ? `It writes ${[owed.lanes ? 'the placements' : '', owed.strategy ? 'the bidding strategy' : ''].filter(Boolean).join(' and ')} a stop saved at Amazon (the write gate judges each); the rest is Nexus only.`
          : 'Nexus only: nothing is sent to Amazon by this change; the brain\'s own runs write afterwards.',
      effect: `${effect}${code.stepUp ? ' A new bid writer going live: approving it needs the approver\'s authenticator code.' : ''}`,
    },
  }
}

/** Put the snapshot back, as the person who approved it (the write gate judges each write). Also set-ads-brain op leave's give-back. */
export async function putBack(campaignId: string, plan: Awaited<ReturnType<typeof giveBackPlan>>, run: { actor: `user:${string}` | `automation:${string}`; reason: string; changeSetId: string; manual: boolean; confirmOwnLimits: boolean }) {
  let sent = 0
  const refused: string[] = []
  const common = { actor: run.actor, reason: `bid brain give-back — ${run.reason}`.slice(0, 480), changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, applyImmediately: true }
  for (const t of plan.targets) {
    const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: t.toCents }, force: true, ...common })
    if (r.ok) sent++
    else if (refused.length < 3) refused.push(r.error ?? 'refused')
  }
  for (const g of plan.adGroups) {
    const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: g.toCents }, force: true, ...common })
    if (r.ok) sent++
    else if (refused.length < 3) refused.push(r.error ?? 'refused')
  }
  let placementsRefused: string | null = null
  if (plan.placements) {
    const r = await updatePlacementBidding({ campaignId, adjustments: plan.placements.to, actor: run.actor, reason: common.reason, changeSetId: run.changeSetId, manual: run.manual }) as { mode?: string; reason?: string }
    if (r.mode !== 'blocked') sent++
    else {
      placementsRefused = r.reason ?? 'placements refused'
      if (refused.length < 3) refused.push(placementsRefused)
    }
  }
  // AB-2 — the bidding strategy a stop switched to down only back to what it was (the campaign write the screens use), and
  // the stop's memory cleared: the LIVE-time placements above stand for its saved lanes — cleared only once they were sent
  // (or none had to be). AB-2 follow-up — a refused placement write keeps the saved lanes (owed), so the give-back can run
  // again and the restore path still finds them: the lanes are never left at 0 % with nothing to bring them back.
  const memory = await giveBackStopMemory(campaignId, { actor: run.actor, reason: common.reason, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, lanes: placementsRefused ? 'keep' : false })
  sent += memory.sent
  for (const r of memory.refused) if (refused.length < 3) refused.push(r)
  return { sent, refused, ...(placementsRefused ? { placementsNotRestored: `placements not restored: ${placementsRefused} — the lanes a stop saved are kept; run give-back again` } : {}) }
}

const setBidBrainEnrollment: AgentTool = {
  name: TOOL,
  title: 'Put a campaign under the bid brain',
  input: z.object({
    campaignId: z.string().trim().min(1).max(64).describe('Nexus campaign id (campaignId in ad-campaigns)'),
    op: z.enum(ENROLL_OPS).describe('live: the brain becomes the campaign\'s one bid writer (a big door: the approver\'s code); shadow: back to shadow, bids stay; give-back: back to shadow and its bids and placements as they were when it went LIVE; hold: the brain raises nothing for holdDays; release: end a hold'),
    holdDays: z.coerce.number().int().min(1).max(60).optional().describe('hold: how many days (default 7)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
  }),
  requires: [F.adsCampaignsManage, F.adsAutomationManage],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  // A give-back writes bids at Amazon, and a LIVE campaign's bids are then written by the brain.
  openWorld: true,
  // The mode always goes back; bids a give-back put back are not taken again by its undo.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const campaignId = String((change.after as { campaignId?: unknown } | null)?.campaignId ?? '')
      const row = await prisma.bidBrainEnrollment.findFirst({ where: { campaignId }, select: { mode: true } })
      return { campaignId, mode: row?.mode ?? null }
    },
    request(change) {
      const before = (change.before ?? {}) as { campaignId?: string; mode?: string | null }
      const after = (change.after ?? {}) as { mode?: string | null }
      if (!before.campaignId) return { refusal: 'This change does not record the campaign it changed.' }
      const was = before.mode ?? 'SHADOW'
      const op: EnrollOp = was === 'SHADOW' ? 'shadow' : was === 'HELD' ? 'hold' : after.mode === 'HELD' ? 'release' : 'live'
      return { tool: TOOL, args: { campaignId: before.campaignId, op, why: 'undo of an earlier bid brain enrollment change' } }
    },
  },
  description:
    'Put one Amazon Sponsored Products campaign under the bid brain, or change its place there. op live: the brain becomes '
    + 'the campaign\'s one bid writer (from its next run; while the server switch NEXUS_BID_BRAIN_MODE is live) — keyword '
    + 'bids toward the goal at most once per new data day, inside the limits; auto-bid, rules and other engines leave the '
    + 'campaign, and a person\'s own edit still passes and holds that bid. Every bid and placement is kept for a give-back. '
    + 'Going LIVE is a big door: approving it needs the approver\'s authenticator code. op hold: the brain raises nothing for '
    + 'some days; op release ends a hold; op shadow: the brain stops, bids stay (what a stop saved — its placements, its '
    + 'bidding strategy — goes back); op give-back: back to shadow and the bids '
    + 'and placements put back as they were when it went LIVE. LIVE (and release) needs the campaign not kept off the bid brain by '
    + 'the Owner in its product\'s brain (an exclusion or a lock of its bids), on the live-write allowlist, its '
    + 'bids serving (not held at a floor), and no classic dayparting schedule, running autopilot plan or older family rank '
    + 'plan on it; its hourly bid plan joins the brain (each hour\'s placement % and Min-bid floors, inside the brain\'s '
    + 'limits) unless an hour sets a base bid. A person approves every op in Nexus (never confirmed in this chat, '
    + 'never by rule); nothing changes until then.',
  async handler(args) {
    return preview(args)
  },
  async execute(args, ctx: ToolContext) {
    const fresh = await preview(args)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as { op: EnrollOp; campaign: { id: string; name: string; market: string | null }; enrollment: { from: EnrollMode | null; to: EnrollMode }; giveBackAgain?: boolean; basis: string; holdDays?: number; effect: string }
    const again = p.op === 'give-back' && p.giveBackAgain === true
    const approved = ctx.approvedPreview as { basis?: unknown } | undefined
    if (approved?.basis && approved.basis !== p.basis) return notRun(`Not run: ${p.campaign.name}'s place in the bid brain changed since it was approved. Nothing changed.`)
    const gate = await codeGate(ctx, fresh.preview)
    if ('refusal' in gate) return notRun(gate.refusal)
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const campaign = await prisma.campaign.findFirst({ where: { id: p.campaign.id }, select: { marketplace: true } })
    // AB-1 review — a campaign moved by hand is recorded in its product's brain (a campaign override of the bids lever),
    // so a product re-apply or the cycle never undoes it. Hold and release change no level.
    //   live              the move and its record go together, in one transaction, or not at all
    //   shadow, give-back the Owner's way back out ALWAYS runs: the mode flips and the bids come back whatever the record
    //                     does; a record that fails is logged and named in the result, never a reason to keep it LIVE
    const marketplace = p.campaign.market ?? campaign?.marketplace ?? ''
    const move = () => setEnrollment({ campaignId: p.campaign.id, marketplace, op: p.op, by: run.actor, holdDays: p.holdDays ?? null, reason: run.reason })
    const record = (level: 'AUTO' | 'OBSERVE') => recordCampaignBidsChoice({ campaignId: p.campaign.id, level, by: run.actor, reason: `set-bid-brain-enrollment op ${p.op}: ${run.reason}` })
    const warnings: string[] = []
    let set: Awaited<ReturnType<typeof setEnrollment>>
    // AB-2 — what a stop's memory still owes the campaign goes back before it changes hands: op live first (refused while
    // any of it is still owed, so it is never dropped unseen), op shadow just after (the brain no longer runs it).
    const memoryBack = () => giveBackStopMemory(p.campaign.id, { actor: run.actor, reason: `bid brain op ${p.op} — ${run.reason}`, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits })
    let gaveMemory: Awaited<ReturnType<typeof giveBackStopMemory>> | null = null
    // AB-2 follow-up — an op live that gave something back first says so when it then stops: never "nothing changed".
    const givenFirst = (g: { given: string[] } | null) => (g?.given.length ? ` What a stop saved was given back first, as the approver: ${g.given.join(' and ')}.` : ' Nothing changed.')
    if (p.op === 'live') {
      gaveMemory = await memoryBack()
      if (gaveMemory.owed) return notRun(`Not run: ${p.campaign.name} still holds what a stop saved, and it could not all be put back (${gaveMemory.refused.join('; ')}). ${p.campaign.name} is not LIVE.${givenFirst(gaveMemory)}`)
      try {
        set = await inDatabaseTransaction(prisma, async () => {
          const moved = await move()
          await record('AUTO')
          return moved
        }, { isolationLevel: 'Serializable' })
      } catch (e) {
        return notRun(`Not run: ${(e as Error).message}. ${p.campaign.name} is not LIVE.${givenFirst(gaveMemory)}`)
      }
    } else if (again) {
      // AB-2 follow-up — the give-back again: the campaign is in shadow already; only the put-back runs.
      set = { from: 'SHADOW', to: 'SHADOW', snapshot: null }
    } else {
      set = await move()
      if (p.op === 'shadow' || p.op === 'give-back') {
        try {
          await inDatabaseTransaction(prisma, () => record('OBSERVE'), { isolationLevel: 'Serializable' })
        } catch (e) {
          const message = (e as Error).message
          logger.warn('[bid-brain] op ran; its record in the product\'s brain failed', { campaignId: p.campaign.id, op: p.op, error: message })
          warnings.push(`${p.campaign.name} is back in shadow, but its product's brain could not record it as the Owner's campaign choice (${message}): a later change of the product's bids lever may put it LIVE again — record it by hand with a campaign override of the bids lever.`)
        }
      }
    }
    if (p.op === 'shadow') {
      gaveMemory = await memoryBack()
      if (gaveMemory.owed) warnings.push(`${p.campaign.name} is back in shadow, but what a stop saved could not all be put back (${gaveMemory.refused.join('; ')}): the next restore of its stop gives it back (restoreCampaignBids), or op give-back.`)
    }
    let gaveBack: Awaited<ReturnType<typeof putBack>> | null = null
    if (p.op === 'give-back') {
      const row = await prisma.bidBrainEnrollment.findFirst({ where: { campaignId: p.campaign.id }, select: { snapshot: true } })
      const snapshot = readSnapshot(row?.snapshot)
      if (snapshot) gaveBack = await putBack(p.campaign.id, await giveBackPlan(p.campaign.id, snapshot), run)
      if (gaveBack?.placementsNotRestored) warnings.push(`${p.campaign.name}: ${gaveBack.placementsNotRestored}.`)
    }
    return {
      ok: true,
      data: { campaignId: p.campaign.id, mode: set.to, from: set.from, changeSetId: run.changeSetId, ...(gaveBack ? { gaveBack } : {}), ...(gaveMemory && (gaveMemory.sent || gaveMemory.refused.length) ? { stopMemoryBack: gaveMemory } : {}), ...(warnings.length ? { warnings } : {}) },
      change: { before: { campaignId: p.campaign.id, mode: set.from }, after: { campaignId: p.campaign.id, mode: set.to, ...(warnings.length ? { warnings } : {}) } },
    }
  },
}

export const ADS_BID_BRAIN_ENROLLMENT_TOOLS: AgentTool[] = [setBidBrainEnrollment]
