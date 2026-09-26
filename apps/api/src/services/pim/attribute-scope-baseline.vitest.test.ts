/**
 * P3b S0 (docs/attributes/PLAN.md §10.9) — TODAY's behaviour on the four scope fixtures, pinned.
 *
 * These are the study's findings, measured through the real services. Each later P3b step FLIPS one of them on purpose
 * and changes the assertion here in the same commit, so the diff of this file is the list of behaviour changes:
 *
 *   B1 (S1/S2) — which channels a business "has" does not depend on what it connected: every business has the same
 *               switched-on markets.
 *   B2 (S4)    — a product with no family sees none of the business's dictionary on Shared, not even the starter one.
 *   B3 (S4)    — an Amazon-only key in the shared bag comes back on Shared as an "Additional saved attributes" column.
 *   B4 (S3/S5) — a Motovento-shaped family shows every one of the 242 attributes on Shared, the Amazon-only ones too.
 *   B5 (S2)    — readiness writes Amazon rows for an eBay-only business: "No active account for this destination."
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
import { AMAZON_ONLY_KEY, createScopeFixtures, studyAttributes, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
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

  it('B2: a product with no family sees none of the dictionary on Shared — not even the starter attributes', async () => {
    const starter = new Set(customAttributeConcepts().map(c => c.key))
    for (const key of ['F1', 'F3'] as const) {
      const dictionary = await inFixture(key, () => prisma.customAttribute.count())
      expect(dictionary).toBe(starter.size)                                   // the business HAS the starter dictionary…
      const columns = await sharedColumns(key)
      expect(columns.length).toBeGreaterThan(0)
      expect(columns.filter(c => starter.has(c.key))).toEqual([])             // …and Shared shows none of it
    }
  }, 120_000)

  it('B3: an Amazon-only key in the shared bag comes back on Shared as "Additional saved attributes"', async () => {
    const leaked = (await sharedColumns('F2')).find(c => c.key === AMAZON_ONLY_KEY)
    expect(leaked).toMatchObject({ group: 'Additional saved attributes' })
    // Control: the business without that key has no such column.
    expect((await sharedColumns('F1')).some(c => c.key === AMAZON_ONLY_KEY)).toBe(false)
  }, 120_000)

  it('B4: a Motovento-shaped family shows all 242 attributes on Shared, the Amazon-only ones too', async () => {
    const columns = new Set((await sharedColumns('F4')).map(c => c.key))
    const study = studyAttributes()
    expect(study).toHaveLength(242)
    expect(study.filter(a => !columns.has(a.code)).map(a => a.code)).toEqual([])
    expect(study.filter(a => a.class === 'channel-specific').length).toBe(74)
  }, 120_000)

  it('B5: readiness writes Amazon rows for an eBay-only business, marked "No active account"', async () => {
    await inFixture('F1', () => reconcileFamilyReadiness(fixtures.F1.productId))
    const rows = await inFixture('F1', () => prisma.readinessIndex.findMany({ where: { productId: fixtures.F1.productId }, select: { channel: true, state: true, note: true } }))
    const amazon = rows.filter(r => r.channel === 'AMAZON')
    expect(amazon.length).toBeGreaterThan(0)
    expect(amazon.every(r => r.state === 'absent' && r.note === 'No active account for this destination.')).toBe(true)
    // Control: the eBay rows are computed (an account exists), and the shared rows exist per language.
    expect(rows.some(r => r.channel === 'EBAY' && r.note !== 'No active account for this destination.')).toBe(true)
    expect(rows.some(r => r.channel === null)).toBe(true)
  }, 180_000)
})
