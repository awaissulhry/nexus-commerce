/** READ-ONLY: does Amazon still report activity for the 4 "deleted" targets? Proof they exist. */
const { default: prisma } = await import('../src/db.js')
const orph = await prisma.adTarget.findMany({ where: { orphanedAt: { not: null } }, select: { id: true, kind: true, expressionType: true, externalTargetId: true, orphanedAt: true, orphanReason: true, adGroup: { select: { campaign: { select: { id: true, name: true } } } } } })
for (const t of orph) {
  const ext = t.externalTargetId ?? ''
  // Amazon's own reporting is the witness: rows keyed to this targetId AFTER the orphan date can
  // only exist if Amazon still has the entity.
  const after = await prisma.amazonAdsDailyPerformance.findMany({
    where: { entityId: ext, date: { gte: t.orphanedAt! } },
    select: { date: true, impressions: true, clicks: true, costMicros: true },
    orderBy: { date: 'desc' }, take: 3,
  })
  const total = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityId: ext, date: { gte: t.orphanedAt! } }, _count: { _all: true }, _sum: { impressions: true, clicks: true } })
  console.log(`\n${t.kind}/${t.expressionType} ext=${ext} · ${t.adGroup?.campaign?.name}`)
  console.log(`  orphaned ${t.orphanedAt?.toISOString().slice(0,10)} · reason mentions: "${(t.orphanReason ?? '').match(/\((\w+)/)?.[1] ?? '?'}"  ← entity kind is ${t.kind}`)
  console.log(`  Amazon performance rows dated AFTER the orphan: ${total._count._all}  (impr ${total._sum.impressions ?? 0}, clicks ${total._sum.clicks ?? 0})`)
  for (const r of after) console.log(`    ${r.date.toISOString().slice(0,10)}  impr=${r.impressions} clicks=${r.clicks}`)
  console.log(`  VERDICT: ${total._count._all > 0 ? 'ALIVE at Amazon → false orphan' : 'no reporting evidence either way'}`)
}
console.log('\n═══ What is inside the 3,413 FAILED queue rows? ═══')
const rows = await prisma.outboundSyncQueue.findMany({ where: { syncStatus: 'FAILED' }, select: { errorCode: true, errorMessage: true, createdAt: true, syncType: true } })
const by = new Map<string, number>()
for (const r of rows) by.set(`${r.syncType ?? '—'}|${r.errorCode ?? '—'}`, (by.get(`${r.syncType ?? '—'}|${r.errorCode ?? '—'}`) ?? 0) + 1)
for (const [k, n] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(5)}×  ${k}`)
const oldest = rows.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), rows[0]?.createdAt ?? new Date())
const newest = rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), rows[0]?.createdAt ?? new Date())
console.log(`  span: ${oldest.toISOString().slice(0,10)} → ${newest.toISOString().slice(0,10)}`)
const isRouting = rows.filter((r) => /entitynotfound/i.test(r.errorMessage ?? '')).length
console.log(`  rows whose error is entityNotFound (the routing signature): ${isRouting} of ${rows.length}`)
await prisma.$disconnect()
