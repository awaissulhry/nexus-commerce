import { describe, expect, it } from 'vitest'
import { newListingChoices } from './new-listing-choices.js'

/** New listings (Owner 2026-10-04) — what Publish does with each row of a family not on the channel, on one destination. PURE. */
const products = [{ id: 'main', parentId: null }, { id: 's', parentId: 'main' }, { id: 'm', parentId: 'main' }]
const draft = (productId: string, extra: Record<string, unknown> = {}) =>
  ({ id: `l-${productId}`, productId, externalListingId: null, listingStatus: 'DRAFT', isPublished: false, sellingTarget: null, ...extra })

describe('newListingChoices', () => {
  it('own choice, else the main row\'s, else today\'s default; a variation with no listing reads Not listed on Amazon', () => {
    const choices = newListingChoices({ channel: 'AMAZON', aliasKey: '', familyId: 'main', products,
      listings: [draft('main', { sellingTarget: 'INACTIVE' }), draft('s', { sellingTarget: 'ACTIVE' })] })
    expect([...choices.values()].map(c => [c.productId, c.target, c.source, c.noRecord])).toEqual([
      ['main', 'inactive', 'own', false], ['s', 'active', 'own', false], ['m', 'inactive', 'main', true]])
    const plain = newListingChoices({ channel: 'AMAZON', aliasKey: '', familyId: 'main', products, listings: [draft('main'), draft('s')] })
    expect(plain.get('m')).toMatchObject({ target: 'not_listed', source: 'default', defaultTarget: 'not_listed', includedByDefault: false })
    expect(plain.get('s')).toMatchObject({ target: 'active', source: 'default' })
  })
  it('a listing on the channel and one waiting for its channel number are not new', () => {
    const choices = newListingChoices({ channel: 'AMAZON', aliasKey: '', familyId: 'main', products,
      listings: [draft('main', { externalListingId: 'B0X', listingStatus: 'ACTIVE', isPublished: true }), draft('s', { listingStatus: 'ACTIVE', isPublished: true })] })
    expect([...choices.keys()]).toEqual(['m'])
  })
  it('a deleted row (simplify) is a row not on the channel: Not listed by default, its own Active lists it again, its main row\'s choice reaches it', () => {
    const deletion = { at: '2026-10-04T10:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD00001', relistChosenAt: null }
    const deletions = new Map([['l-main', deletion], ['l-s', deletion], ['l-m', deletion]])
    const all = (listings: ReturnType<typeof draft>[]) => newListingChoices({ channel: 'AMAZON', aliasKey: '', familyId: 'main', products, listings, deletions })
    const rest = all([draft('main'), draft('s'), draft('m')])
    expect([...rest.values()].map(c => [c.productId, c.target, c.source, c.defaultTarget, c.deleted?.where])).toEqual([
      ['main', 'not_listed', 'default', 'not_listed', 'Amazon · IT'], ['s', 'not_listed', 'default', 'not_listed', 'Amazon · IT'], ['m', 'not_listed', 'default', 'not_listed', 'Amazon · IT']])
    const relist = all([draft('main', { sellingTarget: 'ACTIVE' }), draft('s'), draft('m', { sellingTarget: 'NOT_LISTED' })])
    expect([...relist.values()].map(c => [c.productId, c.target, c.source])).toEqual([['main', 'active', 'own'], ['s', 'active', 'main'], ['m', 'not_listed', 'own']])
  })
  it('an OLDER relist choice (Action Partial or Full update after the delete) reads as Status Active until a Status choice replaces it', () => {
    const chosen = { at: '2026-10-04T10:00:00.000Z', where: 'Amazon · IT', oldReference: null, relistChosenAt: '2026-10-04T11:00:00.000Z' }
    const read = (sellingTarget: string | null) => newListingChoices({ channel: 'AMAZON', aliasKey: '', familyId: 's', products: [{ id: 's', parentId: null }],
      listings: [draft('s', { sellingTarget })], deletions: new Map([['l-s', chosen]]) }).get('s')
    expect(read(null)).toMatchObject({ target: 'active', source: 'own', own: 'active' })
    expect(read('NOT_LISTED')).toMatchObject({ target: 'not_listed', source: 'own' })
  })
  it('eBay: a family never started here creates every variation; a variation left out of the listing reads Not listed', () => {
    expect([...newListingChoices({ channel: 'EBAY', aliasKey: '', familyId: 'main', products, listings: [] }).values()].map(c => c.target)).toEqual(['active', 'active', 'active'])
    const excluded = newListingChoices({ channel: 'EBAY', aliasKey: '', familyId: 'main', products, listings: [draft('main'), draft('s'), draft('m')], excludedListingIds: new Set(['l-m']) })
    expect(excluded.get('m')).toMatchObject({ target: 'not_listed', includedByDefault: false })
  })
  it('Shopify: a Draft product unless its stored Shopify status is ACTIVE', () => {
    expect(newListingChoices({ channel: 'SHOPIFY', aliasKey: '', familyId: 'main', products: [products[0]], listings: [draft('main')] }).get('main')!.target).toBe('inactive')
    expect(newListingChoices({ channel: 'SHOPIFY', aliasKey: '', familyId: 'main', products: [products[0]], listings: [draft('main')], shopifyActive: true }).get('main')!.target).toBe('active')
  })
})
