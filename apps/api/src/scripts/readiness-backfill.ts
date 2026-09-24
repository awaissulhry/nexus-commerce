/**
 * PLAN 15.1 (a) — the readiness BACKFILL, off the cron.
 *
 * Step 2.7's one-shot is *"run the readiness reconcile"*. Measured, that is **68 minutes at 1,000
 * root families and 11.4 hours at 10,000**, times the number of active businesses. 🔴 A one-shot
 * that takes eleven hours must never be a cron tick — you want to stop it, look at it, and resume.
 *
 *   npx tsx apps/api/src/scripts/readiness-backfill.ts                     # DRY RUN, writes nothing
 *   npx tsx apps/api/src/scripts/readiness-backfill.ts --apply             # one chunk, 10 minutes
 *   npx tsx apps/api/src/scripts/readiness-backfill.ts --apply --budget 60 # one chunk, 60 seconds
 *   … --workspace <id>        # which business. Readiness is per business; this runs ONE.
 *
 * 🔴 RUN IT AGAIN TO CONTINUE. There is no cursor to pass. A family the last chunk finished has a
 * fresh `ReadinessIndex.computedAt` and is no longer due, so the next run starts where the last one
 * stopped. A family that crashed mid-way is still due and is retried — which is the case a stored
 * cursor gets wrong.
 *
 * 🔴 IT PRINTS `stopped: budget` WHEN THERE IS MORE TO DO. "Finished the chunk" and "finished the
 * catalogue" must never read the same.
 */
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import prisma from '../db.js'
import { runReadinessReconcile } from '../jobs/readiness-reconcile.job.js'
import { describeSweep } from '../services/pim/resumable-sweep.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const APPLY = argv.includes('--apply')
const BUDGET_S = Number(flag('budget') ?? 600)
const BATCH = Number(flag('batch') ?? 25)
const WORKSPACE = flag('workspace') ?? LEGACY_WORKSPACE_ID
// `--due-after-hours N` — recompute families whose readiness is older than N hours (default: the job's own 20 h).
// 0 recomputes every family now (2026-09-24: the Owner asked to run the night's reconcile the same evening).
const DUE_AFTER_HOURS = flag('due-after-hours')
const dueAfterMs = DUE_AFTER_HOURS === undefined ? undefined : Number(DUE_AFTER_HOURS) * 3_600_000
if (dueAfterMs !== undefined && !(Number.isFinite(dueAfterMs) && dueAfterMs >= 0)) {
  console.error(`[backfill] REFUSE: --due-after-hours must be a number ≥ 0, got ${DUE_AFTER_HOURS}`)
  process.exit(2)
}

async function main() {
  const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://unknown/').hostname
  console.log(`[backfill] host ${host} · database ${database} · business ${WORKSPACE}`)
  console.log(`[backfill] ${APPLY ? `APPLY, budget ${BUDGET_S}s, batch ${BATCH}` : 'DRY RUN — nothing will be written'} · due after ${dueAfterMs === undefined ? '20 h (default)' : `${DUE_AFTER_HOURS} h`}`)

  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const before = await prisma.readinessIndex.count()
    const report = await runReadinessReconcile({ dryRun: !APPLY, budgetMs: BUDGET_S * 1000, batchSize: BATCH, ...(dueAfterMs === undefined ? {} : { dueAfterMs }) })
    const after = await prisma.readinessIndex.count()
    console.log(`[backfill] ${describeSweep(report)}`)
    console.log(`[backfill] ReadinessIndex rows: ${before} → ${after}`)
    if (report.stoppedBecause === 'budget') console.log('[backfill] 🔴 MORE TO DO — run it again to continue from here.')
    if (report.stoppedBecause === 'failures') console.log('[backfill] 🔴 stopped on failures. Read them before running again.')
    if (report.stoppedBecause === 'complete' && APPLY) console.log('[backfill] 🟢 nothing left due for this business.')
  })
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
