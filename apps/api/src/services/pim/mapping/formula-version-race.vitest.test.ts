import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { rbacHook } from '../../../lib/auth/rbac-hook.js'
const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
// External queues are outside this disposable database. The product writer and events stay real.
vi.mock('../../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('../../product-read-cache.service.js', () => ({ pickFaceImage: (images: any[]) => images?.[0]?.url ?? null, productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {} }))
import prisma from '../../../db.js'
import productRoutes from '../../../routes/products.routes.js'
import formulaRoutes from '../../../routes/cell-formula.routes.js'
import { auditLogService } from '../../audit-log.service.js'
import { getStudioSheet } from '../studio-sheet.service.js'
import { sheetCellStamp } from '@nexus/shared/sheet-stamp'

/**
 * Review of #614 (G4) — the version a formula route answers is the formula write's OWN, read inside its transaction.
 *
 * The first version read the row back after commit, after the `formula.set` audit row and after the cascade. A write by
 * someone else in that window was counted while `versionBefore` still equalled the version the sheet held, so the sheet
 * adopted it — and its next stamped save, at that version, was taken on the version alone and overwrote the other write,
 * which the sheet had never shown. Real routes, real PostgreSQL (PGlite).
 */
const app = Fastify()
const coordinate = { scope: 'master', market: 'IT', locale: 'it', fieldKey: 'manufacturer' }
beforeAll(async () => {
  await app.register(cookie); app.addHook('preHandler', rbacHook)
  await prisma.marketplace.create({ data: { id: 'fixture-market', channel: 'AMAZON', code: 'IT', name: 'Fixture Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await app.register(productRoutes, { prefix: '/api' }); await app.register(formulaRoutes, { prefix: '/api' }); await app.ready()
}, 60_000)
beforeEach(async () => {
  await prisma.auditLog.deleteMany(); await prisma.cellFormula.deleteMany(); await prisma.bulkOperation.deleteMany()
  await prisma.productTranslation.deleteMany(); await prisma.productEvent.deleteMany(); await prisma.channelListing.deleteMany(); await prisma.product.deleteMany()
  await prisma.product.create({ data: { id: 'one', sku: 'fixture-one', name: 'one jacket', basePrice: 10, brand: 'Nexus', manufacturer: 'Original' } })
})
afterAll(async () => { await app.close(); await fixture.database.close() }, 30_000)

const versionOf = async () => (await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).version
/** The sheet's rule (`apps/web/…/sheet/formulaWriteLine.ts` `formulaAdoptedVersion`, product branch). */
const adopted = (facts: any, held: number) => typeof facts.currentVersion === 'number' && typeof facts.versionBefore === 'number'
  && facts.currentVersion >= facts.versionBefore && facts.versionOf === 'product' && held === facts.versionBefore ? facts.currentVersion : held

describe('a write by someone else right after a formula save', { timeout: 30_000 }, () => {
  it('is not in the version the formula route answers, so the sheet\'s next stamped save of that field is refused, never written over it', async () => {
    // The sheet reads the row: its version, and the Brand cell it shows (its stamp).
    const sheet = await getStudioSheet({ productId: 'one', scope: 'master', market: 'IT', locale: 'it', canEditPrice: true } as never)
    const brandCell = (sheet.rows.find((r: any) => r.id === 'one') as any).values.brand
    expect(brandCell?.value).toBe('Nexus')
    const held = await versionOf()

    // Another tab writes Brand once the formula's own write has committed (when `formula.set` is audited).
    const audit = auditLogService.write.bind(auditLogService)
    let foreign: number | null = null
    const spy = vi.spyOn(auditLogService, 'write').mockImplementation(async (entry: any) => {
      if (entry?.action === 'formula.set' && foreign === null) {
        const other = await app.inject({ method: 'PATCH', url: '/api/products/bulk', payload: { expectedVersion: await versionOf(),
          changes: [{ id: 'one', field: 'brand', value: 'Foreign brand' }], marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] } })
        foreign = other.statusCode
      }
      return audit(entry)
    })
    let saved
    try {
      saved = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', payload: { ...coordinate, expr: 'upper("acme")' } })
    } finally { spy.mockRestore() }
    expect(foreign, 'the other write landed').toBe(200)
    expect(await versionOf()).toBe(held + 2)

    // The answer counts the formula's write alone.
    expect(saved.json(), saved.body).toMatchObject({ ok: true, versionOf: 'product', versionBefore: held, currentVersion: held + 1 })
    const next = adopted(saved.json(), held)
    expect(next).toBe(held + 1)

    // The sheet still shows Brand "Nexus"; the person types "Sheet brand" — a stamped save at the adopted version. The
    // version moved, so the door checks the stamp: Brand moved, refused with the stored value. Nothing is lost.
    const edit = await app.inject({ method: 'PATCH', url: '/api/products/bulk', payload: { expectedVersion: next,
      changes: [{ id: 'one', field: 'brand', value: 'Sheet brand', column: 'brand', expected: sheetCellStamp(brandCell) }],
      marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] } })
    expect(edit.statusCode, edit.body).toBe(409)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: 'one' } })).brand).toBe('Foreign brand')
  })

  it('without another write, the answered version is the row\'s, and the next save at it is taken', async () => {
    const held = await versionOf()
    const saved = await app.inject({ method: 'PUT', url: '/api/pim/formulas/product/one', payload: { ...coordinate, expr: 'upper("acme")' } })
    expect(saved.json(), saved.body).toMatchObject({ versionBefore: held, currentVersion: await versionOf() })
    const edit = await app.inject({ method: 'PATCH', url: '/api/products/bulk', payload: { expectedVersion: adopted(saved.json(), held),
      changes: [{ id: 'one', field: 'brand', value: 'Sheet brand' }], marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] } })
    expect(edit.statusCode, edit.body).toBe(200)
  })
})
