/**
 * Garment measurements (2026-10-14) — `Product.fitGarment` saves through the product sheet's bulk save as ONE table,
 * normalised by `normalizeFitGarment` (@nexus/shared/fit-garment): a sound table is stored in its canonical shape, a
 * table the rule refuses never reaches the column (the unit answers 400 with every reason), and an empty value clears
 * the column to a database NULL. A variation's own table: `child-product-field-save.vitest.test.ts`, beside the impact
 * protectors.
 */
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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, FACE_IMAGE_TAKE: 1 }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider calls are forbidden in this fixture') }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance
let serial = 0
const STORED = {
  measures: ['chest', 'waist', 'sleeve'],
  sizes: [{ name: 'M', chest: 106, waist: 94, sleeve: 62.5 }, { name: 'L', chest: 112, waist: 100, sleeve: 64 }],
  flat: ['chest'],
  room: { chest: [6, 16] },
}

beforeAll(async () => {
  const { default: Fastify } = await import('fastify')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
  })
  await app.register((await import('../../routes/products-bulk-save.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 60_000)
afterAll(async () => { vi.unstubAllGlobals(); await app?.close(); await state.db?.close() })

async function family() {
  const n = ++serial
  const parent = await prisma.product.create({ data: { sku: `E2E-FIT-${n}`, name: 'Fit fixture', basePrice: 10, isParent: true } })
  await prisma.product.create({ data: { sku: `E2E-FIT-${n}-M`, name: 'Fit M', basePrice: 10, parentId: parent.id } })
  return { parent }
}

async function send(id: string, value: unknown) {
  const current = await prisma.product.findUniqueOrThrow({ where: { id } })
  const response = await app.inject({ method: 'POST', url: '/api/products/bulk-save', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({
    operationId: `fit-garment-${++serial}`, units: [{ key: id, expectedVersion: current.version, changes: [{ id, field: 'fitGarment', value }] }],
  }) })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().units[0] as { status: number; body: unknown }
}

async function save(id: string, value: unknown) {
  const unit = await send(id, value)
  expect(unit.status, JSON.stringify(unit.body)).toBe(200)
  return prisma.product.findUniqueOrThrow({ where: { id } })
}

it('a sound table is stored in its canonical shape: text numbers read, an empty row and an unused measure dropped', async () => {
  const { parent } = await family()
  const typed = {
    measures: ['chest', 'waist', 'hips', 'sleeve'],
    sizes: [{ sleeve: '62,5', name: ' M ', waist: 94, chest: 106 }, { name: 'L', chest: '112', waist: 100, sleeve: 64 }, { name: 'XL' }],
    flat: ['chest'],
    room: { chest: [6, 16] },
  }
  const stored = await save(parent.id, typed)
  expect(stored.fitGarment).toEqual(STORED)
  // JSONB keeps the values, not the key order (it sorts keys); the rule gives the canonical order back for the store.
  const { normalizeFitGarment } = await import('@nexus/shared/fit-garment')
  expect(JSON.stringify(normalizeFitGarment(stored.fitGarment))).toBe(JSON.stringify(STORED))
})

it('a table the rule refuses is answered 400 with every reason, and the stored table is kept', async () => {
  const { parent } = await family()
  await save(parent.id, STORED)
  const unit = await send(parent.id, { measures: ['chest', 'shoulder'], sizes: [{ name: 'M', chest: 0 }, { name: 'm', chest: 100 }], flat: ['sleeve'] })
  expect(unit.status).toBe(400)
  const text = JSON.stringify(unit.body)
  expect(text).toContain('Garment measurements:')
  expect(text).toContain('\\"shoulder\\" is not a measure')
  expect(text).toContain('must be above 0')
  expect(text).toContain('cannot be measured flat')
  expect((await prisma.product.findUniqueOrThrow({ where: { id: parent.id } })).fitGarment).toEqual(STORED)
})

it('null, an empty string and a table with no values clear the column to a database NULL', async () => {
  const { parent } = await family()
  for (const empty of [null, '', { measures: ['chest'], sizes: [{ name: 'M' }] }]) {
    await save(parent.id, STORED)
    expect((await save(parent.id, empty)).fitGarment).toBeNull()
  }
  const [{ isNull }] = await prisma.$queryRaw<Array<{ isNull: boolean }>>`SELECT "fitGarment" IS NULL AS "isNull" FROM "Product" WHERE id = ${parent.id}`
  expect(isNull).toBe(true)
})
