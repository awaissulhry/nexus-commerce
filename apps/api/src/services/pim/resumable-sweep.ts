/**
 * PLAN 15.6 — ONE resumable-sweep helper, for all three one-shot sweeps over every product: the
 * requirements pass (2.1), the axis migration (2.6) and the readiness backfill (2.7).
 *
 * 🔴 WHY IT EXISTS. Three sweeps had the same hazards and none named a runtime, a batch size or a
 * resume point. Step 2.6 carried *"rehearse first, `--apply` only when the group counts are
 * identical"* as a footnote. **R2: put the rule in the engine, not in one step's footnote.**
 *
 * The contract 15.6 asks for:
 *   · a cursor and a resume point
 *   · a wall-clock budget
 *   · a DRY RUN that prints counts, with `--apply` only when the counts match
 *
 * 🔴 AND THE CHECKPOINT IS DERIVED, NOT STORED. There is no new column and therefore no migration —
 * which matters, because a migration gets its own branch and its own merge and may never ride with
 * code. The caller supplies `nextBatch`, which is re-queried every time and must return only work
 * that is still OUTSTANDING. Finished work stops being returned because it is finished. A crash
 * mid-unit leaves that unit outstanding, so it is retried rather than skipped — which a stored
 * cursor gets wrong in exactly the case that matters.
 *
 * 🔴 FAILURES ARE BOUNDED. `readiness-reconcile.job.ts:21` accumulated every error and joined them
 * into one string; a systemic failure at 10,000 products produced a message nobody could read and
 * a job that threw at the very end, after hours of work. Here the count is complete, the messages
 * are capped, and the sweep can stop early when failures say the run is not worth finishing.
 */

export interface SweepReport {
  name: string
  /** Outstanding before this run started. `null` when the caller does not offer a count. */
  planned: number | null
  /** Units this run actually finished. `0` for a dry run, which finishes nothing by design. */
  processed: number
  /** What the units produced — rows written, records touched. Caller-defined. */
  produced: number
  failed: number
  /** Outstanding after this run. `null` when the caller does not offer a count. */
  remaining: number | null
  /** 🔴 Never "done" by omission: a budget stop and a clean finish must not read the same. */
  stoppedBecause: 'complete' | 'budget' | 'failures' | 'dry-run'
  ms: number
  /** Capped. The count above is complete; this is a sample for a human. */
  failures: string[]
  applied: boolean
}

export interface ResumableSweepOptions {
  name: string
  /** The next outstanding units, at most `take`. Re-queried each batch — see the note above. */
  nextBatch: (take: number) => Promise<string[]>
  /** One unit of work. Returns however many records it produced. */
  apply: (id: string) => Promise<number>
  /** How much is outstanding. Optional — a sweep with no cheap count still runs. */
  countOutstanding?: () => Promise<number>
  /** 🔴 Default 10 minutes. A sweep with no budget is the 11-hour job this helper exists to stop. */
  budgetMs?: number
  batchSize?: number
  /** 🔴 DEFAULT DRY RUN. Writing is the thing a caller has to ask for. */
  dryRun?: boolean
  /** Stop early once this many units have failed. Default 25. */
  maxFailures?: number
  /** How many failure messages to keep for a human. The COUNT is always complete. Default 10. */
  keepFailures?: number
  onProgress?: (report: Pick<SweepReport, 'processed' | 'failed' | 'produced' | 'ms'>) => void
  /** Injected for tests; never for production. */
  now?: () => number
}

export async function runResumableSweep(options: ResumableSweepOptions): Promise<SweepReport> {
  const {
    name, nextBatch, apply, countOutstanding,
    budgetMs = 10 * 60_000, batchSize = 100, dryRun = true,
    maxFailures = 25, keepFailures = 10, onProgress, now = Date.now,
  } = options

  const started = now()
  const planned = countOutstanding ? await countOutstanding() : null
  const failures: string[] = []
  let processed = 0
  let produced = 0
  let failed = 0
  let stoppedBecause: SweepReport['stoppedBecause'] = 'complete'

  if (dryRun) {
    // 🔴 A dry run reports the size of the job and touches nothing. It does NOT process one unit
    // "to check": that is a write, and a caller reading `processed: 0` would be reading a lie.
    return {
      name, planned, processed: 0, produced: 0, failed: 0,
      remaining: planned, stoppedBecause: 'dry-run', ms: now() - started, failures: [], applied: false,
    }
  }

  /**
   * 🔴 Attempted THIS RUN, and why it has to exist.
   *
   * A failed unit stays outstanding on purpose — that is how it gets retried on the next run. But
   * `nextBatch` is re-queried, so within ONE run the same failure comes straight back at the same
   * position and the sweep spins on it until `maxFailures`. Caught by the "carries on past a
   * single failure" test, which saw `['a','b','c','b','b','b', …]`: three units, twenty-seven
   * attempts, and the run abandoned on a failure budget it had spent entirely on one record.
   *
   * Retry belongs on the NEXT run, where something may have changed. Not on the next loop.
   */
  const attempted = new Set<string>()

  outer: while (true) {
    if (now() - started >= budgetMs) { stoppedBecause = 'budget'; break }
    // Ask further ahead when everything in view has already been tried, rather than stopping —
    // a failure early in the order must not hide the work behind it.
    let take = batchSize
    let batch: string[] = []
    while (true) {
      const got = await nextBatch(take)
      batch = got.filter(id => !attempted.has(id))
      if (batch.length || got.length < take) break
      take += batchSize
    }
    if (!batch.length) break
    for (const id of batch) {
      if (now() - started >= budgetMs) { stoppedBecause = 'budget'; break outer }
      attempted.add(id)
      try {
        produced += await apply(id)
        processed++
      } catch (error) {
        failed++
        if (failures.length < keepFailures) failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
        if (failed >= maxFailures) { stoppedBecause = 'failures'; break outer }
      }
    }
    onProgress?.({ processed, failed, produced, ms: now() - started })
  }

  const remaining = countOutstanding ? await countOutstanding() : null
  return { name, planned, processed, produced, failed, remaining, stoppedBecause, ms: now() - started, failures, applied: true }
}

/** One line a human can read in a log or a cron summary, with nothing rounded away. */
export function describeSweep(report: SweepReport): string {
  const parts = [
    `${report.name}: ${report.applied ? `${report.processed} done` : 'DRY RUN, nothing written'}`,
    report.produced ? `${report.produced} rows` : '',
    report.failed ? `🔴 ${report.failed} failed` : '',
    report.planned !== null ? `${report.remaining} of ${report.planned} outstanding` : '',
    `stopped: ${report.stoppedBecause}`,
    `${Math.round(report.ms / 1000)}s`,
  ].filter(Boolean)
  return parts.join(' · ') + (report.failures.length ? ` — first: ${report.failures.join('; ')}` : '')
}
