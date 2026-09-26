/**
 * P3b S0 (docs/attributes/PLAN.md §10.9) — TODAY's behaviour on the four scope fixtures, pinned.
 *
 * These are the study's findings, measured through the real services. Each later P3b step FLIPS one of them on purpose
 * and changes the assertion here in the same commit, so the diff of this file is the list of behaviour changes:
 *
 *   B1 (S1/S2) — which channels a business "has" does not depend on what it connected: every business has the same
 *               switched-on markets.
 *   B2 (S4 ✓)  — FLIPPED by S4: a product with no family sees the business's core on Shared (the concept-linked
 *               attributes: the starter set for a new business).
 *   B3 (S4 ✓)  — FLIPPED by S4: an Amazon-only key in the shared bag no longer comes back on Shared; a real old key
 *               (in no dictionary and no channel schema) still does.
 *   B4 (S3/S5) — a Motovento-shaped family shows every one of the 242 attributes on Shared, the Amazon-only ones too.
 *   B5 (S2 ✓)  — FLIPPED by S2: readiness follows the channel footprint. An eBay-only business gets eBay rows only (no
 *               "No active account" rows); a business with no channel gets the Shared rows only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { customAttributeConcepts } from '@nexus/shared/attribute-concepts'
import { AMAZON_ONLY_KEY, OLD_KEY, createScopeFixtures, studyAttributes, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'

let fixtures: Record<ScopeFixtureKey, ScopeFixture>
const inFixture = <T>(key: ScopeFixtureKey, work: () => Promise<T>) => withWorkspace(fixtures[key].context, work)
const sharedColumns = (key: ScopeFixtureKey) => inFixture(key, async () =>
  (await getStudioSheet({ productId: fixtures[key].productId, scope: 'master', market: 'IT', locale: 'it' } as never)).columns)

beforeAll(async () => { fixtures = await createScopeFixtures(state.db.client) }, 240_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('P3b S0 — today, pinned', () => {
  it('B1: every business has the same switched-on markets, whatever it connected', async () => {
    const markets: Record<string, string[]> = {}
    for (const key of ['F1', 'F2', 'F3', 'F4'] as const) {
      markets[key] = (await inFixture(key, () => prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true } })))
        .map(m => `${m.channel}:${m.code}`).sort()
      const connected = await inFixture(key, () => prisma.channelConnection.findMany({ where: { isActive: true }, select: { channelType: true } }))
      expect(connected.map(c => c.channelType).sort()).toEqual([...fixtures[key].channels].sort())
    }
    expect(markets.F1.length).toBe(19)
    expect(markets.F2).toEqual(markets.F1)
    expect(markets.F3).toEqual(markets.F1)
    expect(markets.F4).toEqual(markets.F1)
    // Channels no fixture connected are switched on too.
    expect(markets.F3.some(m => m.startsWith('AMAZON:')) && markets.F3.some(m => m.startsWith('EBAY:'))).toBe(true)
  })

  it('B2 (flipped by S4): a product with no family sees the business\'s core on Shared — the starter set', async () => {
    const starter = new Set(customAttributeConcepts().map(c => c.key))
    for (const key of ['F1', 'F3'] as const) {
      const dictionary = await inFixture(key, () => prisma.customAttribute.count())
      expect(dictionary).toBe(starter.size)
      const columns = await sharedColumns(key)
      expect([...starter].filter(code => !columns.some(c => c.key === code))).toEqual([])   // every starter attribute is on Shared
    }
  }, 120_000)

  it('B3 (flipped by S4): an Amazon-only bag key stays off Shared; a real old key is still shown', async () => {
    const columns = await sharedColumns('F2')
    expect(columns.some(c => c.key === AMAZON_ONLY_KEY)).toBe(false)
    expect(columns.find(c => c.key === OLD_KEY)).toMatchObject({ group: 'Additional saved attributes' })
    // The value itself is untouched: the Amazon scope reads the same key.
    const bag = await inFixture('F2', () => prisma.product.findUniqueOrThrow({ where: { id: fixtures.F2.productId }, select: { categoryAttributes: true } }))
    expect((bag.categoryAttributes as Record<string, unknown>)[AMAZON_ONLY_KEY]).toBe('Uomo')
  }, 120_000)

  it('B4: a Motovento-shaped family shows all 242 attributes on Shared, the Amazon-only ones too', async () => {
    const columns = new Set((await sharedColumns('F4')).map(c => c.key))
    const study = studyAttributes()
    expect(study).toHaveLength(242)
    expect(study.filter(a => !columns.has(a.code)).map(a => a.code)).toEqual([])
    expect(study.filter(a => a.class === 'channel-specific').length).toBe(74)
  }, 120_000)

  it('B5 (flipped by S2): readiness follows the footprint — eBay rows only for F1, Shared rows only for F3', async () => {
    const rowsOf = async (key: 'F1' | 'F3') => {
      await inFixture(key, () => reconcileFamilyReadiness(fixtures[key].productId))
      return inFixture(key, () => prisma.readinessIndex.findMany({ where: { productId: fixtures[key].productId }, select: { channel: true, accountId: true, language: true, note: true } }))
    }
    const f1 = await rowsOf('F1')
    expect([...new Set(f1.map(r => r.channel))].sort()).toEqual(['EBAY', null].sort())
    expect(f1.some(r => r.note === 'No active account for this destination.')).toBe(false)
    expect(f1.filter(r => r.channel === 'EBAY').every(r => r.accountId !== null)).toBe(true)
    const f3 = await rowsOf('F3')
    expect(f3.length).toBeGreaterThan(0)
    expect(f3.every(r => r.channel === null)).toBe(true)
    // The Shared rows are unchanged by S2: one per language of every switched-on market, for both businesses.
    const sharedLanguages = (rows: typeof f1) => rows.filter(r => r.channel === null).map(r => r.language).sort()
    expect(sharedLanguages(f1)).toEqual(sharedLanguages(f3))
    expect(sharedLanguages(f3).length).toBeGreaterThan(1)
  }, 180_000)
})
