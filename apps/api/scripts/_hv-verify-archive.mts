/**
 * HV — verifying the archive, and the one thing nobody has checked:
 * does ARCHIVED actually stop the bid writes, or is rank-defend now writing to retired rows?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const now = Date.now()

console.log('\n═══ archive verification ═══\n')

// ── 1 · the archive landed ──────────────────────────────────────────────────
const st = await prisma.adTarget.groupBy({ by: ['status'], where: { kind: 'KEYWORD', isNegative: false }, _count: { _all: true } })
console.log('── 1 · positive KEYWORD status ──')
console.log(`  ${st.map((s) => `${s.status}=${int(s._count._all)}`).join(' · ')}   [was PAUSED 119 · ENABLED 1,983 · ARCHIVED 28]`)

const engLogs = await prisma.advertisingActionLog.findMany({ where: { actionType: 'create_keyword', userId: 'automation:auto-harvest' }, select: { entityId: true } })
const engIds = [...new Set(engLogs.map((l) => l.entityId))]
const eng = await prisma.adTarget.findMany({ where: { id: { in: engIds } }, select: { id: true, status: true, externalTargetId: true } })
const liveLocalOnly = eng.filter((t) => !t.externalTargetId && String(t.status) !== 'ARCHIVED')
console.log(`\n  engine cohort ${eng.length} · ARCHIVED ${eng.filter((t) => String(t.status) === 'ARCHIVED').length} · with an Amazon id ${eng.filter((t) => t.externalTargetId).length}`)
console.log(`  LIVE local-only in the cohort: ${liveLocalOnly.length}   [session said 0]`)

// ── 2 · account-wide id-less population, by status ──────────────────────────
const idless = await prisma.adTarget.groupBy({ by: ['status'], where: { externalTargetId: null }, _count: { _all: true } })
console.log(`\n── 2 · id-less AdTarget rows account-wide, by status ──`)
console.log(`  ${idless.map((s) => `${s.status}=${int(s._count._all)}`).join(' · ')}   [was 258 total]`)
const idlessLive = await prisma.adTarget.count({ where: { externalTargetId: null, status: { not: 'ARCHIVED' } } })
console.log(`  still live (not ARCHIVED) and id-less: ${int(idlessLive)}`)

// ── 3 · 🔴 did archiving stop D-B? ──────────────────────────────────────────
console.log('\n── 3 · D-B since the archive — is rank-defend writing to ARCHIVED rows? ──')
const archived = await prisma.adTarget.findMany({ where: { externalTargetId: null, status: 'ARCHIVED' }, select: { id: true } })
const archivedIds = new Set(archived.map((t) => t.id))
const recent = await prisma.advertisingActionLog.findMany({
  where: { entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE', createdAt: { gte: new Date(now - 3 * 86_400_000) } },
  select: { entityId: true, createdAt: true, amazonResponseStatus: true, userId: true },
  orderBy: { createdAt: 'desc' },
})
const idlessAll = new Set((await prisma.adTarget.findMany({ where: { externalTargetId: null }, select: { id: true } })).map((t) => t.id))
const vsIdless = recent.filter((b) => idlessAll.has(b.entityId))
const vsArchived = recent.filter((b) => archivedIds.has(b.entityId))
console.log(`  AD_BID_UPDATE rows in the last 72h: ${int(recent.length)}`)
console.log(`  …against an id-less target: ${int(vsIdless.length)}`)
console.log(`  …against an ARCHIVED id-less target: ${int(vsArchived.length)}   ${vsArchived.length > 0 ? '🔴 ARCHIVING DID NOT STOP IT' : '✅ none since'}`)
if (vsIdless.length) {
  const newest = vsIdless[0]
  console.log(`  newest such write: ${newest.createdAt.toISOString().slice(0, 16)} · status ${newest.amazonResponseStatus} · actor ${(newest.userId ?? '').slice(0, 40)}`)
}
// by day, to see whether the rate changed at the archive
const byDay = new Map<string, number>()
for (const b of vsIdless) { const d = b.createdAt.toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1) }
console.log(`  id-less bid writes by day: ${[...byDay.entries()].sort().map(([d, n]) => `${d}=${n}`).join(' · ') || 'none'}`)

// ── 4 · the 9 groups' Amazon keywords ───────────────────────────────────────
console.log('\n── 4 · archived rows whose keyword exists at Amazon under another row ──')
const arch = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false, status: 'ARCHIVED', externalTargetId: null },
  select: { expressionValue: true, expressionType: true, adGroupId: true },
})
const live = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false, externalTargetId: { not: null } },
  select: { expressionValue: true, expressionType: true, adGroupId: true, externalTargetId: true, status: true },
})
const liveKey = new Map(live.map((t) => [`${t.adGroupId}|${t.expressionType.toUpperCase()}|${t.expressionValue.trim().toLowerCase()}`, t]))
let covered = 0, orphanText = 0
for (const a of arch) {
  const hit = liveKey.get(`${a.adGroupId}|${a.expressionType.toUpperCase()}|${a.expressionValue.trim().toLowerCase()}`)
  if (hit) covered++; else orphanText++
}
console.log(`  archived id-less rows: ${int(arch.length)}`)
console.log(`  …whose (ad group · match · text) IS held by a live row with an Amazon id: ${int(covered)}`)
console.log(`  …with no live twin: ${int(orphanText)}   ⇒ these were genuinely never at Amazon`)

// ── 5 · the engine, untouched ───────────────────────────────────────────────
console.log('\n── 5 · the engine ──')
for (const r of await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 3, select: { startedAt: true, outputSummary: true } }))
  console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${r.outputSummary}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
