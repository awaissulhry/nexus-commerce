/**
 * Batch 2 fix (item 7) — the money brain's brakes reach the bids (design 2026-10-08-ads-one-brain/DESIGN.md §2.6, §5: on
 * projected month-end spend, > 95 % of the envelope no raises, > 100 % bids step down 10 % a day, > 105 % the stop recipe on
 * the weakest campaigns until back on pace). AB-7 plans the brake and AB-8 writes the budgets; nobody carried out the bid
 * part. The bid brain now reads, per campaign it decides, the newest money plan of the campaign's product and applies its
 * brake in its own facts and decide path (facts.ts, decide.ts), in the existing override order:
 *
 *   who        only where the product's budgets lever is the brain's — PROPOSE or AUTO, the product enrolled, the campaign
 *              not excluded and the lever not locked (brain/lever-owners.ts `owned`). OBSERVE or OFF: nothing is read and
 *              nothing changes — the money shadow (AB-7) logs the brake, the bids decide as before.
 *   when       the plan of today's budget day only (the money shadow plans every 15 minutes): an older plan is no pace.
 *   hold       hold_raises — every raise of the campaign's keywords waits (decide's raise cap: a give-back after the brain's
 *              own floor still goes, as under a HELD campaign)
 *   step down  cut_bids — every keyword one step down a data day (10 %, the plan's bidStepPct) from the bid of the day before
 *              (a floor the brain set meanwhile — a Min-bid hour — is not the base), never compounded by a rerun, never
 *              below the limits; a goal that asks lower goes lower. A pin (the Owner's) holds; a stop, stock, a phase or a
 *              Min-bid hour that floors lower wins (the lower bid). Not a floor: when the pace recovers, the goal walks the
 *              bids back up inside its own steps — no jump back.
 *   floor      stop_weakest — the plan's weakest campaigns (lowest marginal profit) take the stop bid as a STOP (the stop
 *              recipe's bid part: given back when it lifts), unless the Owner pins their bids; the others step down as above.
 *              The recipe's lanes and bidding strategy are not set from here (the stop owners' path does that today).
 */
import { budgetDayKey } from '@nexus/shared/ads-budget-day'
import { BRAKE_BID_STEP_PCT, MONEY_BRAKES, type BrakeLevel } from '../brain/budget-pace.js'

/** One campaign's money brake as the bid brain applies it. */
export interface MoneyBrakeFact {
  level: Exclude<BrakeLevel, 'none'>
  /** cut_bids and stop_weakest: how far the bids step down a data day, % (positive). */
  stepPct: number
  /** stop_weakest: this campaign is among the weakest — the stop bid. */
  floor: boolean
  productId: string
  /** In words, with no money amount: whose brake, its level and the pace that set it. */
  why: string
}

type PlanLike = { day: string; brake: { level: BrakeLevel; bidStepPct: number | null; stop: ReadonlyArray<{ campaignId: string }> | null }; pace: { pacePct: number | null } }

/** The brake one money plan puts on one campaign of its product; null: none (no brake, or not today's plan). Pure. */
export function moneyBrakeOf(plan: PlanLike | null | undefined, campaignId: string, productId: string, today: string): MoneyBrakeFact | null {
  if (!plan || plan.day !== today || plan.brake.level === 'none') return null
  const level = plan.brake.level
  const above = MONEY_BRAKES.find((b) => b.level === level)?.abovePct
  const pace = plan.pace.pacePct != null ? `projected ${Math.round(plan.pace.pacePct * 10) / 10} % of its monthly budget` : 'its monthly budget spent ahead of the month'
  const floor = level === 'stop_weakest' && !!plan.brake.stop?.some((s) => s.campaignId === campaignId)
  return {
    level, productId, floor,
    stepPct: level === 'hold_raises' ? 0 : Math.abs(plan.brake.bidStepPct ?? BRAKE_BID_STEP_PCT),
    why: `the money brake of product ${productId} (${level}: ${pace}${above != null ? `, above ${above} %` : ''})`,
  }
}

/**
 * The money brakes on these campaigns (only those with one): a fixed number of reads — the lever holders (nothing when no
 * product is enrolled: one remembered query), then the newest plan of each product holding a campaign's budgets lever.
 */
export async function loadMoneyBrakes(campaignIds: readonly string[], market: string, now: Date): Promise<Map<string, MoneyBrakeFact>> {
  const out = new Map<string, MoneyBrakeFact>()
  if (!campaignIds.length) return out
  const { campaignLeverOwners } = await import('../brain/lever-owners.js')
  const owners = await campaignLeverOwners(campaignIds)
  const productOf = new Map<string, string>()
  for (const [campaignId, o] of owners) {
    const hold = o.levers.budgets
    if (hold?.kind === 'owned' && hold.market === market) productOf.set(campaignId, hold.productId)
  }
  if (!productOf.size) return out
  const { newestMoneyDecisions } = await import('../brain/budget-shadow.js')
  const plans = await newestMoneyDecisions(market, [...new Set(productOf.values())])
  const today = budgetDayKey(now, market)
  for (const [campaignId, productId] of productOf) {
    const brake = moneyBrakeOf(plans.get(productId)?.plan, campaignId, productId, today)
    if (brake) out.set(campaignId, brake)
  }
  return out
}
