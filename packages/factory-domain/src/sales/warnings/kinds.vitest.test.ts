import { describe, expect, it } from 'vitest'
import { ORDER_WARNING_KINDS, ORDER_WARNING_WORD_KEYS, ORDER_WARNING_WORDS, overridesSchema } from './kinds'

/** owb- (order workflow, b2.5): the warn kinds — R39 only under pick A — with words and the body's overrides. */
describe('ORDER_WARNING_KINDS', () => {
  it('holds PAYMENT_DUE_AT_SHIP only (R39); each kind has a words key and EN + IT words', () => {
    expect(ORDER_WARNING_KINDS).toEqual(['PAYMENT_DUE_AT_SHIP'])
    for (const kind of ORDER_WARNING_KINDS) {
      expect(ORDER_WARNING_WORD_KEYS[kind]).toMatch(/^warning\.[a-z][A-Za-z]+$/)
      expect(ORDER_WARNING_WORDS[kind].en.length).toBeGreaterThan(10)
      expect(ORDER_WARNING_WORDS[kind].it.length).toBeGreaterThan(10)
    }
  })

  it('overrides: optional, a list of known kinds only', () => {
    expect(overridesSchema.parse(undefined)).toBeUndefined()
    expect(overridesSchema.parse([])).toEqual([])
    expect(overridesSchema.parse(['PAYMENT_DUE_AT_SHIP'])).toEqual(['PAYMENT_DUE_AT_SHIP'])
    expect(overridesSchema.safeParse(['HOLD']).success).toBe(false)
    expect(overridesSchema.safeParse('PAYMENT_DUE_AT_SHIP').success).toBe(false)
  })
})
