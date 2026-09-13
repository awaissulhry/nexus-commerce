import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { reconcileFamilyReadiness } from '../services/pim/readiness-index.service.js'

let scheduled: ReturnType<typeof cron.schedule> | null = null
/** Clustered cron supplies the workspace context; each family commits atomically. */
export async function runReadinessReconcile() {
  return recordCronRun('readiness-reconcile', async () => {
    let cursor: string | undefined, families = 0, rows = 0
    const failures: Error[] = []
    do {
      const products = await prisma.product.findMany({ where: { parentId: null, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })
      for (const product of products) {
        try { rows += await reconcileFamilyReadiness(product.id); families++ }
        catch (error) { failures.push(new Error(`${product.id}: ${error instanceof Error ? error.message : String(error)}`)) }
      }
      cursor = products.length === 100 ? products[products.length - 1].id : undefined
    } while (cursor)
    if (failures.length) throw new Error(`Readiness reconcile: ${families} families repaired; ${failures.length} failed. ${failures.map(error => error.message).join('; ')}`)
    return `Reconciled ${families} families, ${rows} readiness rows.`
  })
}
export function startReadinessReconcileCron() {
  if (scheduled || process.env.NEXUS_ENABLE_READINESS_RECONCILE === '0') return
  // LX.F P3-26 — the claim must outlive the RUN, not just the tick. Measured: 714 rows
  // in 4,087 ms for ONE family (step-5 record) → ≈150 s for 37 root families, against a
  // 50 s default claim; the lock stopped protecting the run two thirds of the way
  // through. 30 minutes is comfortably longer than any measured run and far shorter than
  // this job's own daily period, so the next tick is still contestable.
  scheduled = cron.schedule('17 2 * * *', async () => { await runReadinessReconcile() }, { lockTtlMs: 30 * 60_000 })
}
