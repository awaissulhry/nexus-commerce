import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get() { throw new Error('Shadow attempted a database call') } }) }))
import { classifyContentDiff, compareProductionContent, equalContent } from '../../../../../docs/audits/2026-09-12-language-axis/step3-switch/accepted-shadow-runtime.mjs'
import { resolveContentPath } from './content-resolver.js'

const fixture = () => ({
  products: [{ id: 'p', sku: 'P', name: 'Fonte', description: 'Descrizione', parentId: null, localizedContent: {}, categoryAttributes: {}, variantAttributes: {} }],
  listings: [{ id: 'l', productId: 'p', channel: 'AMAZON', marketplace: 'BE', title: 'Nederlands', followMasterTitle: true, channelConnectionId: 'account' }],
  marketplaces: [{ channel: 'AMAZON', code: 'BE', languages: ['nl', 'fr'], schemaMapping: { fields: { item_name: { source: 'localizedContent.{locale}.title' } } } }],
  translations: [],
})

describe('production shadow coverage and non-vacuous controls', () => {
  it('covers both Belgium languages, actual mapping sources and the shared product', () => {
    const report = compareProductionContent(fixture())
    expect(report.coveredListings).toBe(1)
    for (const language of ['nl', 'fr']) for (const field of ['title', 'description', 'bulletPoints', 'keywords']) expect(report.counts.find(c => c.reader === 'attribute-coordinate' && c.language === language && c.field === field)?.compared).toBe(1)
    expect(report.counts.filter(c => c.reader === 'mapping-source').reduce((n, c) => n + c.compared, 0)).toBe(2)
    expect(report.diffs.some(d => d.language === 'nl' && d.next.tier === 'pin' && d.next.value === 'Nederlands')).toBe(true)
    expect(report.diffs.some(d => d.language === 'fr' && d.next.value === 'Fonte')).toBe(true)
  })
  it('keeps account and alias listing coordinates separate', () => {
    const data = fixture()
    data.listings.push({ ...data.listings[0], id: 'l2', channelConnectionId: 'another', title: 'Tweede' })
    const report = compareProductionContent(data)
    expect(report.coveredListings).toBe(2)
    expect(new Set(report.diffs.filter(d => d.reader === 'attribute-coordinate' && d.field === 'title' && d.language === 'nl').map(d => d.next.value))).toEqual(new Set(['Nederlands', 'Tweede']))
  })
  it('includes products without a listing, and refuses unmatched listing rows', () => {
    const data = fixture(); data.products.push({ ...data.products[0], id: 'unlisted' })
    const report = compareProductionContent(data)
    expect(report.counts.find(c => c.reader === 'attribute-coordinate' && c.field === 'title' && c.language === 'fr')?.compared).toBe(2)
    data.listings[0].marketplace = 'UNKNOWN'
    expect(() => compareProductionContent(data)).toThrow('coverage mismatch')
  })
  it('crosses unlisted products with every observed account coordinate', () => {
    const data = fixture(); data.products.push({ ...data.products[0], id: 'unlisted' })
    data.listings.push({ ...data.listings[0], id: 'l2', channelConnectionId: 'second' })
    const report = compareProductionContent(data)
    expect(report.counts.find(c => c.reader === 'attribute-coordinate' && c.field === 'title' && c.language === 'fr')?.compared).toBe(4)
    expect(report.coordinates).toBe(2)
    expect(report.coveredListings).toBe(2)
  })
  it('compares exact text bytes and array order', () => {
    expect(equalContent(' title', 'title')).toBe(false)
    expect(equalContent(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(equalContent('é', 'e\u0301')).toBe(false)
  })
  it('refuses to classify an injected value defect as source retirement', () => {
    expect(classifyContentDiff({ old: { value: 'Old JSON', source: 'masterLocale' }, next: { value: 'INJECTED', tier: 'source', language: 'it', requested: 'de', provenance: { member: 'inherited', from: null } }, product: { name: 'Real source', localizedContent: { de: { title: 'Old JSON' } } }, field: 'title', reader: 'attribute-coordinate' })).toBe('UNCLASSIFIED')
  })
  it('rejects an injected wrong-language label even when the bytes match', () => {
    expect(classifyContentDiff({ old: { value: 'Fonte' }, next: { value: 'Fonte', tier: 'source', language: 'de', requested: 'de', provenance: { member: 'inherited', from: null } }, product: { name: 'Fonte' }, field: 'title', reader: 'attribute-coordinate' })).toBe('UNCLASSIFIED')
  })
  it('classifies an exact-language miss against the established native variant alias', () => {
    expect(classifyContentDiff({ old: { value: null }, next: { value: 'Da motociclista', tier: 'source', language: 'it', requested: 'de', provenance: { member: 'inherited', from: null } }, product: { id: 'p', parentId: null, localizedContent: {}, categoryAttributes: {}, variantAttributes: { Style: 'Da motociclista' } }, field: 'style', reader: 'sourceContent' })).toBe('R6-explicit-source-fallback')
  })
  it('resolves mapping paths through the new tier without reading the old JSON path', () => {
    const product = { ...fixture().products[0], translations: [{ language: 'de', name: 'Titel', bulletPoints: ['Erster'] }] }
    Object.defineProperty(product, 'localizedContent', { get() { throw new Error('Legacy read') } })
    expect(resolveContentPath({ product, path: 'localizedContent.de-DE.title', address: { requested: 'fr' } })).toMatchObject({ value: 'Titel', language: 'de', requested: 'de', tier: 'language' })
    expect(resolveContentPath({ product, path: 'localizedContent.{locale}.bulletPoints.0', address: { requested: 'de-DE' } })?.value).toBe('Erster')
    expect(resolveContentPath({ product, path: 'price', address: { requested: 'de' } })).toBeNull()
  })
  it('does not mutate catalogue rows while comparing regional table keys', () => {
    const data = { ...fixture(), translations: [{ productId: 'p', language: 'fr-FR', name: 'Français' }] }
    const before = JSON.stringify(data)
    compareProductionContent(data)
    expect(JSON.stringify(data)).toBe(before)
  })
  it.each(['ETSY', 'SHOPIFY'])('exercises the %s locale-bag reader without a provider', channel => {
    const data = {
      products: fixture().products,
      marketplaces: [{ channel, code: 'GLOBAL', languages: ['fr'] }],
      translations: [],
      listings: [{ id: 'store', productId: 'p', channel, marketplace: 'GLOBAL', channelConnectionId: 'account', title: 'Stored title', followMasterTitle: false,
        platformAttributes: { _etsyInformationLocales: { fr: { title: 'Ancien Etsy' } }, _shopifyInformationLocales: { fr: { title: 'Ancien Shopify', descriptionHtml: 'Ancienne description' } } } }],
    }
    const report = compareProductionContent(data)
    const reader = channel === 'ETSY' ? 'etsyContentState' : 'shopify-information-locale'
    expect(report.counts.some(c => c.reader === reader && c.compared > 0)).toBe(true)
    expect(report.diffs.some(d => d.reader === reader && d.field === 'title' && d.next.value === 'Stored title' && d.classification === 'R7-outbound-content-retired')).toBe(true)
  })
})
