/**
 * ACR.0.2-bis — run the REAL nightly job, not a hand-rolled equivalent.
 *
 * The earlier proof called `ingestTopOfSearchIS()` directly, IT-only, windowDays 30. The nightly
 * cron calls `runTosIsIngestCron()` → `recordCronRun()` → `ingestTopOfSearchIS({windowDays: 7})`
 * across every active profile, and it is the cron WRAPPER that decides SUCCESS vs FAILED.
 *
 * That classification is the thing that hid this defect for twelve nights — nine failed profiles
 * out of nine, recorded as SUCCESS — so it is worth exercising rather than assuming.
 */
import '../src/env.js'
await import('../src/db.js')
const { runTosIsIngestCron } = await import('../src/jobs/ads-tos-is-ingest.job.js')

const { default: prisma } = await import('../src/db.js')
const before = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
console.log(`[cron-e2e] rows carrying a ToS-IS BEFORE: ${before}`)
console.log('[cron-e2e] invoking runTosIsIngestCron() — the exact nightly entry point')

const t0 = Date.now()
await runTosIsIngestCron()
console.log(`[cron-e2e] returned after ${Math.round((Date.now() - t0) / 1000)}s`)

const run = await prisma.cronRun.findFirst({
  where: { jobName: 'tos-is-ingest' }, orderBy: { startedAt: 'desc' },
  select: { status: true, outputSummary: true, errorMessage: true, triggeredBy: true },
})
console.log('\n[cron-e2e] CronRun row this produced:')
console.log(`  status      ${run?.status}`)
console.log(`  triggeredBy ${run?.triggeredBy}`)
console.log(`  summary     ${run?.outputSummary ?? run?.errorMessage}`)

const after = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
console.log(`\n[cron-e2e] rows carrying a ToS-IS AFTER: ${after}  (delta ${after - before})`)
await prisma.$disconnect()
