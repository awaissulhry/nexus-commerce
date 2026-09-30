import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import pg from 'pg'
import type { FastifyInstance } from 'fastify'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { formulaDatabase } from '../../test-support/formula-database.js'

// Real routes, content writers and formula writes on a disposable database. Only external side effects are replaced.
const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | null }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeContent } from '../pim/content-write.js'
import { setCellFormula } from '../pim/mapping/cell-formula.service.js'
import type { ProductBulkInput } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let account: string
let serial = 0
beforeAll(async () => {
  await scoped(async () => {
    for (const [code, language] of [['DE', 'de'], ['IT', 'it']]) {
      await prisma.marketplace.create({ data: { channel: 'EBAY', code, name: code, currency: 'EUR', region: 'EU', language, languages: [language] } })
    }
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-formula-reply', isActive: true } })).id
  })
  const { default: Fastify } = await import('fastify')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register((await import('../../routes/products.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/cell-formula.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close(); await state.db?.close() })

const patch = async (payload: ProductBulkInput) => {
  const query = process.env.MEASURE_CONTENT_REPLY ? vi.spyOn(pg.Client.prototype, 'query') : null
  try {
    const result = await scoped(() => app.inject({ method: 'PATCH', url: '/api/products/bulk', payload }))
    if (query) console.log('CONTENT_REPLY_STATEMENTS', JSON.stringify({ field: payload.changes[0].field, value: payload.changes[0].value,
      calls: query.mock.calls.length, statements: query.mock.calls.reduce((n, args) => n + (args[0]?.constructor?.name === 'ScopedQuery' ? 2 : 1), 0) }))
    return result
  } finally { query?.mockRestore() }
}
const productRow = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const listingRow = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id }, include: { translations: true } }))

it.each([
  { tier: 'language', rest: false },
  { tier: 'language', rest: true },
  { tier: 'source', rest: false },
] as const)('returns final $tier tokens after the dependent formula (rest=$rest)', async ({ tier, rest }) => {
  const locale = tier === 'source' ? 'it' : 'de', market = tier === 'source' ? 'IT' : 'DE'
  const address: ContentAddress = tier === 'source' ? { tier } : { tier, language: locale }
  const product = await scoped(() => prisma.product.create({ data: { sku: `reply-${++serial}`, name: 'original title', basePrice: 10 } }))
  if (tier === 'language') await scoped(() => writeContent({ productId: product.id, address, values: { title: 'original title' }, label: 'Title', state: 'reviewed' }))
  const formula = await scoped(() => setCellFormula({ productId: product.id, scope: 'master', market, locale, fieldKey: 'description', expr: rest ? 'upper($brand)' : 'upper($name)', contentAddress: address }))
  expect(formula.error).toBeNull()
  const before = await productRow(product.id)
  const token = before.translations.find(row => row.language === locale)?.version
  const request = (name: string, version: number, contentVersion = token) => ({
    changes: [{ id: product.id, field: 'name', value: name, contentAddress: address, contentVersion },
      ...(rest ? [{ id: product.id, field: 'brand', value: name }] : [])],
    marketplaceContexts: [{ marketplace: market, locale }], expectedVersion: version,
  })
  const result = await patch(request('new title', before.version))
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().errors ?? []).toEqual([])
  const after = await productRow(product.id)
  const content = after.translations.find(row => row.language === locale)
  expect(tier === 'source' ? after.description : content?.description).toBe('NEW TITLE')
  expect.soft(result.json().currentVersion).toBe(after.version)
  if (tier === 'language') expect.soft(result.json().contentVersions).toEqual([{ id: product.id, tier, language: locale, version: content!.version }])
  const next = await patch(request('second title', result.json().currentVersion, result.json().contentVersions?.[0]?.version))
  expect(next.statusCode, next.body).toBe(200)
  const latest = await productRow(product.id)
  expect(tier === 'source' ? latest.description : latest.translations.find(row => row.language === locale)?.description).toBe('SECOND TITLE')
  // Real CAS remains: old product token and old translation token are refused separately.
  expect((await patch(request('stale owner', before.version))).statusCode).toBe(409)
  if (tier === 'language') expect((await patch(request('stale content', latest.version, token))).statusCode).toBe(409)
  expect((await productRow(product.id)).version).toBe(latest.version)
}, 60_000)

it.each(['', 'synthetic-alias'])('returns pin tokens only for the selected listing %s', async aliasKey => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `reply-pin-${++serial}`, name: 'shared title', basePrice: 10 } }))
  await scoped(() => prisma.productListingAlias.create({ data: { id: `synthetic-alias-${serial}`, productId: product.id, channel: 'EBAY', marketplace: 'DE', channelConnectionId: account, label: `Alias ${serial}` } }))
  aliasKey = aliasKey ? `synthetic-alias-${serial}` : ''
  const listings = await scoped(async () => Promise.all(['', `synthetic-alias-${serial}`].map(alias => prisma.channelListing.create({ data: {
    productId: product.id, channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account, aliasKey: alias,
  } }))))
  const own = listings.find(row => row.aliasKey === aliasKey)!, other = listings.find(row => row.aliasKey !== aliasKey)!
  const address: ContentAddress = { tier: 'pin', language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account, ...(aliasKey ? { aliasId: aliasKey } : {}) } }
  await scoped(() => writeContent({ productId: product.id, address, values: { title: 'original pin' }, label: 'Title' }))
  const formula = await scoped(() => setCellFormula({ productId: product.id, scope: 'channel', channel: 'EBAY', marketplace: 'DE', market: 'DE', locale: 'de', channelConnectionId: account, aliasKey, fieldKey: 'description', expr: 'upper($name)', contentAddress: address, contentAcknowledged: true }))
  expect(formula.error, JSON.stringify(formula)).toBeNull()
  const before = await listingRow(own.id), sibling = await listingRow(other.id), master = await productRow(product.id)
  const request = (value: string, version: number, contentVersion: number) => ({
    changes: [{ id: product.id, field: 'name', target: 'channel' as const, value, contentAddress: address, contentVersion, contentAcknowledged: true },
      { id: product.id, field: 'bulletPoints[1]', target: 'channel' as const, value: ['invalid list'], contentAddress: address, contentAcknowledged: true }],
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', accountId: account, aliasKey, locale: 'de' }], expectedVersion: version,
  })
  const result = await patch(request('new pin', before.version, before.translations[0].version))
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().errors).toEqual([expect.objectContaining({ field: 'bulletPoints[1]' })])
  const after = await listingRow(own.id)
  expect(after.translations[0].description).toBe('NEW PIN')
  expect.soft(result.json().currentVersion).toBe(after.version)
  expect.soft(result.json().contentVersions).toEqual([{ id: product.id, tier: 'pin', language: 'de', version: after.translations[0].version }])
  const next = await patch(request('second pin', result.json().currentVersion, result.json().contentVersions[0].version))
  expect(next.statusCode, next.body).toBe(200)
  const latest = await listingRow(own.id)
  expect(latest.translations[0].description).toBe('SECOND PIN')
  expect((await patch(request('stale pin owner', before.version, latest.translations[0].version))).statusCode).toBe(409)
  expect((await patch(request('stale pin content', latest.version, before.translations[0].version))).statusCode).toBe(409)
  expect(await listingRow(own.id)).toEqual(latest)
  expect(await listingRow(other.id)).toEqual(sibling)
  expect(await productRow(product.id)).toEqual(master)
}, 60_000)

it('keeps simple shared saves chainable without dependent formulas', async () => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `reply-simple-${++serial}`, name: 'source', basePrice: 10 } }))
  const address: ContentAddress = { tier: 'language', language: 'de' }
  const request = (value: string, version: number, contentVersion: number) => ({ changes: [{ id: product.id, field: 'name', value, contentAddress: address, contentVersion }],
    marketplaceContexts: [{ marketplace: 'DE', locale: 'de' }], expectedVersion: version })
  const first = await patch(request('simple first', product.version, 0))
  expect(first.statusCode, first.body).toBe(200)
  const next = await patch(request('simple second', first.json().currentVersion, first.json().contentVersions[0].version))
  expect(next.statusCode, next.body).toBe(200)
  const stored = await productRow(product.id)
  expect(next.json().currentVersion).toBe(stored.version)
  expect(next.json().contentVersions[0].version).toBe(stored.translations[0].version)
})

it('returns final content tokens for every product group after all formulas finish', async () => {
  const address: ContentAddress = { tier: 'language', language: 'de' }
  const products = await scoped(async () => {
    const rows = []
    for (let i = 0; i < 2; i++) {
      const product = await prisma.product.create({ data: { sku: `reply-group-${++serial}`, name: 'source', basePrice: 10 } })
      await writeContent({ productId: product.id, address, values: { title: 'before groups' }, label: 'Title' })
      expect((await setCellFormula({ productId: product.id, scope: 'master', market: 'DE', locale: 'de', fieldKey: 'description', expr: 'upper($name)', contentAddress: address })).error).toBeNull()
      rows.push(await productRow(product.id))
    }
    return rows
  })
  const result = await patch({ changes: products.map(product => ({ id: product.id, field: 'name', value: 'after groups', contentAddress: address, contentVersion: product.translations[0].version })),
    marketplaceContexts: [{ marketplace: 'DE', locale: 'de' }] })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().updated).toBe(2)
  for (const product of products) {
    const stored = await productRow(product.id)
    expect(stored.translations[0].description).toBe('AFTER GROUPS')
    const version = result.json().contentVersions.find((row: { id: string }) => row.id === product.id).version
    expect(version).toBe(stored.translations[0].version)
    expect((await patch({ changes: [{ id: product.id, field: 'name', value: 'next group', contentAddress: address, contentVersion: version }],
      marketplaceContexts: [{ marketplace: 'DE', locale: 'de' }], expectedVersion: stored.version })).statusCode).toBe(200)
  }
}, 60_000)

it('returns the final owner token when a refused content cell leaves a non-content formula write', async () => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `reply-rest-${++serial}`, name: 'source', basePrice: 10, brand: 'old brand' } }))
  expect((await scoped(() => setCellFormula({ productId: product.id, scope: 'master', market: 'IT', locale: 'it', fieldKey: 'description', expr: 'upper($brand)', contentAddress: { tier: 'source' } }))).error).toBeNull()
  const before = await productRow(product.id)
  const result = await patch({ changes: [
    { id: product.id, field: 'name', value: ['invalid list'], contentAddress: { tier: 'source' } },
    { id: product.id, field: 'brand', value: 'new brand' },
  ], expectedVersion: before.version, marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().errors).toEqual([expect.objectContaining({ field: 'name' })])
  const after = await productRow(product.id)
  expect(after.description).toBe('NEW BRAND')
  expect(result.json().currentVersion).toBe(after.version)
  expect((await patch({ changes: [{ id: product.id, field: 'brand', value: 'next brand' }], expectedVersion: result.json().currentVersion,
    marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] })).statusCode).toBe(200)
}, 60_000)

it('returns the final version of a draft created by the rest write before content formulas run', async () => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `reply-draft-${++serial}`, name: 'source', basePrice: 10 } }))
  expect((await scoped(() => setCellFormula({ productId: product.id, scope: 'master', market: 'IT', locale: 'it', fieldKey: 'description', expr: 'upper($name)', contentAddress: { tier: 'source' } }))).error).toBeNull()
  const result = await patch({ changes: [
    { id: product.id, field: 'name', value: 'draft title', contentAddress: { tier: 'source' }, contentAcknowledged: true },
    { id: product.id, field: 'ebay_quantity', value: 7, target: 'channel' },
  ], marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: account, locale: 'it' }] })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().errors ?? []).toEqual([])
  expect(result.json().createdListings).toHaveLength(1)
  const created = result.json().createdListings[0]
  const after = await listingRow(created.listingId)
  expect((await productRow(product.id)).description).toBe('DRAFT TITLE')
  expect(created.version).toBe(after.version)
}, 60_000)

it('returns final family listing tokens when another content group advances the parent listing', async () => {
  await scoped(() => prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '910001', schemaVersion: 'synthetic-reply', expiresAt: new Date('2099-01-01'),
    schemaDefinition: { aspects: [{ id: 'aspect_Origin', kind: 'text', label: 'Origin', localizedName: 'Origin', cardinality: 'SINGLE' }] } } }))
  const parent = await scoped(() => prisma.product.create({ data: { sku: `reply-family-${++serial}`, name: 'parent source', basePrice: 10, isParent: true } }))
  const child = await scoped(() => prisma.product.create({ data: { sku: `reply-family-${serial}-child`, name: 'child source', basePrice: 10, parentId: parent.id } }))
  for (const product of [parent, child]) await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU',
    channelConnectionId: account, platformAttributes: { categoryId: '910001', itemSpecifics: { Origin: 'old origin' } } } }))
  expect((await scoped(() => setCellFormula({ productId: parent.id, scope: 'master', market: 'IT', locale: 'it', fieldKey: 'description', expr: 'upper($name)', contentAddress: { tier: 'source' } }))).error).toBeNull()
  const result = await patch({ changes: [
    { id: parent.id, field: 'name', value: 'parent title', contentAddress: { tier: 'source' }, contentAcknowledged: true },
    { id: child.id, field: 'attr_origin', value: 'new origin', target: 'channel' },
  ], marketplaceContexts: [{ channel: 'EBAY', marketplace: 'IT', accountId: account, locale: 'it' }] })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().errors ?? []).toEqual([])
  expect(result.json().familyListings).toHaveLength(1)
  const receipt = result.json().familyListings[0]
  const stored = await listingRow(receipt.listingId)
  expect(stored.productId).toBe(parent.id)
  expect((await productRow(parent.id)).description).toBe('PARENT TITLE')
  expect(receipt.version).toBe(stored.version)
}, 60_000)
