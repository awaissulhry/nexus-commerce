/**
 * ONE BRAIN AB-8 — the intraday ladder's give-back exception, read from the budget log (design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.5, §2.6, §5). Pure: the write gate (ads-write-gate.ts budgetDayMoveDenial), the
 * money plan's facts (brain/budget-load.ts) and the money writer (brain/budget-live.ts) read one definition.
 *
 *   actors     the money writer writes as MONEY_BUDGETS_ACTOR (a campaign's daily budget) and MONEY_PORTFOLIO_ACTOR (an
 *              Amazon portfolio cap). Both are the product brain's (ads-write-gate.ts PRODUCT_BRAIN_ACTOR + "-<what>"), so
 *              the gate's one-owner-per-lever check lets them through only on a lever the brain owns; the gate also
 *              refuses them on a lever the brain does not own (moneyActorRefusal there).
 *   ladder     a rung is a budget write by MONEY_BUDGETS_ACTOR whose evidence says `brain.layer = 'ladder'`: the brain's
 *              raise for the rest of today (Adbrew's hourly ladder, +25 % … +100 % of the base), on top of the day's base.
 *   exception  the day-move bound (−30 % / +50 % or +€10 around the day's opening) holds every writer. For the brain's
 *              own ladder alone, a rung may pass the CEILING: an "intraday give-back" — at most LADDER_GATE_MAX_PCT of
 *              today's base, where the base itself lies inside the bound. Nothing else is exempt: the floor, the bounds,
 *              the spend ceilings, the value cap and every other check still bind, and only the brain's actor on a lever
 *              the brain owns gets it. Another writer with the same numbers is refused, as before.
 *   give-back  the ladder is given back at the next budget day: the day after a ladder "opens at the base" for the brain
 *              — its opening is the base the ladder climbed from, not the laddered budget (brainDayOpeningCents) — so its
 *              first write takes the budget back down without passing the floor. For every other writer the day opens
 *              exactly as before (loggedDayOpeningCents).
 *   from logs  never from a flag on the write: the gate reads who wrote each row of the campaign's budget log and what
 *              its evidence says, as 6.1 reads a budget schedule's give-back. A row the gate refused or Amazon failed
 *              (SKIPPED, FAILED) moved nothing and is passed over; a superseded row's value went out inside the newer one.
 */

/** The money writer's actor for a campaign's daily budget (the product brain's, ads-write-gate.ts PRODUCT_BRAIN_ACTOR). */
export const MONEY_BUDGETS_ACTOR = 'automation:ads-brain-budgets'
/** The money writer's actor for an Amazon portfolio cap. */
export const MONEY_PORTFOLIO_ACTOR = 'automation:ads-brain-portfolio'
export const MONEY_ACTORS: readonly string[] = [MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR]
export const isMoneyActor = (actor: string | null | undefined): boolean => !!actor && MONEY_ACTORS.includes(actor)

/** The evidence layer of a ladder rung, of the day's base move, and of a portfolio cap the brain wrote. */
export const LADDER_LAYER = 'ladder'
export const BASE_LAYER = 'base'
export const CAP_LAYER = 'cap'

/**
 * The gate's hard limit on a rung: +100 % of the base (Amazon spends at most 2× a campaign's budget a day). The Owner's
 * own largest raise (intradayLadderMaxPct, 0–100) is the planner's to apply; the gate holds the outer bound.
 */
export const LADDER_GATE_MAX_PCT = 100

/** Statuses of a budget log row that moved nothing: the gate refused it, or Amazon failed it (the value was put back). */
const DID_NOT_STICK: ReadonlySet<string> = new Set(['SKIPPED', 'FAILED'])

/** One AD_BUDGET_UPDATE log row as the ladder reads it (cents; `layer` from the row's evidence). */
export interface MoneyLogStep {
  actor: string | null
  beforeCents: number | null
  afterCents: number | null
  /** evidence.brain.layer, when the row carries one. */
  layer: string | null
  /** False for a row the gate refused or Amazon failed: it moved nothing. */
  stuck: boolean
}

/**
 * Read one log row. ⚠ payloadBefore / payloadAfter `dailyBudget` is EUROS (ads-budget-giveback.ts budgetLogStepOf).
 */
export function moneyLogStepOf(row: { userId: string | null; payloadBefore: unknown; payloadAfter: unknown; evidence?: unknown; amazonResponseStatus?: string | null }): MoneyLogStep {
  const cents = (payload: unknown): number | null => {
    const raw = (payload as { dailyBudget?: unknown } | null)?.dailyBudget
    const euros = raw == null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(euros) ? Math.round(euros * 100) : null
  }
  const layer = (row.evidence as { brain?: { layer?: unknown } } | null)?.brain?.layer
  return {
    actor: row.userId,
    beforeCents: cents(row.payloadBefore),
    afterCents: cents(row.payloadAfter),
    layer: typeof layer === 'string' ? layer : null,
    stuck: !DID_NOT_STICK.has(String(row.amazonResponseStatus ?? '')),
  }
}

/** A rung of the brain's ladder: the money writer's budget row marked `ladder`, which raised the budget. */
export function isLadderRung(s: MoneyLogStep): boolean {
  return s.actor === MONEY_BUDGETS_ACTOR && s.layer === LADDER_LAYER && s.beforeCents != null && s.afterCents != null && s.afterCents > s.beforeCents
}

/**
 * The base a ladder that ended an earlier day climbed from, when the budget still stands on that ladder (`nowCents`: the
 * budget at the start of today — today's first row's `before`, else the budget held now). Walking the rows before today
 * newest first, each stuck rung must have set the value the walk stands on; the walk then steps to its `before`. A row
 * that moved nothing is passed over; any other row ends the run. Null when the newest stuck row before today is not a
 * rung, or the chain does not reach `nowCents`.
 */
export function carriedLadderBase(beforeTodayNewestFirst: readonly MoneyLogStep[], nowCents: number | null): number | null {
  if (nowCents == null) return null
  let at = nowCents
  let rungs = 0
  for (const s of beforeTodayNewestFirst) {
    if (!s.stuck) continue
    if (!isLadderRung(s) || s.afterCents !== at) break
    at = s.beforeCents!
    rungs++
  }
  return rungs ? at : null
}

/**
 * The day's opening as the BRAIN's writes are measured: after a ladder that ended an earlier day, the base it climbed
 * from (the next day opens at the base); otherwise `standardOpening` — exactly what every other writer is measured
 * against (ads-write-gate.ts loggedDayOpeningCents, else the value the write replaces). Null when neither is known.
 */
export function brainDayOpeningCents(input: {
  todayOldestFirst: readonly MoneyLogStep[]
  beforeTodayNewestFirst: readonly MoneyLogStep[]
  /** The budget before this write (the queued change's old value), else the campaign's budget. */
  currentCents: number | null
  standardOpening: number | null
}): { openingCents: number | null; carried: boolean } {
  const first = input.todayOldestFirst[0]
  const startOfDay = first ? first.beforeCents : input.currentCents
  const carried = carriedLadderBase(input.beforeTodayNewestFirst, startOfDay)
  if (carried != null) return { openingCents: carried, carried: true }
  return { openingCents: input.standardOpening ?? input.currentCents, carried: false }
}

/**
 * The base the brain's ladder climbs from today: the day's opening, then the value each of today's stuck rows set,
 * except the brain's own rungs (a rung is on top of the base, never the base). Pure.
 */
export function ladderBaseCents(openingCents: number, todayOldestFirst: readonly MoneyLogStep[]): number {
  let base = openingCents
  for (const s of todayOldestFirst) {
    if (!s.stuck || isLadderRung(s) || s.afterCents == null) continue
    base = s.afterCents
  }
  return base
}

/**
 * The gate's verdict on one budget write by the brain (MONEY_BUDGETS_ACTOR) against the day-move bound: inside it →
 * allowed; above the ceiling → allowed only as a ladder rung (an intraday give-back) at most LADDER_GATE_MAX_PCT of
 * today's base, the base itself inside the bound; below the floor → refused (a give-back of yesterday's ladder is
 * already inside, because the day opens at the base). Pure.
 */
export function brainDayMoveVerdict(a: { intendedCents: number; floorCents: number; ceilCents: number; baseCents: number }): { allowed: boolean; exception: 'intraday-give-back' | null; limitCents: number | null; why: string } {
  const { intendedCents, floorCents, ceilCents, baseCents } = a
  if (intendedCents >= floorCents && intendedCents <= ceilCents) return { allowed: true, exception: null, limitCents: null, why: 'inside the day-move bound' }
  if (intendedCents < floorCents) return { allowed: false, exception: null, limitCents: null, why: 'below the day-move floor' }
  const baseInside = baseCents >= floorCents && baseCents <= ceilCents
  const limitCents = baseCents + Math.round((baseCents * LADDER_GATE_MAX_PCT) / 100)
  if (baseInside && intendedCents <= limitCents) {
    return { allowed: true, exception: 'intraday-give-back', limitCents, why: `above the day-move ceiling, allowed as the brain's intraday ladder: at most +${LADDER_GATE_MAX_PCT} % of today's base, given back at the next budget day` }
  }
  return {
    allowed: false, exception: null, limitCents: baseInside ? limitCents : null,
    why: baseInside ? `above the day-move ceiling and beyond the brain's ladder (+${LADDER_GATE_MAX_PCT} % of today's base)` : 'above the day-move ceiling, and today\'s base itself is outside the day-move bound',
  }
}

/**
 * Where a campaign's budget stands against the brain's ladder now (for the plan and the writer): `today` — the budget is
 * today's rung(s) on top of `baseCents`; `before` — a ladder of an earlier day still stands (its give-back is owed);
 * null — no ladder under the budget. Pure.
 */
export function ladderNowOf(input: { todayOldestFirst: readonly MoneyLogStep[]; beforeTodayNewestFirst: readonly MoneyLogStep[]; currentCents: number; openingCents: number; carried: boolean }): { baseCents: number; fromDay: 'today' | 'before' } | null {
  const stuck = input.todayOldestFirst.filter((s) => s.stuck)
  const last = stuck[stuck.length - 1]
  if (last && isLadderRung(last) && last.afterCents === input.currentCents) return { baseCents: ladderBaseCents(input.openingCents, input.todayOldestFirst), fromDay: 'today' }
  if (!stuck.length && input.carried && input.currentCents !== input.openingCents) return { baseCents: input.openingCents, fromDay: 'before' }
  return null
}

/** What the brain asked today on one campaign, whatever became of it (a refused ask is not asked again the same day). */
export function brainAskedToday(todayOldestFirst: readonly MoneyLogStep[]): { baseAsked: boolean; ladderAskedCents: number | null } {
  let baseAsked = false
  let ladderAskedCents: number | null = null
  for (const s of todayOldestFirst) {
    if (s.actor !== MONEY_BUDGETS_ACTOR) continue
    if (s.layer === LADDER_LAYER) ladderAskedCents = Math.max(ladderAskedCents ?? 0, s.afterCents ?? 0)
    else baseAsked = true
  }
  return { baseAsked, ladderAskedCents }
}

/**
 * One campaign's budget log of today as the money writer reads it (brain/budget-load.ts): what the brain already asked
 * (whatever became of it), and the other writers that moved the budget today — a person, a safety owner, an undo. The
 * brain leaves a budget another writer moved today until the next budget day.
 */
export interface CampaignTodayFacts {
  baseAsked: boolean
  ladderAskedCents: number | null
  /** The actors of today's stuck budget rows other than the brain's money writer (oldest first, each once). */
  others: string[]
}

/** Today's facts of one campaign from its budget log of today (oldest first). Pure. */
export function campaignTodayOf(todayOldestFirst: readonly MoneyLogStep[]): CampaignTodayFacts {
  const others = [...new Set(todayOldestFirst.filter((s) => s.stuck && s.actor !== MONEY_BUDGETS_ACTOR).map((s) => s.actor ?? 'an unnamed writer'))]
  return { ...brainAskedToday(todayOldestFirst), others }
}
