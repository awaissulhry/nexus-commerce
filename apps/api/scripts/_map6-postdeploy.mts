const { default: prisma } = await import('../src/db.js')
const rows = await prisma.cronRun.findMany({ orderBy: { startedAt: 'desc' }, take: 6,
  select: { jobName: true, status: true, startedAt: true, outputSummary: true, errorMessage: true } })
for (const r of rows) console.log(`  ${r.startedAt.toISOString()}  ${r.jobName.padEnd(22)} ${String(r.status).padEnd(8)} ${r.errorMessage ? 'ERROR: '+r.errorMessage.slice(0,60) : String(r.outputSummary ?? '').slice(0,60)}`)
console.log('\nerrors in the last 6:', rows.filter(r=>r.errorMessage).length)
await prisma.$disconnect()
