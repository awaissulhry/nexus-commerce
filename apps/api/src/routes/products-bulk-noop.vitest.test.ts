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
const bulkOperationCreate = vi.fn()
const executeRaw = vi.fn()
const $transaction = vi.fn()
const connections = new Map<string, string | null>()
const primaryConnections = vi.fn()
const namedConnection = vi.fn()
const aliasFindMany = vi.fn()
const resolveBatch = vi.fn()
const referenceThemes = vi.fn()
vi.mock('../services/pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: (...args: unknown[]) => resolveBatch(...args) }))
// Persistence contracts run without Redis or background cache workers.
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emitMany: async () => [], emitManyTx: async () => [] } }))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { writeMany: async () => [] } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: async () => [] } }))

vi.mock('../db.js', () => ({
  default: {
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
    },
    bulkOperation: { create: (...a: unknown[]) => bulkOperationCreate(...a) },
    $transaction: (...a: unknown[]) => $transaction(...a),
    $executeRaw: (...a: unknown[]) => executeRaw(...a),
  },
}))
vi.mock('../services/connection-resolver.service.js', () => ({
  // A Map, not an object literal: the handler calls `connFor.get(channel)`.
  // Returning `{}` here produced a 500 ("connFor.get is not a function") that
  // looked exactly like a route defect until the body was printed.
  primaryConnectionIds: (...args: unknown[]) => primaryConnections(...args),
  resolveConnection: (...args: unknown[]) => namedConnection(...args),
}))
// attr_* writes are gated on the per-marketplace registry; the channel case
// below needs a definition that exists and is editable, nothing more.
vi.mock('../services/pim/field-registry.service.js', () => ({
  getAvailableFields: async () => [],
  getFieldDefinition: async () => ({ id: 'attr_ceCertification', editable: true, type: 'text' }),
}))

import productsRoutes from './products.routes.js'
import * as sheetColumns from '../services/pim/sheet-columns.service.js'
import * as fieldRegistry from '../services/pim/field-registry.service.js'
import * as categoryContext from '../services/pim/product-category-context.js'
import { etsyProductSpec, shopifyProductSpec } from '../services/pim/channel-specs/store.js'

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
  it.each(['SHOPIFY', 'ETSY'] as const)('saves %s title to the selected account and leaves shared content alone', async channel => {
    const coordinate = { channel, marketplace: 'GLOBAL', label: `${channel === 'SHOPIFY' ? 'Shopify' : 'Etsy'} · GLOBAL`, inMarket: false }
    const spec = channel === 'SHOPIFY' ? shopifyProductSpec() : etsyProductSpec()
    const built = sheetColumns.buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({ ...built, coordinates: [coordinate] } as never)
    const category = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({ categories: [], byRow: new Map(), defaults: {} } as never)
    connections.set(channel, 'store-primary')
    namedConnection.mockResolvedValue({ id: 'store-outlet', channelType: channel, isActive: true })
    channelListingFindMany.mockResolvedValue([listingRow({ channel, marketplace: 'GLOBAL', channelConnectionId: 'store-outlet', title: 'Before', titleOverride: 'Before', followMasterTitle: false })])
    try {
      const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'attr_name', value: 'Store title', target: 'channel' }],
        marketplaceContexts: [{ channel, marketplace: 'GLOBAL', accountId: 'store-outlet' }], expectedVersion: 19 })
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json()).toMatchObject({ updated: 1, versionOf: 'channelListing' })
      expect(productUpdate.mock.calls.some(([args]) => args.data?.name !== undefined)).toBe(false)
      expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ channel, marketplace: 'GLOBAL', channelConnectionId: 'store-outlet', title: 'Store title', titleOverride: 'Store title', followMasterTitle: false }),
      }))
      const unchanged = await patch({ changes: [{ id: PRODUCT_ID, field: 'attr_name', value: 'Before', target: 'channel' }],
        marketplaceContexts: [{ channel, marketplace: 'GLOBAL', accountId: 'store-outlet' }], expectedVersion: 19 })
      expect(unchanged.json()).toMatchObject({ updated: 0, unchanged: 1, versionOf: 'channelListing' })
      const reset = await patch({ changes: [{ id: PRODUCT_ID, field: 'attr_name', value: null, target: 'channel', intent: 'reset' }],
        marketplaceContexts: [{ channel, marketplace: 'GLOBAL', accountId: 'store-outlet' }], expectedVersion: 19 })
      expect(reset.statusCode, reset.body).toBe(200)
      expect(channelListingUpsert).toHaveBeenLastCalledWith(expect.objectContaining({ update: expect.objectContaining({ title: null, titleOverride: null, followMasterTitle: true }) }))
      $transaction.mockRejectedValueOnce(Object.assign(new Error('Version changed'), { code: 'P2025' }))
      const conflict = await patch({ changes: [{ id: PRODUCT_ID, field: 'attr_name', value: 'Concurrent title', target: 'channel' }],
        marketplaceContexts: [{ channel, marketplace: 'GLOBAL', accountId: 'store-outlet' }], expectedVersion: 18 })
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json()).toMatchObject({ versionOf: 'channelListing', currentVersion: 19 })
    } finally { columns.mockRestore(); category.mockRestore() }
  })
})

beforeAll(async () => {
  app = Fastify()
  await app.register(productsRoutes)
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

beforeEach(() => {
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
  bulkOperationCreate.mockReset()
  executeRaw.mockReset()
  $transaction.mockReset()
  $transaction.mockResolvedValue([])
  bulkOperationCreate.mockResolvedValue({ id: 'bulk_test' })
  productFindUnique.mockResolvedValue({ version: 27 })
  channelListingFindUnique.mockResolvedValue({ version: 19 })
  productUpdate.mockReturnValue({ __stmt: 'product.update' })
  channelListingUpsert.mockReturnValue({ __stmt: 'listing.upsert' })
  // The fixture as measured: manufacturer is null, version 26.
  productFindMany.mockResolvedValue([
    { id: PRODUCT_ID, manufacturer: null, version: 26, categoryAttributes: {} },
  ])
  channelListingFindMany.mockResolvedValue([])
})

/** The equality pass is the only full-row read; every other call selects. */
const fullRowReads = () =>
  productFindMany.mock.calls.filter((c) => !(c[0] as { select?: unknown } | undefined)?.select)

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
    expect(res.json()).toMatchObject({ dryRun: true, wouldUpdate: 0, errors: [expect.objectContaining({ field })] })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('accepts a child override for a legacy field saved only on its parent', async () => {
    productFindMany.mockImplementation(async (args: any) => args.where?.OR
      ? [{ id: 'family_root', categoryAttributes: { condition_type: 'new_new' } }]
      : args.select?.parentId
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
  description: null,
  overrideData: {},
  version: 19,
  ...over,
})

const patch = (body: unknown) =>
  app.inject({ method: 'PATCH', url: '/products/bulk', payload: body as object })

describe('requested account resolution before bulk writes', () => {
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
    channelListingFindMany.mockResolvedValue([listingRow({ channelConnectionId: 'account-b' })])
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'Custom title', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }], expectedVersion: 19 })
    expect(result.statusCode, result.body).toBe(200)
    expect(primaryConnections).toHaveBeenCalledWith([])
    expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { productId_channel_marketplace: expect.objectContaining({ channelConnectionId: 'account-b' }) } }))
  })

  it.each([
    [[{ channel: 'AMAZON', marketplace: 'IT', accountId: 'account-a' }, { channel: 'AMAZON', marketplace: 'DE', accountId: 'account-b' }]],
    [[{ channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b' }, { channel: 'AMAZON', marketplace: 'DE' }]],
  ])('refuses conflicting explicit/implicit account contexts: %j', async marketplaceContexts => {
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'Wrong target' }], marketplaceContexts })
    expect(result.statusCode).toBe(400)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('rejects a named account from another channel before any write', async () => {
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'ebay_title', value: 'Wrong target' }],
      marketplaceContext: { channel: 'EBAY', marketplace: 'IT', accountId: 'account-b' } })
    expect(result.statusCode).toBe(400)
    expect($transaction).not.toHaveBeenCalled()
  })

  it('rejects a stale alias from a different account before any write', async () => {
    aliasFindMany.mockResolvedValue([{ id: 'alias-2', productId: PRODUCT_ID, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a' }])
    const result = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'Wrong alias', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'account-b', aliasKey: 'alias-2' }] })
    expect(result.statusCode).toBe(409)
    expect(result.json().code).toBe('LISTING_SCOPE_MISMATCH')
    expect($transaction).not.toHaveBeenCalled()
    expect(channelListingUpsert).not.toHaveBeenCalled()
  })
})

describe('#675 — the equality pass, bounded to expectedVersion', () => {
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
    // pass DOES take its full-row read. (One read here is one product, not
    // evidence of batching — a single-row case cannot show that.)
    expect(fullRowReads()).toHaveLength(1)
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
    // (it did, the first time this was written). The equality read is the
    // only FULL-ROW read — `findMany({ where: { id: { in: ids } } })` with
    // no `select` — so that is what must be absent here.
    expect(fullRowReads()).toHaveLength(0)
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
    channelListingFindMany.mockResolvedValue([listingRow({ overrideData: { [key]: false } })])
    // A channel attribute now requires its category schema. Supply that contract, and use false
    // so an accidental truthiness check cannot pass this no-op test.
    const context = vi.spyOn(categoryContext, 'productCategoryContext').mockResolvedValue({
      categories: ['OUTERWEAR'], byRow: new Map(), defaults: { [PRODUCT_ID]: { channelCategoryId: 'OUTERWEAR' } },
    } as any)
    const columns = vi.spyOn(sheetColumns, 'getSheetColumns').mockResolvedValue({
      columns: [{ key, label: 'Has GTIN exemption?', kind: 'boolean', editable: true, shape: 'scalar', channels: {} }],
      coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' }],
    } as any)
    try {
      const res = await patch({
        changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: false, target: 'channel' }],
        marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }], expectedVersion: 5,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ updated: 0, unchanged: 1, versionOf: 'channelListing' })
      expect(body.currentVersion).toBe(19)
      expect(body.currentVersion).not.toBe(26)
    } finally { context.mockRestore(); columns.mockRestore() }
  })

  it('#689 a same-value MAPPED channel field (amazon_title) is now a no-op', async () => {
    // The bag stores it as `title` (CHANNEL_FIELD_MAP), so before this fix the
    // equality pass looked up `amazon_title`, found undefined, and called an
    // identical value a change.
    channelListingFindMany.mockResolvedValue([
      listingRow(),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'XAVIA GALE' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
      expectedVersion: 5,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      updated: 0, unchanged: 1, currentVersion: 19, versionOf: 'channelListing',
    })
  })

  it('#689 a REAL amazon_title change still writes', async () => {
    channelListingFindMany.mockResolvedValue([
      listingRow(),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'XAVIA GALE MK2' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
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
    channelListingFindMany.mockResolvedValue([listingRow()])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'XAVIA GALE MK2', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
      expectedVersion: 19,
    })
    expect(res.statusCode).toBe(200)
    // The product is not the row this write touches, so it must not be CAS'd.
    expect(productCasBuilt()).toBe(false)
    // And the row it DOES touch must be guarded, keyed on the token.
    expect(
      channelListingUpdate.mock.calls.some(
        (c) => (c[0] as { where?: { id?: string; version?: number } })?.where?.version === 19
          && (c[0] as { where?: { id?: string } })?.where?.id === 'listing_1',
      ),
    ).toBe(true)
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
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
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
    channelListingFindMany.mockResolvedValue([listingRow({ version: 82 })])
    channelListingFindUnique.mockResolvedValue({ version: 82 })
    $transaction.mockRejectedValue(Object.assign(new Error('no rows'), { code: 'P2025' }))
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'NEW TITLE', target: 'master' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
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
    channelListingFindMany.mockResolvedValue([listingRow({ version: 19 })])
    channelListingFindUnique.mockResolvedValue({ version: 20 })
    const first = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'EDIT ONE', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
      expectedVersion: 19,
    })
    expect(first.statusCode).toBe(200)
    const advanced = first.json().currentVersion
    expect(advanced).toBe(20)

    channelListingUpdate.mockClear()
    channelListingFindMany.mockResolvedValue([listingRow({ version: 20 })])
    channelListingFindUnique.mockResolvedValue({ version: 21 })
    const second = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'EDIT TWO', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }],
      expectedVersion: advanced,
    })
    expect(second.statusCode).toBe(200)
    expect(
      channelListingUpdate.mock.calls.some(
        (c) => (c[0] as { where?: { version?: number } })?.where?.version === 20,
      ),
    ).toBe(true)
  })

  it('#703 a mapped write under alias-2 targets the ALIAS listing, never the primary', async () => {
    // Both rows exist for the same coordinate; only the aliasKey separates
    // them. Before this, the write hardcoded `aliasKey: ''` and landed on the
    // primary while the client had asked for alias-2 — silent wrong row, and
    // with the listing CAS it would have guarded the primary's version too.
    channelListingFindMany.mockResolvedValue([
      listingRow({ id: 'listing_primary', aliasKey: '', version: 19 }),
      listingRow({ id: 'listing_alias2', aliasKey: 'alias-2', version: 55 }),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'ALIAS TITLE', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', aliasKey: 'alias-2' }],
      expectedVersion: 55,
    })
    expect(res.statusCode).toBe(200)
    const upsertWhere = channelListingUpsert.mock.calls.map(
      (c) => (c[0] as { where?: { productId_channel_marketplace?: { aliasKey?: string } } })
        ?.where?.productId_channel_marketplace?.aliasKey,
    )
    expect(upsertWhere).toContain('alias-2')
    expect(upsertWhere).not.toContain('')
    // The CREATE branch must carry it too — it defaults to '' otherwise, so a
    // FIRST write under an alias would silently create the primary row.
    const createAlias = channelListingUpsert.mock.calls.map(
      (c) => (c[0] as { create?: { aliasKey?: string } })?.create?.aliasKey,
    )
    expect(createAlias).toContain('alias-2')
    // And the CAS guards the alias row, keyed on its own version.
    expect(
      channelListingUpdate.mock.calls.some(
        (c) => (c[0] as { where?: { id?: string; version?: number } })?.where?.id === 'listing_alias2'
          && (c[0] as { where?: { version?: number } })?.where?.version === 55,
      ),
    ).toBe(true)
    expect(
      channelListingUpdate.mock.calls.some(
        (c) => (c[0] as { where?: { id?: string } })?.where?.id === 'listing_primary',
      ),
    ).toBe(false)
  })

  it('#703 CONTROL: the PRIMARY alias ("") is unchanged', async () => {
    channelListingFindMany.mockResolvedValue([
      listingRow({ id: 'listing_primary', aliasKey: '', version: 19 }),
      listingRow({ id: 'listing_alias2', aliasKey: 'alias-2', version: 55 }),
    ])
    const res = await patch({
      changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'PRIMARY TITLE', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', aliasKey: '' }],
      expectedVersion: 19,
    })
    expect(res.statusCode).toBe(200)
    const upsertWhere = channelListingUpsert.mock.calls.map(
      (c) => (c[0] as { where?: { productId_channel_marketplace?: { aliasKey?: string } } })
        ?.where?.productId_channel_marketplace?.aliasKey,
    )
    expect(upsertWhere).toContain('')
    expect(upsertWhere).not.toContain('alias-2')
    expect(
      channelListingUpdate.mock.calls.some(
        (c) => (c[0] as { where?: { id?: string } })?.where?.id === 'listing_primary',
      ),
    ).toBe(true)
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
      const sql = executeRaw.mock.calls.find(call => call[0].join('').includes('ON CONFLICT'))!
      expect(sql[0].join('')).toContain(' - ::text[]')
      expect(sql).toContainEqual([key])
      expect(sql).toContain('{}')
      expect(sql).toContain('account-a')
      expect(sql).toContain('alias-2')
      expect(channelListingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
        OR: expect.arrayContaining([expect.objectContaining({ channel: 'AMAZON', marketplace: 'IT', aliasKey: 'alias-2', channelConnectionId: 'account-a' })]),
      }) }))
      expect(channelListingUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'listing_1', version: 19 } }))
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
      const sql = executeRaw.mock.calls.find(call => call[0].join('').includes('ON CONFLICT'))!
      expect(sql).toContain(JSON.stringify({ [key]: null }))
      expect(sql).toContainEqual([])
    } finally { restore() }
  })

  it.each(['amazon_title', 'ebay_price', 'amazon_bulletPoints'])('restores %s follow flags and removes old aliases on the requested account', async field => {
    const channel = field.startsWith('ebay_') ? 'EBAY' : 'AMAZON'
    connections.set(channel, 'account-a')
    aliasFindMany.mockResolvedValue([{ id: 'alias-2', productId: PRODUCT_ID, channel, marketplace: 'IT', channelConnectionId: 'account-a' }])
    channelListingFindMany.mockResolvedValue([listingRow({ channel, aliasKey: 'alias-2', channelConnectionId: 'account-a' })])
    const res = await patch({ changes: [{ id: PRODUCT_ID, field, value: null, intent: 'reset', target: 'channel' }],
      marketplaceContexts: [{ channel, marketplace: 'IT', aliasKey: 'alias-2' }], expectedVersion: 19 })
    expect(res.statusCode, res.body).toBe(200)
    const column = field === 'amazon_title' ? 'title' : field === 'ebay_price' ? 'price' : 'bulletPoints'
    const update = column === 'bulletPoints' ? { bulletPointsOverride: [], followMasterBulletPoints: true }
      : { [column]: null, [`${column}Override`]: null, [`followMaster${column[0].toUpperCase()}${column.slice(1)}`]: true }
    expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { productId_channel_marketplace: expect.objectContaining({ aliasKey: 'alias-2', channelConnectionId: 'account-a' }) },
      create: expect.objectContaining({ ...update, channelConnectionId: 'account-a', aliasKey: 'alias-2', isPublished: false }),
      update: expect.objectContaining({ ...update, version: { increment: 1 } }),
    }))
    expect(executeRaw.mock.calls.some(call => call[0].join('').includes('IS NOT DISTINCT FROM'))).toBe(true)
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

  it.each([false, true])('seeds a slot using follow/presence rules (follow=%s)', async follows => {
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
    expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({
      bulletPointsOverride: follows ? ['Italian first', 'New second', 'Italian third'] : ['', 'New second'], followMasterBulletPoints: false,
    }) }))
  })

  it('refuses both halves of a whole-list reset mixed with a slot edit', async () => {
    const res = await patch({ changes: [
      { id: PRODUCT_ID, field: 'amazon_bulletPoints', value: null, intent: 'reset', target: 'channel' },
      { id: PRODUCT_ID, field: 'amazon_bulletPoints[2]', value: 'New second', target: 'channel' },
    ], marketplaceContexts: contexts, dryRun: true })
    expect(res.json()).toMatchObject({ wouldUpdate: 0, errors: [
      expect.objectContaining({ field: 'amazon_bulletPoints', error: expect.stringContaining('separately') }),
      expect.objectContaining({ field: 'amazon_bulletPoints[2]', error: expect.stringContaining('separately') }),
    ] })
    expect($transaction).not.toHaveBeenCalled()
  })

  it('does not broadcast one listing’s slot siblings into another market', async () => {
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_bulletPoints[2]', value: 'New second', target: 'channel' }],
      marketplaceContexts: [...contexts, { channel: 'AMAZON', marketplace: 'DE', aliasKey: 'alias-2' }], dryRun: true })
    expect(res.json()).toMatchObject({ wouldUpdate: 0, errors: [expect.objectContaining({ error: expect.stringContaining('one channel') })] })
  })

  it('guards a platform snapshot without a client token and reports a stale snapshot as 409', async () => {
    const updatedAt = new Date('2026-09-06T00:00:00Z')
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2', updatedAt, platformAttributes: { settings: { exemption: false } } })])
    const restore = installContract({ kind: 'platformAttributes', path: ['settings', 'exemption'] })
    try {
      $transaction.mockRejectedValueOnce(Object.assign(new Error('snapshot changed'), { code: 'P2025' }))
      const res = await patch({ changes: [{ id: PRODUCT_ID, field: `attr_${key}`, value: true, target: 'channel' }], marketplaceContexts: contexts })
      expect(channelListingUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'listing_1', version: 19, updatedAt } }))
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ code: 'VERSION_CONFLICT', versionOf: 'channelListing' })
    } finally { restore() }
  })

  it('verifies a listing once before applying a paste across column and JSON stores', async () => {
    channelListingFindMany.mockResolvedValue([listingRow({ aliasKey: 'alias-2' })])
    const restore = installContract()
    const guard = { __stmt: 'guard' }
    channelListingUpdate.mockReturnValue(guard)
    try {
      const res = await patch({ changes: [
        { id: PRODUCT_ID, field: 'amazon_title', value: 'Changed title', target: 'channel' },
        { id: PRODUCT_ID, field: `attr_${key}`, value: true, target: 'channel' },
      ], marketplaceContexts: contexts, expectedVersion: 19 })
      expect(res.statusCode, res.body).toBe(200)
      const statements = $transaction.mock.calls[0][0]
      expect(statements[0]).toBe(guard)
      expect(statements.filter((statement: unknown) => statement === guard)).toHaveLength(1)
      expect(statements).toContainEqual({ __stmt: 'listing.upsert' })
    } finally { restore() }
  })

  it('refuses a single-slot reset rather than silently discarding other list overrides', async () => {
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_bulletPoints[1]', value: null, intent: 'reset', target: 'channel' }],
      marketplaceContexts: contexts, dryRun: true })
    expect(res.json()).toMatchObject({ wouldUpdate: 0, errors: [expect.objectContaining({ error: expect.stringContaining('whole list') })] })
    expect($transaction).not.toHaveBeenCalled()
  })
})

describe('provenance is part of the no-op decision', () => {
  it('pinning the current title breaks inheritance even when the synced text matches', async () => {
    channelListingFindMany.mockResolvedValue([listingRow({ followMasterTitle: true, titleOverride: null })])
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'XAVIA GALE', intent: 'pin', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }], expectedVersion: 19 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ updated: 1 })
    expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({
      title: 'XAVIA GALE', titleOverride: 'XAVIA GALE', followMasterTitle: false,
    }) }))
  })

  it('does not infer that every target is unchanged from the first listing', async () => {
    channelListingFindMany.mockResolvedValue([listingRow(), listingRow({ id: 'listing_de', marketplace: 'DE', title: 'German title' })])
    const res = await patch({ changes: [{ id: PRODUCT_ID, field: 'amazon_title', value: 'XAVIA GALE', target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }, { channel: 'AMAZON', marketplace: 'DE' }], expectedVersion: 19 })
    expect(res.statusCode, res.body).toBe(200)
    expect(channelListingUpsert.mock.calls.map(call => call[0].where.productId_channel_marketplace.marketplace)).toEqual(['IT', 'DE'])
  })
})

describe('primary-only legacy bulk destination boundaries', () => {
  it('reads and creates schema-update rows only in the requested channel primary account', async () => {
    connections.set('AMAZON', 'account-a')
    channelListingUpsert.mockResolvedValue({})
    const result = await app.inject({ method: 'POST', url: '/products/bulk-schema-update', payload: {
      productIds: [PRODUCT_ID], marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }], attributes: { item_name: 'Updated title' },
    } })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ updated: 1, errors: [] })
    expect(primaryConnections).toHaveBeenCalledWith(['AMAZON'])
    expect(channelListingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [
      { productId: { in: [PRODUCT_ID] }, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-a', aliasKey: '' },
    ] } }))
    expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ channelConnectionId: 'account-a', aliasKey: '', title: 'Updated title' }) }))
  })

  it('uses the resolved source and target accounts throughout replication, including new targets', async () => {
    connections.set('AMAZON', 'account-a')
    connections.set('EBAY', 'account-b')
    const updatedAt = new Date('2026-09-06T00:00:00Z')
    channelListingFindMany.mockResolvedValueOnce([listingRow({ channelConnectionId: 'account-a', updatedAt })]).mockResolvedValueOnce([])
    channelListingFindUnique.mockResolvedValue({ updatedAt })
    channelListingUpsert.mockResolvedValue({})
    const result = await app.inject({ method: 'POST', url: '/products/bulk-replicate', payload: {
      productIds: [PRODUCT_ID], sourceContext: { channel: 'AMAZON', marketplace: 'IT' }, targetContexts: [{ channel: 'EBAY', marketplace: 'IT' }], columnsOnly: true,
    } })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ replicated: 1, errors: [] })
    expect(primaryConnections).toHaveBeenCalledWith(['AMAZON', 'EBAY'])
    expect(channelListingFindMany.mock.calls[0][0].where).toMatchObject({ channelConnectionId: 'account-a', aliasKey: '' })
    expect(channelListingFindMany.mock.calls[1][0].where.OR[0]).toMatchObject({ channelConnectionId: 'account-b', aliasKey: '' })
    expect(channelListingFindUnique.mock.calls[0][0].where.productId_channel_marketplace).toMatchObject({ channelConnectionId: 'account-a', aliasKey: '' })
    expect(channelListingUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ channelConnectionId: 'account-b', aliasKey: '', title: 'XAVIA GALE' }) }))
  })

  it.each(['bulk-schema-update', 'bulk-replicate'])('refuses unsupported account overrides before %s can write', async route => {
    const result = await app.inject({ method: 'POST', url: `/products/${route}`, payload: {
      productIds: [PRODUCT_ID], attributes: { item_name: 'Do not write' }, marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'b' }],
      sourceContext: { channel: 'AMAZON', marketplace: 'IT' }, targetContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: 'b' }],
    } })
    expect(result.statusCode).toBe(400)
    expect(primaryConnections).not.toHaveBeenCalled()
    expect(channelListingUpsert).not.toHaveBeenCalled()
  })
})
