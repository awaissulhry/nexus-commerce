import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A-45 (Step 4.3 #4) — the readiness index names its REQUIRED-AND-EMPTY fields.
 *
 * The completeness card says "18 of 22 required · these 4 are empty". The counts come from the row's
 * `completeness.required` (`readinessFromSheet`); the names used to be thrown away before storage, and
 * `missing[]` held only readiness ISSUES — prose, and not the same set. So:
 *  - pure: issues keep today's exact shape; a required-empty field that already has an issue is flagged
 *    IN PLACE (one field, one entry — LX.F P1-4); one no validator named gets its own entry;
 *  - the real writer on real (disposable) PostgreSQL: on EVERY stored row the flagged count equals
 *    `requiredTotal − requiredFilled` — with a positive control, a row where that is > 0;
 *  - the reader relays each product's own counts and age.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => { const { formulaDatabase } = await import('../../test-support/formula-database.js'); state.db = await formulaDatabase(); return { default: state.db.client } })
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
// Production runs with business profiles ON: every real-database step runs inside a business, as the real callers do.
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
import { readinessMissingEntries, REQUIRED_EMPTY_REASON, type MissingReadinessField } from './readiness-model.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'
import { getProductReadiness } from './scope-readiness.service.js'

const row = (issues: Array<{ key: string; label: string; message: string; kind?: string }>, missing: Array<{ key: string; label: string }>) => ({
  id: 'p1',
  readiness: { state: 'errors', issues: issues.map(i => ({ ...i, severity: 'error' as const })) },
  completeness: { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: missing.length, missing }, byGroup: [] },
}) as any

describe('readinessMissingEntries — pure', () => {
  it('A1: a row with issues only keeps today\'s exact entries (no flag anywhere)', () => {
    const entries = readinessMissingEntries(row([{ key: 'color', label: 'Colour', message: 'Colour is not one of the allowed values', kind: 'attribute-unbound' }], []))
    expect(entries).toEqual([{ productId: 'p1', field: 'color', label: 'Colour', reason: 'Colour is not one of the allowed values', kind: 'attribute-unbound' }])
  })

  it('A2: a required-empty field that already has an issue is ONE entry, flagged in place, its reason and kind kept', () => {
    const entries = readinessMissingEntries(row([{ key: 'name', label: 'Product title', message: 'de content is missing; showing it fallback.', kind: 'language-fallback' }], [{ key: 'name', label: 'Product title' }]))
    expect(entries).toEqual([{ productId: 'p1', field: 'name', label: 'Product title', reason: 'de content is missing; showing it fallback.', kind: 'language-fallback', requiredEmpty: true }])
  })

  it('A3: a required-empty field no validator named gets its own entry, with no kind', () => {
    const entries = readinessMissingEntries(row([], [{ key: 'gtin', label: 'GTIN' }]))
    expect(entries).toEqual([{ productId: 'p1', field: 'gtin', label: 'GTIN', reason: REQUIRED_EMPTY_REASON, requiredEmpty: true }])
  })

  it('A2b: two issues on one required-empty field — only the first is flagged, never counted twice', () => {
    const entries = readinessMissingEntries(row([
      { key: 'brand', label: 'Brand', message: 'Brand is required by Amazon · IT' },
      { key: 'brand', label: 'Brand', message: 'Brand is too long' },
    ], [{ key: 'brand', label: 'Brand' }]))
    expect(entries.filter(e => e.requiredEmpty)).toHaveLength(1)
    expect(entries).toHaveLength(2)
  })
})

beforeAll(() => scoped(async () => {
  // No product type: on Amazon·DE the one required field (`productType`) is EMPTY on both products, and three
  // issues already name it — the flag-in-place case on real data, the positive control for the equality.
  // (Measured first, 2026-09-24: an empty child title inherits the parent's, and an Italian-only title counts as
  // FILLED on the German shared row — see A-45 phase 2's finding — so neither is a control.)
  await prisma.product.create({ data: { id: 'rm-parent', sku: 'RM-PARENT', name: 'Titolo italiano', basePrice: 10, isParent: true } })
  await prisma.product.create({ data: { id: 'rm-child', sku: 'RM-CHILD', name: 'Figlio', basePrice: 10, parentId: 'rm-parent' } })
  await prisma.channelConnection.create({ data: { id: 'rm-amazon', channelType: 'AMAZON', isActive: true } as any })
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
  for (const productId of ['rm-parent', 'rm-child']) await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', channelMarket: 'AMAZON_DE', marketplace: 'DE', region: 'EU', channelConnectionId: 'rm-amazon' } as any })
}), 30_000)
afterAll(async () => { await state.db?.close() })

describe('the one writer, on real disposable PostgreSQL', () => {
  it('A4: on EVERY stored row, the flagged entries = requiredTotal − requiredFilled; the Amazon·DE rows are the positive control', () => scoped(async () => {
    expect(await reconcileFamilyReadiness('rm-parent')).toBeGreaterThan(0)
    const rows = await prisma.readinessIndex.findMany({ where: { productId: { in: ['rm-parent', 'rm-child'] } } })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const flagged = (r.missing as unknown as MissingReadinessField[]).filter(e => e.requiredEmpty === true)
      expect({ id: `${r.productId}·${r.coordinateKey}·${r.language}`, flagged: flagged.length }).toEqual({ id: `${r.productId}·${r.coordinateKey}·${r.language}`, flagged: r.requiredTotal - r.requiredFilled })
    }
    // Positive control: a row where something required IS empty, so the equality above is not 0 = 0 everywhere.
    const amazon = rows.filter(r => r.channel === 'AMAZON' && r.market === 'DE')
    expect(amazon).toHaveLength(2)
    for (const r of amazon) {
      expect(r.requiredTotal - r.requiredFilled).toBeGreaterThan(0)
      const entries = (r.missing as unknown as MissingReadinessField[]).filter(e => e.field === 'productType')
      expect(entries.length).toBeGreaterThan(1)                          // several issues name the field…
      expect(entries.filter(e => e.requiredEmpty)).toHaveLength(1)       // …it is flagged once: one field, one flag
      expect(entries[0].requiredEmpty).toBe(true)                        // on its first entry, in place
    }
    // A filled field is never flagged: the shared Italian title.
    const sharedIt = rows.find(r => r.productId === 'rm-parent' && r.channel === null && r.language === 'it')!
    expect(sharedIt.requiredFilled).toBe(sharedIt.requiredTotal)
    expect((sharedIt.missing as unknown as MissingReadinessField[]).some(e => e.requiredEmpty)).toBe(false)
  }), 60_000)

  it('A5: the reader relays each product\'s own required counts and age; a product with no row stays absent', () => scoped(async () => {
    const readiness = await getProductReadiness({ productId: 'rm-parent', market: 'DE', locale: 'de' })
    const shared = readiness.matrix.find(e => e.channel === 'AMAZON' && e.language === 'de')!
    const stored = await prisma.readinessIndex.findFirstOrThrow({ where: { productId: 'rm-child', channel: 'AMAZON', language: 'de' } })
    expect(stored.requiredTotal - stored.requiredFilled).toBeGreaterThan(0)
    expect(shared.byProduct['rm-child']).toMatchObject({ required: { filled: stored.requiredFilled, total: stored.requiredTotal }, computedAt: stored.computedAt.toISOString() })
    expect(shared.byProduct['no-such-product']).toBeUndefined()
  }))
})
