import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Editing speed (2026-10-13) — the rebuild after a product sheet save (`readiness-after-response.ts`) on a real server.
 *
 * It runs at Repeatable Read, so it takes no predicate locks and never makes another save restart. What keeps it from
 * leaving old values current is the mark: every save WRITES its family's readiness rows (`markReadinessPending`, the
 * already-pending ones too), so a rebuild whose snapshot predates a save meets that write when it replaces the rows and
 * retries from a fresh snapshot.
 *
 * Each race is FORCED, not hoped for: the rebuild is held inside its reads (a gate in its first studio sheet read, after
 * it has read the family's products), the other write commits, then the rebuild goes on. The readiness row's `sortTitle`
 * (the resolved title) shows which values a rebuild read. The first case is the positive control: a bare Repeatable Read
 * rebuild, held while a write that does not mark lands, commits old values as current — so the harness can see the
 * failure that the mark, and the rebuild's own check of the family's product rows (a family with no rows yet), prevent.
 * Runs only on a real server (`scripts/run-real-postgres-tests.mjs`).
 */
const state = vi.hoisted(() => ({ db: null as any, hold: false, reached: () => {}, gate: Promise.resolve() as Promise<void> }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`readiness-after-response-race: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: { name: 'readiness' }, addJobSafely: vi.fn(async () => ({ enqueued: true })) }))
vi.mock('./studio-sheet.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./studio-sheet.service.js')>()
  return { ...actual, getStudioSheet: async (input: Parameters<typeof actual.getStudioSheet>[0]) => {
    // One-shot: the next rebuild to read a sheet waits here, its snapshot already taken.
    if (state.hold) { state.hold = false; state.reached(); await state.gate }
    return actual.getStudioSheet(input)
  } }
})

import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { countPendingReadinessFamilies, markReadinessPending, produceReadinessForProducts, rebuildPendingFamily, reconcileFamilyReadiness } from './readiness-index.service.js'
import { familiesRebuildingAfterResponse, familyReadinessSettled } from './readiness-after-response.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!concurrentDatabaseUrl())(`the rebuild after a sheet save on a real server: never old values as current, never another save restarted (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => { state.db = await concurrentDatabase() }, 120_000)
  afterAll(async () => { for (const root of familiesRebuildingAfterResponse()) await familyReadinessSettled(root, 60_000); await state.db?.close() }, 60_000)

  async function seed(root: string) {
    await scoped(async () => {
      await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: 'Old name', basePrice: 10, isParent: true } })
      await prisma.product.create({ data: { id: `${root}-child`, sku: `${root.toUpperCase()}-CHILD`, name: 'Child', basePrice: 10, parentId: root } })
      await reconcileFamilyReadiness(root)
    })
  }
  const parentRows = (root: string) => scoped(() => prisma.readinessIndex.findMany({ where: { productId: root } }))
  /** Old values shown as current: what must never be the end state. */
  const staleCurrent = async (root: string, latest: string) => (await parentRows(root)).some(row => row.pendingSince === null && row.sortTitle !== latest)
  const currentOn = async (root: string, latest: string) => (await parentRows(root)).every(row => row.pendingSince === null && row.sortTitle === latest)
  /** The product sheet's Shared save: values and the deferred family rebuild, in one transaction. */
  const sheetSave = (root: string, name: string) => scoped(() => inDatabaseTransaction(prisma as never, async () => {
    await prisma.product.update({ where: { id: root }, data: { name } })
    return produceReadinessForProducts([root], undefined, { afterResponse: true })
  }))
  /** Hold the next rebuild's first sheet read; resolves once it is held, with the release. */
  function holdNextRebuild() {
    const held = new Promise<void>(resolve => { state.reached = resolve })
    let release: () => void = () => {}
    state.gate = new Promise<void>(resolve => { release = resolve })
    state.hold = true
    return { held, release: () => release() }
  }

  /** Save W1 ('Mid name'); its rebuild after the response is held in its reads; `w2` commits; the rebuild goes on. */
  async function duringRebuild(root: string, w2: () => Promise<unknown>) {
    await seed(root)
    const rebuild = holdNextRebuild()
    await sheetSave(root, 'Mid name')
    await rebuild.held
    expect((await parentRows(root)).every(row => row.pendingSince instanceof Date), 'W1 marked the family').toBe(true)
    await w2()
    rebuild.release()
    await familyReadinessSettled(root, 60_000)
  }

  it('control: a bare Repeatable Read rebuild, held while a write that does not mark lands, commits old values as current', async () => {
    await seed('race-control')
    await scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-control' }, data: { name: 'Mid name' } })
      await markReadinessPending(['race-control'])
    }))
    const rebuild = holdNextRebuild()
    const bare = scoped(() => inDatabaseTransaction(prisma as never, () => reconcileFamilyReadiness('race-control'), { memoReads: true, isolationLevel: 'RepeatableRead' }))
    await rebuild.held
    await scoped(() => prisma.product.update({ where: { id: 'race-control' }, data: { name: 'New name' } }))
    rebuild.release()
    await bare
    // If this does not hold, the harness cannot see the failure the mark and the product check prevent.
    expect(await currentOn('race-control', 'Mid name')).toBe(true)
  }, 120_000)

  it('a sheet save whose mark leaves the pending rows alone, and no rebuild of its own (a crash before it): the product check catches it', async () => {
    await duringRebuild('race-unmarked', () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-unmarked' }, data: { name: 'New name' } })
      expect(await markReadinessPending(['race-unmarked'], undefined, { onlyNewMarks: true })).toBe(0)
    })))
    expect(await staleCurrent('race-unmarked', 'New name')).toBe(false)
    expect(await currentOn('race-unmarked', 'New name')).toBe(true)
  }, 120_000)

  it('a save whose rows are already pending marks them anyway: the held rebuild retries, and no rebuild of its own is needed (a crash before it)', async () => {
    await duringRebuild('race-mark', () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-mark' }, data: { name: 'New name' } })
      expect(await markReadinessPending(['race-mark'])).toBeGreaterThan(0)
    })))
    expect(await staleCurrent('race-mark', 'New name')).toBe(false)
    expect(await currentOn('race-mark', 'New name')).toBe(true)
  }, 120_000)

  it('an edit over three families (the pending path) during the rebuild is not lost: never old values as current, and the worker finishes it', async () => {
    await seed('race-bulk-b'); await seed('race-bulk-c')
    await duringRebuild('race-bulk', () => scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-bulk' }, data: { name: 'New name' } })
      expect(await produceReadinessForProducts(['race-bulk', 'race-bulk-b', 'race-bulk-c'])).toEqual({ inline: 0, pending: 3 })
    })))
    expect(await staleCurrent('race-bulk', 'New name')).toBe(false)
    // The edit's queued job for this family (the worker's lane).
    await scoped(() => rebuildPendingFamily('race-bulk'))
    expect(await currentOn('race-bulk', 'New name')).toBe(true)
  }, 120_000)

  it('a family with no readiness row yet: an edit over three families during its first rebuild is not lost either', async () => {
    // No rows: the edit's mark has nothing to write, so the rebuild's own check of the family's products must catch it.
    await scoped(async () => {
      await prisma.product.create({ data: { id: 'race-new', sku: 'RACE-NEW', name: 'Old name', basePrice: 10, isParent: true } })
      await prisma.product.create({ data: { id: 'race-new-child', sku: 'RACE-NEW-CHILD', name: 'Child', basePrice: 10, parentId: 'race-new' } })
    })
    await seed('race-new-b'); await seed('race-new-c')
    const rebuild = holdNextRebuild()
    await sheetSave('race-new', 'Mid name')
    await rebuild.held
    await scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-new' }, data: { name: 'New name' } })
      await produceReadinessForProducts(['race-new', 'race-new-b', 'race-new-c'])
    }))
    rebuild.release()
    await familyReadinessSettled('race-new', 60_000)
    expect(await staleCurrent('race-new', 'New name')).toBe(false)
    expect(await currentOn('race-new', 'New name')).toBe(true)
  }, 120_000)

  it('the next sheet save during the rebuild: never old values as current at any moment, and current on the latest values at the end', async () => {
    await seed('race-sheet')
    const rebuild = holdNextRebuild()
    await sheetSave('race-sheet', 'Mid name')
    await rebuild.held
    await sheetSave('race-sheet', 'New name')
    rebuild.release()
    let sawStale = false
    while (familiesRebuildingAfterResponse().includes('race-sheet')) {
      if ((await parentRows('race-sheet')).every(row => row.pendingSince === null && row.sortTitle === 'Mid name')) sawStale = true
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(sawStale, 'the older rebuild committed the older values as current').toBe(false)
    expect(await currentOn('race-sheet', 'New name')).toBe(true)
  }, 120_000)

  it('an older Serializable drain rebuild vs a save whose rows are already pending: never old values as current', async () => {
    await seed('race-drain')
    await scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-drain' }, data: { name: 'Mid name' } })
      await markReadinessPending(['race-drain'])
    }))
    const rebuild = holdNextRebuild()
    const drain = scoped(() => rebuildPendingFamily('race-drain')).catch(() => 0)
    await rebuild.held
    await scoped(() => inDatabaseTransaction(prisma as never, async () => {
      await prisma.product.update({ where: { id: 'race-drain' }, data: { name: 'New name' } })
      await markReadinessPending(['race-drain'])
    }))
    rebuild.release()
    await drain
    expect(await staleCurrent('race-drain', 'New name')).toBe(false)
    if (await scoped(() => countPendingReadinessFamilies())) await scoped(() => rebuildPendingFamily('race-drain'))
    expect(await currentOn('race-drain', 'New name')).toBe(true)
  }, 120_000)

  /**
   * Another family's save, held open across a rebuild's commit: it has read and written before the rebuild commits and
   * commits after it. Returns how many attempts the save needed (a lost serialization check restarts it).
   */
  async function saveAcross(rebuilt: string, other: string, startRebuild: () => Promise<unknown>, rebuildDone: () => Promise<unknown>) {
    await seed(rebuilt); await seed(other)
    const rebuild = holdNextRebuild()
    void startRebuild()
    await rebuild.held
    let attempts = 0
    let reached: () => void = () => {}, open: () => void = () => {}
    const atGate = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { open = resolve })
    const save = scoped(() => inDatabaseTransaction(prisma as never, async () => {
      attempts++
      await prisma.product.update({ where: { id: other }, data: { name: `Other ${attempts}` } })
      await markReadinessPending([other])
      reached()
      await gate
    }))
    await atGate
    rebuild.release()
    await rebuildDone()
    open()
    await save
    return attempts
  }

  it('control: a SERIALIZABLE rebuild committing while another family\'s save is open makes that save restart', async () => {
    let done: Promise<unknown> = Promise.resolve()
    const attempts = await saveAcross('race-ser-a', 'race-ser-b',
      async () => { done = scoped(() => inDatabaseTransaction(prisma as never, () => reconcileFamilyReadiness('race-ser-a'), { memoReads: true })).catch(() => undefined) },
      () => done)
    // If this does not hold, the next case proves nothing.
    expect(attempts).toBeGreaterThan(1)
  }, 120_000)

  it('the rebuild after a sheet save (Repeatable Read) never makes another family\'s save restart', async () => {
    const attempts = await saveAcross('race-rr-a', 'race-rr-b', () => sheetSave('race-rr-a', 'New name'), () => familyReadinessSettled('race-rr-a', 60_000))
    expect(attempts).toBe(1)
    expect(await currentOn('race-rr-a', 'New name')).toBe(true)
  }, 120_000)
})
