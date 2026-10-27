import { describe, expect, it } from 'vitest'
import { STANDARD_REQUEST_TEXT } from '@nexus/shared/review-request-text'
import type { RuleItem } from '../../_rules/rulesModel'
import {
  NEW_RULE_FORM,
  changedFields,
  formFromRule,
  languageIssues,
  minTotalCents,
  previewText,
  ruleBody,
  saveHeld,
  toggleSkip,
  unsavedWords,
  withFirstTryDays,
  withScope,
  withStandardWords,
  withText,
  withTextMode,
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
      useSentimentDiversion: true, fallbackOnNoResponse: false, emailText: null,
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
    expect(saveHeld({ ...f, scope: 'ETSY' }, OK)).toBe('Pick Amazon or Shopify — Nexus asks only those buyers (eBay asks its buyers itself).')
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

describe('N3 — the rule’s own e-mail text per language, checked as it is typed', () => {
  const SHOP: RuleItem = { ...RULE, scope: 'SHOPIFY', marketplace: null, exclusions: [], sendHourLocal: null }
  const ownEn = { subject: 'How is your {product}?', body: 'Hi {first_name}\n\n{review_button}\n\nStop? {unsubscribe_link}' }

  it('default: every language on the standard text, and a save sends no text of its own (no buyer’s e-mail changes)', () => {
    const f = formFromRule(SHOP)
    expect(f.emailText.it).toEqual({ mode: 'standard', ...STANDARD_REQUEST_TEXT.it })
    expect(f.emailText.en.mode).toBe('standard')
    expect(ruleBody(f).emailText).toBeNull()
    expect(ruleBody(NEW_RULE_FORM).emailText).toBeNull()
    // Picking "own" and saving the standard words unchanged is still the standard text.
    expect(ruleBody(withTextMode(f, 'it', 'own')).emailText).toBeNull()
    expect(changedFields(f, withTextMode(f, 'it', 'own'))).toEqual([])
  })

  it('a language’s own words go into the save; the other stays standard; back to standard drops them', () => {
    const f = withText(withText(formFromRule(SHOP), 'en', { subject: ownEn.subject }), 'en', { body: ownEn.body })
    expect(ruleBody(f).emailText).toEqual({ en: ownEn })
    expect(changedFields(formFromRule(SHOP), f)).toEqual(['emailText'])
    expect(previewText(f.emailText, 'en')).toEqual(ownEn)
    expect(previewText(f.emailText, 'it')).toBeNull()
    expect(ruleBody(withTextMode(f, 'en', 'standard')).emailText).toBeNull()
    // The words stay in the editor while "Standard" is picked, and come back with "own".
    expect(withTextMode(withTextMode(f, 'en', 'standard'), 'en', 'own').emailText.en).toEqual({ mode: 'own', ...ownEn })
    expect(withStandardWords(f, 'en').emailText.en).toEqual({ mode: 'own', ...STANDARD_REQUEST_TEXT.en })
  })

  it('a saved text comes back as that language’s own text', () => {
    const f = formFromRule({ ...SHOP, emailText: { en: ownEn } })
    expect(f.emailText.en).toEqual({ mode: 'own', ...ownEn })
    expect(f.emailText.it.mode).toBe('standard')
    expect(ruleBody(f).emailText).toEqual({ en: ownEn })
  })

  it('the live check holds Save with the reason in words; the standard text has nothing to fix', () => {
    const f = formFromRule(SHOP)
    expect(languageIssues(f.emailText.it)).toEqual([])
    const bad = withText(f, 'it', { body: `${STANDARD_REQUEST_TEXT.it.body}\n\nUn buono sconto per la tua recensione!` })
    expect(languageIssues(bad.emailText.it).map((i) => i.code)).toEqual(['incentive'])
    expect(saveHeld(bad, OK)).toBe('Fix the Italian e-mail text first: It offers something for a review. Nothing may be given or promised for a review — no discount, gift, refund or free product.')
    const noButton = withText(f, 'en', { body: STANDARD_REQUEST_TEXT.en.body.replace('{review_button}', '') })
    expect(saveHeld(noButton, OK)).toMatch(/^Fix the English e-mail text first: The review button is missing/)
    // Standard again: nothing to fix.
    expect(saveHeld(withTextMode(bad, 'it', 'standard'), OK)).toBeNull()
  })

  it('an Amazon or eBay rule shows no text: its hidden words never hold Save, and only sendable words are kept', () => {
    const bad = withText(formFromRule(SHOP), 'en', { subject: 'Free gift for 5 stars' })
    const amazon = withScope(bad, 'AMAZON_GLOBAL')
    expect(saveHeld(amazon, OK)).toBeNull()
    expect(ruleBody(amazon).emailText).toBeNull()
  })
})
