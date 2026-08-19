/** READ-ONLY. Did the six converted jobs run since the MAP.3a deploy, and what
 *  did they WRITE? Per reference_cron_success_carries_sweeper_error, judge by the
 *  summary/error, never by `status` alone. */
const { default: prisma } = await import('../src/db.js')
const DEPLOY = new Date('2026-08-19T15:48:24Z')
const JOBS = ['ebay-feed-poll','ebay-item-status-reconcile','ebay-orders-sync','ebay-status-reconcile','ebay-token-refresh','latency-watchdog']
const rows = await prisma.cronRun.findMany({
  where: { jobName: { in: JOBS }, startedAt: { gte: DEPLOY } },
  orderBy: { startedAt: 'desc' },
  select: { jobName: true, status: true, startedAt: true, outputSummary: true, errorMessage: true },
})
console.log(`CronRun rows since deploy (${DEPLOY.toISOString()}): ${rows.length}\n`)
for (const j of JOBS) {
  const mine = rows.filter(r => r.jobName === j)
  if (mine.length === 0) { console.log(`  ${j.padEnd(28)} — no run yet in this window`); continue }
  const r = mine[0]!
  const verdict = r.errorMessage ? `ERROR: ${String(r.errorMessage).slice(0,110)}` : `wrote: ${String(r.outputSummary ?? '(no summary)').slice(0,110)}`
  console.log(`  ${j.padEnd(28)} ${String(r.status).padEnd(8)} ${r.startedAt.toISOString()}  ${verdict}`)
}
console.log('\nAny errorMessage across the window:', rows.filter(r => r.errorMessage).length)
await prisma.$disconnect()
