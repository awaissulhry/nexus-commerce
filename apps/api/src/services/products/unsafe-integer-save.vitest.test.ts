import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof import('../../test-support/formula-database.js').formulaDatabase>> | null }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider calls are forbidden in this fixture') }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import type { FastifyInstance } from 'fastify'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let account = ''
let familyId = ''
let serial = 0
beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'ETSY', code: 'GLOBAL', name: 'Etsy', currency: 'EUR', region: 'GLOBAL', language: 'en', languages: ['en'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 'synthetic-integer-safety', isActive: true } })).id
    await prisma.categorySchema.create({ data: { channel: 'ETSY', marketplace: 'GLOBAL', productType: '99004401', schemaVersion: 'integer-safety', expiresAt: new Date('2099-01-01'), schemaDefinition: { count: 0, results: [] } } })
    const group = await prisma.attributeGroup.create({ data: { code: 'integer-safety', label: 'Numeric facts' } })
    const attr = await prisma.customAttribute.create({ data: { code: 'signed_count', label: 'Signed count', type: 'number', groupId: group.id } })
    familyId = (await prisma.productFamily.create({ data: { code: 'integer-safety', label: 'Synthetic numeric family' } })).id
    await prisma.familyAttribute.create({ data: { familyId, attributeId: attr.id, channels: [] } })
  })
  const { default: Fastify } = await import('fastify')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register((await import('../../routes/products-bulk-save.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { vi.unstubAllGlobals(); await app?.close(); await state.db?.close() })

async function fixture() {
  const product = await prisma.product.create({ data: { sku: `E2E-INTEGER-${++serial}`, name: 'Integer safety fixture', basePrice: 10 } })
  const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'ETSY', marketplace: 'GLOBAL', channelMarket: 'ETSY_GLOBAL', region: 'GLOBAL', channelConnectionId: account, platformAttributes: { taxonomy_id: 99004401, production_partner_ids: [17] } } })
  return { product, listing }
}

async function post(f: Awaited<ReturnType<typeof fixture>>, value: unknown) {
  const current = await prisma.channelListing.findUniqueOrThrow({ where: { id: f.listing.id } })
  const response = await app.inject({ method: 'POST', url: '/api/products/bulk-save', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({
    operationId: `integer-${++serial}`, units: [{ key: 'partners', expectedVersion: current.version,
      marketplaceContexts: [{ channel: 'ETSY', marketplace: 'GLOBAL', accountId: account, locale: 'en' }],
      changes: [{ id: f.product.id, field: 'attr_production_partner_ids', target: 'channel', value }],
    }],
  }) })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().units[0]
}

it.each([['9007199254740993'], [9007199254740992], '[9007199254740993]', ['-9007199254740993']].map(value => [value]))(
  'refuses unsafe partner IDs %j at the real API and retains the stored list and version', value => scoped(async () => {
    const f = await fixture()
    const before = await prisma.channelListing.findUniqueOrThrow({ where: { id: f.listing.id } })
    const unit = await post(f, value)
    const after = await prisma.channelListing.findUniqueOrThrow({ where: { id: f.listing.id } })
    expect(after.platformAttributes).toEqual(before.platformAttributes)
    expect(after.overrideData).toEqual(before.overrideData)
    expect(after.version).toBe(before.version)
    expect(unit.body.errors).toEqual([expect.objectContaining({ id: f.product.id, field: 'attr_production_partner_ids',
      error: 'Production partner IDs is outside the safe whole-number range (-9007199254740991 to 9007199254740991). It has not been rounded or saved.' })])
  }))

it('saves the safe positive boundary as a JSON number and reads it back from the sheet', () => scoped(async () => {
  const f = await fixture()
  const values = [1, Number.MAX_SAFE_INTEGER]
  const unit = await post(f, values.map(String))
  expect(unit.status, JSON.stringify(unit)).toBe(200)
  expect(unit.body.errors ?? []).toEqual([])
  const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: f.listing.id } })
  expect(stored.platformAttributes).toMatchObject({ production_partner_ids: values })
  expect(stored.version).toBeGreaterThan(f.listing.version)
  const sheet = await getStudioSheet({ productId: f.product.id, scope: 'channel', channel: 'ETSY', market: 'GLOBAL', locale: 'en', accountId: account })
  expect(sheet.rows.find(row => row.id === f.product.id)?.values.production_partner_ids.value).toEqual(values)
}))


it.each([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, -1, 0, -1.25])('persists supported signed scalar %s through the real API and sheet read', value => scoped(async () => {
  const row = await prisma.product.create({ data: { sku: `E2E-SIGNED-${++serial}`, name: 'Signed fact fixture', familyId, basePrice: 10, categoryAttributes: { signed_count: 4 } } })
  const write = async (input: unknown) => {
    const current = await prisma.product.findUniqueOrThrow({ where: { id: row.id } })
    const response = await app.inject({ method: 'POST', url: '/api/products/bulk-save', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({
      units: [{ key: 'signed', expectedVersion: current.version, changes: [{ id: row.id, field: 'attr_signed_count', target: 'master', value: input }] }],
    }) })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().units[0]
  }
  const accepted = await write(String(value))
  expect(accepted.status, JSON.stringify(accepted)).toBe(200)
  expect(accepted.body.errors ?? []).toEqual([])
  const stored = await prisma.product.findUniqueOrThrow({ where: { id: row.id } })
  expect(stored.categoryAttributes).toMatchObject({ signed_count: value })
  const sheet = await getStudioSheet({ productId: row.id, scope: 'master', market: 'GLOBAL', locale: 'en' })
  expect(sheet.rows.find(item => item.id === row.id)?.values.signed_count.value).toBe(value)
  const refused = await write('-9007199254740993')
  const after = await prisma.product.findUniqueOrThrow({ where: { id: row.id } })
  expect(after.categoryAttributes).toEqual(stored.categoryAttributes)
  expect(after.version).toBe(stored.version)
  expect(refused.body.errors).toEqual([expect.objectContaining({ field: 'attr_signed_count', error: expect.stringContaining('Signed count is outside the safe whole-number range') })])
}))
