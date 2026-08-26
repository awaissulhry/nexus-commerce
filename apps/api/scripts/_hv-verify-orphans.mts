/**
 * HV — what are the 71 performance rows attached to local-only keywords? READ-ONLY.
 *
 * A row that never reached Amazon should have no performance history. Three candidate
 * explanations, and they lead to different dispositions:
 *   A. the row DID reach Amazon and its id was later cleared (AX2.0 orphaning) — real history
 *   B. localEntityId was resolved by something other than externalTargetId — misattribution
 *   C. the census's membership is wrong
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ the 71 performance rows ═══\n')

// the local-only engine population
const engLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_keyword', userId: 'automation:auto-harvest' }, select: { entityId: true },
})
const engIds = [...new Set(engLogs.map((l) => l.entityId))]
const eng = await prisma.adTarget.findMany({
  where: { id: { in: engIds } },
  select: { id: true, expressionValue: true, expressionType: true, externalTargetId: true, status: true,
    orphanedAt: true, orphanReason: true, lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true, createdAt: true,
    adGroup: { select: { name: true, campaign: { select: { name: true, targetingType: true, marketplace: true } } } } },
})
const localOnly = eng.filter((t) => !t.externalTargetId)
console.log(`engine keywords ${eng.length} · local-only ${localOnly.length}`)

// ── A · were any of them ORPHANED — i.e. they DID exist at Amazon? ──────────
const orphaned = localOnly.filter((t) => t.orphanedAt)
const everSynced = localOnly.filter((t) => t.lastSyncedAt)
console.log(`\n── A · did any local-only row ever exist at Amazon? ──`)
console.log(`  carrying orphanedAt (Amazon said entityNotFound):  ${orphaned.length}`)
console.log(`  carrying lastSyncedAt (a sync was attempted):      ${everSynced.length}`)
const syncStatus = new Map<string, number>()
for (const t of localOnly) syncStatus.set(String(t.lastSyncStatus ?? '(never attempted)'), (syncStatus.get(String(t.lastSyncStatus ?? '(never attempted)')) ?? 0) + 1)
console.log(`  lastSyncStatus: ${[...syncStatus.entries()].map(([s, n]) => `${s}=${n}`).join(' · ')}`)
for (const t of orphaned.slice(0, 5)) console.log(`    orphaned: "${t.expressionValue}" at ${t.orphanedAt?.toISOString().slice(0, 10)} — ${t.orphanReason ?? '(no reason)'}`)

// ── B · the performance rows themselves ─────────────────────────────────────
const ids = localOnly.map((t) => t.id)
const perf = await prisma.amazonAdsDailyPerformance.findMany({
  where: { entityType: 'AD_TARGET', localEntityId: { in: ids } },
  select: { localEntityId: true, entityId: true, date: true, impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true, marketplace: true, reportedAt: true },
  orderBy: { date: 'asc' },
})
console.log(`\n── B · performance rows attached to local-only keywords: ${perf.length} ──`)
if (perf.length) {
  const byTarget = new Map<string, typeof perf>()
  for (const p of perf) { const g = byTarget.get(p.localEntityId!) ?? []; g.push(p); byTarget.set(p.localEntityId!, g) }
  console.log(`  distinct local-only targets carrying performance: ${byTarget.size}`)
  console.log(`  date range: ${perf[0].date.toISOString().slice(0, 10)} → ${perf[perf.length - 1].date.toISOString().slice(0, 10)}`)
  const tot = perf.reduce((s, p) => ({
    i: s.i + (p.impressions ?? 0), c: s.c + (p.clicks ?? 0),
    sp: s.sp + Math.round(Number(p.costMicros ?? 0n) / 10000), sa: s.sa + (p.sales7dCents ?? 0), o: s.o + (p.orders7d ?? 0),
  }), { i: 0, c: 0, sp: 0, sa: 0, o: 0 })
  console.log(`  totals: impressions ${int(tot.i)} · clicks ${int(tot.c)} · spend ${eur(tot.sp)} · sales ${eur(tot.sa)} · orders ${tot.o}`)
  console.log(`\n  ${pad('keyword', 34)} ${pad('rows', 5)} ${pad('amazon entityId on the perf row', 22)} ${pad('impr', 7)} ${pad('spend', 9)} orphaned?`)
  for (const [tid, g] of [...byTarget.entries()].slice(0, 12)) {
    const t = localOnly.find((x) => x.id === tid)!
    const extIds = [...new Set(g.map((p) => p.entityId))]
    const impr = g.reduce((s, p) => s + (p.impressions ?? 0), 0)
    const sp = g.reduce((s, p) => s + Math.round(Number(p.costMicros ?? 0n) / 10000), 0)
    console.log(`  ${pad(t.expressionValue, 34)} ${pad(String(g.length), 5)} ${pad(extIds.join(',').slice(0, 21), 22)} ${pad(int(impr), 7)} ${pad(eur(sp), 9)} ${t.orphanedAt ? 'YES' : 'no'}`)
  }
  // 🔴 does that Amazon entityId belong to a DIFFERENT AdTarget row?
  const extIds = [...new Set(perf.map((p) => p.entityId).filter(Boolean))] as string[]
  const owners = await prisma.adTarget.findMany({ where: { externalTargetId: { in: extIds } }, select: { id: true, externalTargetId: true, expressionValue: true } })
  console.log(`\n  distinct Amazon entityIds on those perf rows: ${extIds.length}`)
  console.log(`  of those, owned by a DIFFERENT AdTarget row that does have the id: ${owners.length}`)
  for (const o of owners.slice(0, 8)) console.log(`    ${pad(o.externalTargetId ?? '', 20)} belongs to "${o.expressionValue}"`)
  console.log(`  ⇒ if that count is > 0, localEntityId was resolved by TEXT or ad-group, not by Amazon id`)
}

// ── C · the bid writes against phantom rows ────────────────────────────────
const bidLogs = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'], where: { entityType: 'AD_TARGET', entityId: { in: ids } }, _count: { _all: true },
})
console.log(`\n── C · audit rows pointing at local-only keywords ──`)
for (const b of bidLogs) console.log(`  ${pad(b.actionType, 30)} ${int(b._count._all)}`)
const bidRows = await prisma.advertisingActionLog.findMany({
  where: { entityType: 'AD_TARGET', entityId: { in: ids }, actionType: 'AD_BID_UPDATE' },
  select: { createdAt: true, userId: true, amazonResponseStatus: true }, orderBy: { createdAt: 'desc' }, take: 2000,
})
const byActor = new Map<string, number>(); const byStatus = new Map<string, number>()
for (const b of bidRows) {
  byActor.set(b.userId ?? '(null)', (byActor.get(b.userId ?? '(null)') ?? 0) + 1)
  byStatus.set(String(b.amazonResponseStatus ?? '(null)'), (byStatus.get(String(b.amazonResponseStatus ?? '(null)')) ?? 0) + 1)
}
console.log(`  AD_BID_UPDATE by status: ${[...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join(' · ')}`)
console.log(`  top actors: ${[...byActor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, n]) => `${a.slice(0, 34)}=${n}`).join(' · ')}`)
if (bidRows.length) console.log(`  newest ${bidRows[0].createdAt.toISOString().slice(0, 16)} · oldest of ${bidRows.length} sampled ${bidRows[bidRows.length - 1].createdAt.toISOString().slice(0, 16)}`)
console.log(`  ⇒ 🔴 a bid write against a target with no externalTargetId can never reach Amazon`)

// is ARCHIVED already in use for positive keywords?
const st = await prisma.adTarget.groupBy({ by: ['status'], where: { kind: 'KEYWORD', isNegative: false }, _count: { _all: true } })
console.log(`\n── D · is ARCHIVED already a used state? ──`)
console.log(`  ${st.map((s) => `${s.status}=${int(s._count._all)}`).join(' · ')}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
