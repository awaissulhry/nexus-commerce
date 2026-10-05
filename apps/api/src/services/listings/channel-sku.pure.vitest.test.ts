/**
 * S2 — the per-listing channel SKU rules (channel-sku.pure.ts): the old stores in today's order, conflicts, the Amazon
 * alias refusal, draft → nothing live, and parity with today's Amazon Publish rule (studio-publication-amazon.ts).
 */
import { describe, expect, it } from 'vitest'
import { AMAZON_LISTING_SKU_KEYS } from '../channel-mapping/defaults.js'
import { nativeListingValue } from '../shopify/native-listing-value.js'
import {
  SHOPIFY_SKU_STORES, differsFromProduct, legacyChannelSku, legacyChannelSkus, legacySkuIsLive, liveChannelSku, wantedChannelSku,
  type ChannelSkuListing,
} from './channel-sku.pure.js'

const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0LIVE' } as const
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null } as const
const amazon = (facts: Partial<ChannelSkuListing> = {}): ChannelSkuListing => ({ channel: 'AMAZON', productId: 'p1', aliasKey: '', ...LIVE, ...facts })
const offer = (sku: string, isActive = true, fulfillmentMethod = 'FBM') => ({ sku, isActive, fulfillmentMethod })

describe('legacyChannelSkus — the old stores in today\'s order', () => {
  it('Amazon: active offers, then the platformAttributes keys in their order, then the flat-file snapshot; trimmed and de-duplicated', () => {
    const listing = amazon({
      offers: [offer(' OFF-1 '), offer('OLD', false)],
      platformAttributes: { item_sku: 'PA-ITEM', sku: 'PA-SKU', seller_sku: 'OFF-1', sellerSku: 'PA-SELLER' },
      flatFileSnapshot: { item_sku: 'FF-1' },
    })
    expect(legacyChannelSkus(listing)).toEqual([
      { sku: 'OFF-1', source: 'offer', key: 'FBM' },
      { sku: 'PA-SELLER', source: 'attributes', key: 'sellerSku' },
      { sku: 'PA-SKU', source: 'attributes', key: 'sku' },
      { sku: 'PA-ITEM', source: 'attributes', key: 'item_sku' },
      { sku: 'FF-1', source: 'flatFile', key: 'item_sku' },
    ])
    // The keys are exactly the shared ones Publish and the import read.
    expect(AMAZON_LISTING_SKU_KEYS.platformAttributes).toEqual(['sellerSku', 'seller_sku', 'sku', 'item_sku'])
  })

  it('Amazon: an inactive offer counts only when asked for every offer (matching back)', () => {
    const listing = amazon({ offers: [offer('OLD', false)] })
    expect(legacyChannelSkus(listing)).toEqual([])
    expect(legacyChannelSkus(listing, { offers: 'all' })).toEqual([{ sku: 'OLD', source: 'offer', key: 'FBM' }])
  })

  it('blank, whitespace and non-text values are not SKUs', () => {
    expect(legacyChannelSkus(amazon({ offers: [offer('  ')], platformAttributes: { sellerSku: '', sku: 12345, item_sku: null }, flatFileSnapshot: { item_sku: '   ' } }))).toEqual([])
  })

  it('Shopify: the native SKU, as nativeListingValue reads it (platformAttributes first, then the override bag)', () => {
    expect(legacyChannelSkus({ channel: 'SHOPIFY', platformAttributes: { sku: 'SH-1' } })).toEqual([{ sku: 'SH-1', source: 'shopify', key: 'sku' }])
    const viaOverride = { channel: 'SHOPIFY', overrideData: { [SHOPIFY_SKU_STORES.overrideKeys[0]]: 'SH-2' } }
    expect(nativeListingValue(viaOverride, 'sku')).toBe('SH-2')
    expect(legacyChannelSkus(viaOverride)).toEqual([{ sku: 'SH-2', source: 'shopify', key: 'sku' }])
    // The Amazon mirror keys mean nothing on a Shopify row (its `sku` key is the Shopify store, read once).
    expect(legacyChannelSkus({ channel: 'SHOPIFY', platformAttributes: { sellerSku: 'AMZ' }, flatFileSnapshot: { item_sku: 'FF' } })).toEqual([])
  })

  it('the Shopify stores the prefilter reads are the spec\'s', () => {
    expect(SHOPIFY_SKU_STORES.attributePaths).toEqual([['sku']])
    expect(SHOPIFY_SKU_STORES.overrideKeys).toEqual(['listing_sku'])
  })

  it('an alias\'s own SKU: on the alias\'s main row only, and never for Amazon', () => {
    const alias = { sku: 'ALIAS-PARENT', productId: 'root' }
    expect(legacyChannelSkus({ channel: 'EBAY', productId: 'root', aliasKey: 'al1', alias })).toEqual([{ sku: 'ALIAS-PARENT', source: 'alias' }])
    expect(legacyChannelSkus({ channel: 'EBAY', productId: 'child', aliasKey: 'al1', alias })).toEqual([])
    expect(legacyChannelSkus({ channel: 'EBAY', productId: 'root', aliasKey: '', alias })).toEqual([])
    expect(legacyChannelSkus({ channel: 'AMAZON', productId: 'root', aliasKey: 'al1', alias })).toEqual([])
    // Shopify native SKU first, then the alias SKU.
    expect(legacyChannelSkus({ channel: 'SHOPIFY', productId: 'root', aliasKey: 'al1', alias, platformAttributes: { sku: 'SH' } }).map(s => s.source)).toEqual(['shopify', 'alias'])
  })

  it('eBay and Etsy rows have no other old store', () => {
    expect(legacyChannelSkus({ channel: 'EBAY', platformAttributes: { sku: 'X', sellerSku: 'Y' }, flatFileSnapshot: { item_sku: 'Z' }, offers: [offer('O')] })).toEqual([])
    expect(legacyChannelSkus({ channel: 'ETSY', platformAttributes: { sku: 'X' } })).toEqual([])
  })
})

describe('wantedChannelSku — what Nexus sends', () => {
  it('the listing\'s own channelSku wins over every old store (even a conflict)', () => {
    expect(wantedChannelSku(amazon({ channelSku: ' OWN ', offers: [offer('A'), offer('B')] }), 'P')).toEqual({ sku: 'OWN', source: 'channel' })
  })

  it('else exactly one old value, with its source', () => {
    expect(wantedChannelSku(amazon({ offers: [offer('OFF')] }), 'P')).toEqual({ sku: 'OFF', source: 'offer' })
    expect(wantedChannelSku(amazon({ platformAttributes: { seller_sku: 'PA' } }), 'P')).toEqual({ sku: 'PA', source: 'attributes' })
    expect(wantedChannelSku(amazon({ flatFileSnapshot: { item_sku: 'FF' } }), 'P')).toEqual({ sku: 'FF', source: 'flatFile' })
    expect(wantedChannelSku({ channel: 'SHOPIFY', platformAttributes: { sku: 'SH' } }, 'P')).toEqual({ sku: 'SH', source: 'shopify' })
    expect(wantedChannelSku({ channel: 'EBAY', productId: 'r', aliasKey: 'a', alias: { sku: 'AL', productId: 'r' } }, 'P')).toEqual({ sku: 'AL', source: 'alias' })
  })

  it('the same value in several stores is one SKU, not a conflict', () => {
    expect(wantedChannelSku(amazon({ offers: [offer('S')], platformAttributes: { sellerSku: 'S ' }, flatFileSnapshot: { item_sku: ' S' } }), 'P')).toEqual({ sku: 'S', source: 'offer' })
  })

  it('else the product SKU', () => {
    expect(wantedChannelSku(amazon(), ' P ')).toEqual({ sku: 'P', source: 'product' })
    expect(wantedChannelSku({ channel: 'EBAY' }, 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('two different old values: a conflict naming both, never a guess', () => {
    const answer = wantedChannelSku(amazon({ offers: [offer('A')], flatFileSnapshot: { item_sku: 'B' } }), 'P')
    expect(answer.sku).toBeNull()
    expect(answer.conflict?.code).toBe('CONFLICTING_SKUS')
    expect(answer.conflict?.candidates.map(c => c.sku)).toEqual(['A', 'B'])
    const shopify = wantedChannelSku({ channel: 'SHOPIFY', productId: 'r', aliasKey: 'a', alias: { sku: 'AL', productId: 'r' }, platformAttributes: { sku: 'SH' } }, 'P')
    expect(shopify.conflict).toMatchObject({ code: 'CONFLICTING_SKUS', sentence: 'P: this Shopify listing has more than one SKU on record (SH, AL). Set this listing\'s own SKU before sending it.' })
  })

  it('Amazon: more than one active offer is refused first; an inactive second offer is not counted', () => {
    expect(wantedChannelSku(amazon({ offers: [offer('A'), offer('B', true, 'FBA')] }), 'P').conflict?.code).toBe('MULTIPLE_ACTIVE_OFFERS')
    expect(wantedChannelSku(amazon({ offers: [offer('A'), offer('B', false, 'FBA')] }), 'P')).toEqual({ sku: 'A', source: 'offer' })
  })

  it('Amazon: an alias with no seller SKU of its own is refused; an eBay alias falls back to the product SKU', () => {
    expect(wantedChannelSku(amazon({ aliasKey: 'al1' }), 'P').conflict).toMatchObject({ code: 'ALIAS_NEEDS_OWN_SKU', sentence: 'P: this alias needs its own Amazon seller SKU before publishing.' })
    expect(wantedChannelSku(amazon({ aliasKey: 'al1', platformAttributes: { sellerSku: 'OWN' } }), 'P')).toEqual({ sku: 'OWN', source: 'attributes' })
    expect(wantedChannelSku({ channel: 'EBAY', aliasKey: 'al1' }, 'P')).toEqual({ sku: 'P', source: 'product' })
  })
})

describe('liveChannelSku — what the channel holds', () => {
  it('a still-draft listing holds nothing on the channel', () => {
    expect(liveChannelSku(amazon({ ...DRAFT, liveChannelSku: 'X', offers: [offer('O')] }), 'P')).toBeNull()
  })

  it('a listing that is not a still-draft (published, ACTIVE, or with a channel id) is read', () => {
    expect(liveChannelSku(amazon({ ...DRAFT, externalListingId: 'B0X' }), 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(liveChannelSku(amazon({ ...DRAFT, isPublished: true }), 'P')).toEqual({ sku: 'P', source: 'product' })
    // A missing fact counts as "not a draft" (the push-lock rule).
    expect(liveChannelSku({ channel: 'EBAY' }, 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('the confirmed liveChannelSku first, then one old value, then the product SKU; channelSku is NOT what the channel holds', () => {
    expect(liveChannelSku(amazon({ liveChannelSku: 'LIVE', channelSku: 'WANT', offers: [offer('O')] }), 'P')).toEqual({ sku: 'LIVE', source: 'live' })
    expect(liveChannelSku(amazon({ channelSku: 'WANT', offers: [offer('O')] }), 'P')).toEqual({ sku: 'O', source: 'offer' })
    expect(liveChannelSku(amazon({ channelSku: 'WANT' }), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('a conflict in the old stores is a conflict here too', () => {
    expect(liveChannelSku(amazon({ offers: [offer('A')], platformAttributes: { sku: 'B' } }), 'P')?.conflict?.code).toBe('CONFLICTING_SKUS')
  })
})

describe('eBay (S4) — an extra listing\'s own SKU is WANTED, never LIVE (eBay publish never sent it)', () => {
  const alias = { sku: 'AL-1', productId: 'root' }
  const ebay = (facts: Partial<ChannelSkuListing> = {}): ChannelSkuListing => ({ channel: 'EBAY', productId: 'root', aliasKey: 'al1', alias, ...LIVE, ...facts })

  it('eBay\'s old store is wanted-only (S5: Shopify\'s too); Amazon\'s and Etsy\'s are read as live', () => {
    expect(legacySkuIsLive({ channel: 'EBAY' })).toBe(false)
    expect(legacySkuIsLive({ channel: 'ebay' })).toBe(false)
    expect(legacySkuIsLive({ channel: 'SHOPIFY' })).toBe(false)
    for (const channel of ['AMAZON', 'ETSY']) expect(legacySkuIsLive({ channel })).toBe(true)
  })

  it('wanted = channelSku ?? the alias SKU (alias main row) ?? Product.sku', () => {
    expect(wantedChannelSku(ebay({ channelSku: 'OWN' }), 'P')).toEqual({ sku: 'OWN', source: 'channel' })
    expect(wantedChannelSku(ebay(), 'P')).toEqual({ sku: 'AL-1', source: 'alias' })
    expect(wantedChannelSku(ebay({ productId: 'child' }), 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(wantedChannelSku(ebay({ aliasKey: '', alias: null }), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('live = liveChannelSku ?? Product.sku: the alias SKU is never read as what eBay holds', () => {
    expect(liveChannelSku(ebay(), 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(liveChannelSku(ebay({ channelSku: 'OWN' }), 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(liveChannelSku(ebay({ liveChannelSku: ' HELD ', channelSku: 'OWN' }), 'P')).toEqual({ sku: 'HELD', source: 'live' })
    expect(liveChannelSku(ebay({ aliasKey: '', alias: null }), ' P ')).toEqual({ sku: 'P', source: 'product' })
  })

  it('a still-draft eBay row holds nothing on eBay; no product SKU and nothing confirmed is NO_SKU, never the alias SKU', () => {
    expect(liveChannelSku(ebay({ ...DRAFT }), 'P')).toBeNull()
    expect(liveChannelSku(ebay(), '')?.conflict?.code).toBe('NO_SKU')
  })

  it('the backfill\'s reading of the old stores is unchanged (the alias SKU, as the wanted value)', () => {
    expect(legacyChannelSku(ebay(), 'P')).toEqual({ sku: 'AL-1', source: 'alias' })
  })

  it('Amazon still reads its old stores as live (parity); Shopify\'s are wanted-only too (S5, below)', () => {
    expect(liveChannelSku(amazon({ offers: [offer('O')] }), 'P')).toEqual({ sku: 'O', source: 'offer' })
    expect(liveChannelSku({ channel: 'SHOPIFY', ...LIVE, platformAttributes: { sku: 'SH' } }, 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(liveChannelSku({ channel: 'SHOPIFY', ...LIVE, productId: 'root', aliasKey: 'al1', alias }, 'P')).toEqual({ sku: 'P', source: 'product' })
  })
})

/**
 * S5 — Shopify's old stores are WANTED values only (`legacySkuIsLive`): the native path (`platformAttributes.sku`) is what
 * the Shopify sheet's SKU column saves and the next Publish sends, and the override bag (`overrideData.listing_sku`)
 * holds older sheet edits. Nothing in them proves what Shopify holds, so live = the confirmed `liveChannelSku`, else the
 * product SKU. wanted = channelSku ?? the override-bag edit ?? the native SKU / alias SKU ?? Product.sku.
 */
describe('S5 — Shopify: the old stores are wanted only; live is the confirmed SKU or the product SKU', () => {
  const shopify = (facts: Partial<ChannelSkuListing> = {}): ChannelSkuListing => ({ channel: 'SHOPIFY', productId: 'p1', aliasKey: '', ...LIVE, ...facts })
  const edit = (sku: string) => ({ overrideData: { [SHOPIFY_SKU_STORES.overrideKeys[0]]: sku } })

  it('parity: no own SKU anywhere → the product SKU, wanted and live', () => {
    expect(wantedChannelSku(shopify(), 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(liveChannelSku(shopify(), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('an edit only in the override bag: wanted, never live', () => {
    expect(wantedChannelSku(shopify(edit('SH-EDIT')), 'P')).toEqual({ sku: 'SH-EDIT', source: 'shopify' })
    expect(liveChannelSku(shopify(edit('SH-EDIT')), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('the native SKU (the sheet\'s SKU column): wanted while no edit is pending, never live', () => {
    expect(wantedChannelSku(shopify({ platformAttributes: { sku: 'SH-NATIVE' } }), 'P')).toEqual({ sku: 'SH-NATIVE', source: 'shopify' })
    expect(liveChannelSku(shopify({ platformAttributes: { sku: 'SH-NATIVE' } }), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('an edit AND a native SKU: the edit is wanted (no conflict); live is still the product SKU', () => {
    const listing = shopify({ platformAttributes: { sku: 'SH-NATIVE' }, ...edit('SH-EDIT') })
    expect(wantedChannelSku(listing, 'P')).toEqual({ sku: 'SH-EDIT', source: 'shopify' })
    expect(liveChannelSku(listing, 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('the columns win: channelSku over every old store (wanted), the confirmed liveChannelSku (live)', () => {
    const listing = shopify({ channelSku: 'OWN', liveChannelSku: ' LIVE ', platformAttributes: { sku: 'SH-NATIVE' }, ...edit('SH-EDIT') })
    expect(wantedChannelSku(listing, 'P')).toEqual({ sku: 'OWN', source: 'channel' })
    expect(liveChannelSku(listing, 'P')).toEqual({ sku: 'LIVE', source: 'live' })
    // channelSku is never what Shopify holds.
    expect(liveChannelSku(shopify({ channelSku: 'OWN' }), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('a still-draft holds nothing on Shopify; it wants its edit. No product SKU and nothing confirmed: NO_SKU, never an old store', () => {
    const draft = shopify({ ...DRAFT, platformAttributes: { sku: 'SH-NATIVE' }, ...edit('SH-EDIT') })
    expect(liveChannelSku(draft, 'P')).toBeNull()
    expect(wantedChannelSku(draft, 'P')).toEqual({ sku: 'SH-EDIT', source: 'shopify' })
    expect(liveChannelSku(shopify({ platformAttributes: { sku: 'SH-NATIVE' } }), '')?.conflict?.code).toBe('NO_SKU')
  })

  it('an extra listing whose own SKU disagrees with the native SKU: a conflict for wanted (an edit settles it); live is not touched by it', () => {
    const alias = { aliasKey: 'al1', alias: { sku: 'AL', productId: 'p1' }, platformAttributes: { sku: 'SH' } }
    expect(wantedChannelSku(shopify(alias), 'P').conflict).toMatchObject({ code: 'CONFLICTING_SKUS', candidates: [{ sku: 'SH' }, { sku: 'AL' }] })
    expect(wantedChannelSku(shopify({ ...alias, ...edit('E') }), 'P')).toEqual({ sku: 'E', source: 'shopify' })
    expect(liveChannelSku(shopify(alias), 'P')).toEqual({ sku: 'P', source: 'product' })
  })

  it('blank values are not SKUs, and the old stores\' listing (matching back) still reads every store', () => {
    expect(wantedChannelSku(shopify({ platformAttributes: { sku: '  ' }, ...edit(' ') }), 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(legacyChannelSkus(shopify(edit('SH-EDIT')))).toEqual([{ sku: 'SH-EDIT', source: 'shopify', key: 'sku' }])
  })

  it('the other channels are unchanged by the Shopify rule (an Amazon `sku` key and an Etsy override bag)', () => {
    expect(liveChannelSku(amazon({ platformAttributes: { sku: 'PA' } }), 'P')).toEqual({ sku: 'PA', source: 'attributes' })
    expect(liveChannelSku({ channel: 'ETSY', ...edit('X') }, 'P')).toEqual({ sku: 'P', source: 'product' })
    expect(wantedChannelSku({ channel: 'ETSY', ...edit('X') }, 'P')).toEqual({ sku: 'P', source: 'product' })
  })
})

describe('differsFromProduct — the sheet\'s "own SKU here" mark', () => {
  it('true for an own SKU or a conflict; false when the listing sends the product SKU', () => {
    expect(differsFromProduct(amazon({ channelSku: 'OWN' }), 'P')).toBe(true)
    expect(differsFromProduct(amazon({ offers: [offer('OFF')] }), 'P')).toBe(true)
    expect(differsFromProduct(amazon({ offers: [offer('A')], platformAttributes: { sku: 'B' } }), 'P')).toBe(true)
    expect(differsFromProduct(amazon(), 'P')).toBe(false)
    expect(differsFromProduct(amazon({ channelSku: 'P', offers: [offer('P')] }), 'P')).toBe(false)
  })
})

/**
 * Parity — a verbatim copy of today's Amazon Publish seller-SKU rule (studio-publication-amazon.ts, the `sellerSkus`
 * map) is the oracle: for an Amazon row with no channelSku, `wantedChannelSku` must give the same SKU, or a conflict
 * whose sentence is the same error. Inputs are untrimmed-free on purpose: trimming is the one deliberate difference.
 */
describe('parity with today\'s Amazon Publish rule', () => {
  const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
  type PublishListing = { offers: Array<{ sku: string; isActive: boolean }>; platformAttributes?: unknown; flatFileSnapshot?: unknown }
  function todayPublish(product: { sku: string }, listing: PublishListing | undefined, destinationAliasKey: string): string {
    const offers = [...new Set(listing?.offers.filter(o => o.isActive).map(o => o.sku) ?? [])]
    if (offers.length > 1) throw new Error(`${product.sku} has multiple seller SKUs. Select its offer before publishing.`)
    const pa = object(listing?.platformAttributes)
    const ff = object(listing?.flatFileSnapshot)
    const identities = [...new Set([...offers, ...[...AMAZON_LISTING_SKU_KEYS.platformAttributes.map(k => pa[k]), ...AMAZON_LISTING_SKU_KEYS.flatFileSnapshot.map(k => ff[k])].filter((v): v is string => typeof v === 'string' && !!v.trim())])]
    if (identities.length > 1) throw new Error(`${product.sku}: conflicting Amazon seller SKUs. Reconcile this listing's identity before publishing.`)
    if (!identities.length && destinationAliasKey) throw new Error(`${product.sku}: this alias needs its own Amazon seller SKU before publishing.`)
    return identities[0] ?? product.sku
  }

  const cases: Array<[string, PublishListing, string]> = [
    ['nothing stored', { offers: [] }, ''],
    ['one active offer', { offers: [offer('OFF-1')] }, ''],
    ['an inactive offer only', { offers: [offer('OLD', false)] }, ''],
    ['two active offers', { offers: [offer('A'), offer('B', true, 'FBA')] }, ''],
    ['two active offers, same SKU', { offers: [offer('A'), offer('A', true, 'FBA')] }, ''],
    ['active + inactive offer', { offers: [offer('A'), offer('B', false)] }, ''],
    ['each mirror key', { offers: [], platformAttributes: { seller_sku: 'M' } }, ''],
    ['mirror key = offer', { offers: [offer('S')], platformAttributes: { sellerSku: 'S', item_sku: 'S' } }, ''],
    ['mirror key ≠ offer', { offers: [offer('S')], platformAttributes: { sku: 'T' } }, ''],
    ['two mirror keys differ', { offers: [], platformAttributes: { sellerSku: 'U', item_sku: 'V' } }, ''],
    ['flat-file snapshot only', { offers: [], flatFileSnapshot: { item_sku: 'FF' } }, ''],
    ['flat-file ≠ mirror', { offers: [], platformAttributes: { sellerSku: 'M' }, flatFileSnapshot: { item_sku: 'FF' } }, ''],
    ['non-text and blank values', { offers: [], platformAttributes: { sellerSku: 42, sku: '  ', item_sku: null } }, ''],
    ['an array where the bag should be', { offers: [], platformAttributes: ['sellerSku'] }, ''],
    ['alias with nothing', { offers: [] }, 'alias-1'],
    ['alias with an offer', { offers: [offer('AL-OFF')] }, 'alias-1'],
    ['alias with only an inactive offer', { offers: [offer('AL-OLD', false)] }, 'alias-1'],
    ['alias with a conflict', { offers: [offer('A')], flatFileSnapshot: { item_sku: 'B' } }, 'alias-1'],
  ]
  it.each(cases)('%s', (_name, listing, aliasKey) => {
    const product = { sku: 'PROD-1' }
    let expected: { sku: string } | { error: string }
    try { expected = { sku: todayPublish(product, listing, aliasKey) } } catch (error) { expected = { error: (error as Error).message } }
    const answer = wantedChannelSku({ channel: 'AMAZON', aliasKey, ...LIVE, ...listing }, product.sku)
    expect(answer.sku === null ? { error: answer.conflict.sentence } : { sku: answer.sku }).toEqual(expected)
    // The backfill's reading (the old stores alone) is the same rule.
    expect(legacyChannelSku({ channel: 'AMAZON', aliasKey, ...listing }, product.sku)).toEqual(answer)
  })
})
