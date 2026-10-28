/**
 * Reviews PR J — the Timing tests section, the rule editor's A/B card, the Rules A/B marks and the Queue's A/B rows lay
 * out what the API answers; this proves the form, the held reasons, the rows and the marks. Lane N6: the form offers an
 * Amazon market or the Shopify store; eBay and Etsy are listed held, each with why.
 */
import { describe, expect, it } from 'vitest'
import { STANDARD_REQUEST_TEXT } from '@nexus/shared/review-request-text'
import {
  abAppliedWords,
  NEW_TEST_FORM,
  NOT_OFFERED_WORDS,
  abBadge,
  abPartner,
  abResultRows,
  abRows,
  abStartHeld,
  abTestOf,
  abTile,
  appliedWords,
  armProgress,
  isAbApplied,
  sideTimingWords,
  armRows,
  daysHint,
  estimateQuery,
  holdoutHint,
  keepLabel,
  needMoreWords,
  newTestBody,
  newTestHeld,
  splitTests,
  statusPill,
  toggleDay,
  whereOf,
  whereOptions,
  type AbRule,
  type TimingTest,
  type TimingTestArm,
} from './timingTestsModel'

const arm = (id: string, position: number, over: Partial<TimingTestArm> = {}): TimingTestArm => ({
  id, label: `Day ${id}`, position, holdout: false, orders: 100, sent: 98, counted: 80, reviews: 6, delayDays: Number(id) || null, ruleId: null, ruleName: null, rate: 0.075, ...over,
})
const test = (over: Partial<TimingTest> = {}): TimingTest => ({
  id: 't1', kind: 'TIMING', channel: 'AMAZON', market: 'DE', productType: 'glove', ruleId: null, title: 'Amazon Germany · glove',
  groupsWords: 'Day 4 vs 7 · 10% holdout', holdoutPct: 10, status: 'RUNNING', statusWords: 'Running · week 2 of about 6', startedAt: '2026-10-12T00:00:00Z',
  endedAt: null, endsWhen: { ordersPerArm: 300, maxDays: 56 }, endsWords: 'At 300 orders per group, or after 8 weeks',
  arms: [arm('4', 0, { label: 'Day 4 (now)' }), arm('7', 1, { rate: 0.09, reviews: 9 }), arm('hold', 2, { label: 'Not asked (holdout)', holdout: true, sent: 0, delayDays: null, orders: 20, counted: 20, reviews: 0, rate: 0 })],
  result: { tooEarly: true, leaderId: '7', controlId: '4', sure: 54, liftPct: 20, words: 'Too early to call — day 7 leads, 54% sure.', sureWords: null, rates: {}, needMore: 20 },
  countedWords: 'Counted: …', approval: null, applied: null, kept: null, lastWords: null, applyWords: null,
  held: { start: 'The test is running.', stop: null, apply: 'The test has not finished: stop it, or wait until it ends.', keep: 'The test has not finished.' },
  ...over,
})

describe('New timing test', () => {
  it('days toggle sorted, at most four; the hint says each group’s share', () => {
    let f = toggleDay(NEW_TEST_FORM, 14)
    expect(f.days).toEqual([4, 7, 14])
    f = toggleDay(toggleDay(f, 10), 21)
    expect(f.days).toEqual([4, 7, 10, 14])
    expect(toggleDay(f, 4).days).toEqual([7, 10, 14])
    expect(daysHint({ ...f, holdoutPct: 10 })).toBe('4 groups and a 10% holdout: each group gets about 23% of the new orders, by order number.')
    expect(daysHint({ ...f, days: [4] })).toBe('Pick 2–4 days.')
  })

  it('held with the first thing to fix; the body the API takes', () => {
    expect(newTestHeld(NEW_TEST_FORM, { canManage: false, sending: false })).toMatch(/Manage reviews/)
    expect(newTestHeld({ ...NEW_TEST_FORM, days: [7] }, { canManage: true, sending: false })).toBe('Pick at least 2 days to compare.')
    expect(newTestHeld(NEW_TEST_FORM, { canManage: true, sending: true })).toBe('Sending…')
    expect(newTestHeld(NEW_TEST_FORM, { canManage: true, sending: false })).toBeNull()
    expect(newTestBody({ ...NEW_TEST_FORM, productType: ' Glove ' })).toEqual({ channel: 'AMAZON', market: 'DE', productType: 'glove', days: [4, 7], holdoutPct: 10 })
    expect(newTestBody(NEW_TEST_FORM).productType).toBeNull()
  })

  it('Shopify is offered (the whole store, no market); eBay and Etsy are listed held, each with why', () => {
    const options = whereOptions()
    expect(options.filter((o) => !o.heldReason).map((o) => [o.group, o.label])).toEqual([
      ['Amazon', 'Amazon Italy'], ['Amazon', 'Amazon Germany'], ['Amazon', 'Amazon France'], ['Amazon', 'Amazon Spain'], ['Amazon', 'Amazon UK'],
      ['Shopify', 'Shopify store'],
    ])
    expect(options.filter((o) => o.heldReason).map((o) => [o.label, o.heldReason])).toEqual([
      ['eBay', 'Not offered: Nexus asks no eBay buyer — eBay asks its buyers for feedback itself.'],
      ['Etsy', 'Not offered: Nexus sends Etsy buyers no review request, so there is no day to test.'],
    ])
    expect(NOT_OFFERED_WORDS).toMatch(/^eBay and Etsy are not offered: Nexus asks no eBay buyer/)
    // A held option never becomes a test.
    expect(whereOf('EBAY')).toBeNull()
    expect(newTestHeld({ ...NEW_TEST_FORM, where: 'ETSY' }, { canManage: true, sending: false })).toBe('Pick an Amazon market or Shopify to test.')

    const shopify = { ...NEW_TEST_FORM, where: 'SHOPIFY', productType: 'Glove', days: [4, 10], holdoutPct: 5 }
    expect(newTestHeld(shopify, { canManage: true, sending: false })).toBeNull()
    expect(newTestBody(shopify)).toEqual({ channel: 'SHOPIFY', productType: 'glove', days: [4, 10], holdoutPct: 5 })
    expect(estimateQuery(shopify)).toEqual({ channel: 'SHOPIFY', market: undefined, productType: 'Glove', days: '4,10', holdout: 5 })
    expect(estimateQuery(NEW_TEST_FORM)).toEqual({ channel: 'AMAZON', market: 'DE', productType: undefined, days: '4,7', holdout: 10 })
    expect(holdoutHint(shopify)).toBe('Shows what asking adds at all. These buyers get no review e-mail from Nexus.')
    expect(holdoutHint(NEW_TEST_FORM)).toBe('Shows what asking adds at all. These buyers get no request.')
  })
})

describe('a test’s card', () => {
  it('status pill per state', () => {
    expect(statusPill(test())).toEqual({ tone: 'info', label: 'Running · week 2 of about 6' })
    expect(statusPill(test({ status: 'WAITING_APPROVAL' }))).toEqual({ tone: 'warning', label: 'Waiting for approval' })
    expect(statusPill(test({ status: 'DONE' }))).toEqual({ tone: 'success', label: 'Finished' })
    expect(statusPill(test({ status: 'STOPPED' }))).toEqual({ tone: 'neutral', label: 'Stopped' })
  })

  it('rows: the leader is marked only once the test can be called; the holdout has no sent column', () => {
    expect(armRows(test()).some((r) => r.leader)).toBe(false)
    const called = test({ status: 'DONE', result: { ...test().result, tooEarly: false } })
    expect(armRows(called).map((r) => [r.leader, ...r.cells])).toEqual([
      [false, 'Day 4 (now)', '100', '98', '80', '6', '7.5%'],
      [true, 'Day 7', '100', '98', '80', '9', '9.0%'],
      [false, 'Not asked (holdout)', '20', '—', '20', '0', '0.0%'],
    ])
    expect(keepLabel(called)).toBe('Keep day 4')
  })

  it('an applied winner says what its day counts from (a Shopify rule may count from shipping)', () => {
    const applied = { armId: '7', label: 'Day 7', delayDays: 7, ruleId: 'r', ruleName: 'Shopify glove', created: true, at: '2026-10-20T00:00:00Z', by: null }
    expect(appliedWords(applied)).toBe('“Shopify glove” asks on day 7 after delivery.')
    expect(appliedWords({ ...applied, countsFrom: 'shipping' })).toBe('“Shopify glove” asks on day 7 after shipping.')
  })

  it('progress towards the end, too-early words, live and ended tests', () => {
    const t = test()
    expect(armProgress(t.arms[0], t)).toBe(33)
    // The holdout's share of the same end: 10% of 2 × 300 / 90% ≈ 67 orders.
    expect(armProgress(t.arms[2], t)).toBe(30)
    expect(needMoreWords(t)).toBe('About 20 more counted orders per group to go.')
    expect(needMoreWords(test({ result: { ...t.result, tooEarly: false, needMore: 0 } }))).toBeNull()
    expect(needMoreWords(test({ status: 'STOPPED' }))).toBeNull()
    const { live, ended } = splitTests([test({ id: 'a' }), test({ id: 'b', status: 'DONE' }), test({ id: 'c', status: 'DRAFT' })])
    expect([live.map((x) => x.id), ended.map((x) => x.id)]).toEqual([['a', 'c'], ['b']])
  })
})

describe('A/B splits', () => {
  const rule = (id: string, name: string, over: Partial<AbRule> = {}): AbRule => ({
    id, name, scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', isActive: true, minDaysSinceDelivery: 4, maxDaysSinceDelivery: 25, sendDelayDays: 4, ...over,
  })
  const a = rule('A', 'Germany jackets')
  const b = rule('B', 'Germany jackets (variant 1)', { isActive: false, sendDelayDays: 7 })
  const other = rule('C', 'Germany jackets (variant 1)', { marketplace: 'IT' })

  it('finds the other side from either side, in the same channel and market only', () => {
    expect(abPartner(a, [a, b, other])).toEqual({ a, b })
    expect(abPartner(b, [a, b, other])).toEqual({ a, b })
    expect(abPartner(rule('X', 'Alone'), [a, b])).toBeNull()
  })

  it('start is held until A is on, B is off, B differs and everything is saved', () => {
    const ctx = { canManage: true, unsaved: 0, live: null, sending: false }
    expect(abStartHeld({ a, b }, ctx)).toBeNull()
    expect(abStartHeld({ a: { ...a, isActive: false }, b }, ctx)).toMatch(/side A\) on first/)
    expect(abStartHeld({ a, b: { ...b, isActive: true } }, ctx)).toMatch(/side B\) off first/)
    expect(abStartHeld({ a, b: { ...b, sendDelayDays: 4 } }, ctx)).toMatch(/same timing as A/)
    expect(abStartHeld({ a, b }, { ...ctx, unsaved: 2 })).toMatch(/Save your changes first/)
    expect(abStartHeld({ a, b }, { ...ctx, live: test({ kind: 'AB', status: 'WAITING_APPROVAL' }) })).toBe('This split already waits for approval.')
  })

  const ab = (over: Partial<TimingTest> = {}) => test({
    id: 'ab1', kind: 'AB', ruleId: 'A', title: '“Germany jackets” · A/B split', holdoutPct: 0,
    arms: [arm('a', 0, { label: 'A', ruleId: 'A', ruleName: 'Germany jackets', sent: 186, rate: 0.075 }), arm('b', 1, { label: 'B', ruleId: 'B', ruleName: 'Germany jackets (variant 1)', sent: 180, rate: 0.089 })],
    result: { tooEarly: true, leaderId: 'b', controlId: 'a', sure: 71, liftPct: 19, words: 'Too early to call — B leads, 71% sure.', sureWords: null, rates: {}, needMore: 120 },
    ...over,
  })

  it('a rule’s split (the live one before an ended one), the card rows, the marks, the tile and the Queue rows', () => {
    const ended = ab({ id: 'old', status: 'STOPPED' })
    expect(abTestOf([ended, ab()], 'B')?.id).toBe('ab1')
    expect(abTestOf([ended], 'A')?.id).toBe('old')
    expect(abTestOf([ab()], 'Z')).toBeNull()
    expect(abRows(ab(), 'A').map((r) => r.cells)).toEqual([
      ['A · Germany jackets (this)', '186', '80', '7.5%'],
      ['B · Germany jackets (variant 1)', '180', '80', '8.9%'],
    ])
    expect(needMoreWords(ab())).toBe('About 120 more counted orders per side to go.')
    expect(abBadge('A', [ab()])).toEqual({ side: 'A', state: 'running', tone: 'info' })
    expect(abBadge('B', [ab({ status: 'WAITING_APPROVAL' })])).toEqual({ side: 'B', state: 'waiting for approval', tone: 'warning' })
    expect(abBadge('A', [])).toBeNull()
    expect(abTile([ab(), ab({ id: 'w', status: 'WAITING_APPROVAL' }), ended])).toEqual({ value: '1', hint: '1 running · 1 waiting for approval · 1 ended' })
    expect(abTile([])).toEqual({ value: '0', hint: 'none yet · Duplicate as A/B, then start it' })
    expect(abResultRows([ab(), ab({ id: 'd', status: 'DRAFT' }), ended]).map((r) => r.cells)).toEqual([
      ['“Germany jackets” · A/B split', '186 sent · 7.5%', '180 sent · 8.9%', 'Too early to call — B leads, 71% sure.'],
      ['“Germany jackets” · A/B split', '186 sent · 7.5%', '180 sent · 8.9%', 'Ended — Too early to call — B leads, 71% sure.'],
    ])
  })

  it('N3 — a Shopify split may differ by B’s own e-mail text only; the words say what each side sends', () => {
    const ctx = { canManage: true, unsaved: 0, live: null, sending: false }
    const own = { en: { subject: 'How is it?', body: 'Hi {first_name}\n\n{review_button}\n\n{unsubscribe_link}' } }
    const shopA = rule('SA', 'Shop', { scope: 'SHOPIFY', marketplace: null })
    const shopB = rule('SB', 'Shop (variant 1)', { scope: 'SHOPIFY', marketplace: null, isActive: false, emailText: own })
    expect(abStartHeld({ a: shopA, b: shopB }, ctx)).toBeNull()
    expect(abStartHeld({ a: shopA, b: { ...shopB, emailText: { it: STANDARD_REQUEST_TEXT.it } } }, ctx))
      .toBe('“Shop (variant 1)” has the same timing and e-mail text as A. Change B’s e-mail text, first try, send hour or window first.')
    // An Amazon pair is compared by its timing only (Amazon sends its own e-mail).
    expect(abStartHeld({ a, b: { ...b, sendDelayDays: 4, emailText: own } }, ctx)).toMatch(/same timing as A\./)
    expect(sideTimingWords(shopB)).toBe('Day 4 · window day 4–25 · own English text')
    expect(sideTimingWords(shopA)).toBe('Day 4 · window day 4–25 · standard e-mail text')
    expect(sideTimingWords(a)).toBe('Day 4 · window day 4–25')
  })

  it('N3 — an applied A/B winner in words', () => {
    const applied = { kind: 'AB' as const, armId: 'b', label: 'B', ruleId: 'SA', ruleName: 'Shop', winnerRuleName: 'Shop (variant 1)', changed: ['E-mail text in English', 'First try'], at: '2026-10-27T10:00:00Z', by: 'app:u' }
    expect(isAbApplied(applied)).toBe(true)
    expect(isAbApplied({ armId: 'x', label: 'Day 7', delayDays: 7, ruleId: 'r', ruleName: 'R', created: false, at: '2026-10-27T10:00:00Z', by: null })).toBe(false)
    expect(abAppliedWords(applied)).toBe('Applied 27 Oct: “Shop” took B’s e-mail text in English, first try. The split ended; “Shop (variant 1)” stays off.')
  })
})
