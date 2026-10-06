/**
 * ADS PLAYBOOK PB-3 — a template's phase recipes made absolute for ONE product at enrollment (design report 9 §3.7),
 * pure. A template holds factors (a phase's target is a share of the product's break-even ACoS, its bid band a factor
 * of the product's base bid); a product row holds the numbers, in the ads strategy's own field names and units, so a
 * later phase switch writes them into the strategy through its one writer (which judges each raise again).
 *
 *   target     breakEven: factor × the product's break-even ACoS; without cost data, fallbackFactor × the market's
 *              target (the factor itself when the template names no fallback, said in a note) · marketTarget: factor ×
 *              the market's target. A whole percent, 1–500.
 *   bid band   minFactor / maxFactor × the product's base bid, at least the 2¢ floor; without a base bid the band is left
 *              to the strategy (a note says so).
 *   harvest    its counts and window as they are; its ACoS ceiling as a factor of the phase's target.
 *   negate     its counts and window as they are; its least spend as a factor of the base bid (left out without one).
 *
 * Nothing is guessed: what cannot be made absolute is left out and named.
 */
import { MAX_TARGET_PCT } from '../ads-strategy/fields.js'
import type { PhaseRecipes, TemplateDoc } from './doc.js'

export interface RecipeFacts {
  /** The product's break-even ACoS as a whole percent (profit data); null when its costs are not known. */
  breakEvenPct: number | null
  /** The market's target ACoS as a whole percent (the strategy's market row, else the account default, else 30 %). */
  marketTargetPct: number
  /** The product's base bid in minor units; null when the row sets none. */
  baseBidCents: number | null
}

const FLOOR_BID_CENTS = 2
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(Math.round(n), low), high)

export function absoluteRecipes(phases: TemplateDoc['phases'], facts: RecipeFacts): { recipes: PhaseRecipes; notes: string[] } {
  const recipes: PhaseRecipes = {}
  const notes: string[] = []
  for (const [phase, entry] of Object.entries(phases) as Array<[keyof PhaseRecipes, NonNullable<TemplateDoc['phases'][keyof TemplateDoc['phases']]>]>) {
    if (!entry) continue
    const r = entry.recipe
    const out: NonNullable<PhaseRecipes[typeof phase]> = {}
    let targetPct: number | null = null
    if (r.targetAcos) {
      const { from, factor, fallbackFactor } = r.targetAcos
      if (from === 'marketTarget') targetPct = factor * facts.marketTargetPct
      else if (facts.breakEvenPct != null) targetPct = factor * facts.breakEvenPct
      else {
        targetPct = (fallbackFactor ?? factor) * facts.marketTargetPct
        notes.push(`${phase}: no cost data for a break-even ACoS, so its target is ${fallbackFactor ?? factor} × the market's target${fallbackFactor ? '' : ' (the template names no fallback: its own factor is used)'}`)
      }
      out.targetAcosPct = clamp(targetPct, 1, MAX_TARGET_PCT)
      targetPct = out.targetAcosPct
    }
    if (r.bidBand) {
      if (facts.baseBidCents == null) notes.push(`${phase}: no base bid, so its bid band is left to the strategy`)
      else {
        if (r.bidBand.minFactor) out.minBidCents = clamp(r.bidBand.minFactor * facts.baseBidCents, FLOOR_BID_CENTS, 100_000)
        if (r.bidBand.maxFactor) out.maxBidCents = clamp(r.bidBand.maxFactor * facts.baseBidCents, FLOOR_BID_CENTS, 100_000)
      }
    }
    if (r.maxChangePct) out.maxChangePct = r.maxChangePct
    if (r.harvest) {
      out.harvestMinOrders = r.harvest.minOrders
      out.harvestMinClicks = r.harvest.minClicks
      out.harvestWindowDays = r.harvest.windowDays
      if (r.harvest.maxAcosFactor) {
        if (targetPct == null) notes.push(`${phase}: its harvest ACoS ceiling is a share of the phase's target, which it does not set; left out`)
        else out.harvestMaxAcosPct = clamp(r.harvest.maxAcosFactor * targetPct, 1, 1000)
      }
    }
    if (r.negate) {
      out.negateMinClicks = r.negate.minClicks
      out.negateMaxOrders = r.negate.maxOrders
      out.negateWindowDays = r.negate.windowDays
      if (r.negate.minSpendFactor) {
        if (facts.baseBidCents == null) notes.push(`${phase}: no base bid, so its negate spend threshold is left out`)
        else out.negateMinSpendCents = clamp(r.negate.minSpendFactor * facts.baseBidCents, 0, 10_000_000)
      }
    }
    recipes[phase] = out
  }
  return { recipes, notes }
}
