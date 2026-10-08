/**
 * ONE BRAIN AB-8 — the intraday ladder's give-back exception, read from the budget log (budget-ladder.ts): the brain's day
 * opens at the base after its ladder of an earlier day; today's base excludes its rungs; a rung may pass the day-move
 * ceiling up to +100 % of the base (the base inside the bound), never the floor; a row that moved nothing is passed over.
 * Every value is made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import {
  brainAskedToday, brainDayMoveVerdict, brainDayOpeningCents, campaignTodayOf, carriedLadderBase, isLadderRung, isMoneyActor, ladderBaseCents, ladderNowOf,
  MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR, moneyLogStepOf, type MoneyLogStep,
} from './budget-ladder.js'

const step = (actor: string | null, before: number, after: number, layer: string | null = null, stuck = true): MoneyLogStep => ({ actor, beforeCents: before, afterCents: after, layer, stuck })
const brain = (before: number, after: number, layer: 'base' | 'ladder') => step(MONEY_BUDGETS_ACTOR, before, after, layer)

describe('reading the budget log', () => {
  it('a row: euros to cents, the evidence layer, and whether it moved anything', () => {
    expect(moneyLogStepOf({ userId: MONEY_BUDGETS_ACTOR, payloadBefore: { dailyBudget: 40 }, payloadAfter: { dailyBudget: '60.5' }, evidence: { brain: { layer: 'ladder' } }, amazonResponseStatus: 'SUCCESS' }))
      .toEqual({ actor: MONEY_BUDGETS_ACTOR, beforeCents: 4_000, afterCents: 6_050, layer: 'ladder', stuck: true })
    expect(moneyLogStepOf({ userId: 'user:owner', payloadBefore: null, payloadAfter: { dailyBudget: '' }, amazonResponseStatus: 'SKIPPED' }))
      .toEqual({ actor: 'user:owner', beforeCents: null, afterCents: null, layer: null, stuck: false })
    expect(moneyLogStepOf({ userId: null, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'FAILED' }).stuck).toBe(false)
    // A superseded row's value went out inside the newer one: it counts.
    expect(moneyLogStepOf({ userId: null, payloadBefore: {}, payloadAfter: {}, amazonResponseStatus: 'SUPERSEDED' }).stuck).toBe(true)
  })

  it('the money actors, and what a rung is: the brain\'s budget row marked ladder that raised the budget', () => {
    expect([MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR, 'automation:ads-brain', 'automation:ads-brain-budgetsx', null].map(isMoneyActor)).toEqual([true, true, false, false, false])
    expect(isLadderRung(brain(4_000, 6_000, 'ladder'))).toBe(true)
    expect(isLadderRung(brain(4_000, 6_000, 'base'))).toBe(false)
    expect(isLadderRung(step('automation:rule-x', 4_000, 6_000, 'ladder'))).toBe(false)
    expect(isLadderRung(brain(6_000, 4_000, 'ladder'))).toBe(false)
  })
})

describe('the next day opens at the base', () => {
  // Yesterday: base €40 → €50, then two rungs €50 → €62.50 → €100 (newest first below).
  const yesterday = [brain(6_250, 10_000, 'ladder'), brain(5_000, 6_250, 'ladder'), brain(4_000, 5_000, 'base')]

  it('a ladder that ended an earlier day: its base, while the budget still stands on it', () => {
    expect(carriedLadderBase(yesterday, 10_000)).toBe(5_000)
    // Someone moved it since (the budget is not the ladder's top any more): no carry.
    expect(carriedLadderBase(yesterday, 9_000)).toBeNull()
    // The newest row is not a rung: no carry.
    expect(carriedLadderBase([step('user:owner', 10_000, 9_000), ...yesterday], 9_000)).toBeNull()
    // A refused rung moved nothing: passed over, the chain goes on from the one below it.
    expect(carriedLadderBase([step(MONEY_BUDGETS_ACTOR, 6_250, 12_000, 'ladder', false), ...yesterday.slice(1)], 6_250)).toBe(5_000)
    expect(carriedLadderBase([], 10_000)).toBeNull()
  })

  it('the brain\'s opening: the carried base; otherwise the standard opening every writer has', () => {
    expect(brainDayOpeningCents({ todayOldestFirst: [], beforeTodayNewestFirst: yesterday, currentCents: 10_000, standardOpening: null })).toEqual({ openingCents: 5_000, carried: true })
    // The brain's first write today (the give-back and the new base move): the day still opens at the base.
    expect(brainDayOpeningCents({ todayOldestFirst: [brain(10_000, 4_500, 'base')], beforeTodayNewestFirst: yesterday, currentCents: 4_500, standardOpening: 10_000 })).toEqual({ openingCents: 5_000, carried: true })
    expect(brainDayOpeningCents({ todayOldestFirst: [step('user:owner', 3_000, 3_500)], beforeTodayNewestFirst: [], currentCents: 3_500, standardOpening: 3_000 })).toEqual({ openingCents: 3_000, carried: false })
    expect(brainDayOpeningCents({ todayOldestFirst: [], beforeTodayNewestFirst: [], currentCents: 3_500, standardOpening: null })).toEqual({ openingCents: 3_500, carried: false })
  })

  it('where the budget stands on the ladder now: today\'s rungs on their base, an earlier day\'s owed, or none', () => {
    const today = [brain(4_000, 5_000, 'base'), brain(5_000, 7_500, 'ladder')]
    expect(ladderNowOf({ todayOldestFirst: today, beforeTodayNewestFirst: [], currentCents: 7_500, openingCents: 4_000, carried: false })).toEqual({ baseCents: 5_000, fromDay: 'today' })
    expect(ladderNowOf({ todayOldestFirst: [], beforeTodayNewestFirst: yesterday, currentCents: 10_000, openingCents: 5_000, carried: true })).toEqual({ baseCents: 5_000, fromDay: 'before' })
    expect(ladderNowOf({ todayOldestFirst: [brain(10_000, 4_500, 'base')], beforeTodayNewestFirst: yesterday, currentCents: 4_500, openingCents: 5_000, carried: true })).toBeNull()
    expect(ladderNowOf({ todayOldestFirst: [], beforeTodayNewestFirst: [], currentCents: 4_000, openingCents: 4_000, carried: false })).toBeNull()
  })
})

describe('the gate\'s verdict on the brain\'s own budget write', () => {
  // Opening €40: the bound is €28 … €60 (−30 % / +50 %).
  const bound = { floorCents: 2_800, ceilCents: 6_000 }

  it('today\'s base: the opening, then each stuck row that is not a rung', () => {
    expect(ladderBaseCents(4_000, [])).toBe(4_000)
    expect(ladderBaseCents(4_000, [brain(4_000, 5_000, 'base'), brain(5_000, 6_250, 'ladder'), brain(6_250, 7_500, 'ladder')])).toBe(5_000)
    expect(ladderBaseCents(4_000, [step(MONEY_BUDGETS_ACTOR, 4_000, 5_500, 'base', false)])).toBe(4_000)
  })

  it('inside the bound: allowed, no exception', () => {
    expect(brainDayMoveVerdict({ intendedCents: 5_500, baseCents: 4_000, ...bound })).toMatchObject({ allowed: true, exception: null })
  })

  it('above the ceiling: a rung up to +100 % of today\'s base passes as the intraday give-back; beyond it, refused', () => {
    expect(brainDayMoveVerdict({ intendedCents: 8_000, baseCents: 4_000, ...bound })).toMatchObject({ allowed: true, exception: 'intraday-give-back', limitCents: 8_000 })
    expect(brainDayMoveVerdict({ intendedCents: 8_001, baseCents: 4_000, ...bound })).toMatchObject({ allowed: false, exception: null, limitCents: 8_000 })
    expect(brainDayMoveVerdict({ intendedCents: 10_000, baseCents: 5_000, ...bound })).toMatchObject({ allowed: true, exception: 'intraday-give-back' })
  })

  it('a base outside the bound earns no exception; the floor binds the brain too', () => {
    expect(brainDayMoveVerdict({ intendedCents: 7_000, baseCents: 6_500, ...bound })).toMatchObject({ allowed: false, limitCents: null, why: expect.stringMatching(/base itself is outside/) })
    expect(brainDayMoveVerdict({ intendedCents: 2_000, baseCents: 4_000, ...bound })).toMatchObject({ allowed: false, why: 'below the day-move floor' })
  })
})

describe('what the brain asked today, and who else moved the budget', () => {
  it('a base asked (refused or not), the highest rung asked; other writers once each, stuck only', () => {
    const rows = [step('user:owner', 4_000, 4_500), step(MONEY_BUDGETS_ACTOR, 4_500, 5_000, 'base', false), brain(5_000, 6_250, 'ladder'), step('automation:auto-undo', 6_250, 5_000), step('user:owner', 5_000, 5_100), step('automation:rule-x', 5_100, 9_000, null, false)]
    expect(brainAskedToday(rows)).toEqual({ baseAsked: true, ladderAskedCents: 6_250 })
    expect(campaignTodayOf(rows)).toEqual({ baseAsked: true, ladderAskedCents: 6_250, others: ['user:owner', 'automation:auto-undo'] })
    expect(campaignTodayOf([])).toEqual({ baseAsked: false, ladderAskedCents: null, others: [] })
  })
})
