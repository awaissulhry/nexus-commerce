import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A-50 (R-64) — readiness must not count a source-language FALLBACK as filled.
 *
 * `completenessFor` nulled an untranslated value only when the cell carried the LEGACY `requestedLocale`. The studio's cells
 * carry only the §3 pair (`language`, `requested`), so on the shared German row an Italian-only title was stored as
 * "1 of 1 required filled" while the validator on the same row said the German title was missing. The rule is ONE function
 * (`translationMissing`); this pins that `completenessFor` feeds it the same fields the validator does:
 *  - pure: the studio's §3 cells, the source language, region tags, and the master sheet's legacy cells (unchanged);
 *  - the ONE writer on real disposable PostgreSQL: the shared German row counts the Italian-only title as EMPTY, flags it,
 *    and agrees with the validator's own issue on that field; the shared Italian row stays filled; A-45's invariant holds.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => { const { formulaDatabase } = await import('../../test-support/formula-database.js'); state.db = await formulaDatabase(); return { default: state.db.client } })
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { completenessFor } from './sheet-rows.service.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'
import type { MissingReadinessField } from './readiness-model.js'

// Production runs with business profiles ON: every real-database step runs inside a business, as the real callers do.
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const nameColumn = { key: 'name', label: 'Product title', kind: 'text', group: 'Content', requiredBy: ['Master'] } as any
const required = (cell: Record<string, unknown>) =>
  completenessFor([nameColumn], { isParent: true, productType: null }, { name: { source: 'master', inheritedFrom: null, inherited: false, ...cell } as any }).required

describe('completenessFor — the untranslated rule, pure', () => {
  it('P1: a studio cell showing the Italian text on a German request is NOT filled', () => {
    const r = required({ value: 'Titolo italiano', language: 'it', requested: 'de' })
    expect(r).toMatchObject({ filled: 0, total: 1 })
    expect(r.missing.map(m => m.key)).toEqual(['name'])
  })
  it('P2: a German title on a German request is filled', () => {
    expect(required({ value: 'Deutscher Titel', language: 'de', requested: 'de' })).toMatchObject({ filled: 1, total: 1 })
  })
  it('P3: the source language itself is filled', () => {
    expect(required({ value: 'Titolo italiano', language: 'it', requested: 'it' })).toMatchObject({ filled: 1, total: 1 })
  })
  it('P4: region tags are the same language (normalised, as the validator\'s rule does)', () => {
    expect(required({ value: 'Deutscher Titel', language: 'de', requested: 'de-DE' })).toMatchObject({ filled: 1, total: 1 })
  })
  it('P5: the master sheet\'s legacy cells behave exactly as before', () => {
    expect(required({ value: 'Titolo italiano', requestedLocale: 'de', effectiveLocale: 'it' })).toMatchObject({ filled: 0, total: 1 })
    expect(required({ value: 'Deutscher Titel', requestedLocale: 'de', effectiveLocale: 'de' })).toMatchObject({ filled: 1, total: 1 })
  })
  it('P6: a plain value with no language facts counts as its value', () => {
    expect(required({ value: 'Anything' })).toMatchObject({ filled: 1, total: 1 })
    expect(required({ value: '' })).toMatchObject({ filled: 0, total: 1 })
  })
})

beforeAll(() => scoped(async () => {
  // An Italian-only parent title; one Amazon·DE listing per product, so the family has a German market and a shared German row.
  await prisma.product.create({ data: { id: 'ru-parent', sku: 'RU-PARENT', name: 'Titolo italiano', basePrice: 10, isParent: true } })
  await prisma.product.create({ data: { id: 'ru-child', sku: 'RU-CHILD', name: 'Figlio', basePrice: 10, parentId: 'ru-parent' } })
  await prisma.channelConnection.create({ data: { id: 'ru-amazon', channelType: 'AMAZON', isActive: true } as any })
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'DE', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'] } })
  for (const productId of ['ru-parent', 'ru-child']) await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', channelMarket: 'AMAZON_DE', marketplace: 'DE', region: 'EU', channelConnectionId: 'ru-amazon' } as any })
}), 30_000)
afterAll(async () => { await state.db?.close() })

describe('the one writer, on real disposable PostgreSQL', () => {
  it('P7–P9: the shared German row counts the Italian-only title as EMPTY and agrees with its validator; Italian stays filled; flagged = total − filled', () => scoped(async () => {
    expect(await reconcileFamilyReadiness('ru-parent')).toBeGreaterThan(0)
    const rows = await prisma.readinessIndex.findMany({ where: { productId: { in: ['ru-parent', 'ru-child'] } } })
    const entriesOf = (r: (typeof rows)[number]) => r.missing as unknown as MissingReadinessField[]

    const sharedDe = rows.find(r => r.productId === 'ru-parent' && r.channel === null && r.language === 'de')
    expect(sharedDe, 'the shared German row exists').toBeTruthy()
    expect(sharedDe!.requiredFilled).toBeLessThan(sharedDe!.requiredTotal)
    const nameEntries = entriesOf(sharedDe!).filter(e => e.field === 'name')
    expect(nameEntries.filter(e => e.requiredEmpty)).toHaveLength(1)                                // counted empty, flagged once
    expect(nameEntries.some(e => /missing/i.test(e.reason ?? ''))).toBe(true)                        // the validator says missing — they agree

    const sharedIt = rows.find(r => r.productId === 'ru-parent' && r.channel === null && r.language === 'it')!
    expect(sharedIt.requiredFilled).toBe(sharedIt.requiredTotal)                                     // the source language stays filled
    expect(entriesOf(sharedIt).some(e => e.field === 'name' && e.requiredEmpty)).toBe(false)

    for (const r of rows) {                                                                          // A-45's invariant, every row
      const flagged = entriesOf(r).filter(e => e.requiredEmpty === true).length
      expect({ id: `${r.productId}·${r.coordinateKey}·${r.language}`, flagged }).toEqual({ id: `${r.productId}·${r.coordinateKey}·${r.language}`, flagged: r.requiredTotal - r.requiredFilled })
    }
  }), 60_000)
})
