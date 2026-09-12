import { expect, it } from 'vitest'
import { etsyContentState } from './information-content.js'
import { etsyProductSpec } from '../pim/channel-specs/etsy.js'
import { channelValuePatch, storedChannelState } from '../pim/channel-value-mutation.js'
it('marks imported language fallback and keeps explicit empty translation drafts independent', () => {
  const listing = { platformAttributes: { language: 'en', title: 'Original', tags: ['jacket'], translations: [{ language: 'fr', title: 'Veste' }] }, overrideData: { title: 'Historical override' } }
  expect(etsyContentState(listing, 'de', 'title')).toMatchObject({ value: 'Original', effectiveLocale: 'en', translationState: 'fallback', needsTranslation: true })
  expect(etsyContentState(listing, 'fr', 'title')).toMatchObject({ value: 'Veste', effectiveLocale: 'fr', needsTranslation: false })
  const store = etsyProductSpec('de').fields.find(field => field.key === 'tags')!.channelStore
  const changed = { ...listing, ...channelValuePatch(listing, store, ['tags'], 'SET', []) }
  expect(storedChannelState(changed, store, ['tags'])).toEqual({ state: 'stored', value: [] })
  expect(etsyContentState(changed, 'de', 'tags')).toMatchObject({ value: [], translationState: 'draft', needsTranslation: false })
  expect(etsyContentState(changed, 'en', 'tags')?.value).toEqual(['jacket'])
  const reset = { ...changed, ...channelValuePatch(changed, store, ['tags'], 'INHERIT') }
  expect(etsyContentState(reset, 'de', 'tags')).toMatchObject({ value: ['jacket'], translationState: 'fallback' })
  expect(reset.overrideData).toEqual(listing.overrideData)
})
