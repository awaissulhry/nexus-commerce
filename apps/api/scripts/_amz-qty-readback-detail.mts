const { default: prisma } = await import('../src/db.js')
const runs = await prisma.cronRun.findMany({
  where: { jobName: { in: ['amazon-qty-readback', 'amazon-qty-readback-request'] } },
  orderBy: { startedAt: 'desc' }, take: 8,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true, errorMessage: true },
})
for (const r of runs) {
  console.log(`${r.startedAt.toISOString()}  ${r.jobName}  ${r.status}`)
  console.log(`   ${JSON.stringify(r.outputSummary) ?? ''}`.slice(0, 300))
  if (r.errorMessage) console.log(`   ERR: ${r.errorMessage.slice(0, 200)}`)
}
await prisma.$disconnect()
