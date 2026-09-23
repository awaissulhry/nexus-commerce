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

/** Root families whose readiness is missing or older than the horizon, oldest work first. */
async function dueFamilies(take: number, dueBefore: Date): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  // Walks root ids in order and probes their readiness through the `productId` index. The walk
  // re-reads families that are already fresh, which is one indexed probe per 100 roots — about a
  // second at 10,000 — and is the price of having no stored cursor to go stale.
  while (out.length < take) {
    const roots = await prisma.product.findMany({
      where: { parentId: null, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!roots.length) break
    cursor = roots[roots.length - 1].id
    const ids = roots.map(r => r.id)
    const fresh = new Set((await prisma.readinessIndex.findMany({
      where: { productId: { in: ids }, computedAt: { gte: dueBefore } }, select: { productId: true }, distinct: ['productId'],
    })).map(r => r.productId))
    for (const id of ids) if (!fresh.has(id) && out.length < take) out.push(id)
    if (roots.length < 200) break
  }
  return out
}

/**
 * 🔴 An exact count of what is due needs the same walk as finding it, so it is NOT offered to the
 * sweep. `planned`/`remaining` come back `null` rather than a cheap number that would be wrong —
 * a count that lies is worse than a count that is absent.
 */
export async function runReadinessReconcile(options: { dryRun?: boolean; budgetMs?: number; batchSize?: number; now?: () => number } = {}): Promise<SweepReport> {
  const dueBefore = new Date(Date.now() - DUE_AFTER_MS)
  return runResumableSweep({
    name: 'readiness-reconcile',
    budgetMs: options.budgetMs ?? NIGHTLY_BUDGET_MS,
    batchSize: options.batchSize ?? 25,
    // 🔴 The CRON applies. `runResumableSweep` defaults to a dry run because a sweep a human starts
    // should have to ask; this one is the scheduled repair and its whole job is to write.
    dryRun: options.dryRun ?? false,
    nextBatch: take => dueFamilies(take, dueBefore),
    apply: id => reconcileFamilyReadiness(id),
    // A test seam, never production. A budget measured with the real clock cannot be crossed
    // deterministically in a unit test, and a budget test that never crosses it proves nothing.
    ...(options.now ? { now: options.now } : {}),
  })
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
