/**
 * `PATCH /api/products/:id` answers the version it WROTE (the product grid's inline cells, editing-correctness group 3).
 *
 * 🔴 WHAT THIS GUARDS. The grid's cells send their next write of a row at the version this PATCH answers
 * (`apps/web/src/app/products/_components/cellSave.ts`). The route answered the version of a read made AFTER its
 * commit: when someone else's write landed in between, the answer carried it, and the next cell passed over that write
 * unseen. A no-op (the same stock typed again) answered the version it read without checking If-Match, with the same
 * effect. Now the answer is the version this edit's own bump wrote, and a no-op with an older If-Match is a 409.
 *
 * The other write lands "right after ours" through the database client: just before the route's post-commit read.
 * Real PostgreSQL in-process (PGlite), the route through Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any, beforePostCommitRead: null as null | (() => Promise<void>) }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  const real = state.db.client
  const client = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop !== 'product') return typeof value === 'function' ? value.bind(target) : value
      return new Proxy(value, {
        get(model, method) {
          const fn = Reflect.get(model, method, model)
          if (method !== 'findUnique') return typeof fn === 'function' ? fn.bind(model) : fn
          return async (args: any) => {
            // The route's read after its commit selects sku and updatedAt: another writer commits just before it.
            if (state.beforePostCommitRead && args?.select?.sku && args?.select?.updatedAt) {
              const write = state.beforePostCommitRead
              state.beforePostCommitRead = null
              await write()
            }
            return fn.call(model, args)
          }
        },
      })
    },
  })
  return { default: client, prisma: client }
})
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../services/pim/readiness-index.service.js', async () => (await import('../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.mock('./saved-view-persistence.routes.js', () => ({ default: async () => {} }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const LEGACY = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(LEGACY, work)
let app: FastifyInstance

beforeAll(async () => {
  const { default: routes } = await import('./products-catalog.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    request.authUser = { id: 'operator' } as never
    Object.assign(request, { __rbacResolved: { isOwner: true, permissions: new Set<string>() } })
    withWorkspace(LEGACY, done)
  })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

const seed = (id: string) => scoped(async () => {
  await state.db.client.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10, totalStock: 0, brand: 'OLD', productType: 'ORIGINAL' } as never })
  return state.db.client.product.findUniqueOrThrow({ where: { id }, select: { version: true, totalStock: true } }) as Promise<{ version: number; totalStock: number }>
})
const row = (id: string) => scoped(() => state.db.client.product.findUniqueOrThrow({ where: { id }, select: { brand: true, productType: true, version: true } }))
const cell = (id: string, ifMatch: number, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/products/${id}`, headers: { 'if-match': String(ifMatch) }, payload })
/** Someone else's change of the row (another tab, the sheet, the Studio): it moves the version. */
const otherPersonSets = (id: string, data: Record<string, unknown>) => () => scoped(async () => {
  await state.db.client.product.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
})

describe('PATCH /api/products/:id answers the version it wrote', () => {
  it('🔴 another write lands right after ours: the grid\'s next cell of the row is a 409, never a write over it', async () => {
    const id = 'test-written-version-1'
    const shown = await seed(id)
    state.beforePostCommitRead = otherPersonSets(id, { productType: 'THEIRS' })
    const first = await cell(id, shown.version, { brand: 'MINE' })
    expect(first.statusCode, first.body).toBe(200)
    // The grid sends its next cell at the newer of what the row shows and what this PATCH answered (cellSave.ts).
    const next = await cell(id, Math.max(shown.version, first.json().version), { productType: 'MINE' })
    expect(next.statusCode, next.body).toBe(409)
    expect(await row(id)).toMatchObject({ brand: 'MINE', productType: 'THEIRS' })
    expect(first.json().version).toBe(shown.version + 1)
  })

  it('🔴 a no-op (the same stock typed again) with an older If-Match is a 409, not a version that was never seen', async () => {
    const id = 'test-written-version-2'
    const shown = await seed(id)
    await otherPersonSets(id, { brand: 'THEIRS' })() // this tab has not read it again
    const noop = await cell(id, shown.version, { totalStock: shown.totalStock })
    expect(noop.statusCode, noop.body).toBe(409)
    expect(noop.json()).toMatchObject({ code: 'VERSION_CONFLICT', expectedVersion: shown.version, currentVersion: shown.version + 1 })
    expect((await row(id)).brand).toBe('THEIRS')
  })

  it('a no-op at the version on file answers it as before', async () => {
    const id = 'test-written-version-3'
    const shown = await seed(id)
    const noop = await cell(id, shown.version, { totalStock: shown.totalStock })
    expect(noop.statusCode, noop.body).toBe(200)
    expect(noop.json()).toMatchObject({ id, version: shown.version, noop: true })
  })

  it('no other write: two cells of one row, each at the version the one before answered, both land', async () => {
    const id = 'test-written-version-4'
    const shown = await seed(id)
    const first = await cell(id, shown.version, { brand: 'MINE' })
    expect(first.statusCode, first.body).toBe(200)
    const second = await cell(id, first.json().version, { productType: 'MINE' })
    expect(second.statusCode, second.body).toBe(200)
    expect(await row(id)).toEqual({ brand: 'MINE', productType: 'MINE', version: shown.version + 2 })
    expect(second.json().version).toBe(shown.version + 2)
  })
})
