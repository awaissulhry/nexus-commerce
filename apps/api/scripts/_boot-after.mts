/** READ-ONLY: prints NEWBOOT if the API booted after the given unix-seconds arg. */
const { default: prisma } = await import('../src/db.js')
const after = Number(process.argv[2] ?? 0) * 1000
const boot = await prisma.cronRun.findFirst({
  where: { jobName: 'amazon-notifications-setup' },
  orderBy: { startedAt: 'desc' },
  select: { startedAt: true },
})
if (boot && boot.startedAt.getTime() > after) console.log(`NEWBOOT ${boot.startedAt.toISOString()}`)
else console.log(`no new boot (last ${boot?.startedAt.toISOString() ?? 'none'})`)
await prisma.$disconnect()
process.exit(0)
