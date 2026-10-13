/**
 * Settings › PIM › Families — a drag writes the family's attribute order in ONE request and ONE transaction
 * (PUT /api/families/:id/attribute-order). It used to send one PATCH per link at once, with no transaction, so two
 * quick drags mixed their orders. Real PostgreSQL (PGlite), as the families route goldens.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import { goldenApp, inGoldenBusiness } from '../../test-support/route-golden.js'
import familiesRoutes from '../../routes/families.routes.js'

const FAMILY = 'order-fam-test'
const LINKS = ['order-fa-a', 'order-fa-b', 'order-fa-c']

let app: FastifyInstance
const put = (familyId: string, familyAttributeIds: unknown) =>
  app.inject({ method: 'PUT', url: `/api/families/${familyId}/attribute-order`, payload: { familyAttributeIds } as never })
const order = () => inGoldenBusiness(() => state.db.client.familyAttribute.findMany({
  where: { familyId: FAMILY }, orderBy: [{ sortOrder: 'asc' }], select: { id: true, sortOrder: true },
}))

beforeAll(async () => {
  const db = state.db.client
  await inGoldenBusiness(async () => {
    await db.attributeGroup.create({ data: { id: 'order-group', code: 'order_group', label: 'General' } })
    for (const [i, code] of ['order_size', 'order_fit', 'order_lining', 'order_other'].entries()) {
      await db.customAttribute.create({ data: { id: `order-attr-${i}`, code, label: code, groupId: 'order-group', type: 'text' } })
    }
    await db.productFamily.create({ data: { id: FAMILY, code: 'order_jackets', label: 'Jackets' } })
    await db.productFamily.create({ data: { id: 'order-fam-other', code: 'order_other', label: 'Other' } })
    for (const [i, id] of LINKS.entries()) {
      await db.familyAttribute.create({ data: { id, familyId: FAMILY, attributeId: `order-attr-${i}`, sortOrder: i * 10 } })
    }
    await db.familyAttribute.create({ data: { id: 'order-fa-foreign', familyId: 'order-fam-other', attributeId: 'order-attr-3' } })
  })
  app = await goldenApp([{ plugin: familiesRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => { await app?.close() })

beforeEach(async () => {
  await inGoldenBusiness(async () => {
    for (const [i, id] of LINKS.entries()) await state.db.client.familyAttribute.update({ where: { id }, data: { sortOrder: i * 10 } })
  })
})

describe('PUT /api/families/:id/attribute-order', () => {
  it('writes every link’s order in one request: 0, 10, 20', async () => {
    const res = await put(FAMILY, ['order-fa-c', 'order-fa-a', 'order-fa-b'])
    expect(res.statusCode).toBe(200)
    const expected = [{ id: 'order-fa-c', sortOrder: 0 }, { id: 'order-fa-a', sortOrder: 10 }, { id: 'order-fa-b', sortOrder: 20 }]
    expect(res.json()).toEqual({ familyId: FAMILY, familyAttributes: expected })
    expect(await order()).toEqual(expected)
  })

  it('two quick drags: the order on file is one of them, whole — never a mix', async () => {
    const first = ['order-fa-b', 'order-fa-c', 'order-fa-a']
    const second = ['order-fa-c', 'order-fa-b', 'order-fa-a']
    const [a, b] = await Promise.all([put(FAMILY, first), put(FAMILY, second)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    const onFile = (await order()).map((fa: { id: string }) => fa.id)
    expect([first, second]).toContainEqual(onFile)
  })

  it('a list that is not exactly the family’s own links is refused, and nothing is written', async () => {
    const missing = await put(FAMILY, ['order-fa-c', 'order-fa-a'])
    expect(missing.statusCode).toBe(409)
    expect(missing.json().error).toMatch(/changed after the page read them/)
    const foreign = await put(FAMILY, ['order-fa-c', 'order-fa-a', 'order-fa-foreign'])
    expect(foreign.statusCode).toBe(409)
    expect(await order()).toEqual(LINKS.map((id, i) => ({ id, sortOrder: i * 10 })))
  })

  it('refuses a bad body and an unknown family', async () => {
    expect((await put(FAMILY, 'order-fa-a')).statusCode).toBe(400)
    expect((await put(FAMILY, [])).statusCode).toBe(400)
    expect((await put(FAMILY, ['order-fa-a', 'order-fa-a', 'order-fa-b'])).statusCode).toBe(400)
    expect((await put('order-fam-missing', LINKS)).statusCode).toBe(404)
  })
})
