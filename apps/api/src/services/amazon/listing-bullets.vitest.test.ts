import { expect, it } from 'vitest'
import { amazonListingBullets } from './listing-bullets.js'

it('CHMAP M7 (B4): reads Amazon\'s stored bullet_point values, then the listing\'s own bullets', () => {
  const stored = { attributes: { bullet_point: [{ value: 'Impermeabile', language_tag: 'it_IT' }, { value: 'Ventilata', language_tag: 'it_IT' }] } }
  expect(amazonListingBullets({ platformAttributes: stored })).toEqual(['Impermeabile', 'Ventilata'])
  expect(amazonListingBullets({ platformAttributes: {}, bulletPointsOverride: ['Leggera', ' '] })).toEqual(['Leggera'])
  expect(amazonListingBullets({ platformAttributes: stored, bulletPointsOverride: ['Leggera'] })).toEqual(['Impermeabile', 'Ventilata'])
  expect(amazonListingBullets({ platformAttributes: null })).toEqual([])
})

it('keeps the old top-level keys exactly as before where a row has them', () => {
  expect(amazonListingBullets({ platformAttributes: { bullet_points: ['Old one'], attributes: { bullet_point: [{ value: 'New' }] } } })).toEqual(['Old one'])
  expect(amazonListingBullets({ platformAttributes: { bulletPoints: ['Camel'] } })).toEqual(['Camel'])
})
