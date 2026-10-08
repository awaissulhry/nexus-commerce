/**
 * Step 3 (cases, Owner D2 = B; several case sizes per SKU, Owner 2026-10-08) — `PUT /api/stock/case-packs`, the Matrix
 * Case pop-up's save.
 *
 *   validation  every refusal is a 400 by code before anything is written (ids, too many, nothing named, a size value
 *               not named, the shared `sizesProblem` / owner sentences).
 *   save        a size list replaces the SKU's sizes (numbers stored as the columns keep them); the same save again is a
 *               noop; an owner alone saves alone; an Amazon EU box-limit warning never refuses.
 *   family      one call writes every named variation; an unknown id answers for itself, the others still save.
 *   409         removing a size with sealed cases in stock: 409 SEALED_CASES with the list, nothing written; the same
 *               call with `openSealedCases` opens them (units unchanged).
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
const SIZE = { unitsPerCase: 12, caseLengthCm: 60.5, caseWidthCm: 40, caseHeightCm: 35.2, caseWeightKg: 14.55 }
const NO_DIMS = { caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null }
const PACK = { sizes: [SIZE], fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON' }
const ownersRow = (productId: string) => inside(() => database.client.productPackage.findFirst({ where: { productId } }))
const sizeRows = (productId: string) => inside(() => database.client.productCaseSize.findMany({ where: { productId }, orderBy: { unitsPerCase: 'desc' } }))
const unitsOf = async (productId: string) => (await sizeRows(productId)).map((row: Json) => row.unitsPerCase)
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
    expect(await put({ productIds: [ids.red] })).toEqual({ status: 400, body: { ok: false, code: 'MISSING_FIELDS', error: 'Name the case sizes or an owner to save' } })
    const { caseWeightKg: _w, ...partial } = SIZE
    expect(await put({ sizes: [partial], productIds: [ids.red] })).toEqual({ status: 400, body: { ok: false, code: 'MISSING_FIELDS', error: 'Name every value of a case size (null clears it); missing: caseWeightKg' } })
    expect((await put({ sizes: 12, productIds: [ids.red] })).body).toEqual({ ok: false, code: 'INVALID_PACK', error: '`sizes` must be a list' })
    const refusal = async (change: Record<string, unknown>) => (await put({ ...PACK, sizes: [{ ...SIZE, ...change }], productIds: [ids.red] }))
    expect(await refusal({ unitsPerCase: 0 })).toEqual({ status: 400, body: { ok: false, code: 'INVALID_PACK', error: 'Units per case must be a whole number from 1 to 10000' } })
    expect((await refusal({ unitsPerCase: 2.5 })).body.error).toBe('Units per case must be a whole number from 1 to 10000')
    expect((await refusal({ unitsPerCase: null })).body.error).toBe('Units per case must be a whole number from 1 to 10000')
    expect((await refusal({ caseLengthCm: 301 })).body.error).toBe('Case length must be more than 0 and at most 300 cm')
    expect((await refusal({ caseHeightCm: 'tall' })).body.error).toBe('Case height must be more than 0 and at most 300 cm')
    expect((await refusal({ caseWeightKg: 0 })).body.error).toBe('Case weight must be more than 0 and at most 1000 kg')
    expect((await put({ sizes: [SIZE, SIZE], productIds: [ids.red] })).body.error).toBe(CASE_COPY.sameSize(12))
    expect((await put({ sizes: [1, 2, 3, 4, 5, 6].map((unitsPerCase) => ({ ...SIZE, unitsPerCase })), productIds: [ids.red] })).body.error).toBe(CASE_COPY.tooManySizes)
    expect((await put({ ...PACK, fbaPrepOwner: 'BOTH', productIds: [ids.red] })).body.error).toBe('Prep by must be Amazon or Seller')
    expect((await put({ ...PACK, fbaLabelOwner: 'seller', productIds: [ids.red] })).body.error).toBe('Labels by must be Amazon or Seller')
    expect(vi.mocked(setCasePacks)).not.toHaveBeenCalled()
    expect(await sizeRows(ids.red)).toEqual([])
  })

  it('parseCasePackBody: numeric strings read as numbers, ids are de-duplicated, an absent owner is kept, openSealedCases only when true', () => {
    expect(parseCasePackBody({ sizes: [{ ...NO_DIMS, unitsPerCase: ' 12 ', caseWeightKg: '14.5' }], fbaLabelOwner: null, productIds: [' a ', 'a', 'b'], openSealedCases: 'yes' }))
      .toEqual({ ok: true, productIds: ['a', 'b'], sizes: [{ ...NO_DIMS, unitsPerCase: 12, caseWeightKg: 14.5 }], fbaLabelOwner: null, openSealedCases: false })
    expect(parseCasePackBody({ fbaPrepOwner: 'AMAZON', productIds: ['a'] })).toEqual({ ok: true, productIds: ['a'], fbaPrepOwner: 'AMAZON', openSealedCases: false })
  })

  it('saves the size list (numbers stored as the columns keep them); the same save again is a noop; a box-limit warning never refuses; owners save alone', async () => {
    const saved = await put({ ...PACK, productIds: [ids.red] })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ ok: true, results: [{ productId: ids.red, ok: true }], warning: null })
    expect(vi.mocked(setCasePacks)).toHaveBeenCalledWith(expect.objectContaining({ productIds: [ids.red], actor: 'case@example.test', userId: 'u-case', openSealedCases: false }))
    const [row] = await sizeRows(ids.red)
    expect([row?.unitsPerCase, Number(row?.caseLengthCm), Number(row?.caseWidthCm), Number(row?.caseHeightCm), Number(row?.caseWeightKg)]).toEqual([12, 60.5, 40, 35.2, 14.55])
    expect(await ownersRow(ids.red)).toMatchObject({ fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON' })
    expect((await put({ ...PACK, productIds: [ids.red] })).body).toMatchObject({ ok: true, results: [{ productId: ids.red, ok: true, noop: true }] })
    const big = await put({ sizes: [{ ...SIZE, caseLengthCm: 70 }], productIds: [ids.blue] })
    expect(big).toMatchObject({ status: 200, body: { ok: true, warning: CASE_COPY.boxLimit } })
    // A second size; owners may stay "not set".
    expect((await put({ sizes: [{ ...NO_DIMS, unitsPerCase: 6 }, { ...SIZE, caseLengthCm: 70 }], productIds: [ids.blue] })).body).toMatchObject({ ok: true })
    expect(await unitsOf(ids.blue)).toEqual([12, 6])
    expect(await ownersRow(ids.blue)).toBeNull()
    // An owner alone keeps the sizes.
    expect((await put({ fbaPrepOwner: 'AMAZON', productIds: [ids.blue] })).body).toMatchObject({ ok: true, warning: null })
    expect(await ownersRow(ids.blue)).toMatchObject({ fbaPrepOwner: 'AMAZON', fbaLabelOwner: null })
    expect(await unitsOf(ids.blue)).toEqual([12, 6])
  })

  it('a family: one call writes every named variation; an unknown id answers for itself', async () => {
    const out = await put({ sizes: [SIZE], productIds: [ids.red, ids.blue, 'nope'] })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(false)
    expect(out.body.results).toEqual([
      expect.objectContaining({ productId: ids.red, ok: true }),
      expect.objectContaining({ productId: ids.blue, ok: true }),
      { productId: 'nope', ok: false, error: 'Product not found' },
    ])
    expect(await unitsOf(ids.blue)).toEqual([12])
    expect(await unitsOf(ids.red)).toEqual([12])
  })

  it('409 SEALED_CASES: removing a size with sealed cases in stock is refused with the list; confirmed, it opens them (units unchanged)', async () => {
    const { adjustOneLocation } = await import('../services/stock/location-adjust.service.js')
    expect(await inside(() => adjustOneLocation({ productId: ids.red, locationId: ids.main, cases: [{ unitsPerCase: 12, cases: 2 }], reason: 'INVENTORY_COUNT', actor: 'test' })))
      .toMatchObject({ cases: [{ unitsPerCase: 12, cases: 2 }], quantity: 30 })
    const refused = await put({ sizes: [{ ...SIZE, unitsPerCase: 6 }], productIds: [ids.red, ids.blue] })
    expect(refused).toEqual({ status: 409, body: {
      ok: false, code: 'SEALED_CASES', error: CASE_COPY.sealedOpen(2, 'TEST-MAIN'),
      sealed: [{ productId: ids.red, sku: 'TEST-SKU-CP-RED', locationCode: 'TEST-MAIN', unitsPerCase: 12, cases: 2 }],
    } })
    expect(await unitsOf(ids.red)).toEqual([12])
    expect(await unitsOf(ids.blue)).toEqual([12])
    expect(await caseRows(ids.red)).toEqual([{ cases: 2 }])

    const opened = await put({ sizes: [{ ...SIZE, unitsPerCase: 6 }], productIds: [ids.red, ids.blue], openSealedCases: true })
    expect(opened.status).toBe(200)
    expect(opened.body.results[0]).toMatchObject({ productId: ids.red, ok: true, opened: [{ locationCode: 'TEST-MAIN', unitsPerCase: 12, cases: 2 }] })
    expect(await unitsOf(ids.red)).toEqual([6])
    expect(await unitsOf(ids.blue)).toEqual([6])
    expect(await caseRows(ids.red)).toEqual([])
    expect((await inside(() => database.client.stockLevel.findFirst({ where: { productId: ids.red, locationId: ids.main } })))?.quantity).toBe(30)
  })

  it('an empty size list removes the sizes; null owners clear the owners row', async () => {
    expect((await put({ sizes: [], fbaPrepOwner: null, fbaLabelOwner: null, productIds: [ids.blue] })).body).toMatchObject({ ok: true, results: [{ productId: ids.blue, ok: true }] })
    expect(await sizeRows(ids.blue)).toEqual([])
    expect(await ownersRow(ids.blue)).toBeNull()
  })

  it('the permission: `inventory.view` alone is refused by the gate, nothing written; the route maps to inventory.adjust', async () => {
    expect(permissionForRoute('PUT', '/api/stock/case-packs')).toBe(F.inventoryAdjust)
    const before = await sizeRows(ids.red)
    expect(await put({ sizes: [{ ...SIZE, unitsPerCase: 4 }], productIds: [ids.red] }, F.inventoryView)).toEqual({ status: 403, body: { error: 'Access denied', code: 'forbidden', required: F.inventoryAdjust } })
    expect(await sizeRows(ids.red)).toEqual(before)
  })

  it('a refusal the service throws keeps its code (400); an unexpected failure is a 500', async () => {
    vi.mocked(setCasePacks).mockRejectedValueOnce(new CaseCountError('NO_CASE_SIZE', CASE_COPY.noSize))
    expect(await put({ ...PACK, productIds: [ids.red] })).toEqual({ status: 400, body: { ok: false, code: 'NO_CASE_SIZE', error: CASE_COPY.noSize } })
    vi.mocked(setCasePacks).mockRejectedValueOnce(new Error('database went away'))
    expect(await put({ ...PACK, productIds: [ids.red] })).toEqual({ status: 500, body: { ok: false, code: 'FAILED', error: 'database went away' } })
  })
})
