/**
 * Listing readiness rebuild §3 (docs/listings/READINESS-REBUILD-2026-10-23.md) — `readiness.updated`, the live event of
 * the Listing readiness page. On PostgreSQL (PGlite) with the real rebuild, mark and drain; only the bus is a stand-in:
 *   · a rebuild in its own transaction (the worker, the drain, the nightly run) announces its family once, after COMMIT;
 *   · a rebuild inside a save's transaction says nothing before that save commits, and nothing if it rolls back;
 *   · a bulk edit's pending marks announce each family once ("Checking…"), and the drain once more per family rebuilt;
 *   · a sheet save rebuilt after its response: one for the mark, one for the rebuild; a save of a family already
 *     pending marks nothing and says nothing;
 *   · a publish that fails never fails the save.
 * Ids invented.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: { name: 'readiness' }, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
const bus = vi.hoisted(() => ({ published: [] as Array<{ event: Record<string, unknown>; inTransaction: boolean }>, fail: false }))
vi.mock('../listing-events.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../listing-events.service.js')>()
  const { activeDatabaseTransaction } = await import('../../lib/database-context.js')
  return { ...actual, publishListingEvent: (event: Record<string, unknown>) => {
    if (bus.fail) throw new Error('broker down')
    bus.published.push({ event, inTransaction: activeDatabaseTransaction() !== undefined })
  } }
})

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { drainPendingReadiness, INLINE_READINESS_MAX_FAMILIES, markReadinessPending, produceReadiness, produceReadinessForProducts, reconcileFamilyReadiness, rebuildPendingFamily } from './readiness-index.service.js'
import { familyReadinessSettled } from './readiness-after-response.js'
import { announceReadinessUpdated } from './readiness-events.js'

vi.setConfig({ testTimeout: 120_000 })
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const save = <T>(work: () => Promise<T>) => scoped(() => inDatabaseTransaction(prisma as never, work))
const FAMILIES = ['re-a', 're-b', 're-c']
const child = (root: string) => `${root}-child`
/** The readiness events published, as the family roots they name, in order. */
const announced = () => bus.published.filter(p => p.event.type === 'readiness.updated').map(p => p.event.rootProductId)

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  for (const root of FAMILIES) {
    await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: `Parent ${root}`, basePrice: 10, isParent: true, status: 'DRAFT' } })
    await prisma.product.create({ data: { id: child(root), sku: `${root.toUpperCase()}-CHILD`, name: 'Child', basePrice: 10, parentId: root, status: 'DRAFT' } })
  }
}), 120_000)
beforeEach(async () => {
  bus.fail = false
  for (const root of FAMILIES) await scoped(() => reconcileFamilyReadiness(root))
  bus.published.length = 0
}, 120_000)
afterAll(async () => { await state.db?.close() })

it('a rebuild in its own transaction (the worker, the drain, the nightly run) announces its family once, after COMMIT', async () => {
  expect(await scoped(() => reconcileFamilyReadiness(child('re-a')))).toBeGreaterThan(0)
  expect(bus.published).toEqual([{ event: { type: 'readiness.updated', rootProductId: 're-a', ts: expect.any(Number) }, inTransaction: false }])
})

it('a rebuild inside a save says nothing before the save commits, then one event per family however many rebuilds', async () => {
  await save(async () => {
    await produceReadinessForProducts([child('re-a'), 're-a'])
    await produceReadiness(child('re-a'))
    await reconcileFamilyReadiness('re-a')
    expect(bus.published).toEqual([])
  })
  expect(announced()).toEqual(['re-a'])
  expect(bus.published.every(p => !p.inTransaction)).toBe(true)
})

it('a save that rolls back after its rebuild announces nothing', async () => {
  await expect(save(async () => {
    await reconcileFamilyReadiness('re-a')
    throw new Error('refused')
  })).rejects.toThrow('refused')
  expect(bus.published).toEqual([])
})

it('a bulk edit over more families than the inline limit: one "Checking…" event per family after COMMIT, one per family the drain rebuilds', async () => {
  expect(FAMILIES.length).toBeGreaterThan(INLINE_READINESS_MAX_FAMILIES)
  const production = await save(async () => {
    const result = await produceReadinessForProducts(FAMILIES.map(child))
    expect(bus.published).toEqual([])
    return result
  })
  expect(production).toEqual({ inline: 0, pending: FAMILIES.length })
  expect([...announced()].sort()).toEqual(FAMILIES)

  bus.published.length = 0
  const report = await scoped(() => drainPendingReadiness({ budgetMs: 60_000 }))
  expect(report.failed).toBe(0)
  expect([...announced()].sort()).toEqual(FAMILIES)
  // A family no longer pending is not rebuilt, so it is not announced again (the worker's late job).
  bus.published.length = 0
  expect(await scoped(() => rebuildPendingFamily('re-a'))).toBe(0)
  expect(bus.published).toEqual([])
})

it('a sheet save rebuilt after its response: one event for the mark, one for the rebuild; a save while pending says nothing', async () => {
  await save(() => produceReadinessForProducts([child('re-b')], undefined, { afterResponse: true }))
  expect(announced()).toEqual(['re-b'])
  // The second save lands while the family is still pending: its mark writes no row, so it is not announced.
  await save(() => produceReadinessForProducts([child('re-b')], undefined, { afterResponse: true }))
  expect(announced()).toEqual(['re-b'])
  await familyReadinessSettled('re-b')
  expect(announced()).toEqual(['re-b', 're-b'])
})

it('a mark that wrote no row announces nothing', async () => {
  expect(await save(() => markReadinessPending(['re-unknown']))).toBe(0)
  expect(bus.published).toEqual([])
})

it('a publish that fails never fails the save or the rebuild, and the other families are still announced', async () => {
  bus.fail = true
  await expect(save(() => produceReadinessForProducts([child('re-c')]))).resolves.toEqual({ inline: 1, pending: 0 })
  await expect(scoped(() => reconcileFamilyReadiness('re-c'))).resolves.toBeGreaterThan(0)
  expect(() => announceReadinessUpdated(['re-a'])).not.toThrow()
  expect(bus.published).toEqual([])
  bus.fail = false
  announceReadinessUpdated(['re-a', '', 're-b', 're-a'])
  expect(announced()).toEqual(['re-a', 're-b'])
})
