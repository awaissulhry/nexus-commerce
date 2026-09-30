/**
 * A master price changed through the product bulk writer names the person who changed it.
 *
 * `applyProductBulkEdits` hands a `basePrice` change to `masterPriceService.update`, whose AuditLog row is the one that
 * answers "who changed this price, when, from what value" (master-price.service.ts). It was passed `actor: null`, so
 * that row named nobody for every sheet and bulk price edit, while the writer's own audit rows named the person.
 *
 * Runs the real writer and the real price service on PostgreSQL (PGlite) and reads the rows they STORED.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { DEFAULT_HOLD_MS } from '../master-price.service.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let productId = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_AMAZON_IT' } as never })
  const account = await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'price-actor', isActive: true, externalAccountId: 'SELLER-TEST-P' } as never })
  productId = (await prisma.product.create({ data: { sku: 'PRICE-ACTOR-1', name: 'Price actor jacket', basePrice: 10 } })).id
  // A listing that follows the master price, so the price service queues a push the tests can read.
  await prisma.channelListing.create({
    data: { productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: account.id, price: 10, followMasterPrice: true, pricingRule: 'FIXED' } as never,
  })
}), 60_000)
afterAll(async () => { await state.db?.close() })

const priceAudits = () => scoped(async () =>
  (await prisma.auditLog.findMany({ where: { entityId: productId }, orderBy: { createdAt: 'asc' } }))
    .filter((row) => (row.metadata as { field?: string } | null)?.field === 'basePrice'))

it('the price audit row names the person who made the bulk edit', async () => {
  const saved = await scoped(() => applyProductBulkEdits({ changes: [{ id: productId, field: 'basePrice', value: 12.5 }] },
    { formulaCascade: false, userId: 'user-price-editor', logger: { warn: vi.fn(), error: vi.fn() } })) as { updated?: number; errors?: unknown[] }
  expect(saved).toMatchObject({ updated: 1 })
  expect(saved.errors).toBeUndefined()

  const rows = await priceAudits()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ userId: 'user-price-editor', before: { basePrice: 10 }, after: { basePrice: 12.5 } })
  expect((rows[0].metadata as { reason?: string }).reason).toBe('bulk-grid-patch')

  // The exported hold is the hold the service really puts on the push it queued.
  const [push] = await scoped(() => prisma.outboundSyncQueue.findMany({ where: { productId, syncType: 'PRICE_UPDATE' } }))
  expect(DEFAULT_HOLD_MS).toBe(30_000)
  expect(Math.abs(push.holdUntil!.getTime() - push.createdAt.getTime() - DEFAULT_HOLD_MS)).toBeLessThan(10_000)
})

it('a write with no person (a system job) still names nobody, as before', async () => {
  await scoped(() => applyProductBulkEdits({ changes: [{ id: productId, field: 'basePrice', value: 13 }] },
    { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }))
  const rows = await priceAudits()
  expect(rows.at(-1)).toMatchObject({ userId: null, after: { basePrice: 13 } })
})
