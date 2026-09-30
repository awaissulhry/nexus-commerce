/**
 * #30 (2026-09-30) — publish reads the item location city and postal code from the listing (`settings.itemLocation`,
 * `settings.itemPostalCode` in `studio-publication-ebay.ts`), and refuses a NEW listing without the city. Nothing on
 * screen could set them, so a listing on an account with no default location could not be created from the sheet.
 */
import { expect, it } from 'vitest'
import { ebaySpecFromCache } from './ebay.js'

it('offers the item location city and postal code as listing columns, stored where publish reads them', () => {
  const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] })
  const field = (key: string) => spec.fields.find(f => f.key === key)
  expect(field('itemLocation')).toMatchObject({ englishLabel: 'Item location (city)', kind: 'text', channelStore: { kind: 'platformAttributes', path: ['itemLocation'] } })
  expect(field('itemPostalCode')).toMatchObject({ englishLabel: 'Item location postal code', kind: 'text', channelStore: { kind: 'platformAttributes', path: ['itemPostalCode'] } })
  expect(field('itemLocationCountry')).toBeDefined()
})
