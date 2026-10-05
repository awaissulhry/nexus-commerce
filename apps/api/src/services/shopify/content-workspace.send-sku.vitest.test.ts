/**
 * S9 — the Shopify publisher's variant SKUs (`readContent`'s `variants[].sku`, what content sync creates and updates on
 * Shopify) are each listing's WANTED SKU (`wantedChannelSku`, S5's order): its own `channelSku` (the sheet's SKU column),
 * else the old sheet edit (`overrideData.listing_sku`), else the stored native SKU (`platformAttributes.sku`) or an extra
 * listing's own SKU, else the product SKU; two different stored SKUs are a conflict (nothing sent, the sentence).
 *
 * And the sheet's SKU cell (the resolver's `listing_sku`, through `withWantedShopifySku`) shows EXACTLY what is sent, for
 * every combination of stores.
 *
 * On an in-process PostgreSQL (PGlite), the harness of `content-workspace.send-price.vitest.test.ts`. No Shopify call is
 * made (the store's schema is the information fixture). Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('./admin-client.js', async importOriginal => ({ ...await importOriginal<any>(), shopifyAdmin: async () => ({ graphql: async () => { throw new Error('no Shopify call in this test') } }) }))
vi.mock('./linked-products-gateway.js', async importOriginal => ({ ...await importOriginal<any>(), readLinkedStoreSchema: async () => (await import('../../test-support/information-shopify-fixture.js')).informationShopifySchema }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { activeDatabaseTransaction, inDatabaseTransaction } from '../../lib/database-context.js'
import { resolveBatch } from '../pim/mapping/resolve-batch.service.js'
import { contentDestination, readContent } from './content-workspace.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ACCOUNT = 'shopify-sendsku'
const aliasIds: Record<string, string> = {}

/** Each variant's stores, and what Publish (and the cell) must give it. */
const VARIANTS: Array<[key: string, stores: Record<string, unknown>, sends: string]> = [
  ['own', { channelSku: 'SKU-OWN', platformAttributes: { sku: 'SKU-OWN-COPY' }, overrideData: { listing_sku: 'SKU-OWN-EDIT' } }, 'SKU-OWN'],
  ['edit', { overrideData: { listing_sku: 'SKU-EDIT' } }, 'SKU-EDIT'],
  ['native', { platformAttributes: { sku: 'SKU-NATIVE' } }, 'SKU-NATIVE'],
  ['editwins', { platformAttributes: { sku: 'SKU-NATIVE-2' }, overrideData: { listing_sku: 'SKU-EDIT-2' } }, 'SKU-EDIT-2'],
  ['blank', { platformAttributes: { sku: '' } }, 'SKU-BLANK'],
  ['none', {}, 'SKU-NONE'],
]

async function listing(productId: string, aliasKey: string, own: Record<string, unknown>) {
  await prisma.channelListing.create({ data: { id: `l-${productId}-${aliasKey || 'main'}`, productId, channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL',
    channelConnectionId: ACCOUNT, aliasKey, aliasId: aliasKey || null, listingStatus: 'DRAFT', followMasterPrice: true, price: 50, ...own } as never })
}

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify GLOBAL', region: 'GLOBAL', currency: 'EUR', language: 'en' } as never })
  await prisma.channelConnection.create({ data: { id: ACCOUNT, externalAccountId: ACCOUNT, channelType: 'SHOPIFY', isPrimary: true, isActive: true } })
  // A family whose variants cover every combination of stores on the primary listing.
  await prisma.product.create({ data: { id: 'sku-family', sku: 'SKU-FAMILY', name: 'Family', isParent: true, basePrice: 50, variationAxes: ['Colore'] } as never })
  await listing('sku-family', '', {})
  for (const [index, [key, stores]] of VARIANTS.entries()) {
    await prisma.product.create({ data: { id: `sku-${key}`, sku: `SKU-${key.toUpperCase()}`, name: `sku-${key}`, parentId: 'sku-family', basePrice: 50,
      categoryAttributes: { variations: { Colore: `C${index}` } } } as never })
    await listing(`sku-${key}`, '', stores)
  }
  // Extra listings of single products: the alias's own SKU is a store of its main row; with a native SKU too, a conflict.
  for (const [key, aliasSku, stores] of [['alias', 'SKU-ALIAS-OWN', {}], ['clash', 'SKU-CLASH-A', { platformAttributes: { sku: 'SKU-CLASH-B' } }]] as const) {
    await prisma.product.create({ data: { id: `single-${key}`, sku: `SINGLE-${key.toUpperCase()}`, name: `single-${key}`, basePrice: 50 } as never })
    const alias = await prisma.productListingAlias.create({ data: { productId: `single-${key}`, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: ACCOUNT, label: 'Second store listing', position: 2, sku: aliasSku } as never })
    aliasIds[key] = alias.id
    await listing(`single-${key}`, alias.id, stores)
  }
}), 60_000)
afterAll(async () => { await state.db?.close?.() })

const sent = (productId: string, aliasKey = '') => scoped(async () => {
  const destination = await contentDestination(productId, { accountId: ACCOUNT, market: 'GLOBAL', ...(aliasKey ? { aliasKey } : {}) })
  return inDatabaseTransaction(prisma, () => readContent(activeDatabaseTransaction()!, destination))
})
const cells = async (productIds: string[], aliasKey = '') => {
  const result = await scoped(() => resolveBatch({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: ACCOUNT, aliasKey, locale: 'en', productIds, includeCatalogue: false } as never))
  return Object.fromEntries(result.products.map(p => [p.productId, p.cells.listing_sku?.value ?? '']))
}

describe('S9 — the Shopify publisher sends each variant\'s wanted SKU, and the SKU cell shows exactly that', () => {
  it('every store combination: own SKU, old sheet edit, stored native SKU, edit before native, a blank store, none', async () => {
    const data = await sent('sku-family')
    const sends = Object.fromEntries(data.variants.map((v) => [v.id, v.sku]))
    expect(sends).toEqual(Object.fromEntries(VARIANTS.map(([key, , expected]) => [`sku-${key}`, expected])))
    expect(data.errors.filter((e) => /SKU/.test(e))).toEqual([])
    expect(await cells(Object.keys(sends))).toEqual(sends)
  })

  it('an extra listing\'s own SKU is sent and shown; two different stored SKUs send nothing, show nothing and say why', async () => {
    const own = await sent('single-alias', aliasIds.alias)
    expect(own.variants.map((v) => v.sku)).toEqual(['SKU-ALIAS-OWN'])
    expect(await cells(['single-alias'], aliasIds.alias)).toEqual({ 'single-alias': 'SKU-ALIAS-OWN' })
    const clash = await sent('single-clash', aliasIds.clash)
    expect(clash.variants.map((v) => v.sku)).toEqual([''])
    expect(clash.errors).toContainEqual(expect.stringContaining('more than one SKU on record (SKU-CLASH-B, SKU-CLASH-A)'))
    expect(await cells(['single-clash'], aliasIds.clash)).toEqual({ 'single-clash': '' })
  })
})

describe('S9 — a business mapping rule on the Shopify SKU column changes neither the cell nor what is sent', () => {
  it('with a rule mapping the column to the product name, the cell still shows exactly the SKU Publish sends (the rule is ignored)', async () => {
    await scoped(() => prisma.marketplace.updateMany({ where: { channel: 'SHOPIFY', code: 'GLOBAL' }, data: { schemaMapping: { fields: { listing_sku: { source: 'name' } } } as never } }))
    const data = await sent('sku-family')
    const sends = Object.fromEntries(data.variants.map((v) => [v.id, v.sku]))
    // Today's sent value is kept: a following variant still sends its product SKU, never its name.
    expect(sends['sku-none']).toBe('SKU-NONE')
    expect(sends).toEqual(Object.fromEntries(VARIANTS.map(([key, , expected]) => [`sku-${key}`, expected])))
    expect(await cells(Object.keys(sends))).toEqual(sends)
  })

  it('the mapping editor reads the column as taking no rule, and the saved rule as not used (the same line)', async () => {
    const { getFieldCatalogue } = await import('../pim/mapping/field-catalogue.service.js')
    const catalogue = await scoped(() => getFieldCatalogue({ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: ACCOUNT, productType: null }))
    expect(catalogue.fields.find((f) => f.fieldKey === 'listing_sku')).toMatchObject({ ruleOrigin: 'default', rule: { source: 'name' },
      ruleNotUsed: "The SKU column always sends the listing's own SKU, or the product SKU; edit it in the product sheet." })
    expect(catalogue.fields.find((f) => f.fieldKey === 'vendor')?.ruleNotUsed).toBeUndefined()
  })
})
