import { expect, it } from 'vitest'
import { etsyContentState } from './information-content.js'
it('uses canonical translations and keeps an empty language pin independent of source tags', () => {
  const listing = { id: 'listing', productId: 'product', channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'account', languages: ['en', 'fr', 'de'],
    product: { id: 'product', name: 'Original', keywords: ['jacket'], translations: [{ language: 'fr', name: 'Veste', source: 'manual', reviewedAt: new Date() }] },
    platformAttributes: { language: 'en', title: 'Retired import', tags: ['retired'] }, overrideData: { title: 'Historical override' }, translations: [] as any[] }
  expect(etsyContentState(listing, 'de', 'title')).toMatchObject({ value: 'Original', effectiveLocale: 'it', translationState: 'fallback', needsTranslation: true })
  expect(etsyContentState(listing, 'fr', 'title')).toMatchObject({ value: 'Veste', effectiveLocale: 'fr', needsTranslation: false })
  const changed = { ...listing, translations: [{ language: 'de', attributes: { keywords: [] }, follows: [], source: 'import', reviewedAt: null }] }
  expect(etsyContentState(changed, 'de', 'tags')).toMatchObject({ value: [], tier: 'pin', translationState: 'draft', needsTranslation: false })
  expect(etsyContentState(changed, 'it', 'tags')?.value).toEqual(['jacket'])
  const reset = { ...changed, translations: [{ ...changed.translations[0], attributes: {}, follows: ['keywords'] }] }
  expect(etsyContentState(reset, 'de', 'tags')).toMatchObject({ value: ['jacket'], translationState: 'fallback' })
  expect(reset.platformAttributes).toEqual(listing.platformAttributes)
  expect(reset.overrideData).toEqual(listing.overrideData)
})
