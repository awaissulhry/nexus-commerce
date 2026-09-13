import { afterEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ product: { findMany: vi.fn() } }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./catalog-transfer.service.js', () => ({ TransferConflict: class TransferConflict extends Error {} }))
import { resolveAttributes } from './attribute-resolver.js'
import { resolveChannelField, resolveSourcePath } from './resolve-channel-field.js'
import { sourceContent } from './content-locale.js'
import { resolvedContent } from '../products/translation-resolver.service.js'
import { globalContentLocales } from './global-content.js'
import { translationCoverage } from '../translation-completeness.service.js'
import { loadCurrentValues } from '../ai/enrichment/draft.service.js'
import { etsyContentState } from '../etsy/information-content.js'
import { informationContentState } from '../shopify/listing-information-plan.js'
import { shopifyProductSpec } from './channel-specs/store.js'
import { masterTransferState } from './catalog-transfer-plan.js'
import { readMediaCollection } from '@nexus/shared/product-media'

const product = () => ({ id: 'p', workspaceId: 'w', parentId: null, name: 'Fonte italiana', description: 'Descrizione', bulletPoints: [], keywords: [], categoryAttributes: { care: 'Lavare' }, variantAttributes: {},
  translations: [{ productId: 'p', workspaceId: 'w', language: 'de-DE', name: 'Deutscher Titel' }] })
afterEach(() => vi.clearAllMocks())
describe('LX.3 switched reader integration', () => {
  it('uses the same parent translation in attributes, global, API and explicit mapping paths', () => {
    const parent = product(), child = { ...product(), id: 'c', parentId: 'p', name: 'Child source', translations: [], parent }
    const resolved = resolveAttributes({ product: child as any, parent: parent as any, locale: 'DE_de' })
    expect(resolved.title).toMatchObject({ value: 'Deutscher Titel', language: 'de', inheritedFrom: 'p' })
    expect(globalContentLocales(child as any, parent as any).de.title).toBe('Deutscher Titel')
    expect(resolvedContent(child, 'de').name).toBe('Deutscher Titel')
    expect(sourceContent(child, 'title', 'de')).toBe('Deutscher Titel')
    expect(resolveSourcePath('localizedContent.de-DE.title', {}, child, 'fr')).toBe('Deutscher Titel')
  })
  it('keeps [] in both top-level API lists and fields metadata', () => {
    const result = resolvedContent(product(), 'fr')
    expect(result.bulletPoints).toEqual([])
    expect(result.keywords).toEqual([])
    expect(result.fields.bulletPoints.value).toEqual([])
    expect(result.fields.keywords.value).toEqual([])
  })
  it('coverage cannot count non-empty Italian source as German translation', () => {
    expect(translationCoverage(product() as any, 'de')).toMatchObject({ fieldCount: 1, hasContent: true })
    expect(translationCoverage(product() as any, 'fr')).toMatchObject({ fieldCount: 0, hasContent: false })
    expect(translationCoverage(product() as any, 'it')).toMatchObject({ fieldCount: 2, hasContent: true })
  })
  it('AI translation targeting reads missing from language, even when the fallback is non-empty', async () => {
    db.product.findMany.mockResolvedValue([product()])
    const base = { channel: null, marketplace: null, aliasId: null, writeField: 'title' }
    const addresses = [{ ...base, locale: 'fr' }, { ...base, locale: 'de-DE' }]
    const current = await loadCurrentValues(['p'], addresses)
    expect(current.get('p', addresses[0])).toEqual({ found: true, ambiguous: false, value: null })
    expect(current.get('p', addresses[1]).value).toBe('Deutscher Titel')
  })
  it('mapping transformations retain actual source language, including custom expression dependencies', () => {
    const p = product(), attrs = resolveAttributes({ product: p as any, parent: null, locale: 'fr', localizableKeys: ['care'] })
    const mapped = resolveChannelField({ product: p, resolvedAttrs: attrs, locale: 'fr', fieldKey: 'title', rule: { source: 'title', transforms: [{ type: 'upperCase' }] } })
    expect(mapped).toMatchObject({ value: 'FONTE ITALIANA', language: 'it', requested: 'fr', needsTranslation: true })
    const computed = resolveChannelField({ product: p, resolvedAttrs: attrs, locale: 'fr', fieldKey: 'care', rule: { source: '', transforms: [{ type: 'expr', expr: 'upper($care)' }] } })
    expect(computed).toMatchObject({ value: 'LAVARE', language: 'it', needsTranslation: true })
  })
  it.each(['ETSY', 'SHOPIFY'])('%s reads canonical product/listing content with hydrated market authority', channel => {
    const listing = { id: 'l', workspaceId: 'w', productId: 'p', channel, marketplace: 'GLOBAL', channelConnectionId: 'account', languages: ['de'], followMasterTitle: true, title: 'Following snapshot', product: product(),
      platformAttributes: { _etsyInformationLocales: { de: { title: 'RETIRED' } }, _shopifyInformationLocales: { de: { title: 'RETIRED' } } } }
    if (channel === 'ETSY') expect(etsyContentState(listing, 'de-DE', 'title')).toMatchObject({ value: 'Following snapshot', follows: true, drift: true, needsTranslation: false })
    else expect(informationContentState(listing, shopifyProductSpec().fields.find(f => f.masterKey === 'name')!)).toEqual({ state: 'stored', value: 'Following snapshot' })
  })
  it('catalogue transfer treats source fallback as untranslated, and keeps an explicit clear distinct', () => {
    const title = { key: 'name', storage: 'column' } as any
    expect(masterTransferState(product() as any, title, 'fr')).toMatchObject({ state: 'inherited' })
    expect(masterTransferState(product() as any, title, 'de-DE')).toMatchObject({ state: 'stored', value: 'Deutscher Titel' })
    // R-LX-8 corrects this assertion, with the reason recorded beside it: a child
    // that inherits its parent's German row does not OWN it, so `stored` was
    // wrong — but the old code answered `{ state:'inherited', value:null }` and an
    // export of that child alone lost the German title with nothing on the file to
    // show it existed. Three states: stored · inherited-with-value-and-owner ·
    // inherited-untranslated (null).
    expect(masterTransferState({ ...product(), id: 'c', parentId: 'p', translations: [], parent: product() } as any, title, 'de')).toEqual({ state: 'inherited', value: 'Deutscher Titel', from: 'p' })
    expect(masterTransferState({ ...product(), categoryAttributes: { care: null } } as any, { key: 'care', storage: 'localizedContent' } as any, 'it')).toEqual({ state: 'stored', value: null })
  })
  it('an explicit language mapping path retains its exact account/listing pin context', () => {
    const p = product()
    const contentListing = { id: 'l', workspaceId: 'w', productId: 'p', coordinate: { channel: 'AMAZON', market: 'BE', accountId: 'a' }, languages: ['nl', 'fr'], title: 'Dutch snapshot', followMasterTitle: true }
    expect(resolveSourcePath('localizedContent.nl-BE.title', {}, { ...p, contentListing }, 'fr')).toBe('Dutch snapshot')
    expect(resolveSourcePath('localizedContent.fr-BE.title', {}, { ...p, contentListing }, 'nl')).toBe('Fonte italiana')
  })
  it('normalizes media collection/caption addresses without changing legacy JSON', () => {
    const content = { 'de-DE': { _productMedia: { version: 1, items: [{ assetId: 'a', captions: [{ url: 'https://example.test/caption.vtt', language: 'DE_de', label: 'German' }] }] } } }
    const before = JSON.stringify(content)
    expect(readMediaCollection(content, 'de')?.items[0].captions[0].language).toBe('de')
    expect(JSON.stringify(content)).toBe(before)
  })
})
