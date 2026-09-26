import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * P2 (docs/attributes/PLAN.md §4.7) — a pending readiness mark is never lost to a rebuild that started before it.
 *
 * The rule under test: when a bulk edit (values + pending mark) and a family rebuild overlap, the end state is either
 * still PENDING, or rebuilt FROM THE EDIT'S DATA. Never "current" with the old data — that would show a stale verdict
 * as if it were checked. The rebuild's Serializable transaction is what guarantees it; PGlite (one connection) cannot
 * show a race, so this runs only on a real server (`scripts/run-real-postgres-tests.mjs`).
 *
 * The race is FORCED, not hoped for: a third connection locks the family's readiness rows, both transactions reach
 * those rows and block (checked in `pg_stat_activity`), and only then is the lock released. Both orders are run.
 * The readiness row's `sortTitle` (the resolved title, LX.F2) shows which data a rebuild read.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`readiness-pending-race: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { markReadinessPending, reconcileFamilyReadiness } from './readiness-index.service.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!concurrentDatabaseUrl())(`pending readiness vs a concurrent rebuild (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => { state.db = await concurrentDatabase() }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  async function seedFamily(root: string) {
    await scoped(async () => {
      await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: 'Old name', basePrice: 10, isParent: true } })
      await prisma.product.create({ data: { id: `${root}-child`, sku: `${root.toUpperCase()}-CHILD`, name: 'Child', basePrice: 10, parentId: root } })
      await reconcileFamilyReadiness(root)
    })
    const rows = await scoped(() => prisma.readinessIndex.findMany({ where: { productId: root } }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.sortTitle === 'Old name' && r.pendingSince === null)).toBe(true)
  }

  const edit = (root: string) => () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
    await prisma.product.update({ where: { id: root }, data: { name: 'New name' } })
    await markReadinessPending([root])
  }))
  const rebuild = (root: string) => () => scoped(() => reconcileFamilyReadiness(root))

  async function waiters(target: number) {
    let waiting = 0
    for (let i = 0; i < 600 && waiting < target; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await state.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [state.db.name])
      waiting = rows[0].n
    }
    return waiting
  }

  /** Lock the family's readiness rows, start `first`, wait until it blocks, start `second`, wait until both block. */
  async function forced(root: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const locker = await state.db.pool.connect()
    try {
      await locker.query('BEGIN')
      await locker.query(`SELECT id FROM "ReadinessIndex" WHERE "productId" IN ($1, $2) FOR UPDATE`, [root, `${root}-child`])
      const a = first()
      expect(await waiters(1), 'the first transaction must be blocked on the readiness rows').toBe(1)
      const b = second()
      // The positive control: both are blocked, so neither has finished before the other started.
      expect(await waiters(2), 'both transactions must be blocked on the readiness rows before the release').toBe(2)
      await locker.query('COMMIT')
      await Promise.all([a, b])
    } finally {
      locker.release()
    }
    return scoped(() => prisma.readinessIndex.findMany({ where: { productId: root } }))
  }

  it('edit first, rebuild second: the rebuild is retried and reads the edit — current AND correct', async () => {
    await seedFamily('race-edit-first')
    const rows = await forced('race-edit-first', edit('race-edit-first'), rebuild('race-edit-first'))
    expect(rows.every(r => r.pendingSince === null)).toBe(true)
    expect(rows.every(r => r.sortTitle === 'New name')).toBe(true)
  }, 120_000)

  it('rebuild first, edit second: the rebuild finishes with the old data, and the edit leaves the family PENDING', async () => {
    await seedFamily('race-rebuild-first')
    const rows = await forced('race-rebuild-first', rebuild('race-rebuild-first'), edit('race-rebuild-first'))
    expect(rows.every(r => r.sortTitle === 'Old name')).toBe(true)
    expect(rows.every(r => r.pendingSince instanceof Date)).toBe(true)
    // Once drained, the verdict is current and reflects the edit.
    await scoped(() => reconcileFamilyReadiness('race-rebuild-first'))
    const drained = await scoped(() => prisma.readinessIndex.findMany({ where: { productId: 'race-rebuild-first' } }))
    expect(drained.every(r => r.pendingSince === null && r.sortTitle === 'New name')).toBe(true)
  }, 120_000)
})
