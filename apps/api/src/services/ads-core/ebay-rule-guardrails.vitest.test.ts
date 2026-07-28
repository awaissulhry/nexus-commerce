/** D7 — guardrails are read now, and a typo can no longer fail open. */
import { describe, it, expect } from 'vitest'
import {
  parseGuardrails, hasEnforceableGuardrails, passesGuardrailFloors,
  clampByGuardrail, capActions, ENFORCED_GUARDRAIL_KEYS,
} from './ebay-rule-guardrails.js'

describe('parseGuardrails — backwards compatibility', () => {
  it('accepts the shape every existing rule already holds', () => {
    // All six live rules carry exactly this: a free-text note, no constraints.
    const r = parseGuardrails({ note: 'clamped to break-even; skips missing-COGS' })
    expect(r.errors).toEqual([])
    expect(r.value.note).toMatch(/break-even/)
    expect(hasEnforceableGuardrails(r.value)).toBe(false)
  })
  it('accepts empty and null without complaint', () => {
    expect(parseGuardrails({}).errors).toEqual([])
    expect(parseGuardrails(null).errors).toEqual([])
    expect(parseGuardrails(undefined).errors).toEqual([])
  })
})

describe('parseGuardrails — a typo must not fail open', () => {
  it('rejects an unknown key rather than silently ignoring it', () => {
    // The original defect in miniature: stored, shown in the editor, enforcing
    // nothing. maxActionsPerRunn would have been accepted and done nothing.
    const r = parseGuardrails({ maxActionsPerRunn: 5 })
    expect(r.errors[0]).toMatch(/unknown key/)
    expect(r.errors[0]).toMatch(/maxActionsPerRun/)
  })
  it('rejects values that cannot constrain anything', () => {
    expect(parseGuardrails({ maxActionsPerRun: 0 }).errors[0]).toMatch(/positive integer/)
    expect(parseGuardrails({ maxActionsPerRun: 1.5 }).errors[0]).toMatch(/positive integer/)
    expect(parseGuardrails({ maxBidChangePct: 0 }).errors[0]).toMatch(/\(0, 100\]/)
    expect(parseGuardrails({ maxBidChangePct: 150 }).errors[0]).toMatch(/\(0, 100\]/)
    expect(parseGuardrails({ minClicks: -1 }).errors[0]).toMatch(/≥ 0/)
  })
  it('rejects a non-object', () => {
    expect(parseGuardrails('none').errors[0]).toMatch(/must be an object/)
    expect(parseGuardrails([]).errors[0]).toMatch(/must be an object/)
  })
  it('note is documented but NOT enforced', () => {
    expect([...ENFORCED_GUARDRAIL_KEYS]).not.toContain('note')
    expect(hasEnforceableGuardrails({ note: 'x' })).toBe(false)
    expect(hasEnforceableGuardrails({ maxActionsPerRun: 1 })).toBe(true)
  })
})

describe('enforcement', () => {
  it('capActions is the blast-radius lever', () => {
    const five = [1, 2, 3, 4, 5]
    expect(capActions({ maxActionsPerRun: 2 }, five)).toEqual({ kept: [1, 2], withheld: 3 })
    expect(capActions({}, five)).toEqual({ kept: five, withheld: 0 })
    expect(capActions({ maxActionsPerRun: 99 }, five).withheld).toBe(0)
  })
  it('statistical floors skip thin entities', () => {
    expect(passesGuardrailFloors({ minClicks: 30 }, { clicks: 29 })).toBe(false)
    expect(passesGuardrailFloors({ minClicks: 30 }, { clicks: 30 })).toBe(true)
    expect(passesGuardrailFloors({ minSpendCents: 500 }, { spendCents: 499 })).toBe(false)
    expect(passesGuardrailFloors({}, { clicks: 0 })).toBe(true)
    expect(passesGuardrailFloors({ minClicks: 1 }, { clicks: null })).toBe(false)
  })
  it('clampByGuardrail bounds a single move in both directions', () => {
    expect(clampByGuardrail({ maxBidChangePct: 10 }, 100, 150)).toBe(110)
    expect(clampByGuardrail({ maxBidChangePct: 10 }, 100, 50)).toBe(90)
    expect(clampByGuardrail({ maxBidChangePct: 10 }, 100, 105)).toBe(105)
    expect(clampByGuardrail({}, 100, 150)).toBe(150)
    expect(clampByGuardrail({ maxBidChangePct: 10 }, 0, 50)).toBe(50)
  })
})
