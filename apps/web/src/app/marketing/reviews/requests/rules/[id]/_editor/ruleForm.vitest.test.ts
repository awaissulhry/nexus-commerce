import { describe, expect, it } from 'vitest'
import type { RuleItem } from '../../_rules/rulesModel'
import {
  NEW_RULE_FORM,
  changedFields,
  formFromRule,
  minTotalCents,
  ruleBody,
  saveHeld,
  toggleSkip,
  unsavedWords,
  withFirstTryDays,
  withScope,
  withWindow,
} from './ruleForm'

const RULE: RuleItem = {
  id: 'r1', name: 'Germany jackets', scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', isActive: true,
  minDaysSinceDelivery: 4, maxDaysSinceDelivery: 30, exclusions: ['has_refund', 'fbm_only', 'legacy_flag'], minOrderTotalCents: 4990,
  notes: 'Only jackets', useSentimentDiversion: true, fallbackOnNoResponse: false, productTypes: ['jacket'], sendDelayDays: 7,
  anchor: 'DELIVERY', sendHourLocal: 10, skipWeekends: true, shiftToBestDay: false,
}
const OK = { canManage: true, lint: [] }

describe('rule form ⇄ API', () => {
  it('reads a rule into the form, splitting skips, who ships and unknown exclusions', () => {
    const f = formFromRule(RULE)
    expect(f).toMatchObject({
      shippedBy: 'fbm', skips: ['has_refund'], otherExclusions: ['legacy_flag'], minOrderTotal: '49.90', firstTryMode: 'custom',
      firstTryDays: 7, fixedHour: true, sendHour: 10, useSentimentDiversion: true, fallbackOnNoResponse: false,
    })
  })

  it('writes the same rule back, unchanged', () => {
    const body = ruleBody(formFromRule(RULE))
    expect(body).toEqual({
      name: 'Germany jackets', notes: 'Only jackets', isActive: true, scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE',
      minDaysSinceDelivery: 4, maxDaysSinceDelivery: 30, exclusions: ['has_refund', 'fbm_only', 'legacy_flag'], minOrderTotalCents: 4990,
      productTypes: ['jacket'], sendDelayDays: 7, anchor: 'DELIVERY', sendHourLocal: 10, skipWeekends: true, shiftToBestDay: false,
      useSentimentDiversion: true, fallbackOnNoResponse: false,
    })
    expect(changedFields(formFromRule(RULE), formFromRule(RULE))).toEqual([])
  })

  it('maps “Shipped by” to the FBA / FBM exclusions, for Amazon only', () => {
    const fba = { ...formFromRule(RULE), shippedBy: 'fba' as const }
    expect(ruleBody(fba).exclusions).toEqual(['has_refund', 'fba_only', 'legacy_flag'])
    expect(ruleBody({ ...fba, scope: 'EBAY' }).exclusions).toEqual(['has_refund', 'legacy_flag'])
  })

  it('counts the changed fields for the save bar', () => {
    const start = formFromRule(RULE)
    const next = toggleSkip({ ...start, name: 'Germany jackets B', fixedHour: false }, 'is_cancelled')
    expect(changedFields(start, next).sort()).toEqual(['exclusions', 'name', 'sendHourLocal'])
    expect(unsavedWords(1)).toBe('1 unsaved change')
    expect(unsavedWords(3)).toBe('3 unsaved changes')
  })
})

describe('Amazon’s own limits', () => {
  it('always counts from delivery and keeps the first try in day 4–30', () => {
    const email = withScope({ ...NEW_RULE_FORM, scope: 'EBAY', anchor: 'SHIP', firstTryDays: 2 }, 'EBAY')
    expect(ruleBody(email).anchor).toBe('SHIP')
    const amazon = withScope(email, 'AMAZON_GLOBAL')
    expect(amazon.anchor).toBe('DELIVERY')
    expect(amazon.firstTryDays).toBe(4)
    expect(ruleBody({ ...amazon, anchor: 'PURCHASE' }).anchor).toBe('DELIVERY')
    expect(withFirstTryDays(amazon, 45).firstTryDays).toBe(30)
    expect(withFirstTryDays(email, 45).firstTryDays).toBe(45)
    expect(withWindow(amazon, 1, 40)).toMatchObject({ windowFrom: 4, windowTo: 30 })
  })

  it('drops the market of a rule that is not for one market', () => {
    const f = withScope(formFromRule(RULE), 'AMAZON_GLOBAL')
    expect(f.marketplace).toBeNull()
    expect(ruleBody(f).marketplace).toBeNull()
  })
})

describe('held save', () => {
  it('names the first thing to fix', () => {
    const f = formFromRule(RULE)
    expect(saveHeld(f, { canManage: false, lint: [] })).toBe("You need 'Manage reviews' to change review-request rules.")
    expect(saveHeld({ ...f, name: ' ' }, OK)).toBe('Give the rule a name first.')
    expect(saveHeld({ ...f, scope: 'ETSY' }, OK)).toBe('Pick Amazon, eBay or Shopify — Nexus asks only those buyers.')
    expect(saveHeld({ ...f, marketplace: null }, OK)).toBe('Pick the market first: an Amazon rule for one market needs one.')
    expect(saveHeld({ ...f, windowFrom: 20, windowTo: 10 }, OK)).toBe('The window’s first day (20) is after its last day (10).')
    expect(saveHeld({ ...f, minOrderTotal: 'ten' }, OK)).toMatch(/^The minimum order total is not an amount/)
    expect(saveHeld({ ...f, firstTryDays: 25, windowTo: 20 }, OK)).toBe('The first try (day 25) is outside the window (day 4–20): it would never go.')
    expect(saveHeld(f, { canManage: true, lint: [{ severity: 'warn', message: 'Long' }, { severity: 'error', message: 'Offers a reward for a review' }] }))
      .toBe('Fix 1 problem in the notes first: Offers a reward for a review')
    expect(saveHeld(f, OK)).toBeNull()
  })

  it('reads amounts with a comma or a dot', () => {
    expect(minTotalCents('49,90')).toBe(4990)
    expect(minTotalCents('')).toBeNull()
    expect(minTotalCents('-1')).toBeNaN()
  })
})
