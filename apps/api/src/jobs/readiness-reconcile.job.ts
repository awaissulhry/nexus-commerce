import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { reconcileFamilyReadiness } from '../services/pim/readiness-index.service.js'
import { describeSweep, runResumableSweep, type SweepReport } from '../services/pim/resumable-sweep.js'

let scheduled: ReturnType<typeof cron.schedule> | null = null

/**
 * 🔴 PLAN 15.1 — how long the nightly run may take, whatever the catalogue holds.
 *
 * Before this, the job swept EVERY root family every night, sequentially, with no budget. Its own
 * recorded measurement is 4,087 ms for one family, which is ~2.5 minutes at today's 37 families,
 * **68 minutes at 1,000 and 11.4 hours at 10,000** — and multiplied again by the number of active
 * businesses. A run that long collides with live editing (each family holds a Serializable
 * transaction) and outlives its own 30-minute lock.
 *
 * The fix 15.1 asks for is not "make it faster". It is **bounded by design**: stop after the
 * budget, leave the rest outstanding, and pick them up on the next tick.
 */
const NIGHTLY_BUDGET_MS = 10 * 60_000

/**
 * 🔴 WHAT COUNTS AS DUE, and why this is the resume point.
 *
 * A family is due when its readiness was last computed longer ago than this. Because the sweep
 * refreshes `ReadinessIndex.computedAt` as it goes, a family it finished stops being due — so the
 * NEXT tick naturally continues where this one stopped, with no stored cursor and therefore no new
 * column and no migration.
 *
 * 20 hours, not 24: the nightly tick must find last night's work due again, and a horizon equal to
 * the period would race its own schedule. A family that has never been computed has no row at all
 * and is always due.
 */
const DUE_AFTER_MS = 20 * 60 * 60_000

/**
 * 🔴 A-30 (R-28) — EVERY root family that is due, OLDEST FIRST: never computed, then the oldest `computedAt`.
 *
 * It used to walk roots in id order and stop at `take`, under a comment that said "oldest work first". Past the budget
 * that re-did the SAME first families every night — their rows are more than 20 h old again at the next tick — and never
 * reached the rest. Simulated with this job: 500 families at 3 s each, four nights, the same 200 every night and 300
 * never computed. Oldest first turns the budget into a real rotation: a family waits at most
 * ⌈families due ÷ families per night⌉ nights.
 *
 * The order needs every root's age, so it walks all live roots (200 a page) and reads each page's newest row per root
 * through the `productId` index — two indexed queries per 200 roots, ~100 at 10,000. It is still one walk per batch of
 * 25 families, each of which costs 2–4 s.
 */
async function dueFamilies(dueBefore: Date): Promise<string[]> {
  const due: Array<{ id: string; at: number }> = []
  let cursor: string | undefined
  while (true) {
    const roots = await prisma.product.findMany({
      where: { parentId: null, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!roots.length) break
    cursor = roots[roots.length - 1].id
    const ids = roots.map(r => r.id)
    const newest = new Map((await prisma.readinessIndex.groupBy({
      by: ['productId'], where: { productId: { in: ids } }, _max: { computedAt: true },
    })).map(r => [r.productId, r._max.computedAt?.getTime() ?? null]))
    for (const id of ids) {
      const at = newest.get(id) ?? null
      if (at === null || at < dueBefore.getTime()) due.push({ id, at: at ?? -Infinity })
    }
    if (roots.length < 200) break
  }
  // Never computed (-Infinity) first, then the oldest. A tie keeps the walk's order (the database's id order; the sort
  // is stable), so two batches see one order.
  return due.sort((a, b) => (a.at === b.at ? 0 : a.at - b.at)).map(d => d.id)
}

/**
 * 🔴 A-30 — the dry run COUNTS what is due. It used to offer no count, so `readiness-backfill.ts` printed only
 * "DRY RUN, nothing written" and a row total, which read as "nothing due" on production when it had measured nothing.
 * The count is the work's own predicate (`dueFamilies`), so the two cannot disagree.
 */
export async function runReadinessReconcile(options: { dryRun?: boolean; budgetMs?: number; batchSize?: number; now?: () => number; dueAfterMs?: number } = {}): Promise<SweepReport> {
  // `dueAfterMs` — a HAND-RUN's horizon (the backfill script's `--due-after-hours`, e.g. 0 to recompute the same evening).
  // The cron passes none and keeps 20 h. Fixed at the start, so a family this run finishes is never taken twice.
  const dueBefore = new Date(Date.now() - (options.dueAfterMs ?? DUE_AFTER_MS))
  return runResumableSweep({
    name: 'readiness-reconcile',
    budgetMs: options.budgetMs ?? NIGHTLY_BUDGET_MS,
    batchSize: options.batchSize ?? 25,
    // 🔴 The CRON applies. `runResumableSweep` defaults to a dry run because a sweep a human starts
    // should have to ask; this one is the scheduled repair and its whole job is to write.
    dryRun: options.dryRun ?? false,
    nextBatch: async take => (await dueFamilies(dueBefore)).slice(0, take),
    countOutstanding: async () => (await dueFamilies(dueBefore)).length,
    apply: id => reconcileFamilyReadiness(id),
    // A test seam, never production. A budget measured with the real clock cannot be crossed
    // deterministically in a unit test, and a budget test that never crosses it proves nothing.
    ...(options.now ? { now: options.now } : {}),
  })
}

/**
 * 2026-09-24 — the ON-DEMAND run (`CRON_REGISTRY`, the Sync Logs "Run"): every family of the REQUEST's business, NOW —
 * not only those older than the nightly's 20 h. An operator who presses Run wants today's rules applied today (the
 * Owner asked the same evening a readiness fix deployed). Same writer, same budget, same failure signal as the cron.
 */
export async function runReadinessReconcileNow(): Promise<string> {
  const report = await runReadinessReconcile({ dueAfterMs: 0 })
  const line = describeSweep(report)
  if (report.failed > 0) throw new Error(line)
  return line
}

export function startReadinessReconcileCron() {
  if (scheduled || process.env.NEXUS_ENABLE_READINESS_RECONCILE === '0') return
  // LX.F P3-26 — the claim must outlive the RUN, not just the tick. Measured: 714 rows
  // in 4,087 ms for ONE family (step-5 record) → ≈150 s for 37 root families, against a
  // 50 s default claim; the lock stopped protecting the run two thirds of the way
  // through. 30 minutes is comfortably longer than any measured run and far shorter than
  // this job's own daily period, so the next tick is still contestable.
  //
  // 🔴 15.1 — the run is now bounded at NIGHTLY_BUDGET_MS, so 30 minutes is no longer a bet on the
  // catalogue staying small. It is three times the budget.
  scheduled = cron.schedule('17 2 * * *', async () => {
    await recordCronRun('readiness-reconcile', async () => {
      const report = await runReadinessReconcile()
      const line = describeSweep(report)
      // 🔴 R4 — an absent thing is STATED, never hidden. The old job threw when any family failed,
      // which is the right signal and the wrong message: it joined every error into one string.
      // The signal stays; `describeSweep` caps the sample and always carries the complete count.
      if (report.failed > 0) throw new Error(line)
      return line
    })
  }, { lockTtlMs: 30 * 60_000 })
}
