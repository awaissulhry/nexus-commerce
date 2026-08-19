/** READ-ONLY. Is the duplicate active row already changing behaviour? */
const { default: prisma } = await import('../src/db.js')
const { listActiveConnections } = await import('../src/services/connection-resolver.service.js')
console.log('listActiveConnections("EBAY") ->', (await listActiveConnections('EBAY')).length, 'accounts')
const runs = await prisma.cronRun.findMany({
  where: { jobName: { in: ['ebay-orders-sync','ebay-token-refresh'] } },
  orderBy: { startedAt: 'desc' }, take: 8,
  select: { jobName: true, startedAt: true, outputSummary: true },
})
console.log('\nrecent runs (watch the connections= count cross 21:00):')
for (const r of runs) console.log(`  ${r.startedAt.toISOString()}  ${r.jobName.padEnd(20)} ${r.outputSummary ?? ''}`)
await prisma.$disconnect()
