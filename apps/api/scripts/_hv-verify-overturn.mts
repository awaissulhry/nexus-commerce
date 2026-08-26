/**
 * HV — verifying the third overturn. READ-ONLY.
 *   1. did the 54 pushes create keywords, or find ones that already existed?
 *   2. D-B account-wide: bid writes against targets with no Amazon id
 *   3. D-A: perf rows bound to a target that does not hold the row's own entityId
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const now = Date.now()

console.log('\n═══ third-overturn verification ═══\n')

// ── 1 · did the pushes create anything? ─────────────────────────────────────
console.log('── 1 · the six Amazon ids, dated by their own performance ──')
const PUSH_DAY = new Date('2026-08-13T00:00:00Z')
const pushLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'push_keyword' },
  select: { entityId: true, createdAt: true, payloadAfter: true },
})
console.log(`  push_keyword audit rows: ${pushLogs.length}`)
const pushedTargets = await prisma.adTarget.findMany({
  where: { id: { in: [...new Set(pushLogs.map((l) => l.entityId))] } },
  select: { id: true, expressionValue: true, externalTargetId: true, createdAt: true },
})
const withId = pushedTargets.filter((t) => t.externalTargetId)
console.log(`  targets touched by a push: ${pushedTargets.length} · now carrying an Amazon id: ${withId.length}`)

console.log(`\n  ${pad('amazon id', 18)} ${pad('keyword', 30)} ${pad('perf rows', 10)} ${pad('first perf', 12)} ${pad('last perf', 12)} verdict`)
for (const t of withId) {
  const ext = t.externalTargetId!
  const perf = await prisma.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'AD_TARGET', entityId: ext },
    _count: true, _min: { date: true }, _max: { date: true }, _sum: { impressions: true },
  })
  const first = perf._min.date
  const verdict = perf._count === 0 ? 'no performance — UNPROVEN'
    : first && first < PUSH_DAY ? '🔴 EXISTED BEFORE the push'
    : 'created by the push'
  console.log(`  ${pad(ext, 18)} ${pad(t.expressionValue, 30)} ${pad(int(perf._count), 10)} ${pad(first?.toISOString().slice(0, 10) ?? '—', 12)} ${pad(perf._max.date?.toISOString().slice(0, 10) ?? '—', 12)} ${verdict}  imp ${int(perf._sum.impressions ?? 0)}`)
}
const preExisting = []
for (const t of withId) {
  const m = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'AD_TARGET', entityId: t.externalTargetId! }, _min: { date: true }, _count: true })
  if (m._count > 0 && m._min.date && m._min.date < PUSH_DAY) preExisting.push(t.externalTargetId)
}
console.log(`\n  ⇒ provably pre-existing: ${preExisting.length} of ${withId.length}   [session said 5 of 6]`)

// ── 2 · D-B account-wide ────────────────────────────────────────────────────
console.log('\n── 2 · D-B: bid writes against targets with NO Amazon id ──')
const idless = await prisma.adTarget.findMany({ where: { externalTargetId: null }, select: { id: true, kind: true, isNegative: true } })
const idlessIds = idless.map((t) => t.id)
console.log(`  AdTarget rows with no externalTargetId: ${int(idless.length)}`)
const bw = await prisma.advertisingActionLog.findMany({
  where: { entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', entityId: { in: idlessIds } },
  select: { entityId: true, createdAt: true, amazonResponseStatus: true, userId: true },
})
const byStatus = new Map<string, number>()
for (const b of bw) byStatus.set(String(b.amazonResponseStatus ?? '(null)'), (byStatus.get(String(b.amazonResponseStatus ?? '(null)')) ?? 0) + 1)
const dates = bw.map((b) => b.createdAt.getTime()).sort((a, b) => a - b)
console.log(`  AD_BID_UPDATE rows against them: ${int(bw.length)}   [session said 1,938]`)
console.log(`  distinct targets: ${new Set(bw.map((b) => b.entityId)).size}   [session said 120]`)
console.log(`  by status: ${[...byStatus.entries()].map(([s, n]) => `${s}=${int(n)}`).join(' · ')}   [session said 1,926 SUCCESS · 12 PENDING · 0 refusals]`)
if (dates.length) console.log(`  range: ${new Date(dates[0]).toISOString().slice(0, 16)} → ${new Date(dates[dates.length - 1]).toISOString().slice(0, 16)}`)

const engLogs = await prisma.advertisingActionLog.findMany({ where: { actionType: 'create_keyword', userId: 'automation:auto-harvest' }, select: { entityId: true } })
const cohort = new Set(engLogs.map((l) => l.entityId))
const inCohort = bw.filter((b) => cohort.has(b.entityId)).length
const outTargets = new Set(bw.filter((b) => !cohort.has(b.entityId)).map((b) => b.entityId))
console.log(`  inside the harvest cohort: ${int(inCohort)} · outside: ${int(bw.length - inCohort)} across ${outTargets.size} targets   [session said 1,458 / 480 / 7]`)
console.log(`  ⇒ ${outTargets.size > 0 ? '🔴 ACCOUNT-WIDE guard gap, not a harvest artefact' : 'harvest-only'}`)
const today = bw.filter((b) => b.createdAt.getTime() > now - 86_400_000).length
console.log(`  written in the last 24h: ${today}`)

// ── 3 · D-A ─────────────────────────────────────────────────────────────────
console.log('\n── 3 · D-A: perf rows bound to a target that does not hold their entityId ──')
const mism = await prisma.$queryRawUnsafe<Array<{ n: bigint; targets: bigint }>>(`
  select count(*)::bigint n, count(distinct p."localEntityId")::bigint targets
  from "AmazonAdsDailyPerformance" p join "AdTarget" t on t.id = p."localEntityId"
  where p."entityType" = 'AD_TARGET'
    and (t."externalTargetId" is null or t."externalTargetId" <> p."entityId")`)
console.log(`  misbound performance rows: ${int(Number(mism[0].n))} across ${mism[0].targets} targets   [session said 188 across 5]`)
const dupExt = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`
  select count(*)::bigint n from (select "externalTargetId" from "AdTarget"
  where "externalTargetId" is not null group by 1 having count(*) > 1) x`)
console.log(`  externalTargetIds carried by >1 row today: ${dupExt[0].n}  ⇒ the ambiguity is ${Number(dupExt[0].n) === 0 ? 'DORMANT, not fixed' : 'LIVE'}`)
console.log(`  resolver: ads-reports.service.ts:794 findFirst({ where: { externalTargetId } }) — by Amazon id, non-unique column`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
