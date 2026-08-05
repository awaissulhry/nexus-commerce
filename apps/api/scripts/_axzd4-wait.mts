const { default: p } = await import('../src/db.js')
const runs = await p.cronRun.findMany({ where: { jobName: { contains: 'ads-sync' } }, orderBy: { startedAt: 'desc' }, take: 3,
  select: { jobName: true, startedAt: true, status: true, outputSummary: true } })
for (const r of runs) console.log(`RUN ${r.jobName} ${r.startedAt.toISOString().slice(11,19)} ${r.status} ${(r.outputSummary ?? '').slice(0,90)}`)
const n = await p.adDrift.count(); const open = await p.adDrift.count({ where: { resolvedAt: null } })
console.log('DRIFT total=', n, 'open=', open)
await p.$disconnect()
