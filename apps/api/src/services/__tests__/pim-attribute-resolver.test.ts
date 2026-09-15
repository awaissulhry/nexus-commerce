import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { resolveAttributes, resolveAttributesFlat, resolveAttributesBySource, type ProductLike, type ResolveInput } from '../pim/attribute-resolver.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'

const product = (over: Partial<ProductLike> = {}): ProductLike => ({ id: 'p1', parentId: null, categoryAttributes: null, localizedContent: null, variantAttributes: null, ...over })
const listing = (over: Record<string, unknown> = {}) => ({ id: 'cl1', overrideData: null, ...over })
const read = (input: ResolveInput) => resolveAttributes({ coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-a' }, marketLanguages: [PRIMARY_CONTENT_LOCALE, 'en', 'de'], ...input })

describe('attribute adapter: factual inheritance', () => {
  it('retains factual values and their owning product', () => {
    const result = read({ product: product({ categoryAttributes: { material: 'Cowhide', armor: 'CE2' } }), parent: null })
    expect(result.material).toEqual({ value: 'Cowhide', source: 'master', inheritedFrom: 'p1' })
    expect(result.armor.value).toBe('CE2')
  })
  it('represents unset content explicitly without inventing factual fields', () => {
    const result = read({ product: product(), parent: null })
    expect(Object.keys(result).sort()).toEqual(['bulletPoints', 'description', 'keywords', 'title'])
    expect(Object.values(result).every(cell => cell.value === null)).toBe(true)
  })
  it('inherits parent facts and lets a child override one field', () => {
    const parent = product({ id: 'parent', categoryAttributes: { material: 'Cowhide', brand: 'Xavia' } })
    const child = product({ parentId: parent.id, categoryAttributes: { material: 'Kangaroo' } })
    const result = read({ product: child, parent })
    expect(result.material).toEqual({ value: 'Kangaroo', source: 'variant', inheritedFrom: child.id })
    expect(result.brand).toEqual({ value: 'Xavia', source: 'master', inheritedFrom: parent.id })
  })
  it('normalizes physical variant axes while retaining the child as their owner', () => {
    const parent = product({ id: 'parent' })
    const result = read({ product: product({ parentId: parent.id, variantAttributes: { Color: 'Black', Size: '52' } }), parent })
    expect(result.color).toEqual({ value: 'Black', source: 'variant', inheritedFrom: 'p1' })
    expect(result.size.value).toBe('52')
  })
  it.each([null, false, 0, ''])('preserves an explicit factual override of %j', value => {
    const result = read({ product: product({ categoryAttributes: { material: 'Cowhide', armor: 'CE2' } }), parent: null, channelListing: listing({ overrideData: { material: value } }) })
    expect(result.material).toEqual({ value, source: 'channelOverride', inheritedFrom: 'cl1' })
    expect(result.armor.value).toBe('CE2')
  })
  it('an absent override leaves the master fact intact', () => {
    const result = read({ product: product({ categoryAttributes: { material: 'Cowhide' } }), parent: null, channelListing: listing({ overrideData: { other: 'present' } }) })
    expect(result.material.value).toBe('Cowhide')
    expect(result.material.source).toBe('master')
  })
  it.each([
    { followMasterPrice: false, priceOverride: 999, price: 875, expected: 999 },
    { followMasterPrice: false, priceOverride: null, price: 875, expected: 875 },
    { followMasterPrice: false, priceOverride: new Prisma.Decimal('109.99'), price: 105, expected: 109.99 },
    { followMasterPrice: false, priceOverride: null, price: new Prisma.Decimal('0'), expected: 0 },
    { followMasterPrice: true, priceOverride: 999, price: 875, expected: 850 },
    { priceOverride: 999, price: 875, expected: 850 },
  ])('respects price follow and legacy numeric fallback: %j', ({ expected, ...over }) => {
    const result = read({ product: product({ categoryAttributes: { price: 850 } }), parent: null, channelListing: listing(over) })
    expect(result.price.value).toBe(expected)
  })
  it('keeps zero quantity overrides', () => {
    const result = read({ product: product({ categoryAttributes: { quantity: 8 } }), parent: null, channelListing: listing({ followMasterQuantity: false, quantityOverride: 0 }) })
    expect(result.quantity).toEqual({ value: 0, source: 'channelExplicit', inheritedFrom: 'cl1' })
  })
})

describe('attribute adapter: language-addressed content', () => {
  it('reads source columns with their native language and provenance', () => {
    const result = read({ product: product({ name: 'Giacca', description: 'Pelle', bulletPoints: ['Protezione'] }), parent: null })
    expect(result.title).toMatchObject({ value: 'Giacca', source: 'masterColumn', inheritedFrom: 'p1', effectiveLocale: PRIMARY_CONTENT_LOCALE, translationState: 'current' })
    expect(result.description.value).toBe('Pelle')
    expect(result.bulletPoints.value).toEqual(['Protezione'])
  })
  it('uses ProductTranslation for the requested language and falls back per field', () => {
    const result = read({ product: product({ name: 'Giacca', description: 'Pelle', translations: [{ language: 'de', name: 'Jacke', attributes: {}, bulletPoints: [], keywords: [] }] as any }), parent: null, locale: 'de' })
    expect(result.title).toMatchObject({ value: 'Jacke', tier: 'language', effectiveLocale: 'de' })
    expect(result.description).toMatchObject({ value: 'Pelle', tier: 'source', effectiveLocale: PRIMARY_CONTENT_LOCALE, translationState: 'fallback' })
  })
  it('normalizes regional requests without changing the stored language', () => {
    const result = read({ product: product({ name: 'Giacca', translations: [{ language: 'de-DE', name: 'Jacke' }] as any }), parent: null, locale: 'de-AT' })
    expect(result.title).toMatchObject({ value: 'Jacke', requestedLocale: 'de', effectiveLocale: 'de' })
  })
  it('does not read retired localized JSON or untagged fact bags as content', () => {
    const result = read({ product: product({ name: 'Giacca', localizedContent: { de: { title: 'Retired' } }, categoryAttributes: { title: 'Wrong bag' } }), parent: null, locale: 'de', channelListing: listing({ overrideData: { title: 'Wrong override' } }) })
    expect(result.title).toMatchObject({ value: 'Giacca', tier: 'source', translationState: 'fallback' })
  })
  it('source content remains authoritative when factual synthesis is disabled', () => {
    expect(read({ product: product({ name: 'Giacca' }), parent: null, synthesize: false }).title.value).toBe('Giacca')
  })
  it('uses the child source and falls back to the parent when the child has none', () => {
    const parent = product({ id: 'parent', name: 'Parent', description: 'Parent description' })
    const result = read({ product: product({ parentId: parent.id, name: 'Child' }), parent })
    expect(result.title).toMatchObject({ value: 'Child', inheritedFrom: 'p1' })
    expect(result.description).toMatchObject({ value: 'Parent description', inheritedFrom: parent.id })
  })
  it.each([true])('ignores legacy title overrides while following (%s)', followMasterTitle => {
    const result = read({ product: product({ name: 'Giacca' }), parent: null, channelListing: listing({ followMasterTitle, titleOverride: 'Pinned' }) })
    expect(result.title.value).toBe('Giacca')
  })
  it('uses an explicit legacy pin only in the listing primary language', () => {
    const input = { product: product({ name: 'Giacca' }), parent: null, channelListing: listing({ followMasterTitle: false, titleOverride: 'Pinned' }) }
    expect(read(input).title).toMatchObject({ value: 'Pinned', source: 'channelExplicit', tier: 'pin', inheritedFrom: 'cl1' })
    expect(read({ ...input, locale: 'de' }).title.value).toBe('Giacca')
  })
  it('requires market language authority before reading listing content', () => {
    expect(() => resolveAttributes({ product: product(), parent: null, channelListing: listing() })).toThrow('hydrated Marketplace.languages')
  })
})

describe('attribute adapter convenience projections', () => {
  it('flat projection includes factual and explicitly empty content values', () => {
    expect(resolveAttributesFlat({ product: product({ categoryAttributes: { material: 'Cowhide' } }), parent: null })).toEqual({ material: 'Cowhide', title: null, description: null, bulletPoints: null, keywords: null })
  })
  it('filters to explicit channel factual overrides', () => {
    const result = resolveAttributesBySource({ product: product({ categoryAttributes: { material: 'Cowhide' } }), parent: null, channelListing: listing({ overrideData: { material: 'Premium' } }), coordinate: { channel: 'EBAY', market: 'IT' }, marketLanguages: ['it'] }, ['channelOverride', 'channelExplicit'])
    expect(result).toEqual({ material: { value: 'Premium', source: 'channelOverride', inheritedFrom: 'cl1' } })
  })
})
