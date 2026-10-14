/**
 * MCP full control P7 — the tag writes Claude's `set-product-tags` uses moved from products-catalog.routes.ts into
 * tags.service.ts: POST /api/tags (create a tag), POST /api/products/:id/tags (add tags to a product) and
 * DELETE /api/products/:id/tags/:tagId (take one off). Each answers byte for byte what it answered before (goldens
 * recorded on the routes as they were), with business profiles off and on. A created tag's id and creation time are
 * the only parts that differ per run, and are normalized.
 *
 * 2026-10-14: the two product-tag routes were deleted with the old product drawer, their only caller. The service
 * functions stay (Claude's tag tool), so their answers are checked against the same goldens, wrapped as the routes
 * wrapped them (`{ tags }`, `{ ok: true }`, status 200).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness, profilesOn } from '../../test-support/route-golden.js'
import productsCatalogRoutes from '../../routes/products-catalog.routes.js'
import { addProductTags, removeProductTag } from './tags.service.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)
/** A created tag's random id and its database-set creation time. */
/** What the deleted route answered for `value`, checked against its golden. */
const expectRecorded = async (name: string, value: unknown) =>
  expect(`200\n${JSON.stringify(value)}\n`).toMatchFileSnapshot(`${GOLDEN}/${name}.${profilesOn() ? 'on' : 'off'}.txt`)
const createdTag = (body: string) =>
  body.replace(/"id":"[a-z0-9]{20,}"/g, '"id":"<created id>"').replace(/"createdAt":"[^"]+"/g, '"createdAt":"<created at>"')

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    for (const n of [1, 2]) {
      await db.product.create({ data: { id: `golden-tagw-product-${n}`, sku: `TEST-SKU-W${n}`, name: `Tag write product ${n}`, basePrice: '10.00', totalStock: n } })
    }
    await db.tag.create({ data: { id: 'golden-tagw-sale', name: 'sale', color: '#ff0000', icon: 'tag', updatedAt: at(30), createdAt: at(300) } })
    await db.tag.create({ data: { id: 'golden-tagw-summer', name: 'Summer', updatedAt: at(20), createdAt: at(200) } })
    await db.tag.create({ data: { id: 'golden-tagw-old', name: 'Old', updatedAt: at(10), createdAt: at(100) } })
    await db.productTag.create({ data: { productId: 'golden-tagw-product-2', tagId: 'golden-tagw-old' } })
  })
  app = await goldenApp([{ plugin: productsCatalogRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P7 — tag writes: the answers are exactly as before', () => {
  it('POST /api/tags: created, refused without a name, refused as a duplicate', async () => {
    await expectGolden(app, 'tag-create', '/api/tags', GOLDEN, { method: 'POST', payload: { name: '  Clearance ', color: '#0000ff' }, normalize: createdTag })
    await expectGolden(app, 'tag-create-no-name', '/api/tags', GOLDEN, { method: 'POST', payload: { name: '   ' } })
    await expectGolden(app, 'tag-create-duplicate', '/api/tags', GOLDEN, { method: 'POST', payload: { name: 'sale' } })
  })

  it('addProductTags adds tags (again: nothing new), and lists what the product carries', async () => {
    await expectRecorded('product-tags-add', { tags: await inGoldenBusiness(() => addProductTags('golden-tagw-product-1', ['golden-tagw-sale', 'golden-tagw-summer'])) })
    await expectRecorded('product-tags-add-again', { tags: await inGoldenBusiness(() => addProductTags('golden-tagw-product-1', ['golden-tagw-sale'])) })
    await expectRecorded('product-tags-add-none', { tags: await inGoldenBusiness(() => addProductTags('golden-tagw-product-2', [])) })
  })

  it('removeProductTag takes one tag off', async () => {
    await inGoldenBusiness(() => removeProductTag('golden-tagw-product-2', 'golden-tagw-old'))
    await expectRecorded('product-tag-remove', { ok: true })
    await expectRecorded('product-tags-after-remove', { tags: await inGoldenBusiness(() => addProductTags('golden-tagw-product-2', [])) })
  })
})
