/** READ-ONLY: RT.3 post-deploy — subscription setup result + long-poll cadence. */
const { default: prisma } = await import('../src/db.js')

const setup = await prisma.cronRun.findFirst({
  where: { jobName: 'amazon-notifications-setup' },
  orderBy: { startedAt: 'desc' },
})
console.log('== amazon-notifications-setup (boot self-report) ==')
if (!setup) console.log('  NOT YET RECORDED (boot may still be running)')
else console.log(`  ${setup.startedAt.toISOString()} ${setup.status}\n  ${(setup as { outputSummary?: string }).outputSummary ?? ''}\n  err=${setup.errorMessage?.slice(0, 200) ?? 'none'}`)

const polls = await prisma.cronRun.findMany({
  where: { jobName: 'amazon-sqs-poll' },
  orderBy: { startedAt: 'desc' },
  take: 6,
  select: { startedAt: true, finishedAt: true, status: true, outputSummary: true },
})
console.log('== amazon-sqs-poll recent ticks (expect ~55s duration post-deploy) ==')
for (const p of polls) {
  const dur = p.finishedAt ? Math.round((p.finishedAt.getTime() - p.startedAt.getTime()) / 1000) : null
  console.log(`  ${p.startedAt.toISOString().slice(11, 19)} ${p.status} dur=${dur ?? '…'}s ${p.outputSummary ?? ''}`)
}

await prisma.$disconnect()
process.exit(0)
