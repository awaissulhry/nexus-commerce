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

const patch = async (payload: ProductBulkInput, headers?: Record<string, string>) => {
  const query = process.env.MEASURE_CONTENT_REPLY ? vi.spyOn(pg.Client.prototype, 'query') : null
  try {
    const result = await scoped(() => app.inject({ method: 'PATCH', url: '/api/products/bulk', payload, headers }))
    if (query) console.log('CONTENT_REPLY_STATEMENTS', JSON.stringify({ field: payload.changes[0].field, value: payload.changes[0].value, lastValue: payload.changes.at(-1)?.value,
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


it.each([
  { tier: 'source', refusal: 'type' }, { tier: 'source', refusal: 'address' },
  { tier: 'language', refusal: 'type' }, { tier: 'language', refusal: 'address' },
] as const)('keeps the original product CAS after $tier content is refused for $refusal', async ({ tier, refusal }) => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `cas-refused-${++serial}`, name: 'source', brand: 'initial brand', basePrice: 10 } }))
  const locale = tier === 'source' ? 'it' : 'de', marketplace = tier === 'source' ? 'IT' : 'DE'
  const contentAddress = refusal === 'address' ? undefined : tier === 'source' ? { tier } : { tier, language: locale }
  const marketplaceContexts = [{ marketplace, locale }]
  const refused = { id: product.id, field: 'name', value: ['invalid list'], contentAddress }
  const external = await patch({ changes: [{ id: product.id, field: 'brand', value: 'external brand' }], expectedVersion: product.version, marketplaceContexts })
  expect(external.statusCode, external.body).toBe(200)
  const before = await productRow(product.id)
  const request = (expectedVersion?: number) => ({ changes: [refused, { id: product.id, field: 'brand', value: 'next brand' }], expectedVersion, marketplaceContexts })
  const stale = await patch(request(product.version))
  expect.soft(stale.statusCode, stale.body).toBe(409)
  expect.soft((await productRow(product.id)).brand).toBe('external brand')
  // If-Match is the same caller precondition; omitting it from the body must not turn it into a fresh token.
  const staleHeader = await patch(request(), { 'if-match': String(product.version) })
  expect.soft(staleHeader.statusCode, staleHeader.body).toBe(409)
  expect.soft((await productRow(product.id)).brand).toBe('external brand')
  const valid = await patch(request(before.version))
  expect(valid.statusCode, valid.body).toBe(200)
  expect(valid.json().errors).toEqual([expect.objectContaining({ field: 'name' })])
  expect((await productRow(product.id)).brand).toBe('next brand')
}, 60_000)

it.each(['', 'synthetic-cas-alias'])('keeps listing CAS after refused pin content on listing %s', async alias => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `cas-pin-${++serial}`, name: 'source', basePrice: 10, version: 8 } }))
  const aliasKey = alias ? `${alias}-${serial}` : ''
  if (aliasKey) await scoped(() => prisma.productListingAlias.create({ data: { id: aliasKey, productId: product.id, channel: 'EBAY', marketplace: 'DE', channelConnectionId: account, label: 'Synthetic CAS alias' } }))
  const listing = await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account, aliasKey, version: 7 } }))
  const address: ContentAddress = { tier: 'pin', language: 'de', coordinate: { channel: 'EBAY', market: 'DE', accountId: account, ...(aliasKey ? { aliasId: aliasKey } : {}) } }
  const marketplaceContexts = [{ channel: 'EBAY', marketplace: 'DE', accountId: account, aliasKey, locale: 'de' }]
  const external = await patch({ changes: [{ id: product.id, field: 'ebay_quantity', target: 'channel', value: 1 }], expectedVersion: listing.version, marketplaceContexts })
  expect(external.statusCode, external.body).toBe(200)
  const before = await listingRow(listing.id)
  const request = (expectedVersion: number) => ({ changes: [
    { id: product.id, field: 'name', value: ['invalid list'], contentAddress: address, contentAcknowledged: true },
    { id: product.id, field: 'ebay_quantity', target: 'channel' as const, value: 2 },
  ], expectedVersion, marketplaceContexts })
  expect((await patch(request(listing.version))).statusCode).toBe(409)
  expect(await listingRow(listing.id)).toEqual(before)
  const valid = await patch(request(before.version))
  expect(valid.statusCode, valid.body).toBe(200)
  expect(valid.json().errors).toEqual([expect.objectContaining({ field: 'name' })])
  expect((await listingRow(listing.id)).quantity).toBe(2)
  expect((await productRow(product.id)).version).toBe(product.version)
}, 60_000)

it.each([
  { tier: 'source', invalidFact: false, draft: false }, { tier: 'language', invalidFact: false, draft: false },
  { tier: 'pin', invalidFact: false, draft: false }, { tier: 'pin', invalidFact: true, draft: false },
  { tier: 'pin', invalidFact: false, draft: true },
] as const)('hands off the confirmed $tier owner after accepted content (invalid fact=$invalidFact, draft=$draft)', async ({ tier, invalidFact, draft }) => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `cas-accepted-${++serial}`, name: 'source', brand: 'old brand', basePrice: 10 } }))
  const isPin = tier === 'pin', locale = tier === 'source' ? 'it' : 'de', market = tier === 'source' ? 'IT' : 'DE'
  let listing = isPin && !draft ? await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: market, channelMarket: `EBAY_${market}`, region: 'EU', channelConnectionId: account, version: 7 } })) : null
  const address: ContentAddress = isPin ? { tier: 'pin', language: locale, coordinate: { channel: 'EBAY', market, accountId: account } }
    : tier === 'language' ? { tier, language: locale } : { tier }
  const marketplaceContexts = [{ marketplace: market, locale, ...(isPin ? { channel: 'EBAY', accountId: account } : {}) }]
  const ownerVersion = isPin ? listing?.version ?? 0 : product.version
  const payload: ProductBulkInput = { changes: [
    { id: product.id, field: 'name', value: 'saved title', contentAddress: address, contentVersion: 0, contentAcknowledged: true },
    isPin ? { id: product.id, field: 'ebay_quantity', target: 'channel', value: 4 } : { id: product.id, field: 'brand', value: 'saved brand' },
    ...(invalidFact ? [{ id: product.id, field: 'not_a_field', value: 'invalid fact' }] : []),
  ], expectedVersion: ownerVersion, marketplaceContexts }
  const result = await patch(payload)
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().errors ?? []).toEqual(invalidFact ? [expect.objectContaining({ field: 'not_a_field' })] : [])
  if (isPin && !listing) listing = await scoped(() => prisma.channelListing.findFirstOrThrow({ where: { productId: product.id, channelConnectionId: account, aliasKey: '' } }))
  if (listing) {
    const after = await listingRow(listing.id)
    expect(after.translations[0].name).toBe('saved title')
    expect(after.quantity).toBe(4)
    expect(result.json().currentVersion).toBe(after.version)
    expect((await productRow(product.id)).version).toBe(product.version)
  } else {
    const after = await productRow(product.id)
    expect(tier === 'source' ? after.name : after.translations[0].name).toBe('saved title')
    expect(after.brand).toBe('saved brand')
    expect(result.json().currentVersion).toBe(after.version)
  }
  const before = listing ? await listingRow(listing.id) : await productRow(product.id)
  const stale = { ...payload, changes: payload.changes.map(change => ({ ...change, contentVersion: before.translations[0]?.version, value: change.field === 'name' ? 'stale title' : isPin ? 5 : 'stale brand' })) }
  expect((await patch(stale)).statusCode).toBe(409)
  const header = await patch({ ...stale, expectedVersion: undefined }, { 'if-match': String(ownerVersion) })
  expect(header.statusCode, header.body).toBe(409)
  expect(listing ? await listingRow(listing.id) : await productRow(product.id)).toEqual(before)
}, 60_000)

it('checks the original product token even when shared content would be a no-op', async () => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `cas-noop-${++serial}`, name: 'source', brand: 'initial brand', basePrice: 10 } }))
  const address: ContentAddress = { tier: 'language', language: 'de' }
  await scoped(() => writeContent({ productId: product.id, address, values: { title: 'same German title' }, label: 'Title', state: 'reviewed' }))
  const original = await productRow(product.id)
  const marketplaceContexts = [{ marketplace: 'DE', locale: 'de' }]
  expect((await patch({ changes: [{ id: product.id, field: 'brand', value: 'external brand' }], expectedVersion: original.version, marketplaceContexts })).statusCode).toBe(200)
  const before = await productRow(product.id)
  const request = (expectedVersion: number) => ({ changes: [
    { id: product.id, field: 'name', value: 'same German title', contentAddress: address, contentVersion: before.translations[0].version },
    { id: product.id, field: 'brand', value: 'next brand' },
  ], expectedVersion, marketplaceContexts })
  expect((await patch(request(original.version))).statusCode).toBe(409)
  expect(await productRow(product.id)).toEqual(before)
  const valid = await patch(request(before.version))
  expect(valid.statusCode, valid.body).toBe(200)
  expect(valid.json().errors ?? []).toEqual([])
  const after = await productRow(product.id)
  expect(after.translations[0].version).toBe(before.translations[0].version)
  expect(after.version).toBe(before.version + 1) // Only the fact moved the product.
  expect(after.brand).toBe('next brand')
}, 60_000)


it.each(['source', 'language', 'pin'] as const)('stores a valid fact beside refused %s content with the current token', async tier => {
  const product = await scoped(() => prisma.product.create({ data: { sku: `cas-partial-${++serial}`, name: 'source', basePrice: 10 } }))
  const pin = tier === 'pin', locale = tier === 'source' ? 'it' : 'de', market = tier === 'source' ? 'IT' : 'DE'
  const listing = pin ? await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: market, channelMarket: `EBAY_${market}`, region: 'EU', channelConnectionId: account } })) : null
  const address: ContentAddress = pin ? { tier: 'pin', language: locale, coordinate: { channel: 'EBAY', market, accountId: account } }
    : tier === 'language' ? { tier, language: locale } : { tier }
  const result = await patch({ changes: [
    { id: product.id, field: 'name', value: ['invalid list'], contentAddress: address, contentAcknowledged: true },
    pin ? { id: product.id, field: 'ebay_quantity', target: 'channel', value: 6 } : { id: product.id, field: 'brand', value: 'partial saved brand' },
  ], expectedVersion: listing?.version ?? product.version,
    marketplaceContexts: [{ marketplace: market, locale, ...(pin ? { channel: 'EBAY', accountId: account } : {}) }] })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().updated).toBe(1)
  expect(result.json().errors).toEqual([expect.objectContaining({ field: 'name' })])
  expect(listing ? (await listingRow(listing.id)).quantity : (await productRow(product.id)).brand).toBe(pin ? 6 : 'partial saved brand')
}, 60_000)
