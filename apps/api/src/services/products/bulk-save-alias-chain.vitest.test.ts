import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { formulaDatabase } from '../../test-support/formula-database.js'
import type { concurrentDatabase } from '../../test-support/concurrent-database.js'

/*
 * Audit A03 (2026-09-30) — the server contract the sheet writer relies on when one operation edits the SAME product
 * under several listing-alias bands. Each unit of a bulk-save runs in turn, and the first unit that writes the shared
 * record moves the product's (and its translation's) version: a second unit carrying the same tokens is refused, and a
 * unit carrying the tokens the first one answered with is stored. Real routes and writers on a disposable database.
 */
const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof formulaDatabase>> | Awaited<ReturnType<typeof concurrentDatabase>> | null }))
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

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { writeContent } from '../pim/content-write.js'
import type { ProductBulkInput } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let serial = 0
beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'DE', name: 'DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
    await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'synthetic-alias-chain', isActive: true } })
  })
  const { default: Fastify } = await import('fastify')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register((await import('../../routes/products.routes.js')).default, { prefix: '/api' })
  await app.register((await import('../../routes/products-bulk-save.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close(); await state.db?.close() })

const productRow = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, include: { translations: true } }))
const batch = async (units: ProductBulkInput[]) => {
  const response = await scoped(() => app.inject({ method: 'POST', url: '/api/products/bulk-save', payload: { units: units.map((unit, index) => ({ key: String(index), ...unit })) } }))
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { units: Array<{ status: number; body: Record<string, any> }> }
}

async function sharedGerman() {
  const product = await scoped(() => prisma.product.create({ data: { sku: `alias-chain-${++serial}`, name: 'source', brand: 'initial brand', basePrice: 10, version: 7 } }))
  const address: ContentAddress = { tier: 'language', language: 'de' }
  await scoped(() => writeContent({ productId: product.id, address, values: { title: 'existing text' }, label: 'Title' }))
  const before = await productRow(product.id)
  /** One alias band's unit: the shared German title, as the channel sheet sends it (every band carries the same tokens). */
  const unit = (aliasKey: string, title: string, expectedVersion = before.version, contentVersion = before.translations[0].version): ProductBulkInput => ({
    expectedVersion,
    marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', locale: 'de', aliasKey }],
    changes: [{ id: product.id, field: 'name', value: title, contentAddress: address, contentVersion, contentAcknowledged: true, target: 'master' }],
  } as ProductBulkInput)
  return { product, before, unit }
}

it('refuses the second alias band of one product when both carry the tokens the sheet read', async () => {
  const f = await sharedGerman()
  const result = await batch([f.unit('', 'shared text'), f.unit('alias-2', 'shared text')])
  expect(result.units.map(u => u.status)).toEqual([200, 409])
  expect(result.units[1].body).toEqual({ error: 'Title changed. Reload before saving it.' })
  expect((await productRow(f.product.id)).translations[0].name).toBe('shared text')
})

it('refuses a DIFFERENT shared field on the second band too: every master-target unit guards the product version', async () => {
  const f = await sharedGerman()
  const brand: ProductBulkInput = { expectedVersion: f.before.version, marketplaceContexts: [{ channel: 'EBAY', marketplace: 'DE', locale: 'de', aliasKey: 'alias-2' }],
    changes: [{ id: f.product.id, field: 'brand', value: 'next brand', target: 'master' }] } as ProductBulkInput
  const result = await batch([f.unit('', 'shared text'), brand])
  expect(result.units.map(u => u.status)).toEqual([200, 409])
  expect(result.units[1].body).toMatchObject({ code: 'VERSION_CONFLICT', versionOf: 'product' })
  expect((await productRow(f.product.id)).brand).toBe('initial brand')
})

it('stores the second band when it carries the tokens the first band answered with (the next call)', async () => {
  const f = await sharedGerman()
  const [first] = (await batch([f.unit('', 'shared text')])).units
  expect(first.status).toBe(200)
  const content = (first.body.contentVersions as Array<{ tier: string; version: number }>).find(entry => entry.tier === 'language')!
  expect(first.body).toMatchObject({ versionOf: 'product' })
  const [same] = (await batch([f.unit('alias-2', 'shared text', first.body.currentVersion, content.version)])).units
  expect(same.status, JSON.stringify(same.body)).toBe(200)
  const after = await productRow(f.product.id)
  const [other] = (await batch([f.unit('alias-2', 'other text', after.version, after.translations[0].version)])).units
  expect(other.status, JSON.stringify(other.body)).toBe(200)
  expect((await productRow(f.product.id)).translations[0].name).toBe('other text')
})
