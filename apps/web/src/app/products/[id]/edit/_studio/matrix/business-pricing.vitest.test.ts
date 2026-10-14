/**
 * Amazon Business (step 5) — the B2B price pop-up's rules: what it opens with, how its fields read, what Amazon would
 * refuse (held Save, the shared rules the door applies), the sentences of a save, and when an Undo can be offered.
 */
import { describe, expect, it } from 'vitest'

import {
  businessDraftOf, businessSaveHeld, businessSaveLabel, businessSavedSentence, businessSettingOf, businessUndoOf, nextTier, parseBusinessDraft,
  type BusinessDraft,
} from './businessPricing'
import { parseMatrixColId } from './columns'
import type { BusinessCell } from './contract'

const cell = (over: Partial<BusinessCell> = {}): BusinessCell => ({
  rule: null, percent: null, exact: null, tiers: null, price: null, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR',
  warnings: [], held: null, send: null, live: null, reported: null, ...over,
})
const percentCell = cell({
  rule: 'PERCENT_OFF', percent: 5, price: 99.75,
  tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 96.76 }, { minQty: 5, value: 5, unitPrice: 94.76 }] },
})
const draft = (over: Partial<BusinessDraft> = {}): BusinessDraft => ({ mode: 'percent', percent: '5', exact: '', tierType: 'percent', tiers: [], ...over })

describe('what the pop-up opens with', () => {
  it('the kept setting; else Amazon\'s own price (set outside Nexus) as an exact price; else 5 % below the price', () => {
    const kept = businessDraftOf(percentCell)
    expect(kept).toMatchObject({ mode: 'percent', percent: '5', tierType: 'percent' })
    expect(kept.tiers.map((t) => [t.minQty, t.value])).toEqual([['2', '3'], ['5', '5']])
    expect(businessDraftOf(cell({ rule: 'FIXED', exact: 32.95, price: 32.95 }))).toMatchObject({ mode: 'exact', exact: '32.95', tiers: [] })
    expect(businessDraftOf(cell({ reported: { price: 90 } }))).toMatchObject({ mode: 'exact', exact: '90' })
    expect(businessDraftOf(cell())).toMatchObject({ mode: 'percent', percent: '5', tiers: [] })
  })
  it('the setting Nexus keeps, in the door\'s own shape', () => {
    expect(businessSettingOf(percentCell)).toEqual({ rule: 'PERCENT_OFF', percent: 5, price: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] } })
    expect(businessSettingOf(cell())).toBeNull()
  })
})

describe('reading the fields and Amazon\'s rules', () => {
  it('a percent gives the price Nexus sends and each tier\'s unit price; "5,5 %" reads as 5.5', () => {
    const tier = (minQty: string, value: string) => ({ key: minQty, minQty, value })
    const p = parseBusinessDraft(draft({ tiers: [tier('2', '3'), tier('5', '5')] }), cell(), null)
    expect(p.setting).toEqual({ rule: 'PERCENT_OFF', percent: 5, price: null, tiers: { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] } })
    expect(p.price).toBe(99.75)
    expect(p.unitPrices).toEqual([96.76, 94.76])
    expect(p.problems).toEqual([])
    expect(parseBusinessDraft(draft({ percent: '5,5 %' }), cell(), null).setting).toMatchObject({ percent: 5.5 })
  })
  it('a field that is no number is said at the field, and nothing is checked further', () => {
    const p = parseBusinessDraft(draft({ percent: 'abc', tiers: [{ key: 'k', minQty: '', value: '3' }] }), cell(), null)
    expect(p.setting).toBeUndefined()
    expect(p.fieldProblems.get('percent')).toBe('Write a percent, for example 5.')
    expect(p.fieldProblems.get('k:minQty')).toBe('Write a number of units, 2 or more.')
    expect(businessSaveHeld(p, cell())).toBe('Fix the marked field first')
  })
  it('what Amazon refuses holds Save: an exact price above the price; a price per unit with a percent price; a tier below the minimum', () => {
    const above = parseBusinessDraft(draft({ mode: 'exact', exact: '110' }), cell(), null)
    expect(above.problems).toEqual(['The business price EUR 110.00 is above the normal price EUR 105.00: Amazon would not show it to business buyers.'])
    expect(businessSaveHeld(above, cell())).toBe('Amazon would refuse this')
    const fixedTiers = parseBusinessDraft(draft({ tierType: 'fixed', tiers: [{ key: 'k', minQty: '2', value: '90' }] }), cell(), null)
    expect(fixedTiers.problems.join(' ')).toContain('Fixed quantity prices go with an exact business price')
    const low = parseBusinessDraft(draft({ tiers: [{ key: 'k', minQty: '2', value: '20' }] }), cell({ minPrice: 90 }), null)
    expect(low.problems).toEqual(['A quantity discount reaches EUR 79.80, below this listing\'s minimum price EUR 90.00: Amazon refuses it.'])
  })
  it('a sale lower than the business price is a warning: it saves', () => {
    const p = parseBusinessDraft(draft(), cell(), 89)
    expect(p.problems).toEqual([])
    expect(p.warnings.length).toBe(1)
    expect(businessSaveHeld(p, cell())).toBeNull()
  })
  it('None removes; the same setting as kept changes nothing', () => {
    const none = parseBusinessDraft(draft({ mode: 'none' }), percentCell, null)
    expect(none.setting).toBeNull()
    expect(businessSaveLabel(none)).toBe('Remove')
    expect(businessSaveHeld(none, percentCell)).toBeNull()
    expect(businessSaveHeld(parseBusinessDraft(draft({ mode: 'none' }), cell(), null), cell())).toBe('Nothing to change')
    expect(businessSaveHeld(parseBusinessDraft(businessDraftOf(percentCell), percentCell, null), percentCell)).toBe('Nothing to change')
  })
})

describe('a new quantity discount', () => {
  it('the next suggested quantity and discount; a price per unit is that percent below the business price', () => {
    expect(nextTier(draft(), 99.75)).toMatchObject({ minQty: '2', value: '3' })
    expect(nextTier(draft({ tiers: [{ key: 'a', minQty: '2', value: '3' }] }), 99.75)).toMatchObject({ minQty: '5', value: '5' })
    expect(nextTier(draft({ mode: 'exact', tierType: 'fixed' }), 32.95)).toMatchObject({ minQty: '2', value: '31.96' })
    expect(nextTier(draft({ tiers: [{ key: 'a', minQty: '60', value: '3' }] }), 99.75)).toMatchObject({ minQty: '70' })
  })
})

describe('the sentences of a save, and its Undo', () => {
  it('says what was set and where; a removal says Nexus removes it; a held listing says when it is sent', () => {
    const setting = { rule: 'PERCENT_OFF' as const, percent: 5, price: null, tiers: { type: 'percent' as const, levels: [{ minQty: 2, value: 3 }] } }
    expect(businessSavedSentence('GALE-M', 'Amazon · IT', setting, cell()))
      .toBe('Business price · GALE-M · Amazon · IT: €99.75 (5% below €105.00) · 1 quantity discount. Nexus sends it to Amazon.')
    expect(businessSavedSentence('GALE-M', 'Amazon · IT', null, percentCell)).toBe('Business price removed · GALE-M · Amazon · IT. Nexus removes it from Amazon.')
    expect(businessSavedSentence('GALE-M', 'Amazon · IT', { rule: 'FIXED', percent: null, price: 32.95, tiers: null }, cell({ held: 'The listing is paused: it is sent when it sells again.' })))
      .toBe('Business price · GALE-M · Amazon · IT: €32.95. The listing is paused: it is sent when it sells again.')
  })
  it('Undo puts the kept setting back (none included); a price set outside Nexus offers no Undo', () => {
    expect(businessUndoOf(percentCell)).toEqual({ setting: businessSettingOf(percentCell) })
    expect(businessUndoOf(cell())).toEqual({ setting: null })
    expect(businessUndoOf(cell({ reported: { price: 90 } }))).toBeNull()
  })
})

describe('the business columns are Matrix cells', () => {
  it('parseMatrixColId reads the two kinds', () => {
    expect(parseMatrixColId('AMAZON:IT.businessPrice')).toEqual({ key: 'AMAZON:IT', kind: 'businessPrice' })
    expect(parseMatrixColId('AMAZON:IT.businessTiers')).toEqual({ key: 'AMAZON:IT', kind: 'businessTiers' })
  })
})
