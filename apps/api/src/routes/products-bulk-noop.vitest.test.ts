/**
 * PES.5 #675 — a same-value cell spends no version, and the bound holds.
 *
 * Pinned against the LIVE readings taken on the GALE-JACKET parent
 * (cmokmy3a40078pm0p1fvnu523, `manufacturer` null, version 26) on 2026-09-02:
 * the real PATCH returned `{updated: 0, unchanged: 1}` and the version was
 * still 26 on two independent read paths. This test pins the same four
 * behaviours against the real route with prisma mocked, so the pin survives
 * without touching the production database.
 *
 * Why `''` is the interesting input: every write path normalises `''` to
 * `null` BEFORE the equality pass runs (products.routes.ts :1509-1511 attr_*,
 * :1530-1532 channel, :1831-1833 scalar text, :1573 numeric, :1800-1806
 * parentId; `sku`/`name` reject `''` outright). The equality pass iterates
 * `validated`, which holds post-normalisation values — so the comparator's
 * folding of null/undefined/'' IS that normalisation, not a second opinion
 * about it. A `null -> ''` PATCH is therefore a no-op by construction, and
 * that is what these cases hold in place.
 *
 * Run: npx vitest run src/routes/products-bulk-noop.vitest.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const PRODUCT_ID = 'cmokmy3a40078pm0p1fvnu523'

const productFindMany = vi.fn()
const productFindUnique = vi.fn()
const productUpdate = vi.fn()
const productUpdateMany = vi.fn()
const channelListingFindMany = vi.fn()
const channelListingFindUnique = vi.fn()
const channelListingUpdate = vi.fn()
const channelListingUpsert = vi.fn()
const channelListingUpdateMany = vi.fn()
const bulkOperationCreate = vi.fn()
const executeRaw = vi.fn()
const queryRaw = vi.fn()
const $transaction = vi.fn()
const connections = new Map<string, string | null>()
const primaryConnections = vi.fn()
const namedConnection = vi.fn()
const aliasFindMany = vi.fn()
const resolveBatch = vi.fn()
const referenceThemes = vi.fn()
const produceReadiness = vi.fn()
const priceWrite = vi.fn()
// This file gates routing. Real price persistence, pin/reset and enqueue are covered on
// disposable PostgreSQL in price-door-reset.vitest.test.ts (A-12 / A-18).
vi.mock('../services/pim/channel-price-write.service.js', () => ({ writeChannelPrices: (...args: unknown[]) => priceWrite(...args) }))
// 2026-09-27 — the fulfilment door is its own service (real rules in fulfillment-method tests); here only its routing.
const fulfilmentWrite = vi.fn()
vi.mock('../services/pim/fulfillment-method.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/pim/fulfillment-method.service.js')>()),
  setFulfillmentMethod: (...args: unknown[]) => fulfilmentWrite(...args),
}))
vi.mock('../services/pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: (...args: unknown[]) => resolveBatch(...args) }))
// Amazon sheet gaps — a listing quantity goes through the Matrix's Mode / Qty door (`sheet-quantity-door.ts`); its primitives'
// rules run on PostgreSQL (sheet-quantity-door, studio-sheet-stock-columns tests). Here only the routing to them.
const quantityWrite = vi.fn()
vi.mock('../services/pim/matrix-write.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/pim/matrix-write.service.js')>()),
  pinTypedQuantity: (...args: unknown[]) => quantityWrite(...args),
  writeQuantityMode: (...args: unknown[]) => quantityWrite(...args),
}))
// Product-sheet create path — the draft creator's own rules run on PostgreSQL (draft-listing.service and
// bulk-edit-new-market tests); here only that the bulk route calls it, and with what.
const ensureDrafts = vi.fn()
vi.mock('../services/pim/draft-listing.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/pim/draft-listing.service.js')>()),
  ensureDraftListings: (...args: unknown[]) => ensureDrafts(...args),
}))
// Persistence contracts run without Redis or background cache workers.
// LX.F R-LX-13 — and that now includes the QUEUE: this file's 68 failures in this
// environment were all `getaddrinfo ENOTFOUND …upstash.io`, i.e. a DNS lookup for Redis
// from inside the route, not an assertion. `products-bulk-recalc-guard.vitest.test.ts:16`
// already mocks it exactly this way; unsetting `REDIS_URL` does not help because the env
// file is loaded by the runner itself.
vi.mock('../lib/queue.js', () => ({ addJobSafely: async () => null, outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emitMany: async () => [], emitManyTx: async () => [] } }))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { writeMany: async () => [] } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: async () => [] } }))

vi.mock('../db.js', () => {
  const client = {
    ebayDescriptionTheme: { findMany: (...a: unknown[]) => referenceThemes(...a) },
    productListingAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    product: {
      findMany: (...a: unknown[]) => productFindMany(...a),
      findUnique: (...a: unknown[]) => productFindUnique(...a),
      update: (...a: unknown[]) => productUpdate(...a),
      updateMany: (...a: unknown[]) => productUpdateMany(...a),
    },
    channelListing: {
      findMany: (...a: unknown[]) => channelListingFindMany(...a),
      findUnique: (...a: unknown[]) => channelListingFindUnique(...a),
      update: (...a: unknown[]) => channelListingUpdate(...a),
      upsert: (...a: unknown[]) => channelListingUpsert(...a),
      updateMany: (...a: unknown[]) => channelListingUpdateMany(...a),
    },
    bulkOperation: { create: (...a: unknown[]) => bulkOperationCreate(...a) },
    // Execute the outer interactive transaction; the spy measures its statement batches.
    $transaction: (work: any, ...args: unknown[]): any => typeof work === 'function' ? work(client) : $transaction(work, ...args),
    $executeRaw: (...a: unknown[]) => executeRaw(...a),
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  }
  return { default: client }
})
vi.mock('../services/connection-resolver.service.js', () => ({
  // A Map, not an object literal: the handler calls `connFor.get(channel)`.
  // Returning `{}` here produced a 500 ("connFor.get is not a function") that
  // looked exactly like a route defect until the body was printed.
  primaryConnectionIds: (...args: unknown[]) => primaryConnections(...args),
  resolveConnection: (...args: unknown[]) => namedConnection(...args),
}))
// attr_* writes are gated on the per-marketplace registry; the channel case
// below needs a definition that exists and is editable, nothing more.
// Readiness production has its own PostgreSQL regressions; isolate that derived refresh here.
vi.mock('../services/pim/readiness-index.service.js', async () => (await import('../test-support/readiness-module-mock.js')).readinessModuleMock((...args: unknown[]) => produceReadiness(...args)))
vi.mock('../services/pim/field-registry.service.js', () => ({
  getAvailableFields: async () => [],
  getFieldDefinition: async () => ({ id: 'attr_ceCertification', editable: true, type: 'text' }),
}))

import productsRoutes from './products.routes.js'
import * as sheetColumns from '../services/pim/sheet-columns.service.js'
import * as fieldRegistry from '../services/pim/field-registry.service.js'
import * as categoryContext from '../services/pim/product-category-context.js'
import { etsyProductSpec, shopifyProductSpec } from '../services/pim/channel-specs/store.js'
import { amazonSpecFromDefinition, AMAZON_FULFILMENT_KEY } from '../services/pim/channel-specs/amazon.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let app: FastifyInstance

describe('Shopify and Etsy store information saves', () => {
  it.each([
    ['dimension', '{"value":0,"unit":"centimeters","metadata":{"id":9007199254740993}}', undefined],
    ['money', '{"amount":"0.00","currency_code":"EUR"}', undefined],
    ['boolean', 'false', undefined],
    ['list.single_line_text_field', '[]', undefined],
    ['single_line_text_field', '=literal Shopify text', undefined],
    ['single_line_text_field', '', undefined],
    ['single_line_text_field', null, undefined],
    ['single_line_text_field', 'Italiano', 'it'],
  ])('persists Shopify %s without coercion in the exact listing/locale', async (type, value, locale) => {
    const coordinate = { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', inMarket: false }
    const schema: any = { revision: 'fixture', currency: 'EUR', definitions: [{ id: 'definition', namespace: 'custom', key: 'value', ownerType: 'PRODUCT', name: 'Store field', type, description: null, validations: [], access: { admin: 'PUBLIC_READ_WRITE', storefront: null } }], types: [{ name: type, category: 'TEXT' }], metaobjectDefinitions: [], locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }], native: { scopes: ['write_products', 'write_translations'], inputs: {}, enums: {} } }
    const spec = shopifyProductSpec(schema, 'store-outlet', locale), field = spec.fields.find(f => f.shopifyField?.definition)!
    const built = sheetColumns.buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({ ...built, coordinates: [coordinate] } as never)
    const category = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: [], byRow: new Map(), defaults: {} } as never)
    namedConnection.mockResolvedValue({ id: 'store-outlet', channelType: 'SHOPIFY', isActive: true })
    channelListingFindMany.mockResolvedValue([listingRow({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'store-outlet', platformAttributes: { keep: false } })])
    try {
      const result = await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${field.key}`, value, target: 'channel', intent: 'set' }], marketplaceContexts: [{ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'store-outlet', ...(locale ? { locale } : {}) }], expectedVersion: 19 })
      if (value === '') {
        expect(result.statusCode).toBe(400)
        expect(result.json().errors[0].error).toContain('one line')
        expect(executeRaw).not.toHaveBeenCalled(); expect($transaction).not.toHaveBeenCalled()
        return // Shopify rejects an empty required text value; it must never silently become clear.
      }
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json()).toMatchObject({ updated: 1, versionOf: 'channelListing' })
      const update = executeRaw.mock.calls.find(args => args[0].join('').includes('"platformAttributes" ='))!
      expect(update, result.body).toBeDefined()
      const persisted = JSON.parse(update[1])
      expect(persisted.keep).toBe(false)
      expect(locale ? persisted._shopifyInformationLocales[locale]['metafield:PRODUCT:custom.value'] : persisted.metafields.PRODUCT.custom.value[type!]).toBe(value)
      expect(channelListingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: expect.arrayContaining([expect.objectContaining({ channelConnectionId: 'store-outlet', aliasKey: '', channel: 'SHOPIFY', marketplace: 'GLOBAL' })]) }) }))
      expect(productUpdate).not.toHaveBeenCalled()
    } finally { columns.mockRestore(); category.mockRestore() }
  })
  /* Wave 2 D3 + D4 — the theme template's clear stores '' (the store's default template); the Shopify status of a product
     not on Shopify yet is read-only (the Status column's choice creates it). */
  describe('Shopify theme template and status', () => {
    const coordinate = { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', inMarket: false }
    const write = async (key: string, value: string | null, externalListingId: string | null) => {
      const spec = shopifyProductSpec(null, 'store-outlet'), field = spec.fields.find(f => f.shopifyField?.id === key)!
      const built = sheetColumns.buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
      const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({ ...built, coordinates: [coordinate] } as never)
      const category = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: [], byRow: new Map(), defaults: {} } as never)
      namedConnection.mockResolvedValue({ id: 'store-outlet', channelType: 'SHOPIFY', isActive: true })
      channelListingFindMany.mockResolvedValue([listingRow({ channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'store-outlet', externalListingId, platformAttributes: { keep: false } })])
      try {
        return await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${field.key}`, value, target: 'channel', intent: 'set' }], marketplaceContexts: [{ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'store-outlet' }], expectedVersion: 19 })
      } finally { columns.mockRestore(); category.mockRestore() }
    }
    const persisted = () => JSON.parse(executeRaw.mock.calls.find(args => args[0].join('').includes('"platformAttributes" ='))![1])
    it('a cleared theme template is stored as \'\' (the store\'s default template), not refused', async () => {
      const result = await write('templateSuffix', null, null)
      expect(result.statusCode, result.body).toBe(200)
      expect(persisted().templateSuffix).toBe('')
    })
    it('the Shopify status of a product not on Shopify yet is refused with the reason; on Shopify it is saved', async () => {
      const refused = await write('status', 'ACTIVE', null)
      expect(refused.json().errors).toEqual([expect.objectContaining({ error: "A product not on Shopify yet is created with the Status column's choice. Change it there." })])
      expect(executeRaw).not.toHaveBeenCalled()
      const saved = await write('status', 'ACTIVE', '10')
      expect(saved.statusCode, saved.body).toBe(200)
      expect(persisted().status).toBe('ACTIVE')
    })
  })
  it.each(['SHOPIFY', 'ETSY'] as const)('refuses legacy %s title mutations until an explicit content address is supplied', async channel => {
    const coordinate = { channel, marketplace: 'GLOBAL', label: `${channel === 'SHOPIFY' ? 'Shopify' : 'Etsy'} · GLOBAL`, inMarket: false }
    const spec = channel === 'SHOPIFY' ? shopifyProductSpec() : etsyProductSpec()
    const built = sheetColumns.buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({ ...built, coordinates: [coordinate] } as never)
    const category = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: [], byRow: new Map(), defaults: {} } as never)
    try {
      namedConnection.mockResolvedValue({ id: 'store-outlet', channelType: channel, isActive: true })
      for (const intent of ['set', 'pin', 'reset']) {
        const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'attr_name', value: 'Store title', target: 'channel', intent }],
          marketplaceContexts: [{ channel, marketplace: 'GLOBAL', accountId: 'store-outlet' }], expectedVersion: 19 })
        expect(result.statusCode, result.body).toBe(200)
        expect(result.json()).toMatchObject({ success: false, updated: 0, errors: [expect.objectContaining({ error: expect.stringContaining('ContentAddress') })] })
      }
      expect(productUpdate).not.toHaveBeenCalled()
      expect(channelListingUpdateMany).not.toHaveBeenCalled()
      expect(executeRaw).not.toHaveBeenCalled()
    } finally { columns.mockRestore(); category.mockRestore() }
  })

})

describe('the Amazon fulfilment method writes through its one door (2026-09-27)', () => {
  const coordinate = { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }
  const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../services/pim/channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json'), 'utf8'))
  const field = `attr_${AMAZON_FULFILMENT_KEY}`
  const setUp = () => {
    const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: fixture })
    const built = sheetColumns.buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    const category = { channelCategoryId: 'OUTERWEAR' }
    return [
      vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({ ...built, coordinates: [coordinate] } as never),
      vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: ['OUTERWEAR'], byRow: new Map([[`${PRODUCT_ID}:`, category]]), defaults: { [PRODUCT_ID]: category } } as never),
    ]
  }
  const send = (value: unknown) => patch({ changes: [{ id: PRODUCT_ID, field, value, target: 'channel', intent: 'set' }],
    marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }], expectedVersion: 19 })

  it('FBM goes to setFulfillmentMethod on the exact listing, never as a raw nested write', async () => {
    const spies = setUp()
    channelListingFindMany.mockResolvedValue([listingRow({ channelConnectionId: 'account-a', platformAttributes: {} })])
    try {
      const result = await send('DEFAULT')
      expect(result.statusCode, result.body).toBe(200)
      expect(fulfilmentWrite).toHaveBeenCalledTimes(1)
      expect(fulfilmentWrite.mock.calls[0][0].targets).toEqual([{ listingId: 'listing_1', method: 'FBM', expectedVersion: 19 }])
      expect(executeRaw.mock.calls.some(args => String(args[0]?.join?.('') ?? '').includes('"platformAttributes" ='))).toBe(false)
      expect(channelListingUpdateMany).not.toHaveBeenCalled()
    } finally { spies.forEach(s => s.mockRestore()) }
  })

  it('AMAZON_EU is FBA', async () => {
    const spies = setUp()
    channelListingFindMany.mockResolvedValue([listingRow({ channelConnectionId: 'account-a', platformAttributes: {} })])
    try {
      const result = await send('AMAZON_EU')
      expect(result.statusCode, result.body).toBe(200)
      expect(fulfilmentWrite.mock.calls[0][0].targets[0]).toMatchObject({ method: 'FBA' })
    } finally { spies.forEach(s => s.mockRestore()) }
  })

  it('a refusal from the door reaches the operator by name (FBA stock on hand)', async () => {
    const spies = setUp()
    channelListingFindMany.mockResolvedValue([listingRow({ channelConnectionId: 'account-a', platformAttributes: {} })])
    fulfilmentWrite.mockResolvedValueOnce({ results: [{ listingId: 'listing_1', outcome: 'refused', reason: 'Refused — 4 units of FBA stock on hand keep the guard closed', version: 19 }] })
    try {
      const result = await send('DEFAULT')
      expect(result.statusCode).toBe(400)
      expect(result.body).toContain('units of FBA stock on hand')
    } finally { spies.forEach(s => s.mockRestore()) }
  })

  it('no listing in this market (token 0): the draft is started first, and the door writes on it at its fresh version', async () => {
    const spies = setUp()
    // No listing until the draft step starts one; every read after it sees the draft.
    channelListingFindMany.mockImplementation(async () => ensureDrafts.mock.calls.length ? [listingRow({ id: 'draft_1', channelConnectionId: 'account-a', platformAttributes: {}, version: 1 })] : [])
    ensureDrafts.mockResolvedValueOnce([{ id: 'draft_parent', productId: 'parent', version: 1, created: true }, { id: 'draft_1', productId: PRODUCT_ID, version: 1, created: true }])
    channelListingFindUnique.mockResolvedValue({ version: 2 })
    try {
      const result = await patch({ changes: [{ id: PRODUCT_ID, field, value: 'DEFAULT', target: 'channel', intent: 'set' }],
        marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }], expectedVersion: 0 })
      expect(result.statusCode, result.body).toBe(200)
      expect(ensureDrafts).toHaveBeenCalledWith(expect.anything(), { channel: 'AMAZON', market: 'IT', accountId: 'account-a', aliasKey: '', productIds: [PRODUCT_ID], family: true })
      expect(fulfilmentWrite.mock.calls[0][0].targets).toEqual([{ listingId: 'draft_1', method: 'FBM', expectedVersion: 1 }])
      expect(result.json()).toMatchObject({ currentVersion: 2, versionOf: 'channelListing',
        createdListings: [{ productId: 'parent', listingId: 'draft_parent' }, { productId: PRODUCT_ID, listingId: 'draft_1' }] })
    } finally { spies.forEach(s => s.mockRestore()) }
  })

  it('a LIVE Amazon listing: FBA ⇄ FBM is refused by name (the Matrix converts it on Amazon); a value that changes nothing still saves (2026-10-07)', async () => {
    const spies = setUp()
    const live = { channelConnectionId: 'account-a', isPublished: true, externalListingId: 'B0TESTASIN', listingStatus: 'ACTIVE', fulfillmentMethod: 'FBM', offers: [] }
    channelListingFindMany.mockResolvedValue([listingRow({ ...live, platformAttributes: {} })])
    try {
      const refused = await send('AMAZON_EU')
      expect(refused.statusCode).toBe(400)
      expect(refused.body).toContain('This listing is live on Amazon IT: FBA ⇄ FBM is changed in the Matrix (Set fulfilment…)')
      expect(refused.body).toContain('nothing was saved')
      expect(fulfilmentWrite).not.toHaveBeenCalled()
      /* the same method it already has: the door writes it (no conversion is needed). */
      const same = await send('DEFAULT')
      expect(same.statusCode, same.body).toBe(200)
      expect(fulfilmentWrite.mock.calls[0][0].targets).toEqual([{ listingId: 'listing_1', method: 'FBM', expectedVersion: 19 }])
    } finally { spies.forEach(s => s.mockRestore()) }
  })

  it('token 0 against a listing that exists: 409 with that listing\'s version, and nothing is started or written', async () => {
    const spies = setUp()
    channelListingFindMany.mockResolvedValue([listingRow({ channelConnectionId: 'account-a', platformAttributes: {} })])
    try {
      const result = await patch({ changes: [{ id: PRODUCT_ID, field, value: 'DEFAULT', target: 'channel', intent: 'set' }],
        marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }], expectedVersion: 0 })
      expect(result.statusCode).toBe(409)
      expect(result.json()).toMatchObject({ code: 'VERSION_CONFLICT', expectedVersion: 0, currentVersion: 19, listingId: 'listing_1', versionOf: 'channelListing' })
      expect(ensureDrafts).not.toHaveBeenCalled()
      expect(fulfilmentWrite).not.toHaveBeenCalled()
    } finally { spies.forEach(s => s.mockRestore()) }
  })
})

beforeAll(async () => {
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    Object.assign(request, { __rbacResolved: { isOwner: true, permissions: new Set<string>() } }) // the Owner, as the RBAC gate resolves him: price writes check the person's permissions (S1 F5)
    done()
  })
  await app.register(productsRoutes)
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  fulfilmentWrite.mockReset().mockImplementation(async ({ targets }) => ({
    results: targets.map((target: { listingId: string; expectedVersion: number }) => ({
      listingId: target.listingId, outcome: 'applied', version: target.expectedVersion + 1, productFlag: null,
    })),
  }))
  priceWrite.mockReset().mockImplementation(async ({ targets }) => ({
    results: targets.map((target: { listingId: string; expectedVersion: number }) => ({
      listingId: target.listingId, outcome: 'applied', version: target.expectedVersion + 1, guarded: true,
    })),
  }))
  quantityWrite.mockReset().mockResolvedValue({})
  produceReadiness.mockReset().mockResolvedValue(undefined)
  // Persistence cases have no additional Information fields; specific resolver cases override this.
  resolveBatch.mockReset().mockResolvedValue({ products: [{ productId: PRODUCT_ID, cells: {} }] })
  referenceThemes.mockReset().mockResolvedValue([{ id: 'theme-id', name: 'Modern', active: true }])
  connections.clear()
  // These cases exercise connected-listing upserts. A mocked upsert accepts null compound
  // keys that Prisma rejects; unattributed listings are covered by formula-database tests.
  connections.set('AMAZON', 'account-a')
  connections.set('EBAY', 'account-ebay')
  primaryConnections.mockReset().mockImplementation(async () => new Map(connections))
  namedConnection.mockReset().mockResolvedValue({ id: 'account-b', channelType: 'AMAZON', isActive: true })
  aliasFindMany.mockReset().mockImplementation(async () => [{ id: 'alias-2', productId: PRODUCT_ID, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: connections.get('AMAZON') ?? null }])
  productFindMany.mockReset()
  productFindUnique.mockReset()
  productUpdate.mockReset()
  productUpdateMany.mockReset()
  channelListingFindMany.mockReset()
  channelListingFindUnique.mockReset()
  channelListingUpdate.mockReset()
  channelListingUpsert.mockReset()
  channelListingUpdateMany.mockReset()
  ensureDrafts.mockReset().mockImplementation(async () => { throw new Error('No listing was expected to be missing in this case') })
  bulkOperationCreate.mockReset()
  executeRaw.mockReset()
  // Every listing guard of an edit is ONE `UPDATE … FROM jsonb_to_recordset … RETURNING id` (bulk-edit `guardListings`).
  // By default every guarded listing is still as read; a stale case answers fewer rows, as PostgreSQL would.
  queryRaw.mockReset().mockImplementation(async (sql: TemplateStringsArray, rows?: string) =>
    sql.join('').includes('jsonb_to_recordset') ? JSON.parse(rows!).map(({ id }: { id: string }) => ({ id })) : [])
  $transaction.mockReset()
  $transaction.mockResolvedValue([])
  bulkOperationCreate.mockResolvedValue({ id: 'bulk_test' })
  productFindUnique.mockResolvedValue({ version: 27 })
  channelListingFindUnique.mockResolvedValue({ version: 19 })
  productUpdate.mockReturnValue({ __stmt: 'product.update' })
  channelListingUpsert.mockReturnValue({ __stmt: 'listing.upsert' })
  channelListingUpdateMany.mockReturnValue({ __stmt: 'listing.updateMany' })
  // The fixture as measured: manufacturer is null, version 26.
  productFindMany.mockResolvedValue([
    { id: PRODUCT_ID, manufacturer: null, version: 26, categoryAttributes: {} },
  ])
  channelListingFindMany.mockResolvedValue([])
})

/**
 * The full-row reads: the changed rows' schema read (whole row, so a transaction that remembers reads answers the
 * equality pass from memory — this mock does not remember) and the equality pass; every other call selects.
 */
const fullRowReads = () =>
  productFindMany.mock.calls.filter((c) => !(c[0] as { select?: unknown } | undefined)?.select)

/** The listing compare-and-swaps of the requests so far: the rows of each edit's one guard statement. */
const listingGuards = (): Array<{ id: string; version: number; updatedAt: string | null }> =>
  queryRaw.mock.calls.filter(([sql]) => (sql as TemplateStringsArray).join('').includes('jsonb_to_recordset'))
    .flatMap(([, rows]) => JSON.parse(rows as string))

describe('reference writes use authoritative choices', () => {
  const setup = () => {
    channelListingFindMany.mockResolvedValue([listingRow({ channel: 'EBAY', channelConnectionId: 'account-ebay', platformAttributes: { descriptionThemeId: 'old-theme' } })])
    const context = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: ['177104'], byRow: new Map(), defaults: { [PRODUCT_ID]: { channelCategoryId: '177104' } } } as never)
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({
      columns: [{ key: 'descriptionThemeId', label: 'Description theme', kind: 'text', editable: true, shape: 'scalar', maxLength: 12,
        channels: { 'eBay · IT': { store: { kind: 'platformAttributes', path: ['descriptionThemeId'] } } } }],
      coordinates: [{ channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT' }],
    } as never)
    return () => { context.mockRestore(); columns.mockRestore() }
  }
  const request = (value: unknown, extra = {}) => patch({ dryRun: true, changes: [{ id: PRODUCT_ID, field: 'attr_descriptionThemeId', value, target: 'channel' }], marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }], ...extra })

  it('resolves a long pasted name before applying the stored-ID length cap', async () => {
    const cleanup = setup()
    referenceThemes.mockResolvedValue([{ id: 'theme-id', name: 'My descriptive theme name', active: true }])
    try {
      expect((await request('My descriptive theme name')).json()).toMatchObject({ wouldUpdate: 1, errors: [], normalizedChanges: [{ id: PRODUCT_ID, field: 'attr_descriptionThemeId', value: 'theme-id' }] })
      expect($transaction).not.toHaveBeenCalled()
    } finally { cleanup() }
  })

  it('refuses ambiguous, inactive, unknown and non-text values before mutation', async () => {
    const cleanup = setup()
    referenceThemes.mockResolvedValue([{ id: 'a', name: 'Modern', active: true }, { id: 'b', name: 'MODERN', active: false }])
    try {
      for (const [value, message] of [['Modern', 'more than one'], ['b', 'inactive'], ['missing', 'not an available'], [42, 'as text']]) {
        expect((await request(value)).json()).toMatchObject({ wouldUpdate: 0, errors: [expect.objectContaining({ error: expect.stringContaining(message as string) })] })
      }
      expect($transaction).not.toHaveBeenCalled()
    } finally { cleanup() }
  })

  it('preserves a stored retired ID without requiring a lookup and treats its active name as a no-op', async () => {
    const cleanup = setup()
    try {
      expect((await request('old-theme', { expectedVersion: 19 })).json()).toMatchObject({ wouldUpdate: 0, errors: [] })
      expect(referenceThemes).not.toHaveBeenCalled()
      referenceThemes.mockResolvedValue([{ id: 'old-theme', name: 'Modern', active: true }])
      const response = await request('Modern', { dryRun: false, expectedVersion: 19 })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ unchanged: 1, updated: 0, currentVersion: 19, versionOf: 'channelListing', normalizedChanges: [{ value: 'old-theme', id: PRODUCT_ID, field: 'attr_descriptionThemeId' }] })
      expect($transaction).not.toHaveBeenCalled()
    } finally { cleanup() }
  })

  it('keeps clear and inherit usable when choices cannot be loaded', async () => {
    const cleanup = setup()
    referenceThemes.mockRejectedValue(new Error('database unavailable'))
    try {
      expect((await request(null)).json()).toMatchObject({ wouldUpdate: 1, errors: [] })
      expect((await request(null, { changes: [{ id: PRODUCT_ID, field: 'attr_descriptionThemeId', value: null, target: 'channel', intent: 'reset' }] })).json()).toMatchObject({ wouldUpdate: 1, errors: [] })
      expect(referenceThemes).not.toHaveBeenCalled()
      expect((await request('Modern')).json()).toMatchObject({ wouldUpdate: 0, errors: [expect.objectContaining({ error: expect.stringContaining('could not be verified') })] })
    } finally { cleanup() }
  })
})

describe('attribute edit loss prevention', () => {
  it.each([
    ['basePrice', 12.345], ['weightValue', 0.1234], ['totalStock', 1.9], ['totalStock', '12items'],
    ['ebay_price', 12.345], ['ebay_quantity', 1.9],
    ['amazon_bulletPoints', [{ value: 'must not stringify' }]], ['amazon_bulletPoints', 'must not clear'],
  ])('refuses %s=%j before any write', async (field, value) => {
    const channel = String(field).startsWith('amazon_') ? 'AMAZON' : String(field).startsWith('ebay_') ? 'EBAY' : null
    const res = await patch({ dryRun: true,
      marketplaceContexts: channel ? [{ channel, marketplace: 'IT' }] : [{ marketplace: 'IT', locale: 'it' }],
      changes: [{ id: PRODUCT_ID, field, value, ...(channel ? { target: 'channel' } : {}) }],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ...(field === 'amazon_bulletPoints' ? { updated: 0 } : { dryRun: true, wouldUpdate: 0 }), errors: [expect.objectContaining({ field })] })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('accepts a child override for a legacy field saved only on its parent', async () => {
    productFindMany.mockImplementation(async (args: any) => args.where?.OR
      ? [{ id: 'family_root', categoryAttributes: { condition_type: 'new_new' } }]
      : !args.select || args.select.parentId
      ? [{ id: PRODUCT_ID, parentId: 'family_root', isParent: false, productType: 'OUTERWEAR', categoryAttributes: {} }]
      : args.select?.categoryAttributes ? [{ categoryAttributes: { condition_type: 'new_new' } }] : [])
    const registry = vi.spyOn(fieldRegistry, 'getFieldDefinition').mockResolvedValue(undefined as any)
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockImplementation(async input => ({
      ...sheetColumns.buildSheetColumns({ fields: input.savedFields ?? [], coordinates: [], familySchema: true }), coordinates: [],
    } as any))
    try {
      const res = await patch({ dryRun: true, marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }],
        changes: [{ id: PRODUCT_ID, field: 'attr_condition_type', value: 'used' }],
      })
      expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1, errors: [] })
      expect(productFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
        OR: [{ id: { in: ['family_root'] } }, { parentId: { in: ['family_root'] } }], deletedAt: null,
      } }))
    } finally { columns.mockRestore(); registry.mockRestore() }
  })
})

/**
 * A ChannelListing as the WRITE path reads it, not merely as the equality pass
 * does. The equality pass selects {productId, channel, marketplace,
 * overrideData, version}; the write path also reads `id` (to report which row
 * changed), `aliasKey` and `channelConnectionId`. A row carrying only the first
 * set makes the handler throw 500 — which is how this was found.
 */
const listingRow = (over: Record<string, unknown> = {}) => ({
  id: 'listing_1',
  productId: PRODUCT_ID,
  channel: 'AMAZON',
  marketplace: 'IT',
  aliasKey: '',
  channelConnectionId: null,
  // Shape taken from the SCHEMA and a real row, not from an assumption:
  // `title`/`description` are real columns; `overrideData` is the attr_* bag
  // and is `{}` on every listing of the programme fixture.
  title: 'XAVIA GALE',
  price: 100,
  quantity: 100,
  description: null,
  overrideData: {},
  version: 19,
  ...over,
})

const patch = (body: unknown) =>
  app.inject({ method: 'PATCH', url: '/products/bulk', payload: body as object })

// CAS and routing use a factual listing column; content writes have a separate address contract.
const ebayListing = (over: Record<string, unknown> = {}) => listingRow({ channel: 'EBAY', ...over })

describe('autosave readiness follows the actual write destination', () => {
  it.each([undefined, 'account-b'])('limits a listing edit to its resolved account and market (%s)', async accountId => {
    const resolvedAccount = accountId ?? 'account-ebay'
    namedConnection.mockResolvedValue({ id: resolvedAccount, channelType: 'EBAY', isActive: true })
    channelListingFindMany.mockResolvedValue([ebayListing({ channelConnectionId: resolvedAccount })])
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', ...(accountId ? { accountId } : {}) }], expectedVersion: 19 })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().updated).toBe(1)
    expect(produceReadiness.mock.calls).toEqual([[PRODUCT_ID, { channel: 'EBAY', market: 'IT', accountId: resolvedAccount }]])
  })

  it('keeps every dependent destination fresh when the edit writes shared product data', async () => {
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'Changed', target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }], expectedVersion: 26 })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().updated).toBe(1)
    // A context or target hint cannot change a Product column into a listing write.
    expect(produceReadiness.mock.calls).toEqual([[PRODUCT_ID]])
  })

  it('does not rebuild readiness for a no-op', async () => {
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }], expectedVersion: 26 })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().unchanged).toBe(1)
    expect(produceReadiness).not.toHaveBeenCalled()
  })
})

describe('requested account resolution before bulk writes', () => {
  beforeEach(() => {
    namedConnection.mockResolvedValue({ id: 'account-b', channelType: 'EBAY', isActive: true })
    aliasFindMany.mockResolvedValue([{ id: 'alias-2', productId: PRODUCT_ID, channel: 'EBAY', marketplace: 'IT', channelConnectionId: connections.get('EBAY') }])
  })
  it('does not resolve unrelated channels for a Shared edit', async () => {
    primaryConnections.mockImplementation(async channels => {
      if (channels.length) throw new Error('An unrelated channel is ambiguous')
      return new Map()
    })
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }], expectedVersion: 26 })
    expect(result.statusCode).toBe(200)
    expect(primaryConnections).toHaveBeenCalledWith([])
    expect(namedConnection).not.toHaveBeenCalled()
  })

  it('writes the explicitly selected account without consulting that channel’s primary', async () => {
    primaryConnections.mockImplementation(async channels => {
      if (channels.length) throw new Error('No unique primary')
      return new Map()
    })
    channelListingFindMany.mockResolvedValue([ebayListing({ channelConnectionId: 'account-b' })])
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: 'account-b' }], expectedVersion: 19 })
    expect(result.statusCode, result.body).toBe(200)
    expect(primaryConnections).toHaveBeenCalledWith([])
    // A listing quantity is written by the quantity door, on exactly that account's listing.
    expect(quantityWrite).toHaveBeenCalledWith(expect.objectContaining({ coordinates: [expect.objectContaining({ channelConnectionId: 'account-b' })] }))
  })

  it.each([
    [[{ channel: 'EBAY', marketplace: 'IT', accountId: 'account-a' }, { channel: 'EBAY', marketplace: 'DE', accountId: 'account-b' }]],
    [[{ channel: 'EBAY', marketplace: 'IT', accountId: 'account-b' }, { channel: 'EBAY', marketplace: 'DE' }]],
  ])('refuses conflicting explicit/implicit account contexts: %j', async marketplaceContexts => {
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120 }], marketplaceContexts })
    expect(result.statusCode).toBe(400)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('rejects a named account from another channel before any write', async () => {
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120 }],
      marketplaceContext: { channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' } })
    expect(result.statusCode).toBe(400)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('rejects a stale alias from a different account before any write', async () => {
    aliasFindMany.mockResolvedValue([{ id: 'alias-2', productId: PRODUCT_ID, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account-a' }])
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: 'account-b', aliasKey: 'alias-2' }] })
    expect(result.statusCode).toBe(409)
    expect(result.json().code).toBe('LISTING_SCOPE_MISMATCH')
    expect($transaction).not.toHaveBeenCalled()
    expect(channelListingUpdateMany).not.toHaveBeenCalled()
  })
})

describe('#675 — the equality pass, bounded to expectedVersion', () => {
  beforeEach(() => {
    aliasFindMany.mockResolvedValue([{ id: 'alias-2', productId: PRODUCT_ID, channel: 'EBAY', marketplace: 'IT', channelConnectionId: connections.get('EBAY') }])
  })
  it('a null -> "" cell with expectedVersion is unchanged: no version spent, no job row', async () => {
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      expectedVersion: 26,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, updated: 0, unchanged: 1 })

    // The load-bearing half: an all-no-op request must not reach the write.
    // Before #675 this fell into the "nothing survived validation" branch,
    // which answers 400 AND writes a FAILED BulkOperation — telling an
    // operator their save failed because the value was already right.
    expect($transaction).not.toHaveBeenCalled()
    expect(bulkOperationCreate).not.toHaveBeenCalled()
    // The positive half of the control below: with a token, the equality
    // pass DOES take its full-row read, after the schema read of the same
    // rows. (One read each here is one product, not evidence of batching —
    // a single-row case cannot show that.)
    expect(fullRowReads()).toHaveLength(2)
  })

  it('a real change alongside the same fixture still survives validation', async () => {
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' }],
      expectedVersion: 26,
      dryRun: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1 })
  })

  it('the same no-op cell WITHOUT expectedVersion is not filtered — the bound is a bound', async () => {
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      dryRun: true,
    })
    expect(res.statusCode).toBe(200)
    // A tokenless PATCH behaves exactly as it did before #675: the equality
    // pass never runs, so the cell is still a candidate write. This case is
    // what makes the previous one a bounded claim rather than a global one —
    // it fails if anyone widens the check past `expectedVersion !== undefined`.
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1 })
    // Target the BRANCH, not the mock. `product.findMany` is also called
    // earlier in this handler with `select: { productType }`, so a bare
    // call-count conflates two call sites and fails for the wrong reason
    // (it did, the first time this was written). The equality read is a
    // FULL-ROW read — `findMany({ where: { id: { in: ids } } })` with no
    // `select` — and the schema read of the changed rows is the only other
    // one, so exactly that one is what must remain here (two with a token).
    expect(fullRowReads()).toHaveLength(1)
  })

  it('#689(1) a STALE token on a no-op returns the ROW\'s version, not the echoed token', async () => {
    // The point of the whole item: a client holding v25 while the row is at
    // v26 changes nothing, so there is no conflict to report — but it must
    // still learn it is behind, or it goes on writing with a dead token and
    // only finds out on the next edit that DOES change something.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      expectedVersion: 25,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ updated: 0, unchanged: 1, versionOf: 'product' })
    // Load-bearing: 26 is the ROW. 25 is what the caller sent. Echoing the
    // token back would tell a stale client it is current — the precise
    // failure this item exists to remove.
    expect(body.currentVersion).toBe(26)
    expect(body.expectedVersion).toBe(25)
    expect(body.currentVersion).not.toBe(body.expectedVersion)
  })

  it('#689(1) the version handed back is the one that then works', async () => {
    // Closes the loop the hub asked for: take the version from the no-op
    // response and a real change with it survives validation.
    const noop = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      expectedVersion: 25,
    })
    const fresh = noop.json().currentVersion
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' }],
      expectedVersion: fresh,
      dryRun: true,
    })
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1 })
  })

  it('#689(1) a no-op with NO token carries no version at all', async () => {
    // The equality pass never ran, so there is no row read to answer from.
    // Inventing one would be a number with no measurement behind it.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      dryRun: true,
    })
    const body = res.json()
    expect(body.currentVersion).toBeUndefined()
    expect(body.versionOf).toBeUndefined()
  })

  it('#689(1) a CHANNEL-only no-op answers with the LISTING version, not the product\'s', async () => {
    // The deviation the hub ruled on. The product is mocked at 26 and the
    // listing at 19 precisely so the two are distinguishable: had this
    // hardcoded 'product' it would answer 26 — a number from a different row,
    // which is the defect the 409 path documents fixing ("seen: 1 while the
    // listing was at 19"). 19 is the only answer a client can act on.
    const key = 'supplier_declared_has_product_identifier_exemption'
    channelListingFindMany.mockResolvedValue([ebayListing({ overrideData: { [key]: false } })])
    // A channel attribute now requires its category schema. Supply that contract, and use false
    // so an accidental truthiness check cannot pass this no-op test.
    const context = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({
      categories: ['OUTERWEAR'], byRow: new Map(), defaults: { [PRODUCT_ID]: { channelCategoryId: 'OUTERWEAR' } },
    } as any)
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({
      columns: [{ key, label: 'Has GTIN exemption?', kind: 'boolean', editable: true, shape: 'scalar', channels: {} }],
      coordinates: [{ channel: 'EBAY', marketplace: 'IT', label: 'Amazon · IT' }],
    } as any)
    try {
      const res = await patch({
        changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: false, target: 'channel' }],
        marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }], expectedVersion: 5,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ updated: 0, unchanged: 1, versionOf: 'channelListing' })
      expect(body.currentVersion).toBe(19)
      expect(body.currentVersion).not.toBe(26)
    } finally { context.mockRestore(); columns.mockRestore() }
  })

  it('#689 a same-value MAPPED channel field (ebay_quantity) is now a no-op', async () => {
    // Amazon sheet gaps — a listing quantity is the quantity door's: the same number on a listing already PINNED at it is
    // its no-op (on a following listing the number pins it). The door checks the listing token first.
    channelListingFindMany.mockResolvedValue([
      ebayListing({ channelConnectionId: 'account-ebay', followMasterQuantity: false }),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 100 }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: 19,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      updated: 0, unchanged: 1, currentVersion: 19, versionOf: 'channelListing',
    })
    expect(quantityWrite).not.toHaveBeenCalled()
  })

  it('#689 a REAL ebay_quantity change still writes', async () => {
    channelListingFindMany.mockResolvedValue([
      ebayListing(),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120 }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: 5,
      dryRun: true,
    })
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1 })
  })

  it('#689(2) an unreadable If-Match is a 400, not a silent drop', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/products/bulk',
      headers: { 'if-match': 'not-a-version' },
      payload: { changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'X' }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/If-Match/)
  })

  it('#689(2) a STRING expectedVersion is a 400', async () => {
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'X' }],
      expectedVersion: '26',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/expectedVersion/)
  })

  it('#689(2) an explicit NULL expectedVersion is ABSENT, not malformed', async () => {
    // PES.3's channel writer omits on `!== undefined`, so a null version would
    // go out as null. Refusing it would turn a save that works today into a
    // 400 on every such row — a loud defect replacing a silent one.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      expectedVersion: null,
      dryRun: true,
    })
    expect(res.statusCode).toBe(200)
    // Treated as tokenless: the equality pass never runs, so the cell survives.
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1 })
  })

  // ── #693: ONE routing predicate, observed at the CAS ──────────────────
  /** Did the handler build the product CAS statement (`where` carrying a version)? */
  const productCasBuilt = () =>
    productUpdate.mock.calls.some(
      (c) => (c[0] as { where?: { version?: unknown } })?.where?.version !== undefined,
    )

  it('#700 a mapped channel field is CAS\'d against the LISTING, not the product', async () => {
    channelListingFindMany.mockResolvedValue([ebayListing({ channelConnectionId: 'account-ebay' })])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: 19,
    })
    expect(res.statusCode).toBe(200)
    // The product is not the row this write touches, so it must not be CAS'd.
    expect(productCasBuilt()).toBe(false)
    // And the row it DOES touch is guarded by the quantity door, keyed on the token.
    expect(quantityWrite).toHaveBeenCalledWith(expect.objectContaining({ targets: [expect.objectContaining({ id: 'listing_1', version: 19 })] }))
    // And the response names the listing, so the client can advance the token
    // it actually holds — without this the SECOND consecutive edit 409s.
    expect(res.json()).toMatchObject({ versionOf: 'channelListing', currentVersion: 19 })
  })

  it('#693 CONTROL: a master column with target omitted still CASes the product', async () => {
    // Without this the predicate could drift to "everything is a channel
    // change" and the test above would still pass.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' }],
      expectedVersion: 26,
    })
    expect(res.statusCode).toBe(200)
    expect(productCasBuilt()).toBe(true)
    expect(res.json()).toMatchObject({ versionOf: 'product' })
  })

  it('#693 CONTROL: brand + target "channel" still WRITES the master column', async () => {
    // The control that matters for the routing predicate: `CHANNEL_FIELD_MAP`
    // has no `brand`, so classifying it as a channel change would hand it to
    // `upsertChannelListings`, which returns [] for a field it cannot map — the
    // write would vanish with a 200. This asserts the column write is BUILT,
    // which is the property the predicate must preserve.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'brand', value: 'XAVIA RACING', target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: 26,
    })
    expect(res.statusCode).toBe(200)
    const wroteBrand = productUpdate.mock.calls.some(
      (c) => (c[0] as { data?: Record<string, unknown> })?.data?.brand === 'XAVIA RACING',
    )
    expect(wroteBrand).toBe(true)
    // The second hole, now closed: with the gate keyed on `v.target`, this
    // master-column write carried a token and took NO CAS at all
    // (`'channel' !== 'channel'` is false). Keyed on the write's own predicate
    // it is correctly a master change and is guarded.
    expect(productCasBuilt()).toBe(true)
  })

  it('#700 a STALE-CLIENT payload (product version, target master) 409s naming the LISTING', async () => {
    // The pre-#699 shape: target 'master' and the PRODUCT's version 3, while
    // the listing is at 82. It must REFUSE — silently passing would let a
    // half-landed producer/consumer pair overwrite concurrent edits, and the
    // token would be guarding a counter the write never touches.
    channelListingFindMany.mockResolvedValue([ebayListing({ version: 82, channelConnectionId: 'account-ebay' })])
    channelListingFindUnique.mockResolvedValue({ version: 82 })
    // The guard keyed on version 3 matches no row.
    queryRaw.mockResolvedValue([])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'master' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: 3,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      versionOf: 'channelListing',
      currentVersion: 82,
      expectedVersion: 3,
    })
  })

  it('#700 two consecutive mapped edits: the second uses the version the first returned', async () => {
    // PES.3's failure mode if `channelListingIdsTouched` were not recorded:
    // the first save returns no listing version, the sheet keeps the stale one,
    // and the second edit 409s. This is the pair working end to end.
    channelListingFindMany.mockResolvedValue([ebayListing({ version: 19, channelConnectionId: 'account-ebay' })])
    channelListingFindUnique.mockResolvedValue({ version: 20 })
    const first = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: 19,
    })
    expect(first.statusCode).toBe(200)
    const advanced = first.json().currentVersion
    expect(advanced).toBe(20)

    queryRaw.mockClear()
    channelListingFindMany.mockResolvedValue([ebayListing({ version: 20, channelConnectionId: 'account-ebay' })])
    channelListingFindUnique.mockResolvedValue({ version: 21 })
    const second = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 121, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }],
      expectedVersion: advanced,
    })
    expect(second.statusCode).toBe(200)
    expect(quantityWrite.mock.calls.at(-1)![0].targets).toEqual([expect.objectContaining({ id: 'listing_1', version: 20 })])
  })

  it('#703 a mapped write under alias-2 targets the ALIAS listing, never the primary', async () => {
    // Both rows exist for the same coordinate; only the aliasKey separates
    // them. Before this, the write hardcoded `aliasKey: ''` and landed on the
    // primary while the client had asked for alias-2 — silent wrong row, and
    // with the listing CAS it would have guarded the primary's version too.
    channelListingFindMany.mockResolvedValue([
      ebayListing({ id: 'listing_primary', aliasKey: '', version: 19, channelConnectionId: 'account-ebay' }),
      ebayListing({ id: 'listing_alias2', aliasKey: 'alias-2', version: 55, channelConnectionId: 'account-ebay' }),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', aliasKey: 'alias-2' }],
      expectedVersion: 55,
    })
    expect(res.statusCode).toBe(200)
    // The quantity door writes exactly the alias row, on the alias coordinate, CAS'd on its own version.
    expect(quantityWrite).toHaveBeenCalledTimes(1)
    expect(quantityWrite.mock.calls[0][0]).toMatchObject({ targets: [{ id: 'listing_alias2', version: 55 }], coordinates: [{ aliasKey: 'alias-2' }] })
    // There is no create branch left to default the alias to '': a missing listing is started by `ensureDraftListings`,
    // which never creates an alias listing.
    expect(channelListingUpsert).not.toHaveBeenCalled()
    expect(channelListingUpdateMany).not.toHaveBeenCalled()
  })

  it('#703 CONTROL: the PRIMARY alias ("") is unchanged', async () => {
    channelListingFindMany.mockResolvedValue([
      ebayListing({ id: 'listing_primary', aliasKey: '', version: 19, channelConnectionId: 'account-ebay' }),
      ebayListing({ id: 'listing_alias2', aliasKey: 'alias-2', version: 55, channelConnectionId: 'account-ebay' }),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', aliasKey: '' }],
      expectedVersion: 19,
    })
    expect(res.statusCode).toBe(200)
    expect(quantityWrite.mock.calls[0][0]).toMatchObject({ targets: [{ id: 'listing_primary', version: 19 }], coordinates: [{ aliasKey: '' }] })
  })

  it('P10 the audit row records the token the request carried', async () => {
    // The AIREON question an audit row could not answer about itself: was this
    // write version-guarded? `changes` holds the per-cell array only, and the
    // token is a top-level request field, so nothing recorded it.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' }],
      expectedVersion: 26,
    })
    expect(res.statusCode).toBe(200)
    expect(bulkOperationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expectedVersion: 26 }) }),
    )
  })

  it('P10 a TOKENLESS request records null, not a missing field', async () => {
    // null is the honest value: this operation carried no token. It is NOT the
    // same as "the write was unguarded", which is what a reader would infer
    // from an absent column on the rows that predate it.
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: 'XAVIA RACING' }],
    })
    expect(res.statusCode).toBe(200)
    expect(bulkOperationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expectedVersion: null }) }),
    )
  })

  it('SENSITIVITY: the same "" PATCH against a NON-null stored value is a real change', async () => {
    // Without this case the suite cannot tell a working equality pass from
    // one hardwired to call everything a no-op — every other case here
    // expects `unchanged`, so all of them would still pass. Clearing a real
    // value IS a write (`''` normalises to null, null over 'XAVIA RACING'),
    // and it must survive the filter.
    productFindMany.mockResolvedValue([
      { id: PRODUCT_ID, manufacturer: 'XAVIA RACING', version: 26, categoryAttributes: {} },
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      expectedVersion: 26,
      dryRun: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 1 })
  })

  it('dry run reflects the no-op filter, so a preview cannot promise a write it would skip', async () => {
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'manufacturer', value: '' }],
      expectedVersion: 26,
      dryRun: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 0 })
  })
})


describe('channel inheritance reset and account isolation', () => {
  const key = 'supplier_declared_has_product_identifier_exemption'
  const contexts = [{ channel: 'AMAZON', marketplace: 'IT', aliasKey: 'alias-2' }]
  const installContract = (store?: unknown) => {
    const context = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({
      categories: ['OUTERWEAR'], byRow: new Map(), defaults: { [PRODUCT_ID]: { channelCategoryId: 'OUTERWEAR' } },
    } as any)
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({
      columns: [{ key, label: 'Has GTIN exemption?', kind: 'boolean', editable: true, shape: 'scalar',
        channels: store ? { 'Amazon · IT': { store } } : {} }],
      coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' }],
    } as any)
    return () => { context.mockRestore(); columns.mockRestore() }
  }

  it.each([null, false])('removes a JSON override containing %j instead of pinning null or skipping the write', async value => {
    connections.set('AMAZON', 'account-a')
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2', channelConnectionId: 'account-a', overrideData: { [key]: value } })])
    const restore = installContract()
    try {
      const res = await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: null, intent: 'reset', target: 'channel' }],
        marketplaceContexts: contexts, expectedVersion: 19 })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ success: true, updated: 1, versionOf: 'channelListing' })
      const sql = executeRaw.mock.calls.find(call => call[0].join('').includes('"overrideData" = (COALESCE'))!
      expect(sql[0].join('')).toContain(' - ::text[]')
      expect(sql).toContainEqual([key])
      expect(sql).toContain('{}')
      expect(sql).toContain('account-a')
      expect(sql).toContain('alias-2')
      expect(channelListingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
        OR: expect.arrayContaining([expect.objectContaining({ channel: 'AMAZON', marketplace: 'IT', aliasKey: 'alias-2', channelConnectionId: 'account-a' })]),
      }) }))
      expect(listingGuards()).toContainEqual(expect.objectContaining({ id: 'listing_1', version: 19, updatedAt: null }))
    } finally { restore() }
  })

  it('clearing an inherited JSON value creates an explicit null override', async () => {
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2', overrideData: {} })])
    const restore = installContract()
    try {
      const res = await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: null, intent: 'set', target: 'channel' }],
        marketplaceContexts: contexts, expectedVersion: 19 })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ updated: 1 })
      const sql = executeRaw.mock.calls.find(call => call[0].join('').includes('"overrideData" = (COALESCE'))!
      expect(sql).toContain(JSON.stringify({ [key]: null }))
      expect(sql).toContainEqual([])
    } finally { restore() }
  })

  it.each(['amazon_title', 'ebay_price', 'amazon_bulletPoints'])('routes %s resets through its required storage boundary', async field => {
    const channel = field.startsWith('ebay_') ? 'EBAY' : 'AMAZON'
    connections.set(channel, 'account-a')
    aliasFindMany.mockResolvedValue([{ id: 'alias-2', productId: PRODUCT_ID, channel, marketplace: 'IT', channelConnectionId: 'account-a' }])
    channelListingFindMany.mockResolvedValue([listingRow({ channel, aliasKey: 'alias-2', channelConnectionId: 'account-a' })])
    const res = await patch({ changes: [{ id: PRODUCT_ID, field, value: null, intent: 'reset', target: 'channel' }],
      marketplaceContexts: [{ channel, marketplace: 'IT', aliasKey: 'alias-2' }], expectedVersion: 19 })
    expect(res.statusCode, res.body).toBe(200)
    if (field !== 'ebay_price') {
      expect(res.json()).toMatchObject({ updated: 0, errors: [expect.objectContaining({ error: expect.stringContaining('ContentAddress') })] })
      expect(channelListingUpdateMany).not.toHaveBeenCalled()
      return
    }
    expect(priceWrite).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ listingId: 'listing_1', price: null, expectedVersion: 19 }],
    }))
    expect(channelListingUpdateMany).not.toHaveBeenCalled()
  })

  it.each(['reset', 'set'])('%s on a platform path preserves unrelated settings and distinguishes absence from null', async intent => {
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2', platformAttributes: { settings: { exemption: false, retained: 'yes' } } })])
    const restore = installContract({ kind: 'platformAttributes', path: ['settings', 'exemption'] })
    try {
      const res = await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: null, intent, target: 'channel' }],
        marketplaceContexts: contexts, expectedVersion: 19 })
      expect(res.statusCode, res.body).toBe(200)
      const sql = executeRaw.mock.calls.find(call => call[0].join('').includes('SET "platformAttributes"'))!
      expect(JSON.parse(sql[1])).toEqual({ settings: { retained: 'yes', ...(intent === 'set' ? { exemption: null } : {}) } })
      expect(sql).toContainEqual([key, `attr_${key}`])
    } finally { restore() }
  })

  it.each([false, true])('refuses an unaddressed content slot regardless of legacy follow flag (follow=%s)', async follows => {
    productFindMany.mockResolvedValue([{ id: PRODUCT_ID, parentId: null, version: 26,
      categoryAttributes: {}, bulletPoints: ['Master first', 'Master second', 'Master third'] }])
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2',
      bulletPointsOverride: follows ? ['Old snapshot', 'Old second'] : [], followMasterBulletPoints: follows })])
    const category = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: ['OUTERWEAR'], byRow: new Map(), defaults: { [PRODUCT_ID]: { channelCategoryId: 'OUTERWEAR' } } } as any)
    const contract = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({
      columns: [{ key: 'bulletPoints', label: 'Bullets', shape: 'list', editable: true,
        channels: { 'Amazon · IT': { key: 'bullet_point' } } }],
      coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' }],
    } as any)
    resolveBatch.mockResolvedValue({ products: [{ productId: PRODUCT_ID, cells: { bullet_point: { fieldKey: 'bullet_point', value: ['Italian first', 'Italian second', 'Italian third'], errors: [] } } }] })
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_bulletPoints[2]', value: 'New second', target: 'channel' }],
      marketplaceContexts: contexts, expectedVersion: 19 })
    contract.mockRestore()
    category.mockRestore()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ updated: 0, errors: [expect.objectContaining({ error: expect.stringContaining('ContentAddress') })] })
    expect(channelListingUpdateMany).not.toHaveBeenCalled()
  })

  it('refuses both halves of a whole-list reset mixed with a slot edit', async () => {
    const res = await patch({ changes: [
      { id: PRODUCT_ID, field: 'amazon_bulletPoints', value: null, intent: 'reset', target: 'channel' },
      { id: PRODUCT_ID, field: 'amazon_bulletPoints[2]', value: 'New second', target: 'channel' },
    ], marketplaceContexts: contexts, dryRun: true })
    expect(res.json()).toMatchObject({ updated: 0, errors: [
      expect.objectContaining({ field: 'amazon_bulletPoints', error: expect.stringContaining('ContentAddress') }),
      expect.objectContaining({ field: 'amazon_bulletPoints[2]', error: expect.stringContaining('ContentAddress') }),
    ] })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('does not broadcast one listing’s slot siblings into another market', async () => {
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_bulletPoints[2]', value: 'New second', target: 'channel' }],
      marketplaceContexts: [...contexts, { channel: 'AMAZON', marketplace: 'DE', aliasKey: 'alias-2' }], dryRun: true })
    expect(res.json()).toMatchObject({ updated: 0, errors: [expect.objectContaining({ error: expect.stringContaining('ContentAddress') })] })
  })

  it('guards a platform snapshot without a client token and reports a stale snapshot as 409', async () => {
    const updatedAt = new Date('2026-09-06T00:00:00Z')
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2', updatedAt, platformAttributes: { settings: { exemption: false } } })])
    const restore = installContract({ kind: 'platformAttributes', path: ['settings', 'exemption'] })
    try {
      // The snapshot changed: its guard matches no row.
      queryRaw.mockResolvedValueOnce([])
      const res = await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: true, target: 'channel' }], marketplaceContexts: contexts })
      expect(listingGuards()).toContainEqual(expect.objectContaining({ id: 'listing_1', version: 19, updatedAt: updatedAt.toISOString() }))
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ code: 'VERSION_CONFLICT', versionOf: 'channelListing' })
    } finally { restore() }
  })

  it('verifies a listing once before applying a paste across column and JSON stores', async () => {
    channelListingFindMany.mockResolvedValue([ebayListing({ channelConnectionId: 'account-ebay' })])
    const restore = installContract()
    try {
      const res = await patch({ changes: [
        { id: PRODUCT_ID, field: 'ebay_quantity', value: 120, target: 'channel' },
        { id: PRODUCT_ID, field: `attr_${key}`, value: true, target: 'channel' },
      ], marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }], expectedVersion: 19 })
      expect(res.statusCode, res.body).toBe(200)
      // One check of the listing: the quantity (its column) goes through the quantity door, CAS'd on the token, and the
      // JSON store's write in the same transaction takes no second guard on a listing a door already moved.
      expect(quantityWrite).toHaveBeenCalledWith(expect.objectContaining({ targets: [expect.objectContaining({ id: 'listing_1', version: 19 })] }))
      expect(listingGuards()).toEqual([])
    } finally { restore() }
  })

  it('refuses a single-slot reset rather than silently discarding other list overrides', async () => {
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_bulletPoints[1]', value: null, intent: 'reset', target: 'channel' }],
      marketplaceContexts: contexts, dryRun: true })
    expect(res.json()).toMatchObject({ updated: 0, errors: [expect.objectContaining({ error: expect.stringContaining('ContentAddress') })] })
    expect($transaction).not.toHaveBeenCalled()
  })
})

describe('provenance is part of the no-op decision', () => {
  it('pinning the current price breaks inheritance even when the synced number matches', async () => {
    channelListingFindMany.mockResolvedValue([ebayListing({ channelConnectionId: 'account-ebay', followMasterPrice: true, priceOverride: null })])
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_price', value: 100, intent: 'pin', target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }], expectedVersion: 19 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ updated: 1 })
    expect(priceWrite).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ listingId: 'listing_1', price: 100, expectedVersion: 19 }],
    }))
    expect(channelListingUpdateMany).not.toHaveBeenCalled()
  })

  it('does not infer that every target is unchanged from the first listing', async () => {
    channelListingFindMany.mockResolvedValue([ebayListing({ channelConnectionId: 'account-ebay', followMasterQuantity: false }),
      ebayListing({ id: 'listing_de', marketplace: 'DE', quantity: 90, channelConnectionId: 'account-ebay', followMasterQuantity: false })])
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_quantity', value: 100, target: 'channel' }],
      marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT' }, { channel: 'EBAY', marketplace: 'DE' }], expectedVersion: 19 })
    expect(res.statusCode, res.body).toBe(200)
    // IT is already pinned at 100 (the door's no-op); DE is not, so the door pins it.
    expect(quantityWrite.mock.calls.map(call => call[0].coordinates[0].marketplace)).toEqual(['DE'])
  })
})
