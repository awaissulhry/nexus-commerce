import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Editing speed (2026-10-13) — the product sheet's Shared save rebuilds its family's readiness after its response
 * (`readiness-after-response.ts`). Its common case on a real server: a save lands while its family's rows are ALREADY
 * pending — so its mark updates 0 rows and takes no row lock — while a rebuild that read the OLDER values is in flight
 * (the drain in another process, or this process's own after-response run). The end state must be pending, or rebuilt
 * from the latest values; never "current" with the old ones.
 *
 * The race is FORCED, not hoped for: a third connection locks the family's readiness rows, so the older rebuild blocks
 * just before its DELETE (checked in `pg_stat_activity`); the newer save commits while it is blocked; then the lock is
 * released. The first case is the positive control: a save that does not read the readiness rows lets the older rebuild
 * commit stale, so this harness can see the failure it guards against. The readiness row's `sortTitle` (the resolved
 * title) shows which values a rebuild read. Runs only on a real server (`scripts/run-real-postgres-tests.mjs`).
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`readiness-after-response-race: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { markReadinessPending, produceReadinessForProducts, reconcileFamilyReadiness, rebuildPendingFamily } from './readiness-index.service.js'
import { familiesRebuildingAfterResponse, familyReadinessSettled } from './readiness-after-response.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!concurrentDatabaseUrl())(`a sheet save whose rows are already pending vs an older rebuild (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => { state.db = await concurrentDatabase() }, 120_000)
  afterAll(async () => { for (const r of familiesRebuildingAfterResponse()) await familyReadinessSettled(r); await state.db?.close() }, 60_000)

  async function seed(root: string) {
    await scoped(async () => {
      await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: 'Old name', basePrice: 10, isParent: true } })
      await prisma.product.create({ data: { id: `${root}-child`, sku: `${root.toUpperCase()}-CHILD`, name: 'Child', basePrice: 10, parentId: root } })
      await reconcileFamilyReadiness(root)
    })
  }
  const rows = (root: string) => scoped(() => prisma.readinessIndex.findMany({ where: { productId: root } }))
  async function waiters(target: number) {
    let waiting = 0
    for (let i = 0; i < 600 && waiting < target; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await state.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [state.db.name])
      waiting = rows[0].n
    }
    return waiting
  }
  const settledWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))])

  /** S1 marks; a rebuild (drain stand-in) reads S1's values and blocks before its DELETE; S2 writes + marks (0 rows) and commits; release. */
  async function race(root: string, s2: () => Promise<unknown>) {
    await seed(root)
    await scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: root }, data: { name: 'Mid name' } })
      await markReadinessPending([root])
    }))
    expect((await rows(root)).every(r => r.pendingSince instanceof Date)).toBe(true)
    const locker = await state.db.pool.connect()
    let marked: unknown
    try {
      await locker.query('BEGIN')
      await locker.query(`SELECT id FROM "ReadinessIndex" WHERE "productId" IN ($1, $2) FOR UPDATE`, [root, `${root}-child`])
      const drain = scoped(() => rebuildPendingFamily(root)).then(n => ({ n }), error => ({ error: String(error) }))
      expect(await waiters(1), 'the drain must be blocked before its DELETE').toBe(1)
      const save = s2().then(v => { marked = v })
      expect(await settledWithin(save, 10_000), 'S2 commits while the drain is still blocked (its mark updates 0 rows)').toBe(true)
      await locker.query('COMMIT')
      await drain
    } finally { locker.release() }
    return marked
  }

  it('control: a save that does NOT read the readiness rows lets the older rebuild commit stale (this harness can see the failure)', async () => {
    const root = 'race-control'
    await race(root, () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: root }, data: { name: 'New name' } })
    })))
    const end = await rows(root)
    // Stale and current: what the guard must prevent. If this does not hold, the harness cannot detect the failure.
    expect(end.every(r => r.pendingSince === null && r.sortTitle === 'Mid name')).toBe(true)
  }, 120_000)

  it('the mark of a save whose rows are already pending (0 rows) vs the older drain rebuild: never current with old values', async () => {
    const root = 'race-mark'
    const marked = await race(root, () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: root }, data: { name: 'New name' } })
      return markReadinessPending([root])
    })))
    const end = await rows(root)
    expect(marked).toBe(0)
    const stale = end.some(r => r.pendingSince === null && r.sortTitle !== 'New name')
    expect(stale, JSON.stringify(end.map(r => [r.sortTitle, r.pendingSince]))).toBe(false)
  }, 120_000)

  it('the real sheet path (after-response) vs the older drain rebuild: ends current AND on the latest values', async () => {
    const root = 'race-sheet'
    await race(root, () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: root }, data: { name: 'New name' } })
      return produceReadinessForProducts([root], undefined, { afterResponse: true })
    })))
    await familyReadinessSettled(root, 60_000)
    const end = await rows(root)
    expect(end.every(r => r.pendingSince === null && r.sortTitle === 'New name'), JSON.stringify(end.map(r => [r.sortTitle, r.pendingSince]))).toBe(true)
  }, 120_000)

  it('in-process: a save during this process\'s own after-response rebuild ends current AND on the latest values', async () => {
    const root = 'race-inproc'
    await seed(root)
    const sheetSave = (name: string) => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: root }, data: { name } })
      return produceReadinessForProducts([root], undefined, { afterResponse: true })
    }))
    await sheetSave('Mid name')
    const locker = await state.db.pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query(`SELECT id FROM "ReadinessIndex" WHERE "productId" IN ($1, $2) FOR UPDATE`, [root, `${root}-child`])
      expect(await waiters(1), 'the after-response rebuild must be blocked before its DELETE').toBe(1)
      expect(await settledWithin(sheetSave('New name'), 10_000), 'the second save commits while the rebuild is blocked').toBe(true)
      await locker.query('COMMIT')
    } finally { locker.release() }
    await familyReadinessSettled(root, 60_000)
    const end = await rows(root)
    expect(end.every(r => r.pendingSince === null && r.sortTitle === 'New name'), JSON.stringify(end.map(r => [r.sortTitle, r.pendingSince]))).toBe(true)
  }, 120_000)
})
