/**
 * Reviews PR J — the pure part of timing tests: which group an order is in (stable, by order number), how sure a
 * difference is (a two-proportion test), "too early to call" below the minimum, and when a winner may be applied.
 */
import { describe, expect, it } from 'vitest'
import {
  APPLY_MIN_SURE,
  MIN_COUNTED_PER_ARM,
  applyHeld,
  assignArm,
  bucketOf,
  endsWhenOf,
  endsWords,
  normalCdf,
  progressWords,
  shouldFinish,
  sureBetter,
  sureWords,
  testResult,
  timingArms,
  type ArmCounts,
} from './review-timing-test-math.js'

const arms = [
  { id: 'd4', position: 0, holdout: false },
  { id: 'd7', position: 1, holdout: false },
  { id: 'd10', position: 2, holdout: false },
  { id: 'hold', position: 3, holdout: true },
]
const test = { id: 'test-1', holdoutPct: 10, arms }
const orderNumbers = Array.from({ length: 6000 }, (_, i) => `305-${String(1_000_000 + i * 7919).padStart(7, '0')}-${String(i * 31).padStart(7, '0')}`)

describe('assignArm — by order number, stable', () => {
  it('the same order lands in the same group on every run (and with the groups in any order)', () => {
    for (const n of orderNumbers.slice(0, 200)) {
      const first = assignArm(test, n)!.id
      expect(assignArm(test, n)!.id).toBe(first)
      expect(assignArm({ ...test, arms: [...arms].reverse() }, n)!.id).toBe(first)
      expect(assignArm(test, `  ${n} `)!.id).toBe(first)
    }
    expect(bucketOf('test-1', '305-1234567-7654321')).toBe(bucketOf('test-1', '305-1234567-7654321'))
  })

  it('the holdout takes about its share; the asked groups split the rest evenly', () => {
    const count: Record<string, number> = { d4: 0, d7: 0, d10: 0, hold: 0 }
    for (const n of orderNumbers) count[assignArm(test, n)!.id] += 1
    const share = (id: string) => count[id] / orderNumbers.length
    expect(share('hold')).toBeGreaterThan(0.08)
    expect(share('hold')).toBeLessThan(0.12)
    for (const id of ['d4', 'd7', 'd10']) {
      expect(share(id)).toBeGreaterThan(0.27)
      expect(share(id)).toBeLessThan(0.33)
    }
  })

  it('no holdout without a holdout share; another test splits the same orders independently', () => {
    const none = { ...test, holdoutPct: 0 }
    expect(orderNumbers.slice(0, 500).some((n) => assignArm(none, n)!.holdout)).toBe(false)
    const other = { ...test, id: 'test-2' }
    const differ = orderNumbers.slice(0, 500).filter((n) => assignArm(test, n)!.id !== assignArm(other, n)!.id).length
    expect(differ).toBeGreaterThan(200)
    expect(assignArm({ id: 'x', holdoutPct: 10, arms: [{ id: 'hold', position: 0, holdout: true }] }, '1')).toBeNull()
  })
})

describe('how sure — a two-proportion test', () => {
  it('the normal distribution function', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCdf(-1.645)).toBeCloseTo(0.05, 3)
  })

  it('a clear difference is sure; equal rates are 50%; nothing to compare is null', () => {
    // 23 of 300 against 27 of 300: B is ahead, but not by much.
    const small = sureBetter({ n: 300, k: 23 }, { n: 300, k: 27 })!
    expect(small).toBeGreaterThan(0.5)
    expect(small).toBeLessThan(0.8)
    // 30 of 1000 against 60 of 1000: almost certain.
    expect(sureBetter({ n: 1000, k: 30 }, { n: 1000, k: 60 })!).toBeGreaterThan(0.99)
    // The result never says 100% sure.
    const certain = testResult([arm('d4', 0, 1000, 30), arm('d7', 1, 1000, 90)])
    expect(certain.sure).toBe(99)
    expect(sureBetter({ n: 200, k: 10 }, { n: 200, k: 10 })).toBeCloseTo(0.5, 6)
    expect(sureBetter({ n: 200, k: 0 }, { n: 200, k: 0 })).toBe(0.5)
    expect(sureBetter({ n: 0, k: 0 }, { n: 10, k: 1 })).toBeNull()
    // The z-value by hand: p = 90/2000, se = sqrt(p(1-p)(2/1000)), z = 0.03 / se.
    const p = 90 / 2000
    expect(sureBetter({ n: 1000, k: 30 }, { n: 1000, k: 60 })).toBeCloseTo(normalCdf(0.03 / Math.sqrt(p * (1 - p) * 0.002)), 10)
  })

  it('says what N% sure means', () => {
    expect(sureWords(92)).toBe('92% sure means about 1 chance in 12 that the difference is luck.')
    expect(sureWords(54)).toBe('54% sure means about 1 chance in 2 that the difference is luck.')
    expect(sureWords(99)).toBe('99% sure means about 1 chance in 100 that the difference is luck.')
    expect(sureWords(100)).toBe('100% sure means less than 1 chance in 200 that the difference is luck.')
  })
})

const arm = (id: string, position: number, counted: number, reviews: number, over: Partial<ArmCounts> = {}): ArmCounts => ({
  id, label: position === 0 ? `Day ${id.slice(1)} (now)` : `Day ${id.slice(1)}`, position, holdout: false, orders: counted, sent: counted, counted, reviews, ...over,
})

describe('testResult — the words never claim more than the counts show', () => {
  it('too early to call before any order has had its time to answer', () => {
    const r = testResult([arm('d4', 0, 0, 0, { orders: 40 }), arm('d7', 1, 0, 0, { orders: 41 })], { where: 'in Germany' })
    expect(r).toMatchObject({ tooEarly: true, leaderId: null, sure: null })
    expect(r.words).toMatch(/^Too early to call — no order has had its full time to answer yet/)
  })

  it('too early to call below the minimum: the leader and how sure, and how many orders are still needed', () => {
    const r = testResult([arm('d4', 0, 60, 4), arm('d7', 1, 58, 7)], { where: 'in Germany' })
    expect(r.tooEarly).toBe(true)
    expect(r.leaderId).toBe('d7')
    expect(r.needMore).toBe(MIN_COUNTED_PER_ARM - 58)
    expect(r.words).toMatch(new RegExp(`^Too early to call — day 7 leads, ${r.sure}% sure\\. About ${MIN_COUNTED_PER_ARM - 58} more orders per group to go`))
    expect(r.sureWords).toBeNull()
    // An ended test gets no new orders: it never says how many are still "to go".
    const ended = testResult([arm('d4', 0, 60, 4), arm('d7', 1, 58, 7)], { ended: true })
    expect(ended.words).toMatch(/It ended with fewer than 100 counted orders per group; the orders already in it still count/)
    expect(ended.words).not.toMatch(/to go/)
  })

  it('after the minimum: "Day 7 gets 18% more reviews in Germany — N% sure", the holdout never the winner', () => {
    const holdout = { ...arm('hold', 3, 100, 1), label: 'Not asked (holdout)', holdout: true }
    const r = testResult([arm('d4', 0, 300, 23), arm('d7', 1, 300, 27), arm('d10', 2, 300, 24), holdout], { where: 'in Germany' })
    expect(r.tooEarly).toBe(false)
    expect(r.leaderId).toBe('d7')
    expect(r.liftPct).toBe(17)
    expect(r.words).toBe(`Day 7 gets 17% more reviews in Germany — ${r.sure}% sure`)
    expect(r.sureWords).toBe(sureWords(r.sure!))
    expect(r.rates.hold).toBeCloseTo(0.01, 6)
  })

  it('when the day in place leads, it says so against the runner-up; no reviews at all is no call', () => {
    const r = testResult([arm('d4', 0, 200, 30), arm('d7', 1, 200, 20)], { where: 'in Italy' })
    expect(r.leaderId).toBe('d4')
    expect(r.words).toBe(`Day 4 (now) stays best in Italy — ${r.sure}% sure it beats day 7`)
    const none = testResult([arm('d4', 0, 200, 0), arm('d7', 1, 200, 0)])
    expect(none.words).toBe('No group brought a review yet — there is nothing to call.')
    expect(none.leaderId).toBeNull()
  })
})

describe('applyHeld — a winner is applied only when the result holds', () => {
  const sure = (n: number) => ({ tooEarly: false, leaderId: 'd7', controlId: 'd4', sure: n })
  it('holds while running, too early, when the day in place wins, or under the sure line', () => {
    expect(applyHeld({ kind: 'TIMING', status: 'RUNNING' }, sure(95))).toMatch(/has not finished/)
    expect(applyHeld({ kind: 'TIMING', status: 'DONE' }, { ...sure(95), tooEarly: true })).toMatch(/Too early/)
    expect(applyHeld({ kind: 'TIMING', status: 'DONE' }, { ...sure(95), leaderId: 'd4' })).toMatch(/nothing to apply/)
    expect(applyHeld({ kind: 'TIMING', status: 'DONE' }, sure(APPLY_MIN_SURE - 1))).toMatch(/Only 79% sure/)
    expect(applyHeld({ kind: 'AB', status: 'DONE' }, sure(95))).toMatch(/End test/)
    expect(applyHeld({ kind: 'TIMING', status: 'DONE' }, sure(92))).toBeNull()
    expect(applyHeld({ kind: 'TIMING', status: 'STOPPED' }, sure(92))).toBeNull()
  })
})

describe('the end and the groups', () => {
  const started = new Date('2026-10-01T00:00:00Z')
  it('ends at its orders per group, or after its days', () => {
    const ends = { ordersPerArm: 300, maxDays: 56 }
    expect(shouldFinish({ startedAt: started, endsWhen: ends }, [{ holdout: false, orders: 300 }, { holdout: false, orders: 299 }, { holdout: true, orders: 5 }], new Date('2026-10-10T00:00:00Z'))).toBe(false)
    expect(shouldFinish({ startedAt: started, endsWhen: ends }, [{ holdout: false, orders: 300 }, { holdout: false, orders: 301 }, { holdout: true, orders: 5 }], new Date('2026-10-10T00:00:00Z'))).toBe(true)
    expect(shouldFinish({ startedAt: started, endsWhen: ends }, [{ holdout: false, orders: 3 }], new Date('2026-11-26T00:00:00Z'))).toBe(true)
    expect(shouldFinish({ startedAt: null, endsWhen: ends }, [{ holdout: false, orders: 900 }], new Date())).toBe(false)
  })

  it('progress in words, and the end in words', () => {
    expect(progressWords({ startedAt: started, endsWhen: {} }, [{ holdout: false, orders: 50 }, { holdout: false, orders: 60 }], new Date('2026-10-11T00:00:00Z'))).toBe('Running · week 2 of about 8')
    expect(progressWords({ startedAt: started, endsWhen: { ordersPerArm: 100 } }, [{ holdout: false, orders: 50 }], new Date('2026-10-11T00:00:00Z'))).toBe('Running · week 2 of about 3')
    expect(endsWords(endsWhenOf({}))).toBe('At 300 orders per group, or after 8 weeks')
    expect(endsWords(endsWhenOf({ ordersPerArm: 5, maxDays: 999 }), 'AB')).toBe('At 50 orders per side, or after 12 weeks')
  })

  it('the day in place first (marked now), then the other days, then the holdout', () => {
    expect(timingArms([10, 4, 7, 7], 7, 10)).toEqual([
      { label: 'Day 7 (now)', position: 0, delayDays: 7, holdout: false },
      { label: 'Day 4', position: 1, delayDays: 4, holdout: false },
      { label: 'Day 10', position: 2, delayDays: 10, holdout: false },
      { label: 'Not asked (holdout)', position: 3, delayDays: null, holdout: true },
    ])
    expect(timingArms([14, 4], 12, 0).map((a) => a.label)).toEqual(['Day 4', 'Day 14'])
  })
})
