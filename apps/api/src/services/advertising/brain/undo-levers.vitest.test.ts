/**
 * ONE BRAIN AB-15 — auto-undo per lever (brain/undo-levers.ts, brain/lever-holds.ts), pure. Per lever: which brain write
 * is judged (and which never is), the verdict on its metric and window, what auto-undo does at each level (the ceiling,
 * the kill switch, the shared daily cap), and the hold after an undo (its days, what it blocks, when it ends).
 *
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { AUTO_UNDO_DEFAULTS } from '../ads-auto-undo-thresholds.js'
import { BRAIN_NEGATIVES_ACTOR, BRAIN_STATE_ACTOR } from '../ads-write-gate.js'
import { BRAIN_ACTOR } from '../bid-brain/live.js'
import { MONEY_BUDGETS_ACTOR, MONEY_PORTFOLIO_ACTOR } from './budget-ladder.js'
import { campaignHoldWhy, holdNegatives } from './lever-holds.js'
import {
  BRAIN_UNDO_RULES, blocksHeldTerm, brainChangeOf, decideBrainAction, holdsOf, judgeBudgetRaise, judgeNegative, judgePause, judgePortfolioRaise, judgeResume,
  judgeStrategySwitch, periodOf, ruleOf, windowsAround, type BrainChangeRow, type UndoneChange,
} from './undo-levers.js'

const T = AUTO_UNDO_DEFAULTS
const AT = new Date('2026-09-20T10:00:00Z')
const row = (over: Partial<BrainChangeRow>): BrainChangeRow => ({ id: 'l1', entityType: 'CAMPAIGN', entityId: 'c1', actionType: 'update_campaign', userId: MONEY_BUDGETS_ACTOR, payloadBefore: {}, payloadAfter: {}, evidence: null, createdAt: AT, ...over })
const P = (spendCents: number, salesCents: number, clicks: number, orders: number, days = 7) => periodOf({ spendCents, salesCents, clicks, orders }, days)
const BAND = { aim: 0.2, lo: 0.15, hi: 0.25 }

describe('AB-15 — which brain write is judged (pure)', () => {
  it('budgets: a base raise by the money writer; a ladder rung and a cut never', () => {
    const base = { payloadBefore: { dailyBudget: 10 }, payloadAfter: { dailyBudget: 15 }, evidence: { brain: { layer: 'base' } } }
    expect(brainChangeOf(row(base))).toEqual({ lever: 'budgets', kind: 'raise', campaignId: 'c1', fromCents: 1_000, toCents: 1_500 })
    expect(brainChangeOf(row({ ...base, evidence: { brain: { layer: 'ladder' } } }))).toEqual({ skip: 'a ladder rung: the brain gives it back the next budget day' })
    expect(brainChangeOf(row({ payloadBefore: { dailyBudget: 15 }, payloadAfter: { dailyBudget: 10 } }))).toMatchObject({ skip: expect.stringMatching(/pace's brake/) })
  })

  it('portfolio cap: a raise by the money writer; a first cap or a lower one never', () => {
    const r = (before: unknown, after: unknown) => brainChangeOf(row({ userId: MONEY_PORTFOLIO_ACTOR, entityType: 'PORTFOLIO', entityId: 'pf-row', payloadBefore: { portfolioId: 'pf-1', budgetAmount: before }, payloadAfter: { portfolioId: 'pf-1', budgetAmount: after } }))
    expect(r(300, 400)).toEqual({ lever: 'portfolioCap', kind: 'raise', portfolioRowId: 'pf-row', externalPortfolioId: 'pf-1', fromCents: 30_000, toCents: 40_000 })
    expect(r(null, 400)).toMatchObject({ skip: expect.stringMatching(/first cap/) })
    expect(r(400, 300)).toMatchObject({ skip: expect.stringMatching(/lower cap/) })
  })

  it('state: the brain\'s pause and its resume', () => {
    const r = (from: string, to: string) => brainChangeOf(row({ userId: BRAIN_STATE_ACTOR, payloadBefore: { status: from }, payloadAfter: { status: to } }))
    expect(r('ENABLED', 'PAUSED')).toEqual({ lever: 'state', kind: 'pause', campaignId: 'c1', from: 'ENABLED', to: 'PAUSED' })
    expect(r('PAUSED', 'ENABLED')).toEqual({ lever: 'state', kind: 'resume', campaignId: 'c1', from: 'PAUSED', to: 'ENABLED' })
    expect(r('ENABLED', 'ARCHIVED')).toMatchObject({ skip: expect.any(String) })
  })

  it('negatives: an add by the brain; a retire never (archive is terminal)', () => {
    expect(brainChangeOf(row({ userId: BRAIN_NEGATIVES_ACTOR, entityType: 'AD_TARGET', entityId: 'n1', actionType: 'create_negative_keyword', payloadAfter: { keywordText: 'test term', matchType: 'NEGATIVE_EXACT' } })))
      .toEqual({ lever: 'negatives', kind: 'add', negativeId: 'n1', text: 'test term' })
    expect(brainChangeOf(row({ userId: BRAIN_NEGATIVES_ACTOR, entityType: 'AD_TARGET', entityId: 'n1', actionType: 'retire_negative' }))).toMatchObject({ skip: expect.stringMatching(/terminal/) })
  })

  it('bidding strategy: a switch outside a stop; the stop recipe\'s switch and its give-back never', () => {
    const sw = { userId: BRAIN_ACTOR, payloadBefore: { biddingStrategy: 'LEGACY_FOR_SALES' }, payloadAfter: { biddingStrategy: 'AUTO_FOR_SALES' } }
    expect(brainChangeOf(row({ ...sw, evidence: { brain: { layer: 'switch' } } }))).toEqual({ lever: 'biddingStrategy', kind: 'switch', campaignId: 'c1', from: 'LEGACY_FOR_SALES', to: 'AUTO_FOR_SALES' })
    for (const layer of ['stop', 'stock', 'min_bid_hour', 'restore']) expect(brainChangeOf(row({ ...sw, evidence: { brain: { layer } } })), layer).toMatchObject({ skip: expect.stringMatching(/stop/) })
    // The bid brain's keyword bids are not this pass's (A19 judges them as before).
    expect(brainChangeOf(row({ userId: BRAIN_ACTOR, entityType: 'AD_TARGET', payloadBefore: { bidCents: 40 }, payloadAfter: { bidCents: 50 } }))).toMatchObject({ skip: expect.any(String) })
    // Another writer's change is never this pass's.
    expect(brainChangeOf(row({ userId: 'automation:auto-bid' }))).toEqual({ skip: 'not the brain\'s write' })
  })
})

describe('AB-15 — the windows (pure)', () => {
  it('equal days before and after; waits for its least settled days; reads at most its most', () => {
    const rule = ruleOf('budgets', 'raise')
    expect(windowsAround('2026-09-20', '2026-09-22', rule)).toBeNull()
    expect(windowsAround('2026-09-20', '2026-09-23', rule)).toEqual({ days: 3, before: { from: '2026-09-17', to: '2026-09-19' }, after: { from: '2026-09-21', to: '2026-09-23' } })
    expect(windowsAround('2026-09-20', '2026-10-05', rule)?.days).toBe(7)
  })
})

describe('AB-15 — the verdict per lever (pure)', () => {
  it('budgets: only spend (no order) or orders past the band is worse; orders at the target or a budget that did not bind is not', () => {
    expect(judgeBudgetRaise({ before: P(1_000, 4_000, 30, 2), after: P(2_000, 0, 40, 0), band: BAND, t: T })).toMatchObject({ verdict: 'worse', why: expect.stringMatching(/^only spend/) })
    expect(judgeBudgetRaise({ before: P(1_000, 5_000, 30, 2), after: P(2_000, 4_000, 40, 1), band: BAND, t: T })).toMatchObject({ verdict: 'worse', why: expect.stringMatching(/above the target/) })
    expect(judgeBudgetRaise({ before: P(1_000, 5_000, 30, 2), after: P(1_800, 9_000, 40, 4), band: BAND, t: T })).toMatchObject({ verdict: 'not_worse' })
    expect(judgeBudgetRaise({ before: P(2_000, 0, 40, 0), after: P(1_500, 0, 30, 0), band: BAND, t: T })).toMatchObject({ verdict: 'not_worse', why: expect.stringMatching(/did not bind/) })
    expect(judgeBudgetRaise({ before: P(1_000, 0, 5, 0), after: P(1_500, 0, 5, 0), band: BAND, t: T })).toMatchObject({ verdict: 'not_enough_data' })
  })

  it('portfolio cap: worse only when the spend the raise let past the old cap brought nothing at the target', () => {
    expect(judgePortfolioRaise({ monthSpendCents: 20_000, oldCapCents: 30_000, since: P(5_000, 0, 50, 0), band: BAND, t: T })).toMatchObject({ verdict: 'not_worse', why: expect.stringMatching(/never bound/) })
    expect(judgePortfolioRaise({ monthSpendCents: 35_000, oldCapCents: 30_000, since: P(5_000, 0, 50, 0), band: BAND, t: T })).toMatchObject({ verdict: 'worse' })
    expect(judgePortfolioRaise({ monthSpendCents: 35_000, oldCapCents: 30_000, since: P(5_000, 25_000, 50, 4), band: BAND, t: T })).toMatchObject({ verdict: 'not_worse' })
  })

  it('state: a pause whose cause ended costs the sales it made; a resume into waste', () => {
    expect(judgePause({ causeEnded: true, causeWhy: 'back in stock', before: P(1_000, 5_000, 30, 3) })).toMatchObject({ verdict: 'worse', why: expect.stringMatching(/costs sales/) })
    expect(judgePause({ causeEnded: false, causeWhy: 'out of stock', before: P(1_000, 5_000, 30, 3) })).toMatchObject({ verdict: 'not_worse', why: 'its stop goes on: out of stock' })
    expect(judgePause({ causeEnded: true, causeWhy: null, before: P(1_000, 0, 30, 0) })).toMatchObject({ verdict: 'not_worse' })
    expect(judgePause({ causeEnded: null, causeWhy: null, before: P(1_000, 5_000, 30, 3) })).toMatchObject({ verdict: 'not_worse' })
    expect(judgeResume({ after: P(2_000, 0, 40, 0), band: BAND, t: T })).toMatchObject({ verdict: 'worse', why: expect.stringMatching(/into waste/) })
    expect(judgeResume({ after: P(2_000, 4_000, 40, 1), band: BAND, t: T })).toMatchObject({ verdict: 'worse' })
    expect(judgeResume({ after: P(2_000, 10_000, 40, 3), band: BAND, t: T })).toMatchObject({ verdict: 'not_worse' })
  })

  it('negatives: a term a sibling or the market shows converting (2 orders, inside the band top) is worse to keep negated', () => {
    expect(judgeNegative({ elsewhere: P(1_000, 8_000, 20, 2, 14), band: BAND })).toMatchObject({ verdict: 'worse', why: expect.stringMatching(/converts elsewhere/) })
    expect(judgeNegative({ elsewhere: P(1_000, 2_000, 20, 2, 14), band: BAND })).toMatchObject({ verdict: 'not_worse', why: expect.stringMatching(/above the product's band top/) })
    expect(judgeNegative({ elsewhere: P(500, 1_000, 10, 1, 14), band: BAND })).toMatchObject({ verdict: 'not_worse' })
    expect(judgeNegative({ elsewhere: P(0, 0, 0, 0, 14), band: null })).toMatchObject({ verdict: 'not_worse', why: expect.stringMatching(/no other product/) })
  })

  it('bidding strategy: ACoS up with sales flat, or up-and-down spending more with sales flat', () => {
    expect(judgeStrategySwitch({ before: P(1_000, 5_000, 40, 3), after: P(1_500, 4_000, 40, 2), to: 'LEGACY_FOR_SALES', t: T })).toMatchObject({ verdict: 'worse' })
    expect(judgeStrategySwitch({ before: P(1_000, 5_000, 40, 3), after: P(1_700, 5_000, 40, 3), to: 'AUTO_FOR_SALES', t: T })).toMatchObject({ verdict: 'worse' })
    expect(judgeStrategySwitch({ before: P(1_000, 5_000, 40, 3), after: P(1_200, 6_000, 40, 4), to: 'AUTO_FOR_SALES', t: T })).toMatchObject({ verdict: 'not_worse' })
  })
})

describe('AB-15 — what auto-undo does (pure)', () => {
  const at = (level: 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO', over: Partial<Parameters<typeof decideBrainAction>[0]> = {}) =>
    decideBrainAction({ verdict: 'worse', level, rule: { ceiling: 'AUTO' }, kill: null, capLeft: 5, cap: 5, market: 'IT', ...over }).action
  it('OBSERVE would undo, PROPOSE asks, AUTO undoes — only clearly worse', () => {
    expect([at('OBSERVE'), at('PROPOSE'), at('AUTO'), at('OFF')]).toEqual(['would_undo', 'proposed', 'undone', 'none'])
    expect(at('AUTO', { verdict: 'not_worse' })).toBe('none')
    expect(at('AUTO', { verdict: 'not_enough_data' })).toBe('none')
  })
  it('AUTO asks a person where the lever\'s rule says so, or where the Owner\'s kill switch stops the lever; the cap holds', () => {
    expect(at('AUTO', { rule: { ceiling: 'PROPOSE' } })).toBe('proposed')
    expect(at('AUTO', { kill: 'stopped by the Owner\'s kill switch' })).toBe('proposed')
    expect(at('AUTO', { capLeft: 0 })).toBe('held')
    expect(at('OBSERVE', { capLeft: 0 })).toBe('held')
  })
  it('the ceilings: an undo that only lowers spend may run alone; a resume, a revive, a cap back and a strategy back always ask', () => {
    expect(Object.fromEntries(Object.entries(BRAIN_UNDO_RULES).map(([k, r]) => [k, r.ceiling]))).toEqual({
      budgets: 'AUTO', portfolioCap: 'PROPOSE', state: 'PROPOSE', 'state:pause': 'PROPOSE', 'state:resume': 'AUTO', negatives: 'PROPOSE', harvest: 'AUTO', biddingStrategy: 'PROPOSE',
    })
    expect(ruleOf('state', 'pause').ceiling).toBe('PROPOSE')
    expect(ruleOf('state', 'resume').ceiling).toBe('AUTO')
    // Batch 2 review fix — a revive adds spend (the term serves again at its sources' bids): at AUTO it asks a person.
    expect(decideBrainAction({ verdict: 'worse', level: 'AUTO', rule: ruleOf('negatives', 'add'), kill: null, capLeft: 5, cap: 5, market: 'IT' })).toMatchObject({ action: 'proposed', reason: expect.stringMatching(/always goes to a person \(it adds spend/) })
    expect(ruleOf('negatives', 'add').undo).toMatch(/always a person: it adds spend/)
  })
})

describe('AB-15 — the hold after an undo (pure)', () => {
  const NOW = new Date('2026-10-08T12:00:00Z')
  const undone = (over: Partial<UndoneChange>): UndoneChange => ({ id: 'j1', lever: 'budgets', kind: 'raise', entityId: 'c1', campaignId: 'c1', term: null, externalPortfolioId: null, actionAt: new Date('2026-10-05T06:15:00Z'), ...over })

  it('budgets and state hold the campaign 7 days; a state hold blocks only the action put back; it ends by itself', () => {
    const b = holdsOf([undone({})], 'budgets', NOW)
    expect(b.campaigns.get('c1')).toMatchObject({ blocks: null, until: '2026-10-12T06:15:00.000Z', why: expect.stringMatching(/judgement j1.*held until 2026-10-12/) })
    expect(holdsOf([undone({})], 'budgets', new Date('2026-10-12T07:00:00Z')).campaigns.size).toBe(0)
    const s = holdsOf([undone({ lever: 'state', kind: 'pause' }), undone({ id: 'j2', lever: 'state', kind: 'resume', campaignId: 'c2' })], 'state', NOW)
    expect([s.campaigns.get('c1')?.blocks, s.campaigns.get('c2')?.blocks]).toEqual(['pause', 'resume'])
    const h = { kill: null, ...s }
    expect(campaignHoldWhy(h, 'c1', 'pause')).toMatch(/held until/)
    expect(campaignHoldWhy(h, 'c1', 'resume')).toBeNull()
    expect(campaignHoldWhy(h, 'c3', 'pause')).toBeNull()
    expect(campaignHoldWhy({ ...h, kill: 'stopped by the Owner\'s kill switch' }, 'c3', 'resume')).toBe('stopped by the Owner\'s kill switch')
  })

  it('negatives hold the term 30 days in the product; a portfolio cap holds the portfolio', () => {
    const n = holdsOf([undone({ lever: 'negatives', kind: 'add', entityId: 'n1', term: 'Test  Term' })], 'negatives', NOW)
    expect([...n.terms.keys()]).toEqual(['test term'])
    expect(n.terms.get('test term')?.until).toBe('2026-11-04T06:15:00.000Z')
    const p = holdsOf([undone({ lever: 'portfolioCap', entityId: 'pf-row', externalPortfolioId: 'pf-1' })], 'portfolioCap', NOW)
    expect([...p.portfolios.keys()]).toEqual(['pf-1'])
  })

  it('the negatives run: a kill holds every item; a held term holds an exact add of it and a phrase that would block it', () => {
    const plan = { items: [
      { action: 'ADD', text: 'test term', match: 'EXACT', heldBy: null },
      { action: 'ADD', text: 'term', match: 'PHRASE', heldBy: null },
      { action: 'ADD', text: 'other words', match: 'EXACT', heldBy: null },
      { action: 'RETIRE', text: 'test term', match: 'EXACT', heldBy: null },
    ] }
    const held = holdNegatives(plan, { kill: null, terms: new Map([['test term', { why: 'auto-undo revived it', until: 'x' }]]) })
    expect(held.items.map((i) => i.heldBy)).toEqual(['auto-undo revived it', 'auto-undo revived it', null, null])
    expect(holdNegatives(plan, { kill: 'stopped', terms: new Map() }).items.every((i) => i.heldBy === 'stopped')).toBe(true)
    expect(holdNegatives(plan, { kill: null, terms: new Map() })).toBe(plan)
    expect(blocksHeldTerm('B0TESTASIN', 'PRODUCT', new Map([['b0testasin', 1]]))).toBe('b0testasin')
  })
})
