import { describe, expect, it } from 'vitest'
import { PRODUCT_MEDIA_KEY, productMediaCollectionSchema, productMediaQuerySchema, readMediaCollection, resolveMediaCollection, writeMediaCollection } from './product-media'
const gallery = (ids: string[]) => ({ version: 1 as const, items: ids.map(assetId => ({ assetId })) })
const content = (locale: string, ids: string[]) => ({ [locale]: { [PRODUCT_MEDIA_KEY]: gallery(ids) } })
const base = { locale: 'it', own: {}, ownIds: ['own'], parentIds: ['parent'] }

describe('Product media locale and scope contract', () => {
  it('resolves exact language, neutral language and shared defaults without borrowing another locale', () => {
    expect(resolveMediaCollection({ ...base, own: content('it', ['italian']) }).collection).toEqual(gallery(['italian']))
    expect(resolveMediaCollection({ ...base, own: content('und', ['neutral']) }).source).toBe('all-languages')
    expect(resolveMediaCollection({ ...base, own: content('de', ['german']), shared: content('und', ['shared']) }).collection).toEqual(gallery(['shared']))
  })
  it('preserves explicit empty galleries, and uses the parent only when the child has no own media', () => {
    expect(resolveMediaCollection({ ...base, own: content('it', []) }).collection.items).toEqual([])
    expect(resolveMediaCollection({ ...base, parent: content('it', ['parent-localized']) }).collection).toEqual(gallery(['own']))
    expect(resolveMediaCollection({ ...base, ownIds: [], parent: content('it', ['parent-localized']) }).collection).toEqual(gallery(['parent-localized']))
  })
  it('changes only the selected language and keeps unrelated localized content', () => {
    const before = { ...content('de', ['german']), it: { title: 'Giacca', [PRODUCT_MEDIA_KEY]: gallery(['old']) }, en: { description: 'Jacket' } }
    const saved = writeMediaCollection(before, 'it', gallery(['new']))
    expect(saved.de).toEqual(before.de); expect(saved.en).toEqual(before.en)
    expect(saved.it).toEqual({ title: 'Giacca', [PRODUCT_MEDIA_KEY]: gallery(['new']) })
    expect(writeMediaCollection(saved, 'it', null).it).toEqual({ title: 'Giacca' })
    expect(before.it[PRODUCT_MEDIA_KEY]).toEqual(gallery(['old']))
  })
  it('rejects duplicate IDs, executable caption URLs and malformed saved data', () => {
    expect(productMediaCollectionSchema.safeParse(gallery(['a', 'a'])).success).toBe(false)
    expect(productMediaCollectionSchema.safeParse({ version: 1, items: [{ assetId: 'a', captions: [{ url: 'javascript:alert(1)', language: 'it', label: 'Italian' }] }] }).success).toBe(false)
    expect(() => readMediaCollection({ it: { [PRODUCT_MEDIA_KEY]: { version: 99 } } }, 'it')).toThrow()
  })
  it('requires the exact channel account and listing, supports future channels and canonicalizes language tags', () => {
    const query = { scope: 'FUTURE_STORE', market: 'CA', locale: 'fr-ca', accountId: 'store-2', listingId: 'listing-2' }
    expect(productMediaQuerySchema.parse(query).locale).toBe('fr')
    expect(productMediaQuerySchema.safeParse({ ...query, accountId: undefined }).success).toBe(false)
    expect(productMediaQuerySchema.safeParse({ ...query, listingId: undefined }).success).toBe(false)
    expect(productMediaQuerySchema.safeParse({ ...query, scope: 'MASTER' }).success).toBe(false)
    expect(productMediaQuerySchema.safeParse({ scope: 'MASTER', market: 'GLOBAL', locale: 'und' }).success).toBe(true)
    expect(productMediaQuerySchema.safeParse({ ...query, listingId: undefined, aliasKey: '' }).success).toBe(true)
  })
})
