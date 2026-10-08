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
import { updateAdGroupWithSync, updateAdTargetWithSync } from '../../advertising/ads-mutation.service.js'
import { updatePlacementBidding } from '../../advertising/ads-create.service.js'
import {
  DEFAULT_HOLD_DAYS, ENROLL_OPS, enrollRefusal as refusalOf, enrollmentBasis, enrollmentFacts, giveBackPlan, nextMode, PLANS_JOIN_THE_BRAIN, readSnapshot,
  setEnrollment, type EnrollMode, type EnrollOp,
} from '../../advertising/bid-brain/enrollment.js'
import { STEP_UP_NEEDS, type StepUp } from '../step-up-approval.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { ADDS_NO_SPEND, codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const TOOL = 'set-bid-brain-enrollment'
const BIG_DOOR_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs.'

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
  const f = await enrollmentFacts(campaignId, { plansJoin: PLANS_JOIN_THE_BRAIN })
  if (!f) return { ok: false, error: `campaign ${campaignId} not found` }
  const refusal = refusalOf(f, op)
  if (refusal) return { ok: false, error: refusal }
  const from = f.enrollment?.mode ?? null
  const to = (nextMode(op, from) as { to: EnrollMode }).to
  const c = f.campaign
  const warnings: string[] = []
  if (f.ceiling !== 'live' && (to === 'LIVE' || to === 'HELD')) warnings.push(`The server switch NEXUS_BID_BRAIN_MODE is ${f.ceiling}: the brain owns ${c.name} only once that switch is live; until then it stays in shadow and today's engines keep writing.`)
  if (c.status !== 'ENABLED' && to === 'LIVE') warnings.push(`${c.name} is ${c.status.toLowerCase()}: the brain writes nothing while it does not run.`)
  if (c.pinBids && to === 'LIVE') warnings.push(`${c.name}'s bids are pinned by hand: the brain leaves pinned bids alone until the pin is lifted.`)
  const back = op === 'give-back' && f.enrollment?.snapshot ? await giveBackPlan(c.id, f.enrollment.snapshot) : null
  const holdDays = op === 'hold' ? Math.max(1, Math.min(60, Number(args.holdDays ?? DEFAULT_HOLD_DAYS))) : null
  const raises = back && back.raises ? [`${plural(back.raises, 'bid or placement')} back up to ${back.raises === 1 ? 'its' : 'their'} value when the campaign went LIVE`] : op === 'release' ? ['the brain may raise bids again'] : []
  const effect = {
    live: `Puts ${c.name} (${c.market ?? c.marketplace ?? '?'}) under the bid brain: from its next run it is the campaign's one bid writer — keyword bids toward the goal at most once per new data day, inside the limits; auto-bid, rules and other engines leave the campaign, and a person's own edit still passes and holds that bid. Every bid and placement is kept now for a give-back.`,
    shadow: `Takes ${c.name} back to shadow: the brain stops writing; every bid stays where it is and today's engines resume.`,
    'give-back': `Takes ${c.name} back to shadow and puts back what it held when it went LIVE: ${plural(back?.targets.length ?? 0, 'keyword bid')}, ${plural(back?.adGroups.length ?? 0, 'ad group default bid')}${back?.placements ? ' and its placements' : ''}, as the person who approves it.`,
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
      basis: enrollmentBasis(f),
      ceiling: f.ceiling,
      ...(holdDays ? { holdDays } : {}),
      ...(back ? { giveBack: { keywordBids: back.targets.length, adGroupBids: back.adGroups.length, placements: !!back.placements, raises: back.raises } } : {}),
      raises,
      ...(warnings.length ? { warnings } : {}),
      ...code,
      ...(code.stepUp ? {} : { noCode: raises.length ? DAY_TO_DAY_NO_CODE : ADDS_NO_SPEND }),
      reachNote: op === 'give-back' ? 'It writes bids and placements at Amazon (the write gate judges each).' : 'Nexus only: nothing is sent to Amazon by this change; the brain\'s own runs write afterwards.',
      effect: `${effect}${code.stepUp ? ' A new bid writer going live: approving it needs the approver\'s authenticator code.' : ''}`,
    },
  }
}

/** Put the snapshot back, as the person who approved it (the write gate judges each write). */
async function putBack(campaignId: string, plan: Awaited<ReturnType<typeof giveBackPlan>>, run: { actor: `user:${string}` | `automation:${string}`; reason: string; changeSetId: string; manual: boolean; confirmOwnLimits: boolean }) {
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
  if (plan.placements) {
    const r = await updatePlacementBidding({ campaignId, adjustments: plan.placements.to, actor: run.actor, reason: common.reason, changeSetId: run.changeSetId, manual: run.manual }) as { mode?: string; reason?: string }
    if (r.mode !== 'blocked') sent++
    else if (refused.length < 3) refused.push(r.reason ?? 'placements refused')
  }
  return { sent, refused }
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
    + 'some days; op release ends a hold; op shadow: the brain stops, bids stay; op give-back: back to shadow and the bids '
    + 'and placements put back as they were when it went LIVE. LIVE needs the campaign on the live-write allowlist, its '
    + 'bids serving (not held at a floor), and no classic dayparting schedule, running autopilot plan or older family rank '
    + 'plan on it; its hourly bid plan joins the brain (each hour\'s placement % and Min-bid floors, inside the brain\'s '
    + 'limits) unless an hour sets a base bid. A person approves every op in Nexus (or confirms it '
    + 'in Claude with their code); nothing changes until then.',
  async handler(args) {
    return preview(args)
  },
  async execute(args, ctx: ToolContext) {
    const fresh = await preview(args)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as { op: EnrollOp; campaign: { id: string; name: string; market: string | null }; enrollment: { from: EnrollMode | null; to: EnrollMode }; basis: string; holdDays?: number; effect: string }
    const approved = ctx.approvedPreview as { basis?: unknown } | undefined
    if (approved?.basis && approved.basis !== p.basis) return notRun(`Not run: ${p.campaign.name}'s place in the bid brain changed since it was approved. Nothing changed.`)
    const gate = await codeGate(ctx, fresh.preview)
    if ('refusal' in gate) return notRun(gate.refusal)
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const campaign = await prisma.campaign.findFirst({ where: { id: p.campaign.id }, select: { marketplace: true } })
    const set = await setEnrollment({ campaignId: p.campaign.id, marketplace: p.campaign.market ?? campaign?.marketplace ?? '', op: p.op, by: run.actor, holdDays: p.holdDays ?? null, reason: run.reason })
    let gaveBack: { sent: number; refused: string[] } | null = null
    if (p.op === 'give-back') {
      const row = await prisma.bidBrainEnrollment.findFirst({ where: { campaignId: p.campaign.id }, select: { snapshot: true } })
      const snapshot = readSnapshot(row?.snapshot)
      if (snapshot) gaveBack = await putBack(p.campaign.id, await giveBackPlan(p.campaign.id, snapshot), run)
    }
    return {
      ok: true,
      data: { campaignId: p.campaign.id, mode: set.to, from: set.from, changeSetId: run.changeSetId, ...(gaveBack ? { gaveBack } : {}) },
      change: { before: { campaignId: p.campaign.id, mode: set.from }, after: { campaignId: p.campaign.id, mode: set.to } },
    }
  },
}

export const ADS_BID_BRAIN_ENROLLMENT_TOOLS: AgentTool[] = [setBidBrainEnrollment]
