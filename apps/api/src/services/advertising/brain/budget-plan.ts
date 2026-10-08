/**
 * ONE BRAIN AB-7 — one product's money plan in one market, in the design's order (2026-10-08-ads-one-brain/DESIGN.md §4:
 * the money brakes are a stop and state fact, budgets come before bids, budget follows the bid): the envelope
 * (budget-envelope.ts), the pace and its brake (budget-pace.ts), the portfolio-cap plan (budget-portfolio.ts), then each
 * campaign's budget and ladder (budget-campaigns.ts). Pure. SHADOW: what the brain WOULD do — nothing is written to Amazon.
 *
 * Every part carries its "why". `moneyPlanHash` fingerprints the decisions (not the readings' time): an unchanged plan
 * stores no new row (brain/budget-shadow.ts).
 */
import { createHash } from 'node:crypto'
import { money, type Envelope, type MarketSplit } from './budget-envelope.js'
import { BRAKE_BID_STEP_PCT, paceOf, type Brake, type MoneyClock, type Pace, type PaceFacts } from './budget-pace.js'
import { planPortfolioCaps, type PortfolioCapPlan, type PortfolioFacts } from './budget-portfolio.js'
import { planCampaignBudgets, weakestToStop, type BandFacts, type CampaignBudgetDecision, type CampaignMoneyFacts, type DayMoveBounds } from './budget-campaigns.js'
import type { BrainSettings, LeverSettings } from './settings.js'

export const MONEY_PLAN_VERSION = 1

export interface ProductMoneyFacts {
  productId: string
  name: string | null
  market: string
  currency: string
  clock: MoneyClock
  enrolled: boolean
  /** The product-level settings (brain/settings.ts): the budgets and portfolioCap levers, and the values. */
  settings: Pick<BrainSettings, 'levers' | 'values' | 'excluded'>
  envelope: Envelope
  split: Pick<MarketSplit, 'budgetCents' | 'budgetFrom' | 'fixedCents' | 'sharedCents' | 'reserveCents' | 'totalCents' | 'why' | 'warnings'>
  pace: Omit<PaceFacts, 'envelopeCents' | 'aimPct' | 'clock'> & { dayWeightsFrom: 'calendar' | 'even'; hourCurveFrom: 'product' | 'market' | 'even'; dataThrough: string | null }
  portfolios: PortfolioFacts[]
  campaigns: CampaignMoneyFacts[]
  band: BandFacts
  /** Amazon's daily budget limits for Sponsored Products in the market; null: no checked row (said). */
  limits: { minCents: number; maxCents: number } | null
  warnings: string[]
}

export interface ProductMoneyPlan {
  v: number
  productId: string
  name: string | null
  market: string
  currency: string
  month: string
  day: string
  at: string
  enrolled: boolean
  levers: { budgets: { effective: LeverSettings['effective']; why: string }; portfolioCap: { effective: LeverSettings['effective']; why: string } }
  envelope: Omit<Envelope, 'productId'>
  /** The market's split this envelope comes from. */
  split: ProductMoneyFacts['split']
  pace: Pace & { dayWeightsFrom: string; hourCurveFrom: string; dataThrough: string | null; runRateCents: number | null }
  brake: Brake & {
    /** cut_bids: the step the bids take today (%); stop_weakest: the campaigns to stop first, each with what it saves. */
    bidStepPct: number | null
    stop: Array<{ campaignId: string; name: string; savesCents: number }> | null
  }
  portfolioCap: PortfolioCapPlan
  campaigns: CampaignBudgetDecision[]
  fit: { scale: number | null; why: string }
  counts: { raise: number; lower: number; keep: number; hold: number; skip: number; ladder: number; exceptions: number }
  warnings: string[]
  why: string
}

const DEFAULT_LIMITS = { minCents: 100, maxCents: 100_000_000 }

/** One product's money plan. `bounds` is the gate's day-move bound (ads-write-gate.ts budgetDayMoveBounds). Pure. */
export function planProductMoney(f: ProductMoneyFacts, bounds: (openingCents: number) => DayMoveBounds): ProductMoneyPlan {
  const w = (c: number) => money(c, f.currency)
  const warnings = [...f.warnings, ...f.split.warnings]
  const limits = f.limits ?? DEFAULT_LIMITS
  if (!f.limits) warnings.push(`no checked Amazon budget limits for ${f.market} (packages/shared/ads-market-limits.ts): €1–€1,000,000 assumed; the gate would refuse every write there`)
  const values = f.settings.values
  const aimPct = Number(values.paceTargetPct.value) || 90

  // 1. The pace and its brake (a stop and state fact: it binds every step below).
  const pace = paceOf({ ...f.pace, envelopeCents: f.envelope.cents, aimPct, clock: f.clock }, w)
  const stop = pace.brake.level === 'stop_weakest' && f.envelope.cents != null ? weakestToStop(f.campaigns, pace.projectedCents, f.envelope.cents, pace.daysAhead) : null
  const brake = { ...pace.brake, bidStepPct: pace.brake.level === 'cut_bids' || pace.brake.level === 'stop_weakest' ? -BRAKE_BID_STEP_PCT : null, stop }

  // 2. The portfolio cap (the hard backstop), 3. the campaign budgets inside the pace.
  const portfolioCap = planPortfolioCaps({
    envelopeCents: f.envelope.cents,
    settings: { on: values.portfolioCapOn, pct: values.portfolioCapPct, amountCents: values.portfolioCapCents, ownPortfolio: values.ownPortfolio, lock: f.settings.levers.portfolioCap.lock },
    portfolios: f.portfolios,
    runRateCents: f.pace.runRateCents,
  }, w)
  const planned = planCampaignBudgets({ campaigns: f.campaigns, allowanceCents: pace.allowanceCents, brake: pace.brake, ladderHour: f.clock.ladderHour, band: f.band, limits, bounds, words: w })

  const counts = { raise: 0, lower: 0, keep: 0, hold: 0, skip: 0, ladder: 0, exceptions: 0 }
  for (const c of planned.campaigns) {
    counts[c.action]++
    if (c.ladder) { counts.ladder++; if (c.ladder.exception) counts.exceptions++ }
  }
  const label = f.name ? `${f.name} (${f.market})` : `${f.productId} (${f.market})`
  const envelopeWords = f.envelope.cents == null ? 'no envelope' : `envelope ${w(f.envelope.cents)} (${f.envelope.source})`
  const paceWords = pace.pacePct != null ? `projected ${w(pace.projectedCents)} = ${pace.pacePct} %` : `projected ${w(pace.projectedCents)}`
  const capWords = portfolioCap.totalCents != null ? `portfolio cap ${w(portfolioCap.totalCents)} (${portfolioCap.source})` : `no portfolio cap (${portfolioCap.source})`
  const campWords = `${planned.campaigns.length} campaign${planned.campaigns.length === 1 ? '' : 's'}: ${counts.lower} lower, ${counts.raise} raise, ${counts.keep} keep, ${counts.hold} hold${counts.skip ? `, ${counts.skip} not the brain's` : ''}${counts.ladder ? `, ${counts.ladder} on the ladder` : ''}`
  const why = `${label} ${f.clock.month} day ${f.clock.dayOfMonth}: ${envelopeWords} · ${paceWords} → ${brake.level === 'none' ? 'no brake' : `brake ${brake.level}`} · ${capWords} · ${campWords}`
  const lever = (l: LeverSettings) => ({ effective: l.effective, why: l.why })
  const { productId: _p, ...envelope } = f.envelope
  return {
    v: MONEY_PLAN_VERSION, productId: f.productId, name: f.name, market: f.market, currency: f.currency,
    month: f.clock.month, day: f.clock.day, at: f.clock.at, enrolled: f.enrolled,
    levers: { budgets: lever(f.settings.levers.budgets), portfolioCap: lever(f.settings.levers.portfolioCap) },
    envelope, split: f.split,
    pace: { ...pace, dayWeightsFrom: f.pace.dayWeightsFrom, hourCurveFrom: f.pace.hourCurveFrom, dataThrough: f.pace.dataThrough, runRateCents: f.pace.runRateCents },
    brake, portfolioCap, campaigns: planned.campaigns, fit: { scale: planned.scale, why: planned.fitWhy }, counts, warnings, why,
  }
}

/**
 * The plan's decisions, fingerprinted: equal for two plans that would do the same thing. What the brain would WRITE today
 * counts (each campaign's action, step and ladder rung; the envelope, the brake, the portfolio caps, the levers); the
 * readings do not — the projection and each campaign's target drift with the hour as the day's spend arrives, and the
 * budget day's first plan (a snapshot) keeps them every day.
 */
export function moneyPlanHash(p: Pick<ProductMoneyPlan, 'envelope' | 'brake' | 'portfolioCap' | 'campaigns' | 'levers'>): string {
  const decisions = {
    envelope: [p.envelope.cents, p.envelope.source],
    levers: [p.levers.budgets.effective, p.levers.portfolioCap.effective],
    brake: [p.brake.level, p.brake.bidStepPct, (p.brake.stop ?? []).map((s) => s.campaignId)],
    cap: [p.portfolioCap.source, p.portfolioCap.totalCents, p.portfolioCap.portfolios.map((x) => [x.portfolioId, x.capCents, x.action])],
    campaigns: p.campaigns.map((c) => [c.campaignId, c.action, c.stepCents, c.ladder?.pct ?? 0]),
  }
  return createHash('sha256').update(JSON.stringify(decisions)).digest('base64url').slice(0, 22)
}
