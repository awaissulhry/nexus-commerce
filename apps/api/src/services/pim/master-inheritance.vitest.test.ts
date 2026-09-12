import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { resolveAttributes, type ProductLike } from './attribute-resolver.js'

const product: ProductLike = { id: 'p', parentId: null, categoryAttributes: {}, variantAttributes: {}, localizedContent: {} }
describe('canonical Master inheritance', () => {
  it('shares language-independent facts in every content locale', () => {
    for (const locale of ['it', 'de', 'fr', 'en']) {
      const values = resolveAttributes({ product: { ...product, brand: 'Master brand', basePrice: 35 }, parent: null, locale })
      expect(values.brand?.value).toBe('Master brand')
      expect(values.basePrice?.value).toBe(35)
    }
  })
  it('uses the native Master brand instead of a conflicting historical copy', () => {
    const values = resolveAttributes({ product: { ...product, brand: 'Current brand', categoryAttributes: { brand: 'Historical brand' } }, parent: null, locale: 'it' })
    expect(values.brand.value).toBe('Current brand')
  })
  it('lets a channel override the canonical fact without changing Master', () => {
    const master = { ...product, brand: 'Shared' }
    expect(resolveAttributes({ product: master, parent: null, channelListing: { id: 'listing', overrideData: { brand: 'Channel' } }, locale: 'it' }).brand.value).toBe('Channel')
    expect(resolveAttributes({ product: master, parent: null, locale: 'it' }).brand.value).toBe('Shared')
  })
  it('inherits empty child facts from the parent', () => {
    const values = resolveAttributes({ product: { ...product, id: 'child', parentId: 'p', brand: '' }, parent: { ...product, brand: 'Shared' }, locale: 'it' })
    expect(values.brand.value).toBe('Shared')
  })
  it('makes native decimal prices numeric before preview validation', () => {
    const values = resolveAttributes({ product: { ...product, basePrice: new Prisma.Decimal('0') as any }, parent: null, locale: 'it' })
    expect(values.basePrice.value).toBe(0)
  })
  it('inherits historical origin without losing canonical native precedence', () => {
    const old = { ...product, categoryAttributes: { country_of_origin: 'PK' } }
    expect(resolveAttributes({ product: old, parent: null, locale: 'it' }).countryOfOrigin.value).toBe('PK')
    expect(resolveAttributes({ product: { ...old, countryOfOrigin: 'IT' }, parent: null, locale: 'it' }).country_of_origin.value).toBe('IT')
  })
})
