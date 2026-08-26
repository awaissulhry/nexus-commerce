const { default: prisma } = await import('../src/db.js')
const rows = await prisma.cronRun.findMany({
  where: { jobName: { in: ['ebay-orders-sync','ebay-token-refresh','latency-watchdog','ebay-feed-poll'] } },
  orderBy: { startedAt: 'desc' }, take: 8,
  select: { jobName: true, status: true, startedAt: true, outputSummary: true, errorMessage: true },
})
console.log('most recent cron runs:')
for (const r of rows) console.log(`  ${r.startedAt.toISOString()}  ${r.jobName.padEnd(20)} ${String(r.status).padEnd(8)} ${r.errorMessage ? 'ERROR: '+r.errorMessage.slice(0,70) : String(r.outputSummary ?? '').slice(0,70)}`)
console.log('\nerrors in the last 8:', rows.filter(r=>r.errorMessage).length)
await prisma.$disconnect()
