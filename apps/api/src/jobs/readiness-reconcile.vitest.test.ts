import { beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ products: vi.fn(), readiness: vi.fn(), reconcile: vi.fn(), schedule: vi.fn() }))
vi.mock('../db.js', () => ({ default: { product: { findMany: mock.products }, readinessIndex: { findMany: mock.readiness } } }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: mock.schedule } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, work: () => Promise<unknown>) => work() }))
vi.mock('../services/pim/readiness-index.service.js', () => ({ reconcileFamilyReadiness: mock.reconcile }))
import { runReadinessReconcile, startReadinessReconcileCron } from './readiness-reconcile.job.js'

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

/** A fake catalogue. `fresh` is the set the readiness probe reports as already computed. */
function catalogue(roots: string[], fresh = new Set<string>()) {
  mock.products.mockImplementation(async (args: { take: number; cursor?: { id: string } }) => {
    const from = args.cursor ? roots.indexOf(args.cursor.id) + 1 : 0
    return roots.slice(from, from + args.take).map(id => ({ id }))
  })
  mock.readiness.mockImplementation(async (args: { where: { productId: { in: string[] } } }) =>
    args.where.productId.in.filter(id => fresh.has(id)).map(productId => ({ productId })))
  return { fresh }
}

beforeEach(() => { for (const m of Object.values(mock)) m.mockReset() })

it('🔴 a fresh run with no readiness anywhere starts at the beginning and takes every family', async () => {
  catalogue(['a', 'b', 'c'])
  mock.reconcile.mockResolvedValue(2)
  const report = await runReadinessReconcile()
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'c'])
  expect(report).toMatchObject({ processed: 3, produced: 6, failed: 0, stoppedBecause: 'complete', applied: true })
})

it('🔴 skips families whose readiness is already fresh — that IS the checkpoint', async () => {
  // 'a' and 'c' were done by an earlier run, so only 'b' and 'd' are still due.
  catalogue(['a', 'b', 'c', 'd'], new Set(['a', 'c']))
  mock.reconcile.mockResolvedValue(1)
  const report = await runReadinessReconcile()
  expect(mock.reconcile.mock.calls.map(c => c[0])).toEqual(['b', 'd'])
  expect(report.processed).toBe(2)
})

it('🔴 asks only for readiness NEWER than the horizon — a stale row must not look done', async () => {
  catalogue(['a'])
  mock.reconcile.mockResolvedValue(1)
  await runReadinessReconcile()
  const where = mock.readiness.mock.calls[0][0].where
  expect(where.computedAt.gte).toBeInstanceOf(Date)
  const hoursAgo = (Date.now() - where.computedAt.gte.getTime()) / 3_600_000
  // 20 hours, not 24: the nightly tick must find last night's work due again rather than race its
  // own period.
  expect(hoursAgo).toBeGreaterThan(19.9)
  expect(hoursAgo).toBeLessThan(20.1)
})

it('🔴 stops on the budget and leaves the rest due, so the next run continues', async () => {
  const roots = Array.from({ length: 50 }, (_, i) => `f${i}`)
  const fresh = new Set<string>()
  catalogue(roots, fresh)
  // Each family marks itself fresh, exactly as the real reconcile does by writing computedAt.
  mock.reconcile.mockImplementation(async (id: string) => { fresh.add(id); return 3 })

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
