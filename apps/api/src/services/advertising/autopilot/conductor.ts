/**
 * AI Control / Autopilot — the Conductor. Pure: takes the plan (goal + guardrails + enabled
 * modules) + per-campaign signals, runs each enabled module, enforces the cross-set max-daily-
 * spend cap, and returns ordered proposed actions + the effective target ACoS per campaign.
 * The cron applies these (AUTO) or stores them as suggestions (SUGGEST). Harvest/Negate are
 * provisioned/read separately (Rule-Setting session) and are NOT produced here.
 */
import {
  type CampaignSignals, type Guardrails, type Goal,
  GOAL_PRESETS, DEFAULT_GUARDRAILS, effectiveTargetAcosPct,
} from './presets.js'
import { decideBid, decideBudget, decidePlacement, type ProposedAction } from './modules.js'

export interface PlanModules {
  bid?: { on: boolean }
  budget?: { on: boolean }
  placement?: { on: boolean }
  rank?: { on: boolean }       // provisioned via RankTarget (not a per-cycle action here)
  dayparting?: { on: boolean } // provisioned via AdSchedule (not a per-cycle action here)
  harvest?: { on: boolean }    // delegated to Rule-Setting engine
  negate?: { on: boolean }     // delegated to Rule-Setting engine
}

export interface ConductorInput {
  goal: Goal
  guardrails: Partial<Guardrails>
  modules: PlanModules
  signals: CampaignSignals[]
}

export interface ConductorResult {
  targetAcosByCampaign: Record<string, number>
  actions: ProposedAction[]
  skipped: { reason: string; campaignId?: string }[]
}

const on = (mod: { on: boolean } | undefined): boolean => mod?.on !== false  // default ON

export function runConductorCycle(input: ConductorInput): ConductorResult {
  const g: Guardrails = { ...DEFAULT_GUARDRAILS, ...input.guardrails }
  const preset = GOAL_PRESETS[input.goal]
  const m = input.modules ?? {}
  const targetAcosByCampaign: Record<string, number> = {}
  let actions: ProposedAction[] = []
  const skipped: { reason: string; campaignId?: string }[] = []

  for (const s of input.signals) {
    const target = effectiveTargetAcosPct(input.goal, g, s)
    targetAcosByCampaign[s.campaignId] = target
    if (on(m.bid)) { const a = decideBid(s, target, g, preset); if (a) actions.push(a) }
    if (on(m.budget)) { const a = decideBudget(s, target, g, preset); if (a) actions.push(a) }
    if (on(m.placement)) { const a = decidePlacement(s, target, preset); if (a) actions.push(a) }
    // bid / budget / placement touch different fields → no same-field conflict within a campaign.
  }

  // ── cross-set max-daily-spend cap: scale BUDGET_UP raises down proportionally to fit ──
  if (g.maxDailySpendCents > 0) {
    const sigById = new Map(input.signals.map((s) => [s.campaignId, s]))
    const curOf = (id: string) => sigById.get(id)?.dailyBudgetCents ?? 0
    const raises = actions.filter((a) => a.module === 'budget' && a.action === 'BUDGET_UP')
    // projected = sum of every campaign's post-action daily budget
    let projected = 0
    for (const s of input.signals) {
      const up = raises.find((a) => a.campaignId === s.campaignId)
      projected += up?.afterCents ?? s.dailyBudgetCents
    }
    if (projected > g.maxDailySpendCents) {
      const raiseDelta = raises.reduce((n, a) => n + ((a.afterCents ?? 0) - curOf(a.campaignId)), 0)
      const baseTotal = projected - raiseDelta
      const headroom = Math.max(0, g.maxDailySpendCents - baseTotal)
      const scale = raiseDelta > 0 ? Math.min(1, headroom / raiseDelta) : 1
      for (const a of raises) {
        const cur = curOf(a.campaignId)
        a.afterCents = cur + Math.round(((a.afterCents ?? cur) - cur) * scale)
        if (scale < 1) a.reason += ` (scaled to fit €${(g.maxDailySpendCents / 100).toFixed(0)} daily cap)`
      }
      // drop raises that scaled down to a no-op
      actions = actions.filter((a) => !(a.module === 'budget' && a.action === 'BUDGET_UP' && a.afterCents === curOf(a.campaignId)))
      if (scale < 1) skipped.push({ reason: `maxDailySpend cap reached → budget raises scaled to ${(scale * 100).toFixed(0)}%` })
    }
  }

  // stable apply order: group by campaign, higher priority first (safety > bid > budget > placement)
  actions.sort((a, b) => (a.campaignId === b.campaignId ? b.priority - a.priority : a.campaignId.localeCompare(b.campaignId)))
  return { targetAcosByCampaign, actions, skipped }
}
