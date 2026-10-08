/**
 * ONE BRAIN AB-13 — the brain's painted hourly plan, as a request a person approves (design 2026-10-08-ads-one-brain/
 * DESIGN.md §2.3, D3 = B+: "Maybe get my approval, show it to me").
 *
 *   apply-brain-hourly-plan   saves the week the brain painted for ONE hourly plan (planId) as a new version of that plan.
 *                             The brain asks for it itself (brain/hours-proposal.ts, its weekly research of a product whose
 *                             hours lever is PROPOSE); its card carries the research summary, the before / after grid
 *                             (7 × 24, the changed and the locked hours marked), the expected effect on spend, orders and
 *                             ACoS with its range, and the hours the Owner locked. A person approves it in Nexus, always:
 *                             never by rule, never confirmed in Claude (ceiling ask). Approved, it runs as that person:
 *                             the plan's own fields with the painted week go through the Hourly Bids page's own save
 *                             (saveRankScheduleGroup — set-hourly-bid-plan's write path), written as a new plan version
 *                             with the approver as its author. Rejected or expired: the plan stays exactly as it is.
 *
 * Refused, and not run, when the plan changed after the brain painted it (its week, campaigns, on/off, time zone, a
 * campaign's own values, a target's values), the hours lever is no longer PROPOSE, the Owner locked an hour or a lane it
 * changes since, or a newer painting replaced it. Nexus only: nothing is sent to Amazon by this request; the hourly bid
 * engine (and the bid brain on its LIVE campaigns) applies the plan from its next run, each write through Amazon's write
 * gate. undo-change asks set-hourly-bid-plan to paint the week it replaced back.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { applyProposal, HOURS_TOOL, previewApply, type ApplyPreview } from '../../advertising/brain/hours-proposal.js'
import { stateOnly } from '../../advertising/rank-schedule-group.service.js'
import { HOURLY_PLAN_UNDO } from './ads-hourly-plan.tools.js'
import { liveReachOf } from './ads-tool-guards.js'
import { approvedRun, notRun, reachNote, recheck, type StoredReach } from './ads-change-kit.js'
import type { AgentTool, PlanEntities, ToolContext, ToolResult } from '../tool-types.js'

/** The material fields `execute` re-checks (MATERIAL_PREVIEW_FIELDS holds the same). */
const MATERIAL = ['proposalId', 'basis', 'reach', 'gateRefused'] as const
/** At most this many changed hours are listed on the card; the rest are counted (the grid shows every one). */
const CHANGES_SHOWN = 40

const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`

/** Where the engine's writes for this plan land: the market's write gate (a market it refuses is listed, never a refusal here). */
async function reachOf(market: string): Promise<{ stored: StoredReach; refused: Array<{ market: string; deniedAt: string; reason: string }> }> {
  const r = liveReachOf(await checkAdsWriteGate({ marketplace: market, payloadValueCents: 0 }))
  if (r.reach === 'refused') return { stored: { reach: 'sandbox' }, refused: [{ market, deniedAt: r.deniedAt, reason: r.reason }] }
  return { stored: r.reach === 'live' ? { reach: 'live', profileId: r.profileId } : { reach: 'sandbox' }, refused: [] }
}

async function decide(args: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; apply?: ApplyPreview }> {
  const planId = typeof args.planId === 'string' ? args.planId.trim() : ''
  if (!planId) return { result: { ok: false, error: 'Name the hourly plan (planId) whose painting the brain asks to apply (ads-brain view hours names it).' } }
  const out = await previewApply(planId, ctx.approvalId ?? null)
  if ('refusal' in out) return { result: { ok: false, error: `Not queued: ${out.refusal}` } }
  const p = out.preview
  const reach = await reachOf(p.market)
  const n = p.paint.changes.length
  const gateWords = reach.refused.length ? ` Amazon's write gate refuses ${p.market} now (${reach.refused[0].reason}): the engine's writes there are refused until that changes.` : ''
  const summary = `Saves the week the brain painted for the hourly plan "${p.plan.name}" (${p.market}, ${plural(p.plan.members, 'campaign')}) as a new version: ${plural(n, 'hour')} of the week change. ${p.paint.summary[0]}`
  const effect = `${summary} Nexus only: the plan is saved in Nexus; the hourly bid engine (and the bid brain on its LIVE campaigns) applies it from its next run, each write through Amazon's write gate.${gateWords}`
  const warnings = [
    ...(p.research.confidence.thin ? [`Thin product: ${p.research.confidence.words}`] : []),
    ...(p.raises.length ? [`It adds spend in some hours: ${p.raises.join('; ')}.`] : []),
    ...(!p.plan.enabled ? ['The plan is switched off: nothing of it reaches Amazon until it is switched on.'] : []),
  ]
  return {
    apply: p,
    result: {
      ok: true,
      preview: {
        action: HOURS_TOOL,
        summary,
        proposalId: p.proposalId,
        paintedAt: p.createdAt,
        product: { productId: p.productId, market: p.market },
        plan: p.plan,
        research: {
          window: p.research.window, timeZone: p.research.timeZone, confidence: p.research.confidence,
          summary: p.research.summary, money: p.research.money,
        },
        grid: p.grid,
        changes: p.paint.changes.slice(0, CHANGES_SHOWN).map((c) => ({ cell: c.cell, from: c.from, to: c.to, why: c.why })),
        ...(n > CHANGES_SHOWN ? { moreChanges: n - CHANGES_SHOWN } : {}),
        locked: p.paint.locked,
        limited: p.paint.limited,
        antiFlap: p.paint.antiFlap,
        painting: p.paint.summary,
        expected: { lines: p.paint.money, effect: p.paint.effect },
        // The week as the plan stores it after (the grid's first line is the week as it holds now).
        windowsAfter: p.paint.windows,
        defaultTargetKeyAfter: p.paint.defaultTargetKey,
        raises: p.raises,
        markets: [p.market],
        basis: p.basis,
        reach: reach.stored,
        gateRefused: reach.refused,
        reachNote: reach.stored.reach === 'live' ? `Nexus only now; the engine's writes are live (${reachNote(reach.stored)})` : 'Nexus only: the plan is saved in Nexus; nothing is sent to Amazon by this request.',
        consequences: effect,
        effect,
        warnings,
        undoNote: 'Undo asks set-hourly-bid-plan to paint the week it replaced back (a request of its own); what the hourly engine did at Amazon meanwhile stays.',
      },
    },
  }
}

const applyBrainHourlyPlan: AgentTool = {
  name: HOURS_TOOL,
  title: 'Apply the brain\'s hourly plan',
  category: 'advertising',
  description:
    'Save the week the ads brain painted for ONE hourly bid plan (Amazon Sponsored Products, the Hourly Bids page) as a '
    + 'new version of that plan. The brain asks for it itself after its weekly research of a product whose hours lever is '
    + 'PROPOSE (ads-brain view hours shows the research, the painted grid and the status); the card carries the research '
    + 'summary, the before / after grid (7 × 24, changed and locked hours marked), the expected effect on spend, orders '
    + 'and ACoS with its range, and the hours the Owner locked. A person approves it in Nexus, always — never by rule and '
    + 'never confirmed in Claude. Approved, it runs as that person through the Hourly Bids page\'s own save; rejected or '
    + 'expired, the plan stays as it is. Refused when the plan, the hours lever or the Owner\'s locks changed since the '
    + 'brain painted it, or when the brain\'s request for it already waits. Nexus only: the hourly bid engine applies the '
    + 'plan from its next run. undo-change asks set-hourly-bid-plan to paint the week it replaced back.',
  input: z.object({
    planId: z.string().trim().min(1).max(64).describe('the hourly plan the brain painted (planId in ads-brain view hours, or ad-hourly-plans)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the approver and kept in the plan\'s history'),
  }),
  // What the Hourly Bids page's own writes ask for (set-hourly-bid-plan's), and the money its card shows.
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  // Nexus only: the plan is saved; the engine writes at Amazon later, through its own gate.
  openWorld: false,
  // Undo paints the replaced week back; what the engine did at Amazon in between stays.
  reversibility: 'partial',
  // D3: a painted plan applies only after a person's approval in Nexus.
  maxClaudeTrust: 'ask',
  undo: HOURLY_PLAN_UNDO,
  planEntities: (args): PlanEntities => {
    const planId = typeof args.planId === 'string' && args.planId.trim() ? args.planId.trim() : null
    const keys = planId ? [`hourly-plan:${planId}` as const] : []
    return { reads: keys, writes: keys }
  },
  async handler(args, ctx) {
    return (await decide(args, ctx)).result
  },
  async execute(args, ctx) {
    const { result: fresh, apply } = await decide(args, ctx)
    const refusal = recheck(ctx, fresh, MATERIAL)
    if (refusal || !apply) return notRun(refusal ?? 'Not run: it is no longer a valid change.')
    const p = fresh.preview as { effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const out = await applyProposal(apply, { actor: run.actor, changeSetId: run.changeSetId })
    return {
      ok: true,
      // The shape set-hourly-bid-plan records for a painted week, so undo-change asks it to paint the old week back.
      change: {
        before: { op: 'update-windows', ...stateOnly(out.before), changeSetId: run.changeSetId },
        after: { op: 'update-windows', ...stateOnly(out.after), versionId: out.versionId, changeSetId: run.changeSetId, proposalId: apply.proposalId },
      },
      data: {
        planId: apply.plan.planId, name: apply.plan.name, proposalId: apply.proposalId, versionId: out.versionId, changedHours: apply.paint.changes.length,
        changeSetId: run.changeSetId,
        note: 'The painted week is saved in Nexus as a new version of the plan; the hourly bid engine applies it from its next run.',
      },
    }
  },
}

export const ADS_BRAIN_HOURS_TOOLS: AgentTool[] = [applyBrainHourlyPlan]
