import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { formulaDatabase } from '../../test-support/formula-database.js'
import type { concurrentDatabase } from '../../test-support/concurrent-database.js'

// Real routes, content writers and formula writes on a disposable database. Only external side effects are replaced.
const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | Awaited<ReturnType<typeof concurrentDatabase>> | null, failProduct: '', failure: null as Error | null }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

vi.mock('../pim/content-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../pim/content-write.js')>()
  return { ...actual, writeContent: async (input: Parameters<typeof actual.writeContent>[0]) => {
    const written = await actual.writeContent(input)
    if (input.productId === state.failProduct && state.failure) throw state.failure
    return written
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeContent } from '../pim/content-write.js'
import { ProductBulkError } from './bulk-edit.service.js'
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
    account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-content-errors', isActive: true } })).id
  })
  const { default: Fastify } = await import('fastify')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register((await import('../../routes/products.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/cell-formula.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/products-bulk-save.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close(); await state.db?.close() })

const patch = (payload: ProductBulkInput) => scoped(() => app.inject({ method: 'PATCH', url: '/api/products/bulk', payload }))
const productRow = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const listingRow = (id: string) => scoped(() => prisma.channelListing.findUniqueOrThrow({ where: { id }, include: { translations: true } }))

const batch = async (units: ProductBulkInput[]) => {
  const response = await scoped(() => app.inject({ method: 'POST', url: '/api/products/bulk-save', payload: { units: units.map((unit, index) => ({ key: String(index), ...unit })) } }))
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const post = async (unit: ProductBulkInput) => (await batch([unit])).units[0]

async function fixture(tier: 'source' | 'language' | 'pin') {
  const product = await scoped(() => prisma.product.create({ data: { sku: `content-errors-${++serial}`, name: 'source', brand: 'initial brand', basePrice: 10, version: 11 } }))
  const listing = tier === 'pin' ? await scoped(() => prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'DE', channelMarket: 'EBAY_DE', region: 'EU', channelConnectionId: account, version: 7 } })) : null
  const language = tier === 'source' ? 'it' : 'de'
  const address: ContentAddress = tier === 'pin' ? { tier, language, coordinate: { channel: 'EBAY', market: 'DE', accountId: account } } : tier === 'source' ? { tier } : { tier, language }
  const marketplaceContexts = [{ marketplace: tier === 'source' ? 'IT' : 'DE', locale: language, ...(listing ? { channel: 'EBAY', accountId: account } : {}) }]
  if (tier !== 'source') await scoped(() => writeContent({ productId: product.id, address, values: { title: 'existing text' }, label: 'Title' }))
  const row = () => listing ? listingRow(listing.id) : productRow(product.id)
  const before = await row()
  const request = (expectedVersion = before.version, title: unknown = 'next text', contentVersion = before.translations[0]?.version): ProductBulkInput => ({
    expectedVersion, marketplaceContexts, changes: [
      { id: product.id, field: 'name', value: title, contentAddress: address, contentVersion, contentAcknowledged: true },
      listing ? { id: product.id, field: 'ebay_quantity', value: 3, target: 'channel' } : { id: product.id, field: 'brand', value: 'next brand' },
    ],
  })
  return { product, listing, address, marketplaceContexts, row, before, request }
}


it.each(['source', 'language', 'pin'] as const)('keeps the exact %s owner-conflict reason and rolls back its unit', async tier => {
  const f = await fixture(tier)
  const request = f.request(f.before.version - 1)
  const single = await patch(request)
  expect(single.statusCode, single.body).toBe(409)
  const unit = await post(request)
  expect.soft(unit.status, JSON.stringify(unit)).toBe(409)
  expect.soft(unit.body.error).toBe(single.json().message ?? single.json().error)
  expect(await f.row()).toEqual(f.before)
})

it.each(['language', 'pin'] as const)('keeps the exact %s translation-conflict reason and stores nothing', async tier => {
  const f = await fixture(tier)
  const request = f.request(f.before.version, 'next text', f.before.translations[0].version - 1)
  const single = await patch(request)
  expect(single.statusCode, single.body).toBe(409)
  const unit = await post(request)
  expect.soft(unit.status, JSON.stringify(unit)).toBe(409)
  expect.soft(unit.body.error).toBe(single.json().message ?? single.json().error)
  expect(await f.row()).toEqual(f.before)
})

it('refuses stale shared text that would be a no-op, then stores current facts once', async () => {
  const f = await fixture('language')
  const stale = await post(f.request(f.before.version - 1, 'existing text'))
  expect.soft(stale.status, JSON.stringify(stale)).toBe(409)
  expect(await f.row()).toEqual(f.before)
  const valid = await post(f.request(f.before.version, 'existing text'))
  expect(valid.status, JSON.stringify(valid)).toBe(200)
  const stored = await f.row()
  expect(stored.translations[0].version).toBe(f.before.translations[0].version)
  expect(stored.version).toBe(f.before.version + 1)
})

it('keeps successful units on both sides of a refused content unit', async () => {
  const goodFirst = await fixture('source'), bad = await fixture('language'), goodLast = await fixture('pin')
  const result = await batch([goodFirst.request(), bad.request(bad.before.version - 1), goodLast.request()])
  expect(result.saved).toBe(2)
  expect(result.failed).toBe(1)
  expect.soft(result.units.map((unit: { status: number }) => unit.status)).toEqual([200, 409, 200])
  expect((await goodFirst.row()).name).toBe('next text')
  expect((await goodLast.row()).translations[0].name).toBe('next text')
  expect(await bad.row()).toEqual(bad.before)
})

it('preserves existing ProductBulkError conflict metadata', async () => {
  const f = await fixture('source')
  const request: ProductBulkInput = { expectedVersion: f.before.version - 1, changes: [{ id: f.product.id, field: 'brand', value: 'stale facts' }] }
  const single = await patch(request)
  expect(single.statusCode, single.body).toBe(409)
  const unit = await post(request)
  expect(unit.status, JSON.stringify(unit)).toBe(409)
  expect(unit.body).toEqual(single.json())
  expect(unit.body).toMatchObject({ code: 'VERSION_CONFLICT', expectedVersion: f.before.version - 1, currentVersion: f.before.version, versionOf: 'product' })
  expect(await f.row()).toEqual(f.before)
})

it.each([
  new Error('synthetic internal failure'),
  Object.assign(new Error('unclassified status'), { statusCode: 409, privateContext: 'not a public error field' }),
  Object.assign(new Error('unclassified server failure'), { statusCode: 503 }),
  new ProductBulkError(500, { error: 'known internal failure', privateContext: 'not a public error field' }),
])('keeps unexpected error %s at 500 and rolls back its real write', async failure => {
  const first = await fixture('source'), bad = await fixture('language'), last = await fixture('pin')
  state.failProduct = bad.product.id
  state.failure = failure
  try {
    const result = await batch([first.request(), bad.request(), last.request()])
    expect(result.units.map((unit: { status: number }) => unit.status)).toEqual([200, 500, 200])
    expect(result.saved).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.units[1].body).toMatchObject({ error: 'This row could not be saved. The other rows of this change were saved; try this row again.', nothingSaved: true })
    expect(result.units[1].body).not.toHaveProperty('privateContext')
    expect((await first.row()).name).toBe('next text')
    expect((await last.row()).translations[0].name).toBe('next text')
    expect(await bad.row()).toEqual(bad.before)
  } finally { state.failProduct = ''; state.failure = null }
})

it('keeps exhausted retryable conflicts as an operation-wide busy response', async () => {
  const first = await fixture('source'), bad = await fixture('language')
  state.failProduct = bad.product.id
  state.failure = Object.assign(new Error('synthetic serialization conflict'), { code: 'P2034' })
  try {
    const response = await scoped(() => app.inject({ method: 'POST', url: '/api/products/bulk-save', payload: { units: [first, bad].map((f, index) => ({ key: String(index), ...f.request() })) } }))
    expect(response.statusCode, response.body).toBe(503)
    expect(response.headers['retry-after']).toBe('2')
    expect(response.json()).toMatchObject({ retryable: true, nothingSaved: true })
    expect(await first.row()).toEqual(first.before)
    expect(await bad.row()).toEqual(bad.before)
  } finally { state.failProduct = ''; state.failure = null }
})
