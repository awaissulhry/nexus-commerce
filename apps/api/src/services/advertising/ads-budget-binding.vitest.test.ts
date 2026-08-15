/**
 * BSP.2 · binding — the walk-back, pinned.
 *
 * These exist because this arithmetic has already been wrong once in a way that looked like a
 * discovery: reading `payload.dailyBudget` as cents produced binding ratios of 12,000–23,000%,
 * which is the shape of a spectacular finding rather than a unit bug. The euro conversion and the
 * step function are the two things that must never drift.
 */
import { describe, it, expect } from 'vitest'
import { payloadCents, buildSteps, budgetAtStep, modalHour, type BudgetWrite } from './ads-budget-binding.service.js'

const at = (iso: string) => new Date(iso)
const w = (iso: string, before: number | null, after: number | null): BudgetWrite =>
  ({ at: at(iso), actor: null, before, after })

describe('payloadCents — the audit payload is EUROS', () => {
  it('reads 4.42 as €4.42, not as 4 cents', () => {
    expect(payloadCents({ dailyBudget: 4.42 })).toBe(442)
    expect(payloadCents({ dailyBudget: 1 })).toBe(100)
    expect(payloadCents({ dailyBudget: 2220 })).toBe(222000)
  })

  it('🔴 the bug it exists to prevent: treating euros as cents inflates a ratio ~100x', () => {
    const asEuros = payloadCents({ dailyBudget: 4.18 }) as number   // 418 cents
    const asCentsWrongly = 4.18                                     // what the first pass did
    const spendCents = 990
    expect(Math.round((spendCents / asEuros) * 100)).toBe(237)              // the real 237%
    expect(Math.round((spendCents / asCentsWrongly) * 100)).toBeGreaterThan(20000) // the absurd one
  })

  it('is null for a missing or unusable value rather than 0', () => {
    expect(payloadCents(null)).toBeNull()
    expect(payloadCents({})).toBeNull()
    expect(payloadCents({ dailyBudget: null })).toBeNull()
    expect(payloadCents({ dailyBudget: 'nonsense' })).toBeNull()
  })

  it('rounds to whole cents, so a float never leaks into a money field', () => {
    expect(payloadCents({ dailyBudget: 0.1 + 0.2 })).toBe(30)
  })
})

describe('buildSteps — the forward step function', () => {
  it('seeds from the OLDEST write’s payloadBefore, which is the only evidence of the past', () => {
    const { steps } = buildSteps([
      w('2026-08-10T00:00:00Z', 300, 400),
      w('2026-08-05T00:00:00Z', 200, 300),
    ])
    expect(steps[0]).toEqual({ from: new Date(0), cents: 200 })
    expect(steps.map((s) => s.cents)).toEqual([200, 300, 400])
  })

  it('counts a seam break when a write does not start where the last one ended', () => {
    // rule wrote 4.18, pacer then claims it started from 3.34 — the live 41% defect
    const { chainBreaks } = buildSteps([
      w('2026-08-06T04:30:00Z', 334, 267),
      w('2026-08-06T04:15:00Z', 400, 418),
    ])
    expect(chainBreaks).toBe(1)
  })

  it('does not count sub-cent float noise as a break', () => {
    const { chainBreaks } = buildSteps([
      w('2026-08-06T04:30:00Z', 418.4, 300),
      w('2026-08-06T04:15:00Z', 400, 418),
    ])
    expect(chainBreaks).toBe(0)
  })

  it('a clean chain has no breaks', () => {
    const { chainBreaks } = buildSteps([
      w('2026-08-07T00:00:00Z', 300, 250),
      w('2026-08-06T00:00:00Z', 400, 300),
      w('2026-08-05T00:00:00Z', 500, 400),
    ])
    expect(chainBreaks).toBe(0)
  })

  it('survives a write with no usable payload on either side', () => {
    const { steps, chainBreaks } = buildSteps([w('2026-08-06T00:00:00Z', null, null)])
    expect(steps).toEqual([])
    expect(chainBreaks).toBe(0)
  })

  it('an empty history yields no steps rather than throwing', () => {
    expect(buildSteps([])).toEqual({ steps: [], chainBreaks: 0 })
  })
})

describe('budgetAtStep — the value in force on a given day', () => {
  const { steps } = buildSteps([
    w('2026-08-10T12:00:00Z', 300, 400),
    w('2026-08-05T12:00:00Z', 200, 300),
  ])

  it('🔴 returns the budget of the DAY, not today’s budget', () => {
    expect(budgetAtStep(steps, at('2026-08-01T23:59:59Z'))).toBe(200)  // before any write
    expect(budgetAtStep(steps, at('2026-08-06T23:59:59Z'))).toBe(300)  // after the first
    expect(budgetAtStep(steps, at('2026-08-11T23:59:59Z'))).toBe(400)  // after the second
  })

  it('a write lands mid-day: the day closes on the NEW value', () => {
    expect(budgetAtStep(steps, at('2026-08-10T23:59:59Z'))).toBe(400)
    expect(budgetAtStep(steps, at('2026-08-10T11:59:59Z'))).toBe(300)
  })

  it('is null when a campaign has no steps at all', () => {
    expect(budgetAtStep(undefined, at('2026-08-06T00:00:00Z'))).toBeNull()
    expect(budgetAtStep([], at('2026-08-06T00:00:00Z'))).toBeNull()
  })

  it('a single flat step answers for every day — the no-log campaign case', () => {
    const flat = [{ from: new Date(0), cents: 1000 }]
    expect(budgetAtStep(flat, at('2020-01-01T00:00:00Z'))).toBe(1000)
    expect(budgetAtStep(flat, at('2026-08-06T00:00:00Z'))).toBe(1000)
  })
})

describe('modalHour', () => {
  it('picks the most common hour', () => {
    expect(modalHour([22, 22, 15, 22, 15])).toBe(22)
  })
  it('breaks a tie to the later hour, which is the safer read', () => {
    expect(modalHour([9, 21])).toBe(21)
  })
  it('is null with nothing to go on', () => {
    expect(modalHour([])).toBeNull()
  })
  it('handles hour 0 as a real hour, not as absent', () => {
    expect(modalHour([0, 0, 5])).toBe(0)
  })
})
