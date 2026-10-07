/**
 * Step 3 (cases, Owner D2 = B) — `PUT /api/stock/case-packs`, the Matrix Case pop-up's save.
 *
 *   validation  every refusal is a 400 by code before anything is written (ids, too many, a value not named, the
 *               shared `packProblem` sentences).
 *   save        absolute values, numbers stored as the columns keep them; the same save again is a noop; an Amazon EU
 *               box-limit warning never refuses.
 *   family      one call writes every named variation; an unknown id answers for itself, the others still save.
 *   409         a units-per-case change while sealed cases are in stock: 409 SEALED_CASES with the list, nothing
 *               written; the same call with `openSealedCases` opens them (units unchanged).
 *   permission  the real RBAC gate (enforce): `inventory.view` alone is refused, `inventory.adjust` may save.
 *
 * Real SQL (PGlite with the production schema), the real route plugin, the real case service (one spy lets a test make
 * it fail on purpose).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CASE_COPY } from '@nexus/shared/stock-cases'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../lib/auth/audit.js', () => ({ writeAuthAudit: vi.fn(async () => undefined) }))
/** The real service, behind one spy a test can point elsewhere for a single call. */
vi.mock('../services/stock/stock-cases.service.js', async (original) => {
  const real = await original<typeof import('../services/stock/stock-cases.service.js')>()
  return { ...real, setCasePacks: vi.fn((...args: Parameters<typeof real.setCasePacks>) => real.setCasePacks(...args)) }
})

import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { rbacHook } from '../lib/auth/rbac-hook.js'
import { CaseCountError, setCasePacks } from '../services/stock/stock-cases.service.js'
import { MAX_CASE_PACK_PRODUCTS, parseCasePackBody } from './stock-cases.routes.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

type Json = any
const ids = { main: '', fba: '', parent: '', red: '', blue: '' }
const ADJUSTER = [F.inventoryView, F.inventoryAdjust].join(',')
let app: FastifyInstance

/** Every request is a signed-in person whose permissions are named per request (`x-test-permissions`), judged by the REAL gate. */
async function put(payload: unknown, permissions = ADJUSTER): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'PUT', url: '/api/stock/case-packs', headers: { 'x-test-permissions': permissions }, payload: payload as never })
  return { status: response.statusCode, body: response.json() }
}
const PACK = { unitsPerCase: 12, caseLengthCm: 60.5, caseWidthCm: 40, caseHeightCm: 35.2, caseWeightKg: 14.55, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON' }
const NONE = { unitsPerCase: null, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: null }
const packRow = (productId: string) => inside(() => database.client.productPackage.findFirst({ where: { productId } }))
const caseRows = (productId: string) => inside(() => database.client.stockCaseCount.findMany({ where: { stockLevel: { productId } }, select: { cases: true } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.main = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse' } })).id
    ids.fba = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Amazon FBA' } })).id
    ids.parent = (await db.product.create({ data: { sku: 'TEST-SKU-CP-PARENT', name: 'Case parent', basePrice: '9.00', isParent: true } })).id
    ids.red = (await db.product.create({ data: { sku: 'TEST-SKU-CP-RED', name: 'Red', basePrice: '9.00', parentId: ids.parent, totalStock: 30 } })).id
    ids.blue = (await db.product.create({ data: { sku: 'TEST-SKU-CP-BLUE', name: 'Blue', basePrice: '9.00', parentId: ids.parent } })).id
    await db.stockLevel.create({ data: { productId: ids.red, locationId: ids.main, quantity: 30, reserved: 0, available: 30 } })
  })
  app = Fastify()
  app.addHook('onRequest', async (request) => {
    const named = request.headers['x-test-permissions']
    request.__sessionLoaded = true
    request.authUser = { id: 'u-case', email: 'case@example.test' } as never
    request.__rbacResolved = { isOwner: false, permissions: new Set(typeof named === 'string' ? named.split(',') : []) } as never
  })
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  app.addHook('preHandler', rbacHook)
  await app.register((await import('./stock-cases.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

beforeEach(() => { vi.stubEnv('NEXUS_RBAC_MODE', 'enforce') })
afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
})

describe('PUT /api/stock/case-packs', () => {
  it('refuses a malformed body by code, before anything is written', async () => {
    expect(await put({ ...PACK })).toEqual({ status: 400, body: { ok: false, code: 'MISSING_FIELDS', error: '`productIds` must be a list of 1 or more product ids' } })
    expect((await put({ ...PACK, productIds: [] })).body.code).toBe('MISSING_FIELDS')
    expect((await put({ ...PACK, productIds: [ids.red, 7] })).body.code).toBe('MISSING_FIELDS')
    const many = Array.from({ length: MAX_CASE_PACK_PRODUCTS + 1 }, (_, i) => `p-${i}`)
    expect(await put({ ...PACK, productIds: many })).toEqual({ status: 400, body: { ok: false, code: 'TOO_MANY', error: 'At most 200 products per save' } })
    const { caseWeightKg: _w, fbaLabelOwner: _l, ...partial } = PACK
    expect(await put({ ...partial, productIds: [ids.red] })).toEqual({ status: 400, body: { ok: false, code: 'MISSING_FIELDS', error: 'Name every value (null clears it); missing: caseWeightKg, fbaLabelOwner' } })
    const refusal = async (change: Record<string, unknown>) => (await put({ ...PACK, ...change, productIds: [ids.red] }))
    expect(await refusal({ unitsPerCase: 0 })).toEqual({ status: 400, body: { ok: false, code: 'INVALID_PACK', error: 'Units per case must be a whole number from 1 to 10000' } })
    expect((await refusal({ unitsPerCase: 2.5 })).body.error).toBe('Units per case must be a whole number from 1 to 10000')
    expect((await refusal({ caseLengthCm: 301 })).body.error).toBe('Case length must be more than 0 and at most 300 cm')
    expect((await refusal({ caseHeightCm: 'tall' })).body.error).toBe('Case height must be more than 0 and at most 300 cm')
    expect((await refusal({ caseWeightKg: 0 })).body.error).toBe('Case weight must be more than 0 and at most 1000 kg')
    expect((await refusal({ fbaPrepOwner: 'BOTH' })).body.error).toBe('Prep by must be Amazon or Seller')
    expect((await refusal({ fbaLabelOwner: 'seller' })).body.error).toBe('Labels by must be Amazon or Seller')
    expect(vi.mocked(setCasePacks)).not.toHaveBeenCalled()
    expect(await packRow(ids.red)).toBeNull()
  })

  it('parseCasePackBody: numeric strings read as numbers, ids are de-duplicated, openSealedCases only when true', () => {
    expect(parseCasePackBody({ ...NONE, unitsPerCase: ' 12 ', caseWeightKg: '14.5', productIds: [' a ', 'a', 'b'], openSealedCases: 'yes' }))
      .toEqual({ ok: true, productIds: ['a', 'b'], values: { ...NONE, unitsPerCase: 12, caseWeightKg: 14.5 }, openSealedCases: false })
  })

  it('saves absolute values (numbers stored as the columns keep them); the same save again is a noop; a box-limit warning never refuses', async () => {
    const saved = await put({ ...PACK, productIds: [ids.red] })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ ok: true, results: [{ productId: ids.red, ok: true }], warning: null })
    expect(vi.mocked(setCasePacks)).toHaveBeenCalledWith(expect.objectContaining({ productIds: [ids.red], actor: 'case@example.test', userId: 'u-case', openSealedCases: false }))
    const row = await packRow(ids.red)
    expect([row?.unitsPerCase, Number(row?.caseLengthCm), Number(row?.caseWidthCm), Number(row?.caseHeightCm), Number(row?.caseWeightKg), row?.fbaPrepOwner, row?.fbaLabelOwner])
      .toEqual([12, 60.5, 40, 35.2, 14.55, 'SELLER', 'AMAZON'])
    expect((await put({ ...PACK, productIds: [ids.red] })).body).toMatchObject({ ok: true, results: [{ productId: ids.red, ok: true, noop: true }] })
    const big = await put({ ...PACK, caseLengthCm: 70, productIds: [ids.blue] })
    expect(big).toMatchObject({ status: 200, body: { ok: true, warning: CASE_COPY.boxLimit } })
    // Owners may stay "not set".
    expect((await put({ ...NONE, unitsPerCase: 6, productIds: [ids.blue] })).body).toMatchObject({ ok: true, warning: null })
    expect(await packRow(ids.blue)).toMatchObject({ unitsPerCase: 6, caseLengthCm: null, fbaPrepOwner: null, fbaLabelOwner: null })
  })

  it('a family: one call writes every named variation; an unknown id answers for itself', async () => {
    const out = await put({ ...PACK, unitsPerCase: 12, productIds: [ids.red, ids.blue, 'nope'] })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(false)
    expect(out.body.results).toEqual([
      expect.objectContaining({ productId: ids.red, ok: true }),
      expect.objectContaining({ productId: ids.blue, ok: true }),
      { productId: 'nope', ok: false, error: 'Product not found' },
    ])
    expect((await packRow(ids.blue))?.unitsPerCase).toBe(12)
    expect((await packRow(ids.red))?.unitsPerCase).toBe(12)
  })

  it('409 SEALED_CASES: a size change with sealed cases in stock is refused with the list; confirmed, it opens them (units unchanged)', async () => {
    const { adjustOneLocation } = await import('../services/stock/location-adjust.service.js')
    expect(await inside(() => adjustOneLocation({ productId: ids.red, locationId: ids.main, cases: 2, reason: 'INVENTORY_COUNT', actor: 'test' }))).toMatchObject({ cases: 2, quantity: 30 })
    const refused = await put({ ...PACK, unitsPerCase: 6, productIds: [ids.red, ids.blue] })
    expect(refused).toEqual({ status: 409, body: {
      ok: false, code: 'SEALED_CASES', error: CASE_COPY.sealedOpen(2, 'TEST-MAIN'),
      sealed: [{ productId: ids.red, sku: 'TEST-SKU-CP-RED', locationCode: 'TEST-MAIN', cases: 2 }],
    } })
    expect((await packRow(ids.red))?.unitsPerCase).toBe(12)
    expect((await packRow(ids.blue))?.unitsPerCase).toBe(12)
    expect(await caseRows(ids.red)).toEqual([{ cases: 2 }])

    const opened = await put({ ...PACK, unitsPerCase: 6, productIds: [ids.red, ids.blue], openSealedCases: true })
    expect(opened.status).toBe(200)
    expect(opened.body.results[0]).toMatchObject({ productId: ids.red, ok: true, opened: [{ locationCode: 'TEST-MAIN', cases: 2 }] })
    expect((await packRow(ids.red))?.unitsPerCase).toBe(6)
    expect((await packRow(ids.blue))?.unitsPerCase).toBe(6)
    expect((await caseRows(ids.red)).every((r: Json) => r.cases === 0)).toBe(true)
    expect((await inside(() => database.client.stockLevel.findFirst({ where: { productId: ids.red, locationId: ids.main } })))?.quantity).toBe(30)
  })

  it('clearing every value removes the case pack (null clears)', async () => {
    expect((await put({ ...NONE, productIds: [ids.blue] })).body).toMatchObject({ ok: true, results: [{ productId: ids.blue, ok: true }] })
    expect(await packRow(ids.blue)).toBeNull()
  })

  it('the permission: `inventory.view` alone is refused by the gate, nothing written; the route maps to inventory.adjust', async () => {
    expect(permissionForRoute('PUT', '/api/stock/case-packs')).toBe(F.inventoryAdjust)
    const before = await packRow(ids.red)
    expect(await put({ ...PACK, unitsPerCase: 4, productIds: [ids.red] }, F.inventoryView)).toEqual({ status: 403, body: { error: 'Access denied', code: 'forbidden', required: F.inventoryAdjust } })
    expect(await packRow(ids.red)).toEqual(before)
  })

  it('a refusal the service throws keeps its code (400); an unexpected failure is a 500', async () => {
    vi.mocked(setCasePacks).mockRejectedValueOnce(new CaseCountError('NO_CASE_SIZE', CASE_COPY.noSize))
    expect(await put({ ...PACK, productIds: [ids.red] })).toEqual({ status: 400, body: { ok: false, code: 'NO_CASE_SIZE', error: CASE_COPY.noSize } })
    vi.mocked(setCasePacks).mockRejectedValueOnce(new Error('database went away'))
    expect(await put({ ...PACK, productIds: [ids.red] })).toEqual({ status: 500, body: { ok: false, code: 'FAILED', error: 'database went away' } })
  })
})
