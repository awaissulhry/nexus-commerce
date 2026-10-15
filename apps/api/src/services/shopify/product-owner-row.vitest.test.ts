/**
 * One rule for which Nexus row holds a Shopify product's product-level fields: the product sheet shows and edits them on
 * that row, and the Shopify product CSV import records them there. For an adopted colour family the two must name the
 * same size row of each colour, or an imported title would land on a row the sheet never shows it on.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { informationRegistry } from '@nexus/shared/shopify-information'
import { listingShopifyProductId, shopifyProductOwners } from './product-owner-row.js'
import { projectShopifyChannelSheet } from './channel-sheet-projection.js'
import { mapShopifyCsv, readShopifyCsv, type ShopifyCsvTarget } from '../pim/catalog-shopify-csv.js'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_COLOUR_ROWS } from '../pim/catalog-transfer-test/shopify-csv-fixtures.js'

describe('shopifyProductOwners', () => {
  it('gives each product to its first tied row, rows without a parent first, the others in the order given', () => {
    const rows = [{ id: 'm', parent: true, product: 'P1' }, { id: 's', parent: true, product: 'P1' }, { id: 'red', parent: true, product: 'P2' }, { id: 'root', parent: false, product: null }, { id: 'own', parent: false, product: 'P3' }, { id: 'kid', parent: true, product: 'P3' }]
    const owners = shopifyProductOwners(rows, row => row.product, row => row.parent)
    expect([...owners].map(([product, row]) => [product, row.id])).toEqual([['P3', 'own'], ['P1', 'm'], ['P2', 'red']])
  })
  it('reads a listing’s Shopify product from its external id, else its colour link, as a GID', () => {
    expect(listingShopifyProductId({ externalListingId: '101', platformAttributes: {} })).toBe('gid://shopify/Product/101')
    expect(listingShopifyProductId({ externalListingId: null, platformAttributes: { shopifyProductId: '102' } })).toBe('gid://shopify/Product/102')
    expect(listingShopifyProductId({ externalListingId: 'gid://shopify/Product/103', platformAttributes: { shopifyProductId: '104' } })).toBe('gid://shopify/Product/103')
    expect(listingShopifyProductId({ externalListingId: null, platformAttributes: { variantId: '11' } })).toBeNull()
    expect(listingShopifyProductId(undefined)).toBeNull()
  })
})

describe('an adopted colour family: the import records product fields on the row the product sheet shows them on', () => {
  const STORE = 'store-1', BLACK = 'gid://shopify/Product/101', RED = 'gid://shopify/Product/102'
  // The family as the sheet reads it: the family row, then its sizes by SKU. Each size listing is linked to its colour.
  const sizes = [['ACME-RIDE-BLK-M', BLACK, 'c-black', '1012'], ['ACME-RIDE-BLK-S', BLACK, 'c-black', '1011'], ['ACME-RIDE-RED-M', RED, 'c-red', '1022'], ['ACME-RIDE-RED-S', RED, 'c-red', '1021']] as const
  const listings = [{ id: 'l-ride', productId: 'ride', externalListingId: null, platformAttributes: {} },
    ...sizes.map(([sku, product, colour, variant]) => ({ id: `l-${sku}`, productId: sku, externalListingId: product.split('/').at(-1)!, platformAttributes: { shopifyColourProductId: colour, shopifyProductId: product.split('/').at(-1), variantId: variant } }))]

  it('names the same owner row for each colour', () => {
    const targets: ShopifyCsvTarget[] = [{ id: 'l-ride', sku: 'ACME-RIDE', parentSku: null, accountId: STORE, aliasKey: '', version: 1, handles: [] },
      ...sizes.map(([sku, product, colour]) => ({ id: `l-${sku}`, sku, parentSku: 'ACME-RIDE', accountId: STORE, aliasKey: '', version: 1, handles: [], shopifyProductId: product, colourProductId: colour,
        ...(sku === 'ACME-RIDE-RED-S' ? { listingSkus: ['acme-ride-red-s'] } : {}) }))]
    const read = mapShopifyCsv(readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, SHOPIFY_COLOUR_ROWS)), targets, { accountId: STORE, spec: shopifyProductSpec(null, STORE), storeFields: false })
    const imported = Object.fromEntries(read.rows.filter(r => r.field === 'title').map(r => [String(r.value), r.sku]))
    expect(imported).toEqual({ 'Ride jacket – Black': 'ACME-RIDE-BLK-M', 'Ride jacket – Red': 'ACME-RIDE-RED-M' })

    const schema = { revision: 'r1', definitions: [], types: [], locales: [{ locale: 'en', primary: true }], metaobjects: [], currency: 'EUR' } as any
    const columns = informationRegistry(schema).map(field => ({ key: field.id, label: field.label, shopifyField: field, writeField: `attr_${field.id}` }))
    const cell = () => Object.fromEntries(columns.map(c => [c.key, { value: null, writable: true, editable: true, writeTarget: 'channelListing', source: 'master', layer: 'master', mapped: null }]))
    const page = { columns, scope: { channel: 'SHOPIFY', connectionId: STORE }, rows: [{ id: 'ride', sku: 'ACME-RIDE', aliasId: null, parentId: null, values: cell(), readiness: { state: 'ready', issues: [] } },
      ...sizes.map(([sku]) => ({ id: sku, sku, aliasId: null, parentId: 'ride', values: cell(), readiness: { state: 'ready', issues: [] } }))] } as any
    const product = (id: string, title: string) => ({ id, productId: id, kind: 'PRODUCT', title, handle: title, image: null, media: [], fields: [], values: { title, vendor: 'ACME' } })
    const variant = (id: string, productId: string) => ({ id: `gid://shopify/ProductVariant/${id}`, productId, kind: 'PRODUCTVARIANT', title: id, handle: '', image: null, media: [], fields: [], values: { price: '1.00' } })
    const snapshot = { currency: 'EUR', timezone: 'Europe/Rome', rows: [product(BLACK, 'Ride jacket – Black'), product(RED, 'Ride jacket – Red'), ...sizes.map(([, p, , v]) => variant(v, p))] } as any
    const workspace = { productId: 'ride', familyId: 'ride', revision: '1', destination: { accountId: STORE, listingId: 'l-ride', market: 'GLOBAL' }, suggestedProductIds: [BLACK, RED], operation: null, draft: emptyShopifyLinkedDraft() } as any
    const rows = projectShopifyChannelSheet(page, workspace, snapshot, schema, listings, null)
    // The sheet edits each colour's title on one row: the one that owns its product.
    const shown = Object.fromEntries(rows.filter(r => r.values.title?.shopifyWrite).map(r => [String(r.values.title.value), r.sku]))
    expect(shown).toEqual(imported)
    expect(rows.find(r => r.sku === 'ACME-RIDE-BLK-S')!.values.title.writeBlockedReason).toBe('Edit this field on the product row that owns this Shopify listing.')
  })
})
