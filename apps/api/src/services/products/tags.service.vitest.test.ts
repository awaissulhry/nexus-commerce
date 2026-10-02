/**
 * MCP full control P3 — the tag list moved from products-catalog.routes.ts into tags.service.ts. GET /api/tags
 * answers byte for byte what it answered before (golden recorded on the route as it was), with business profiles off
 * and on. Tag writes stay in the route until the organizing changes (P7).
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import productsCatalogRoutes from '../../routes/products-catalog.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    for (const n of [1, 2, 3]) {
      await db.product.create({ data: { id: `golden-tag-product-${n}`, sku: `TEST-SKU-${n}`, name: `Tagged product ${n}`, basePrice: '10.00', totalStock: n } })
    }
    await db.tag.create({ data: { id: 'golden-tag-sale', name: 'sale', color: '#ff0000', icon: 'tag', updatedAt: at(30), createdAt: at(300) } })
    await db.tag.create({ data: { id: 'golden-tag-new', name: 'New season', color: null, icon: null, updatedAt: at(20), createdAt: at(200) } })
    await db.tag.create({ data: { id: 'golden-tag-empty', name: 'Archive', metadata: { note: 'unused' }, updatedAt: at(10), createdAt: at(100) } })
    await db.productTag.create({ data: { productId: 'golden-tag-product-1', tagId: 'golden-tag-sale' } })
    await db.productTag.create({ data: { productId: 'golden-tag-product-2', tagId: 'golden-tag-sale' } })
    await db.productTag.create({ data: { productId: 'golden-tag-product-3', tagId: 'golden-tag-new' } })
  })
  app = await goldenApp([{ plugin: productsCatalogRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — tags: the route answers exactly as before', () => {
  it('GET /api/tags', async () => {
    await expectGolden(app, 'tags', '/api/tags', GOLDEN)
  })
})
