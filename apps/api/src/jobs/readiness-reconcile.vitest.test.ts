import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ products: vi.fn(), newest: vi.fn(), reconcile: vi.fn(), schedule: vi.fn() }))
vi.mock('../db.js', () => ({ default: { product: { findMany: mock.products }, readinessIndex: { groupBy: mock.newest } } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: mock.schedule } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, work: () => Promise<unknown>) => work() }))
vi.mock('../services/pim/readiness-index.service.js', () => ({ reconcileFamilyReadiness: mock.reconcile }))
import { runReadinessReconcile, runReadinessReconcileNow, startReadinessReconcileCron } from './readiness-reconcile.job.js'
import { describeSweep } from '../services/pim/resumable-sweep.js'

/**
 * PLAN 15.1 — the nightly reconcile is now BOUNDED and RESUMABLE.
 *
 * 🔴 WHAT THIS GUARDS. The job swept every root family every night, sequentially, with no budget.
 * Its own recorded measurement is 4,087 ms for ONE family: ~2.5 min at today's 37 families,
 * **68 min at 1,000 and 11.4 hours at 10,000**, times the number of active businesses. Each family
 * holds a Serializable transaction, so an hours-long sweep collides with live editing, and the run
 * outlived its own 30-minute lock.
 *
 * The resume point is DERIVED: a family the sweep finished has a fresh `ReadinessIndex.computedAt`
 * and stops being due. No stored cursor, so no new column and no migration.
 */

/**
 * A fake catalogue. `computed` maps a root to the time of its newest readiness row, as the real
 * `groupBy … _max: { computedAt }` reports it; a root absent from it has never been computed.
 */
function catalogue(roots: string[], computed = new Map<string, number>()) {
  mock.products.mockImplementation(async (args: { take: number; cursor?: { id: string } }) => {
    const from = args.cursor ? roots.indexOf(args.cursor.id) + 1 : 0
    return roots.slice(from, from + args.take).map(id => ({ id }))
  })
  mock.newest.mockImplementation(async (args: { where: { productId: { in: string[] } } }) =>
    args.where.productId.in.filter(id => computed.has(id)).map(productId => ({ productId, _max: { computedAt: new Date(computed.get(productId)!) } })))
  return { computed }
}
/** Each family stamps its readiness now, exactly as the real reconcile writes `computedAt`. */
const stamping = (computed: Map<string, number>, cost = 0) => async (id: string) => {
  if (cost) vi.setSystemTime(Date.now() + cost)
  computed.set(id, Date.now())
  return 3
}

beforeEach(() => { for (const m of Object.values(mock)) m.mockReset() })
afterEach(() => { vi.useRealTimers() })

it('🔴 a fresh run with no readiness anywhere starts at the beginning and takes every family', async () => {
  catalogue(['a', 'b', 'c'])
  mock.reconcile.mockResolvedValue(2)
  const report = await runReadinessReconcile()
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'c'])
  expect(report).toMatchObject({ processed: 3, produced: 6, failed: 0, stoppedBecause: 'complete', applied: true })
})

it('🔴 skips families whose readiness is already fresh — that IS the checkpoint', async () => {
  // 'a' and 'c' were done by an earlier run, so only 'b' and 'd' are still due.
  catalogue(['a', 'b', 'c', 'd'], new Map([['a', Date.now()], ['c', Date.now()]]))
  mock.reconcile.mockResolvedValue(1)
  const report = await runReadinessReconcile()
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['b', 'd'])
  expect(report.processed).toBe(2)
})

it('🔴 the horizon is 20 hours — a row just younger is fresh, just older is due — and a never-computed family comes first', async () => {
  const hour = 3_600_000
  // 20 hours, not 24: the nightly tick must find last night's work due again rather than race its own period.
  catalogue(['a', 'b', 'c'], new Map([['a', Date.now() - 19.9 * hour], ['b', Date.now() - 20.1 * hour]]))
  mock.reconcile.mockResolvedValue(1)
  await runReadinessReconcile()
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['c', 'b'])
})

it('🔴 stops on the budget and leaves the rest due, so the next run continues', async () => {
  const roots = Array.from({ length: 50 }, (_, i) => `f${i}`)
  const { computed } = catalogue(roots)
  mock.reconcile.mockImplementation(stamping(computed))

  // A clock that advances one second per reading: the budget is crossed on a known tick rather
  // than hoping the real clock moves inside a synchronous loop.
  let t = 0
  const clock = () => (t += 1_000) - 1_000
  const first = await runReadinessReconcile({ budgetMs: 6_000, batchSize: 5, now: clock })
  expect(first.stoppedBecause).toBe('budget')
  const doneFirst = mock.reconcile.mock.calls.map(c => c[0])
  expect(doneFirst.length).toBeLessThan(50)

  mock.reconcile.mockClear()
  const second = await runReadinessReconcile({ batchSize: 5 })
  const doneSecond = mock.reconcile.mock.calls.map(c => c[0])
  expect(second.stoppedBecause).toBe('complete')
  // No gap and no repeat across the two runs.
  expect([...doneFirst, ...doneSecond].sort()).toEqual([...roots].sort())
  expect(doneSecond).not.toContain(doneFirst[0])
})

it('continues past a family failure instead of abandoning the run', async () => {
  catalogue(['one', 'two', 'three'])
  mock.reconcile.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('stale schema transaction')).mockResolvedValueOnce(5)
  const report = await runReadinessReconcile()
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['one', 'two', 'three'])
  expect(report).toMatchObject({ processed: 2, produced: 8, failed: 1 })
  expect(report.failures[0]).toContain('stale schema transaction')
  expect(mock.schedule).not.toHaveBeenCalled()
})

it('🔴 the CRON still fails the run when a family failed — the signal stays, the giant message goes', async () => {
  catalogue(['one', 'two'])
  mock.reconcile.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('boom'))
  startReadinessReconcileCron()
  const tick = mock.schedule.mock.calls[0][1] as () => Promise<void>
  // 🔴 ONE tick, both assertions on the SAME error. Calling `tick()` twice spends the `…Once`
  // mocks on the first call, so the second run has nothing left to fail and resolves — which is
  // how this test first failed, on its own scaffolding rather than on the code.
  const error = await tick().then(() => null, (e: Error) => e)
  expect(error).toBeInstanceOf(Error)
  expect(error!.message).toMatch(/1 failed/)
  expect(error!.message).toContain('boom')
  // Bounded: the old job joined EVERY error into one string.
  expect(error!.message.length).toBeLessThan(400)
})

/**
 * 🔴 A-30 (R-28) — NIGHTS, not one run followed at once by another. The resume test above runs its second run while the
 * first run's rows are still fresh, so it could not see this: past the budget, the old id-order walk re-did the SAME
 * first families every night (their rows are over 20 h old by the next tick) and never reached the rest.
 */
it('🔴 three nights over a catalogue larger than one night: never-computed families first, then the oldest', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const roots = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`)
  const { computed } = catalogue(roots)
  // One minute a family and a five-minute budget: five families a night, on the job's own clock.
  mock.reconcile.mockImplementation(stamping(computed, 60_000))
  const night = async (n: number) => {
    vi.setSystemTime(Date.parse('2026-09-24T02:17:00Z') + n * 24 * 3_600_000)
    mock.reconcile.mockClear()
    const report = await runReadinessReconcile({ budgetMs: 5 * 60_000 })
    return { done: mock.reconcile.mock.calls.map(c => c[0]), report }
  }
  const first = await night(0)
  expect(first.done).toEqual(['f00', 'f01', 'f02', 'f03', 'f04'])
  expect(first.report).toMatchObject({ stoppedBecause: 'budget', planned: 12, remaining: 7 })
  // The old walk did f00–f04 again here, every night, and never reached f05–f11.
  expect((await night(1)).done).toEqual(['f05', 'f06', 'f07', 'f08', 'f09'])
  expect((await night(2)).done).toEqual(['f10', 'f11', 'f00', 'f01', 'f02'])
  expect(roots.filter(id => !computed.has(id))).toEqual([])
})

it('🔴 the dry run COUNTS what is due and computes nothing', async () => {
  catalogue(['a', 'b', 'c', 'd'], new Map([['a', Date.now()]]))
  const report = await runReadinessReconcile({ dryRun: true })
  expect(report).toMatchObject({ applied: false, stoppedBecause: 'dry-run', planned: 3, remaining: 3, processed: 0 })
  expect(mock.reconcile).not.toHaveBeenCalled()
  expect(describeSweep(report)).toContain('3 of 3 outstanding')
})

/**
 * 2026-09-24 — the Owner asked to run the night's reconcile NOW, the same evening. Rows computed at 02:17 UTC are not due
 * until ~22:17 UTC under the 20 h horizon, so a hand-run needs its own horizon. The CRON passes none and keeps 20 h.
 */
it('🔴 a hand-run can shorten the horizon: 0 h takes a family computed an hour ago; the default still skips it', async () => {
  const hour = 3_600_000
  catalogue(['a', 'b'], new Map([['a', Date.now() - hour], ['b', Date.now() - hour]]))
  mock.reconcile.mockResolvedValue(1)
  await runReadinessReconcile()
  expect(mock.reconcile).not.toHaveBeenCalled()
  await runReadinessReconcile({ dueAfterMs: 0 })
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['a', 'b'])
})

// A finished family is stamped NOW, so it sorts after every family still due, and the sweep stops at what it planned at
// the start: 0 h cannot loop. (Measured: re-reading the horizon per batch changes nothing here — an equivalent mutant.)
it('🔴 the on-demand run (Sync Logs "Run") recomputes a family computed an hour ago, and fails loudly like the cron', async () => {
  const hour = 3_600_000
  catalogue(['a', 'b'], new Map([['a', Date.now() - hour], ['b', Date.now() - hour]]))
  mock.reconcile.mockResolvedValueOnce(4).mockRejectedValueOnce(new Error('serialization failure'))
  const error = await runReadinessReconcileNow().then(() => null, (e: Error) => e)
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['a', 'b'])
  expect(error?.message).toMatch(/1 failed/)
  mock.reconcile.mockReset()
  catalogue(['c'], new Map([['c', Date.now() - hour]]))
  mock.reconcile.mockResolvedValue(2)
  expect(await runReadinessReconcileNow()).toContain('1 done')
})

it('🔴 with the horizon at 0 every family is done exactly once and the run ends complete', async () => {
  const roots = ['a', 'b', 'c', 'd', 'e', 'f']
  const { computed } = catalogue(roots, new Map(roots.map(id => [id, Date.now() - 3_600_000])))
  mock.reconcile.mockImplementation(stamping(computed, 1_000))
  vi.useFakeTimers({ toFake: ['Date'] })
  const report = await runReadinessReconcile({ dueAfterMs: 0, batchSize: 2 })
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(roots)
  expect(report).toMatchObject({ processed: 6, stoppedBecause: 'complete' })
})
