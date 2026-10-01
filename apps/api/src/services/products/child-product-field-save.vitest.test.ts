/**
 * 2026-10-01 — a variation's own Product field saves with its column's real type.
 *
 * The final local browser round's supplemental editor case saved Impact protectors on a variation: the unit answered 500
 * "Raw query failed. Code: 22P02 invalid input syntax for type json". The child branch of `applyProductBulkEdits` wrote
 * the value through raw SQL, so a JS array reached the `Json?` column as a Postgres array literal. The parent branch used
 * the model update and worked. A clear must also reach a Json column as a database NULL.
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

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let serial = 0
const PROTECTORS = [{ zone: 'shoulder', standard: 'EN 1621-1', level: '2' }, { zone: 'back', standard: 'EN 1621-2', level: '1' }]

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
  const parent = await prisma.product.create({ data: { sku: `E2E-CHILD-FIELD-${n}`, name: 'Child field fixture', basePrice: 10, isParent: true } })
  const child = await prisma.product.create({ data: { sku: `E2E-CHILD-FIELD-${n}-A`, name: 'Child A', basePrice: 10, parentId: parent.id,
    cascadedFields: ['impactProtectors'], impactProtectors: [{ zone: 'elbow', standard: 'EN 1621-1', level: '1' }] } })
  return { parent, child }
}

async function save(id: string, value: unknown) {
  const current = await prisma.product.findUniqueOrThrow({ where: { id } })
  const response = await app.inject({ method: 'POST', url: '/api/products/bulk-save', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({
    operationId: `child-field-${++serial}`, units: [{ key: id, expectedVersion: current.version, changes: [{ id, field: 'impactProtectors', value }] }],
  }) })
  expect(response.statusCode, response.body).toBe(200)
  const unit = response.json().units[0]
  expect(unit.status, JSON.stringify(unit.body)).toBe(200)
  return prisma.product.findUniqueOrThrow({ where: { id } })
}

it('saves Impact protectors on a variation as JSON and clears its inherited mark', () => scoped(async () => {
  const { child } = await family()
  const stored = await save(child.id, PROTECTORS)
  expect(stored.impactProtectors).toEqual(PROTECTORS)
  expect(stored.cascadedFields).not.toContain('impactProtectors')
}))

it('clears Impact protectors on a variation to a database NULL', () => scoped(async () => {
  const { child } = await family()
  const stored = await save(child.id, null)
  expect(stored.impactProtectors).toBeNull()
  expect(stored.cascadedFields).not.toContain('impactProtectors')
}))

it('sets and clears Impact protectors on a parent the same way', () => scoped(async () => {
  const { parent } = await family()
  expect((await save(parent.id, PROTECTORS)).impactProtectors).toEqual(PROTECTORS)
  expect((await save(parent.id, null)).impactProtectors).toBeNull()
}))
