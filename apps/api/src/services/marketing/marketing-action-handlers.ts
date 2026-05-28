/**
 * UM-series (P6) — marketing-domain automation action handlers.
 *
 * Registers cross-channel campaign actions into the shared ACTION_HANDLERS
 * map (the proven side-effect-import pattern from advertising/
 * automation-action-handlers.ts). The AutomationRule engine itself is
 * unchanged — these just add new action types.
 *
 * Keys are prefixed `mkt_` so they never collide with the advertising
 * domain's handlers (the map is global; the domain lives on the rule).
 *
 * Every handler:
 *   - resolves the target campaign from action.campaignId or the matched
 *     trigger context
 *   - is a NO-OP write when meta.dryRun (returns wouldChange, no enqueue)
 *   - routes live writes through the P5 mutation path (enqueueCampaignMutation
 *     → write gate → grace window → audit), so Amazon stays sandbox until P8
 *   - reports estimatedValueCentsEur so the engine's per-rule blast-radius
 *     caps (maxValueCentsEur / maxDailyAdSpendCentsEur) apply
 *
 * Live-with-guardrails: rules ship enabled but dryRun=true by default;
 * the operator graduates a rule to live, and every money action is still
 * bounded by the caps + grace window + the channel write gate.
 */

import { ACTION_HANDLERS, type Action, type ActionResult, getFieldPath } from '../automation-rule.service.js'
import { enqueueCampaignMutation } from './marketing-mutation.service.js'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

/** Resolve the campaign id from the action or the matched context. */
function resolveCampaignId(action: Action, context: unknown): string | null {
  if (typeof action.campaignId === 'string') return action.campaignId
  const fromCtx = getFieldPath(context, 'campaignId') ?? getFieldPath(context, 'campaign.id')
  return typeof fromCtx === 'string' ? fromCtx : null
}

async function loadCampaign(id: string) {
  return prisma.marketingCampaign.findUnique({
    where: { id },
    select: { id: true, status: true, budgetCents: true, channel: true, name: true },
  })
}

// ── mkt_pause_campaign ────────────────────────────────────────────────────
ACTION_HANDLERS.mkt_pause_campaign = async (action, context, meta): Promise<ActionResult> => {
  const id = resolveCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'no campaignId resolved' }
  const c = await loadCampaign(id)
  if (!c) return { type: action.type, ok: false, error: `campaign ${id} not found` }
  if (c.status === 'PAUSED') return { type: action.type, ok: true, output: { skipped: 'already paused' } }
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldChange: { id, status: 'PAUSED' }, name: c.name } }
  }
  const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_STATE_UPDATE', payload: { status: 'PAUSED' }, userId: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, output: { queueId: r.queueId, status: 'PAUSED' } }
}

// ── mkt_resume_campaign ───────────────────────────────────────────────────
ACTION_HANDLERS.mkt_resume_campaign = async (action, context, meta): Promise<ActionResult> => {
  const id = resolveCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'no campaignId resolved' }
  const c = await loadCampaign(id)
  if (!c) return { type: action.type, ok: false, error: `campaign ${id} not found` }
  if (c.status === 'ACTIVE') return { type: action.type, ok: true, output: { skipped: 'already active' } }
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldChange: { id, status: 'ACTIVE' }, name: c.name } }
  }
  const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_STATE_UPDATE', payload: { status: 'ACTIVE' }, userId: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, output: { queueId: r.queueId, status: 'ACTIVE' } }
}

// ── mkt_set_budget ──────────────────────────────────────────────────────
// action.budgetCents = absolute new daily budget.
ACTION_HANDLERS.mkt_set_budget = async (action, context, meta): Promise<ActionResult> => {
  const id = resolveCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'no campaignId resolved' }
  const budgetCents = Number(action.budgetCents)
  if (!Number.isFinite(budgetCents) || budgetCents < 0) return { type: action.type, ok: false, error: 'budgetCents invalid' }
  const c = await loadCampaign(id)
  if (!c) return { type: action.type, ok: false, error: `campaign ${id} not found` }
  // Blast-radius value = the new budget (engine caps on this).
  if (meta.dryRun) {
    return { type: action.type, ok: true, estimatedValueCentsEur: budgetCents, output: { dryRun: true, wouldChange: { id, budgetCents }, from: c.budgetCents } }
  }
  const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_BUDGET_UPDATE', payload: { budgetCents }, userId: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, estimatedValueCentsEur: budgetCents, output: { queueId: r.queueId, budgetCents } }
}

// ── mkt_adjust_budget ────────────────────────────────────────────────────
// action.deltaPct = signed % change (e.g. -20 = cut 20%, +15 = raise 15%).
ACTION_HANDLERS.mkt_adjust_budget = async (action, context, meta): Promise<ActionResult> => {
  const id = resolveCampaignId(action, context)
  if (!id) return { type: action.type, ok: false, error: 'no campaignId resolved' }
  const deltaPct = Number(action.deltaPct)
  if (!Number.isFinite(deltaPct)) return { type: action.type, ok: false, error: 'deltaPct invalid' }
  const c = await loadCampaign(id)
  if (!c) return { type: action.type, ok: false, error: `campaign ${id} not found` }
  const current = c.budgetCents ?? 0
  // €1/day floor so a chain of cuts can't zero a campaign out.
  const next = Math.max(100, Math.round(current * (1 + deltaPct / 100)))
  if (meta.dryRun) {
    return { type: action.type, ok: true, estimatedValueCentsEur: next, output: { dryRun: true, wouldChange: { id, budgetCents: next }, from: current, deltaPct } }
  }
  const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_BUDGET_UPDATE', payload: { budgetCents: next }, userId: `automation:${meta.ruleId}` })
  return { type: action.type, ok: true, estimatedValueCentsEur: next, output: { queueId: r.queueId, budgetCents: next, from: current } }
}

logger.debug('[marketing] action handlers registered', {
  count: 4,
  types: ['mkt_pause_campaign', 'mkt_resume_campaign', 'mkt_set_budget', 'mkt_adjust_budget'],
})
