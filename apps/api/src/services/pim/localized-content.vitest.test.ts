import { describe, expect, it } from 'vitest'
import { mergeLocalizedContent, validateLocalizedPatch } from './localized-content.js'
import { coerceForShape } from './sheet-values.js'
import { normalizeEbayListingValue } from './ebay-listing-values.js'

describe('localized content edits', () => {
  it('updates a numbered bullet in the selected language without replacing another locale or other positions', () => {
    const current = { de: { title: 'Titel', bulletPoints: ['eins', 'zwei', 'drei'] }, it: { bulletPoints: ['uno'] } }
    const patch = { de: { 'bulletPoints[2]': 'neu', 'bulletPoints[4]': 'vier' } }
    expect(validateLocalizedPatch(patch)).toEqual([])
    expect(mergeLocalizedContent(current, patch)).toEqual({ de: { title: 'Titel', bulletPoints: ['eins', 'neu', 'drei', 'vier'] }, it: { bulletPoints: ['uno'] } })
    expect(current.de.bulletPoints).toEqual(['eins', 'zwei', 'drei'])
  })
  it('clears a slot without shifting following bullets and accepts list reset', () => {
    expect(mergeLocalizedContent({ fr: { bulletPoints: ['a', 'b', 'c'] } }, { fr: { 'bulletPoints[2]': null } }).fr.bulletPoints).toEqual(['a', '', 'c'])
    expect(validateLocalizedPatch({ fr: { bulletPoints: null } })).toEqual([])
  })
  it('rejects unknown keys, malformed locales, record-to-text coercion and invalid slots', () => {
    for (const patch of [{ de: { missing: 'x' } }, { deutsch: { title: 'x' } }, { de: { bulletPoints: [{}] } }, { de: { 'bulletPoints[0]': 'x' } }, { de: { 'bulletPoints[1000000]': 'x' } }]) expect(validateLocalizedPatch(patch).length).toBeGreaterThan(0)
    expect(coerceForShape({ shape: 'list' }, [{ zone: 'elbow' }]).ok).toBe(false)
  })
  it('validates and preserves typed custom localized attributes', () => {
    const fields = { score: { kind: 'number' }, washable: { kind: 'boolean' } }
    const patch = { 'pt-br': { score: '0', washable: 'false' } }
    expect(validateLocalizedPatch(patch, fields)).toEqual([])
    expect(mergeLocalizedContent(null, patch, fields)).toEqual({ 'pt-br': { score: 0, washable: false } })
  })
})

describe('eBay listing representations', () => {
  it.each([['conditionId', '1000', 'NEW'], ['conditionId', '2990', 'PRE_OWNED_EXCELLENT'], ['conditionId', '3010', 'PRE_OWNED_FAIR'], ['listingFormat', 'FixedPriceItem', 'FIXED_PRICE'], ['listingFormat', 'Chinese', 'AUCTION'], ['listingDuration', 'Days_7', 'DAYS_7']])('normalizes %s %s to %s', (key, raw, expected) => {
    expect(normalizeEbayListingValue(key, raw)).toBe(expected)
  })
  it('preserves unknown values for a named validation failure', () => {
    expect(normalizeEbayListingValue('conditionId', 'unrecognized')).toBe('unrecognized')
    expect(normalizeEbayListingValue('title', 'Days_7')).toBe('Days_7')
  })
})
