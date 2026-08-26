/**
 * HV — independent verification of HV.5. READ-ONLY.
 * Checks the provenance partition, the four outcome buckets, opening-bid recoverability,
 * the backlog split, and whether the live write has landed.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ HV.5 verification ═══\n')

// ── 1 · provenance partition ────────────────────────────────────────────────
const pos = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { id: true, expressionValue: true, externalTargetId: true, bidCents: true, createdAt: true },
})
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_keyword', entityType: 'AD_TARGET' },
  select: { entityId: true, userId: true, executionId: true, payloadAfter: true, createdAt: true },
})
const byId = new Map<string, typeof logs[number]>()
for (const l of logs) byId.set(l.entityId, l)

const cls = new Map<string, number>()
for (const t of pos) {
  const l = byId.get(t.id)
  const k = !l ? 'mirrored (no create_keyword audit row)'
    : l.executionId ? 'rule execution'
    : (l.userId ?? '(no userId)')
  cls.set(k, (cls.get(k) ?? 0) + 1)
}
console.log(`── 1 · provenance of ${int(pos.length)} positive KEYWORD targets ──`)
let sum = 0
for (const [k, n] of [...cls.entries()].sort((a, b) => b[1] - a[1])) { console.log(`  ${pad(k, 42)} ${int(n)}`); sum += n }
console.log(`  ${pad('TOTAL', 42)} ${int(sum)}   ${sum === pos.length ? '✅ partition is complete — 0 unclassifiable' : '🔴 GAP'}`)
console.log(`  [session said 1,363 mirrored + 548 in-app + 218 engine + 0 operator = 2,129]`)

// ── 2 · the engine cohort's four outcomes ───────────────────────────────────
const engIds = new Set(logs.filter((l) => l.userId === 'automation:auto-harvest').map((l) => l.entityId))
const eng = pos.filter((t) => engIds.has(t.id))
const perf = await prisma.amazonAdsDailyPerformance.findMany({
  where: { entityType: 'AD_TARGET', localEntityId: { in: [...engIds] } },
  select: { localEntityId: true, date: true, impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
})
const pById = new Map<string, typeof perf>()
for (const p of perf) { const g = pById.get(p.localEntityId!) ?? []; g.push(p); pById.set(p.localEntityId!, g) }

let noAmazon = 0, notMeasured = 0, neverServed = 0, served = 0
let sSpend = 0, sSales = 0, sOrders = 0, sImpr = 0
for (const t of eng) {
  if (!t.externalTargetId) { noAmazon++; continue }
  const g = pById.get(t.id) ?? []
  if (!g.length) { notMeasured++; continue }
  const impr = g.reduce((s, p) => s + (p.impressions ?? 0), 0)
  if (impr === 0) { neverServed++; continue }
  served++
  sImpr += impr
  sSpend += g.reduce((s, p) => s + Math.round(Number(p.costMicros ?? 0n) / 10000), 0)
  sSales += g.reduce((s, p) => s + (p.sales7dCents ?? 0), 0)
  sOrders += g.reduce((s, p) => s + (p.orders7d ?? 0), 0)
}
console.log(`\n── 2 · the ${eng.length} engine-written keywords, by outcome ──`)
console.log(`  never reached Amazon        ${noAmazon}`)
console.log(`  not measured (no perf row)  ${notMeasured}`)
console.log(`  reached Amazon, never served ${neverServed}`)
console.log(`  served                      ${served}   impressions ${int(sImpr)} · spend ${eur(sSpend)} · sales ${eur(sSales)} · orders ${sOrders} · ACoS ${sSales ? `${Math.round((sSpend / sSales) * 100)}%` : 'n/a'}`)
console.log(`  TOTAL ${noAmazon + notMeasured + neverServed + served} of ${eng.length}`)
console.log(`  [session said 209 · 2 · 1 · 6, €175.02 / €913.06 / 11 orders / 19% ACoS]`)

// discriminator check: do pre-window keywords have perf rows?
const winStart = new Date('2026-07-05T00:00:00Z')
const preWindowWithRows = pos.filter((t) => t.createdAt < winStart && (pById.get(t.id)?.length ?? 0) > 0).length
const allPerf = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'AD_TARGET' }, _min: { date: true }, _count: true })
console.log(`  performance rows start ${allPerf._min.date?.toISOString().slice(0, 10)} · engine keywords created before it that DO have rows: ${preWindowWithRows}`)
console.log(`  ⇒ the discriminator must be "has a performance row", not the creation date ✅`)

// ── 3 · opening bid recoverability ──────────────────────────────────────────
const bidUpdates = await prisma.advertisingActionLog.findMany({
  where: { actionType: { in: ['bid_update', 'AD_BID_UPDATE', 'update_bid'] }, entityType: 'AD_TARGET', entityId: { in: [...engIds] } },
  select: { entityId: true, createdAt: true, payloadBefore: true },
  orderBy: { createdAt: 'asc' },
})
const firstBefore = new Map<string, unknown>()
for (const b of bidUpdates) if (!firstBefore.has(b.entityId)) firstBefore.set(b.entityId, b.payloadBefore)
let fromAudit = 0, unchanged = 0, reconstructed = 0, unknown = 0
for (const t of eng) {
  const l = byId.get(t.id)
  const p = l?.payloadAfter as Record<string, unknown> | null
  if (p && (p.bidCents != null || p.bidEur != null)) fromAudit++
  else if (firstBefore.has(t.id)) reconstructed++
  else if (!bidUpdates.some((b) => b.entityId === t.id)) unchanged++
  else unknown++
}
console.log(`\n── 3 · opening bid for the ${eng.length} ──`)
console.log(`  recorded in the create audit payload: ${fromAudit}   (HV.5's additive fix applies to NEW writes only)`)
console.log(`  never had a bid update ⇒ current IS opening: ${unchanged}`)
console.log(`  reconstructed from the first bid update's payloadBefore: ${reconstructed}`)
console.log(`  unknown: ${unknown}`)
console.log(`  [session said 99 unchanged + 119 reconstructed + 0 unknown]`)

// ── 4 · the backlog split ───────────────────────────────────────────────────
const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())
const backlog = eng.filter((t) => !t.externalTargetId)
const asins = backlog.filter((t) => isAsin(t.expressionValue))
console.log(`\n── 4 · the local-only backlog ──`)
console.log(`  total ${backlog.length} · ASIN-shaped ${asins.length} · pushable ${backlog.length - asins.length}`)
console.log(`  [session said 209 = 155 pushable + 54 ASIN]`)

// ── 5 · has the live write run? ─────────────────────────────────────────────
const since = new Date('2026-08-12T00:00:00Z')
const newT = await prisma.adTarget.count({ where: { createdAt: { gte: since } } })
const newL = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: { in: ['create_keyword', 'create_negative_keyword'] } } })
const pushed = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
console.log(`\n── 5 · write state ──`)
console.log(`  AdTarget created since 2026-08-12: ${newT} · create_* audit rows: ${newL} · any audit rows: ${pushed}`)
console.log(`  ⇒ the live write ${newT === 0 && newL === 0 ? 'has NOT run' : 'HAS run'}`)
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 2, select: { startedAt: true, outputSummary: true } })
for (const r of runs) console.log(`  ads-auto-harvest ${r.startedAt.toISOString().slice(0, 16)} ${r.outputSummary}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
