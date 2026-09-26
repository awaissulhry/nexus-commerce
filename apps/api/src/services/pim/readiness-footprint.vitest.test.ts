/**
 * P3b S2 (docs/attributes/PLAN.md §10.9) — the readiness index follows the channel footprint.
 *
 * `reconcileReadinessFootprint` runs each minute before the pending drain. On the scope fixtures (PostgreSQL with the
 * generated row-level-security policies):
 *   · an old "No active account" row (what every business had before S2) is deleted;
 *   · a newly connected channel marks the families pending, and the drain writes its rows;
 *   · a disconnected channel's rows are deleted;
 *   · a check with nothing changed does nothing (no rebuild loop);
 *   · a check in one business never touches another business's rows.
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
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { drainPendingReadiness, reconcileFamilyReadiness, reconcileReadinessFootprint } from './readiness-index.service.js'
import { readinessCoordinateKey } from './readiness-model.js'

let fixtures: Record<ScopeFixtureKey, ScopeFixture>
const inFixture = <T>(key: ScopeFixtureKey, work: () => Promise<T>) => withWorkspace(fixtures[key].context, work)
const channelsOf = (key: ScopeFixtureKey) => inFixture(key, async () =>
  [...new Set((await prisma.readinessIndex.findMany({ where: { productId: fixtures[key].productId }, select: { channel: true } })).map(r => r.channel))].sort((a, b) => String(a).localeCompare(String(b))))

beforeAll(async () => {
  fixtures = await createScopeFixtures(state.db.client)
  for (const key of ['F1', 'F2'] as const) await inFixture(key, () => reconcileFamilyReadiness(fixtures[key].productId))
}, 300_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('reconcileReadinessFootprint', () => {
  it('does nothing when the index already follows the footprint (no rebuild loop)', async () => {
    expect(await inFixture('F1', reconcileReadinessFootprint)).toEqual({ removed: [], missing: [], markedFamilies: 0 })
  })

  it('deletes an old "No active account" row, and only in its own business', async () => {
    const coordinate = { channel: 'AMAZON', market: 'IT', accountId: null, aliasId: null }
    await inFixture('F1', () => prisma.readinessIndex.create({ data: { productId: fixtures.F1.productId, ...coordinate, coordinateKey: readinessCoordinateKey(coordinate),
      language: 'it', label: 'Amazon · IT', pct: null, state: 'absent', requiredFilled: 0, requiredTotal: 0, missing: [], note: 'No active account for this destination.', computedAt: new Date() } }))
    const f2AmazonBefore = await inFixture('F2', () => prisma.readinessIndex.count({ where: { channel: 'AMAZON' } }))
    expect(f2AmazonBefore).toBeGreaterThan(0)
    const result = await inFixture('F1', reconcileReadinessFootprint)
    expect(result.removed).toEqual([{ channel: 'AMAZON', market: 'IT', accountId: null, rows: 1 }])
    expect(await channelsOf('F1')).toEqual(['EBAY', null].sort((a, b) => String(a).localeCompare(String(b))))
    // F2 (Amazon connected) keeps every Amazon row.
    expect(await inFixture('F2', () => prisma.readinessIndex.count({ where: { channel: 'AMAZON' } }))).toBe(f2AmazonBefore)
  })

  it('a newly connected channel: the families are marked pending, and the drain writes the new rows', async () => {
    const etsy = await inFixture('F1', () => prisma.channelConnection.create({ data: { channelType: 'ETSY', managedBy: 'oauth', isActive: true, accountLabel: 'F1 ETSY', externalAccountId: 'scope-F1-ETSY-new' } as never }))
    const result = await inFixture('F1', reconcileReadinessFootprint)
    expect(result.missing).toEqual([{ channel: 'ETSY', market: 'GLOBAL', accountId: etsy.id }])
    expect(result.markedFamilies).toBe(1)
    await inFixture('F1', () => drainPendingReadiness({ budgetMs: 60_000 }))
    expect(await channelsOf('F1')).toEqual(['EBAY', 'ETSY', null].sort((a, b) => String(a).localeCompare(String(b))))
    expect(await inFixture('F1', () => prisma.readinessIndex.count({ where: { pendingSince: { not: null } } }))).toBe(0)
    // Settled: the next check finds nothing to do.
    expect(await inFixture('F1', reconcileReadinessFootprint)).toEqual({ removed: [], missing: [], markedFamilies: 0 })

    // Disconnect it: its rows go at the next check, and nothing else does.
    await inFixture('F1', () => prisma.channelConnection.update({ where: { id: etsy.id }, data: { isActive: false } }))
    const after = await inFixture('F1', reconcileReadinessFootprint)
    expect(after.removed.map(r => r.channel)).toEqual(['ETSY'])
    expect(after.missing).toEqual([])
    expect(await channelsOf('F1')).toEqual(['EBAY', null].sort((a, b) => String(a).localeCompare(String(b))))
  }, 180_000)

  it('a business with no rows yet is left to the nightly reconcile (nothing marked)', async () => {
    // F3 has never been computed: no Shared rows to mark, whatever the footprint says.
    expect(await inFixture('F3', () => prisma.readinessIndex.count())).toBe(0)
    const result = await inFixture('F3', reconcileReadinessFootprint)
    expect(result).toEqual({ removed: [], missing: [], markedFamilies: 0 })
  })
})
