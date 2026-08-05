const { default: prisma } = await import('../src/db.js')
const h = new Date(Date.now() - 2*3600e3)
const fails = await prisma.channelPublishAttempt.findMany({
  where: { channel: 'AMAZON', outcome: 'failure', createdAt: { gte: h }, NOT: { errorMessage: { contains: 'circuit open' } } },
  select: { errorMessage: true, marketplace: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 40,
})
const by = new Map<string,number>()
for (const f of fails) { const k=(f.errorMessage??'?').slice(0,110); by.set(k,(by.get(k)??0)+1) }
console.log(`REAL Amazon failures (non-circuit) last 2h = ${fails.length}`)
for (const [k,n] of [...by.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  [${n}] ${k}`)
const ok = await prisma.channelPublishAttempt.count({ where: { channel:'AMAZON', outcome:'success', mode:'live', createdAt: { gte: h } } })
console.log(`live/success last 2h = ${ok}`)
await prisma.$disconnect()
