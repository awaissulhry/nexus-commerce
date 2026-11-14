import type { Grains } from '../../model'
import type { GoalQuery, GoalSeekView, VersionRow } from '../versions/api'
import { typedAmount, typedMargin, type Phrase } from '../versions/model'

/**
 * Style › Cost › Target price (B-W2b-430 on B-W2b-420's goal-seek; design products.styles style.cost.goalseek: Target,
 * Allowed cost, Gap, Biggest lines; FIN-013), pure: what the person typed (a target price, a target margin, the cost read —
 * the weighted cost of the size mix, the base size's or one size's), what is asked of the API (a figure only with its grain;
 * left out = the version's own), the state in words and the gap's tone.
 */

export const GOAL_BASES = ['WEIGHTED', 'BASE_SIZE', 'SIZE'] as const
export type GoalBasis = (typeof GOAL_BASES)[number]

export interface GoalAsk {
  readonly targetPrice: string
  readonly targetMarginPct: string
  readonly basis: GoalBasis
  readonly size: string
}

/** The fields the card opens with: the version's own target (typed back in the person's way) and the weighted cost. */
export function goalAskOf(sheet: Pick<VersionRow, 'targetPrice' | 'targetMarginPct' | 'baseSize' | 'weightedCost'> | null, locale: 'it' | 'en'): GoalAsk {
  const typed = (value: string | null | undefined) => (value === null || value === undefined ? '' : locale === 'it' ? Number(value).toString().replace('.', ',') : Number(value).toString())
  return { targetPrice: typed(sheet?.targetPrice), targetMarginPct: typed(sheet?.targetMarginPct), basis: 'WEIGHTED', size: sheet?.baseSize ?? '' }
}

/** The fields' problems (message keys). */
export function goalProblems(ask: GoalAsk): Partial<Record<'targetPrice' | 'targetMarginPct', string>> {
  const problems: Partial<Record<'targetPrice' | 'targetMarginPct', string>> = {}
  if (ask.targetPrice.trim() !== '' && typedAmount(ask.targetPrice) === null) problems.targetPrice = 'verNew.problem.price'
  if (ask.targetMarginPct.trim() !== '' && typedMargin(ask.targetMarginPct) === null) problems.targetMarginPct = 'verNew.problem.margin'
  return problems
}

/** The query of GET …/goal-seek: a typed figure only with its grain (left out: the version's own). */
export function goalQueryOf(ask: GoalAsk, grains: Grains): GoalQuery {
  const price = grains.price ? typedAmount(ask.targetPrice) : null
  const margin = grains.margin ? typedMargin(ask.targetMarginPct) : null
  return {
    ...(price !== null ? { targetPrice: price } : {}),
    ...(margin !== null ? { targetMarginPct: margin } : {}),
    // The weighted cost is the API's own default (the base size's when the version keeps no size mix): asked only by leaving it out.
    ...(ask.basis === 'WEIGHTED' ? {} : { basis: ask.basis }),
    ...(ask.basis === 'SIZE' && ask.size ? { size: ask.size } : {}),
  }
}

/** What "Keep this target" writes on a draft (a field typed empty clears it; a field without its grain is left alone). */
export function keepBodyOf(ask: GoalAsk, grains: Grains): { targetPrice?: string | null; targetMarginPct?: string | null } {
  return {
    ...(grains.price ? { targetPrice: ask.targetPrice.trim() === '' ? null : typedAmount(ask.targetPrice) } : {}),
    ...(grains.margin ? { targetMarginPct: ask.targetMarginPct.trim() === '' ? null : typedMargin(ask.targetMarginPct) } : {}),
  }
}

/** "Keep this target" changes nothing when the typed target is the version's own. */
export function keepChangesNothing(ask: GoalAsk, sheet: Pick<VersionRow, 'targetPrice' | 'targetMarginPct'>, grains: Grains): boolean {
  const body = keepBodyOf(ask, grains)
  const same = (typed: string | null | undefined, own: string | null | undefined) => (typed ?? null) === null ? (own ?? null) === null : own !== null && own !== undefined && Number(typed) === Number(own)
  return (!('targetPrice' in body) || same(body.targetPrice, sheet.targetPrice)) && (!('targetMarginPct' in body) || same(body.targetMarginPct, sheet.targetMarginPct))
}

/** The state in words and its tone: within the allowed cost, above it (the gap), or what is missing to work it out. */
export function goalStateOf(view: Pick<GoalSeekView, 'state'>): { key: string; tone: 'success' | 'warning' | 'info' | 'neutral' } {
  const tone = view.state === 'WITHIN' ? 'success' : view.state === 'ABOVE' ? 'warning' : view.state === 'NO_COST' || view.state === 'NO_TARGET' ? 'neutral' : 'info'
  return { key: `goalState.${view.state}`, tone }
}

/** Why the answer could not use a target (a grain the person does not hold), in words; null when both could be. */
export function goalHeldWords(grains: Grains): Phrase | null {
  if (!grains.price && !grains.margin) return { key: 'goal.heldBoth' }
  if (!grains.price) return { key: 'goal.heldPrice' }
  if (!grains.margin) return { key: 'goal.heldMargin' }
  return null
}
