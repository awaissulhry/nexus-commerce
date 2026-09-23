import { describe, expect, it, vi } from 'vitest'
import { describeSweep, runResumableSweep } from './resumable-sweep.js'

/**
 * PLAN 15.6 — the one sweep helper, and 15.1's gate: *"a test that the sweep resumes from its
 * checkpoint after an interruption, plus a positive control that a fresh run with no checkpoint
 * starts at the beginning."*
 *
 * The checkpoint here is DERIVED: `nextBatch` returns only outstanding work, so finishing a unit
 * removes it. The tests model that with a queue the work drains, which is what the readiness job
 * does with `ReadinessIndex.computedAt`.
 */

/** A fake catalogue: `nextBatch` returns what is still outstanding, `apply` marks one done. */
function catalogue(ids: string[], options: { failOn?: Set<string> } = {}) {
  const outstanding = new Set(ids)
  const order: string[] = []
  return {
    outstanding,
    order,
    nextBatch: async (take: number) => [...outstanding].slice(0, take),
    countOutstanding: async () => outstanding.size,
    apply: async (id: string) => {
      order.push(id)
      if (options.failOn?.has(id)) throw new Error(`refused ${id}`)
      outstanding.delete(id)
      return 2
    },
  }
}

/** A clock that advances a fixed amount per reading, so a budget can be crossed deterministically. */
const tickingClock = (stepMs: number) => { let t = 0; return () => (t += stepMs) - stepMs }

describe('runResumableSweep', () => {
  it('🔴 a fresh run with nothing done starts at the beginning and finishes the lot', async () => {
    const c = catalogue(['a', 'b', 'c', 'd'])
    const report = await runResumableSweep({ name: 'test', ...c, dryRun: false, batchSize: 2 })
    expect(c.order).toEqual(['a', 'b', 'c', 'd'])
    expect(report).toMatchObject({ processed: 4, produced: 8, failed: 0, planned: 4, remaining: 0, stoppedBecause: 'complete', applied: true })
  })

  it('🔴 stops on the budget, says so, and the NEXT run continues from there — not from the start', async () => {
    const c = catalogue(['a', 'b', 'c', 'd', 'e', 'f'])
    // 1 second per clock reading, 2.5 s of budget: enough for part of the work, not all of it.
    const first = await runResumableSweep({ name: 'test', ...c, dryRun: false, batchSize: 2, budgetMs: 2_500, now: tickingClock(1_000) })
    expect(first.stoppedBecause).toBe('budget')
    expect(first.processed).toBeGreaterThan(0)
    expect(first.processed).toBeLessThan(6)
    expect(first.remaining).toBe(6 - first.processed)
    const doneFirst = [...c.order]

    // 🔴 The resume. A generous budget, and it must NOT redo what the first run finished.
    const second = await runResumableSweep({ name: 'test', ...c, dryRun: false, batchSize: 2 })
    expect(second.stoppedBecause).toBe('complete')
    expect(second.remaining).toBe(0)
    expect(first.processed + second.processed).toBe(6)
    // Every unit exactly once across the two runs — no gap, no repeat.
    expect([...c.order].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(c.order.slice(0, doneFirst.length)).toEqual(doneFirst)
  })

  it('🔴 stops MID-BATCH, not only at a batch boundary', async () => {
    // The batch is the whole catalogue, so a boundary check alone can never fire. This is the arm
    // that caught a mutation the boundary test let through: deleting the per-unit budget check
    // left every test green, because with a small batch size the next boundary arrives first.
    const c = catalogue(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    const report = await runResumableSweep({ name: 'test', ...c, dryRun: false, batchSize: 100, budgetMs: 3_500, now: tickingClock(1_000) })
    expect(report.stoppedBecause).toBe('budget')
    expect(report.processed).toBeGreaterThan(0)
    expect(report.processed).toBeLessThan(8)
  })

  it('🔴 a DRY RUN writes nothing, and says `dry-run` rather than `complete`', async () => {
    const c = catalogue(['a', 'b', 'c'])
    const report = await runResumableSweep({ name: 'test', ...c, batchSize: 2 })
    expect(c.order).toEqual([])                 // it did not "just check one"
    expect(c.outstanding.size).toBe(3)
    expect(report).toMatchObject({ processed: 0, planned: 3, remaining: 3, stoppedBecause: 'dry-run', applied: false })
    // A dry run and a finished run must never read the same.
    expect(report.stoppedBecause).not.toBe('complete')
  })

  it('the default is a dry run — writing is the thing a caller has to ask for', async () => {
    const c = catalogue(['a'])
    expect((await runResumableSweep({ name: 'test', ...c })).applied).toBe(false)
  })

  it('🔴 keeps a COMPLETE failure count but a CAPPED sample, and stops when failures pile up', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `f${i}`)
    const c = catalogue(ids, { failOn: new Set(ids) })
    const report = await runResumableSweep({ name: 'test', ...c, dryRun: false, batchSize: 10, maxFailures: 25, keepFailures: 3 })
    expect(report.stoppedBecause).toBe('failures')
    expect(report.failed).toBe(25)              // the COUNT is complete
    expect(report.failures).toHaveLength(3)     // the MESSAGES are capped
    // The defect this replaces: every error joined into one string. 40 products is unreadable;
    // 10,000 is a message no log will keep.
    expect(describeSweep(report).length).toBeLessThan(400)
  })

  it('carries on past a single failure instead of abandoning the run', async () => {
    const c = catalogue(['a', 'b', 'c'], { failOn: new Set(['b']) })
    const report = await runResumableSweep({ name: 'test', ...c, dryRun: false })
    expect(c.order).toEqual(['a', 'b', 'c'])
    expect(report).toMatchObject({ processed: 2, failed: 1, remaining: 1 })
  })

  it('describeSweep never lets a budget stop read as a finish', () => {
    const base = { name: 'x', planned: 10, processed: 4, produced: 8, failed: 0, remaining: 6, ms: 1000, failures: [], applied: true }
    expect(describeSweep({ ...base, stoppedBecause: 'budget' })).toContain('stopped: budget')
    expect(describeSweep({ ...base, stoppedBecause: 'budget' })).toContain('6 of 10 outstanding')
    expect(describeSweep({ ...base, applied: false, stoppedBecause: 'dry-run' })).toContain('DRY RUN, nothing written')
  })

  it('a sweep with no cheap count still runs, and reports the count as absent rather than zero', async () => {
    const c = catalogue(['a', 'b'])
    const report = await runResumableSweep({ name: 'test', nextBatch: c.nextBatch, apply: c.apply, dryRun: false })
    expect(report.processed).toBe(2)
    // 🔴 `null`, not `0`. "I did not count" and "there is none" are different facts.
    expect(report.planned).toBeNull()
    expect(report.remaining).toBeNull()
  })

  it('does not call the work function at all when there is nothing outstanding', async () => {
    const apply = vi.fn()
    const report = await runResumableSweep({ name: 'test', nextBatch: async () => [], apply, countOutstanding: async () => 0, dryRun: false })
    expect(apply).not.toHaveBeenCalled()
    expect(report).toMatchObject({ processed: 0, stoppedBecause: 'complete', planned: 0, remaining: 0 })
  })
})
