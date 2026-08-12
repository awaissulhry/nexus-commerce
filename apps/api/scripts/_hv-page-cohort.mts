/**
 * HV page study — can we answer "did harvesting work?" READ-ONLY.
 *
 * The prior study's Tier 3 says "track each harvested keyword's performance after promotion, from
 * AmazonAdsDailyPerformance". Nobody in the industry ships that view. This measures whether it is
 * actually buildable on today's data — the join, the coverage, and a real cohort result.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const now = Date.now()

console.log('\n═══ HV page — the post-graduation cohort ═══\n')

// ── 1. does the join exist at all? ────────────────────────────────────────────
const dp = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'AD_TARGET' }, _count: true, _max: { date: true }, _min: { date: true } })
console.log(`AmazonAdsDailyPerformance entityType=AD_TARGET: ${int(dp._count)} rows · ${dp._min.date?.toISOString().slice(0, 10)} → ${dp._max.date?.toISOString().slice(0, 10)}`)

const sample = await prisma.amazonAdsDailyPerformance.findMany({ where: { entityType: 'AD_TARGET' }, take: 3, select: { localEntityId: true, entityId: true, date: true, impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true, marketplace: true, acos7d: true } })
console.log(`sample row: ${JSON.stringify(sample[0], (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`)

const pos = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { id: true, expressionValue: true, expressionType: true, createdAt: true, bidCents: true, externalTargetId: true, status: true, adGroup: { select: { name: true, campaign: { select: { name: true, marketplace: true, targetingType: true } } } } },
})
const posIds = new Set(pos.map((t) => t.id))
const perf = await prisma.amazonAdsDailyPerformance.findMany({
  where: { entityType: 'AD_TARGET', date: { gte: new Date(now - 90 * 86_400_000) } },
  select: { localEntityId: true, date: true, impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
})
const matched = perf.filter((p) => p.localEntityId && posIds.has(p.localEntityId))
console.log(`\nperformance rows (90d, AD_TARGET): ${int(perf.length)}`)
console.log(`  localEntityId resolves to a positive KEYWORD AdTarget: ${int(matched.length)} (${Math.round((matched.length / Math.max(1, perf.length)) * 100)}%)`)
console.log(`  distinct targets with any performance row: ${int(new Set(matched.map((p) => p.localEntityId)).size)} of ${int(pos.length)} positive keywords`)
console.log(`  ⇒ the join ${matched.length ? 'WORKS' : 'DOES NOT WORK'} — this is what a "did it work?" view would read`)

// ── 2. the cohort: keywords created in the last 90 days ───────────────────────
console.log('\n\n═══ 2 · every keyword created in the last 90 days, and what it did AFTER ═══\n')
const byTarget = new Map<string, Array<typeof perf[number]>>()
for (const p of matched) { const g = byTarget.get(p.localEntityId!) ?? []; g.push(p); byTarget.set(p.localEntityId!, g) }

const cohort = pos.filter((t) => t.createdAt.getTime() > now - 90 * 86_400_000)
console.log(`keywords created in 90 days: ${int(cohort.length)}`)
let withAny = 0, totalImpr = 0, totalClicks = 0, totalCost = 0, totalSales = 0, totalOrders = 0
const rows: Array<{ kw: string; created: Date; impr: number; clicks: number; cost: number; sales: number; orders: number; bid: number; camp: string; ext: boolean }> = []
for (const t of cohort) {
  const g = (byTarget.get(t.id) ?? []).filter((p) => p.date >= t.createdAt)
  const impr = g.reduce((s, p) => s + (p.impressions ?? 0), 0)
  const clicks = g.reduce((s, p) => s + (p.clicks ?? 0), 0)
  const cost = g.reduce((s, p) => s + Math.round(Number(p.costMicros ?? 0n) / 10000), 0)
  const sales = g.reduce((s, p) => s + (p.sales7dCents ?? 0), 0)
  const orders = g.reduce((s, p) => s + (p.orders7d ?? 0), 0)
  if (impr > 0) withAny++
  totalImpr += impr; totalClicks += clicks; totalCost += cost; totalSales += sales; totalOrders += orders
  rows.push({ kw: t.expressionValue, created: t.createdAt, impr, clicks, cost, sales, orders, bid: t.bidCents, camp: `${t.adGroup?.campaign?.name ?? '?'}`, ext: !!t.externalTargetId })
}
console.log(`  with any impression AFTER creation: ${int(withAny)} (${Math.round((withAny / Math.max(1, cohort.length)) * 100)}%)`)
console.log(`  cohort totals — impressions ${int(totalImpr)} · clicks ${int(totalClicks)} · spend ${eur(totalCost)} · sales ${eur(totalSales)} · orders ${int(totalOrders)}`)
console.log(`  cohort ACoS: ${totalSales ? `${Math.round((totalCost / totalSales) * 100)}%` : 'n/a (no sales)'}`)
console.log(`  reached Amazon (has externalTargetId): ${int(cohort.filter((t) => t.externalTargetId).length)} of ${int(cohort.length)}`)

console.log(`\ntop 15 of the cohort by sales:`)
console.log(`${pad('keyword', 42)} ${pad('created', 11)} ${pad('bid', 7)} ${pad('impr', 8)} ${pad('clicks', 7)} ${pad('spend', 9)} ${pad('sales', 9)} ${pad('ord', 4)} campaign`)
for (const r of rows.sort((a, b) => b.sales - a.sales || b.impr - a.impr).slice(0, 15)) {
  console.log(`${pad(r.kw, 42)} ${pad(r.created.toISOString().slice(0, 10), 11)} ${pad(eur(r.bid), 7)} ${pad(int(r.impr), 8)} ${pad(int(r.clicks), 7)} ${pad(eur(r.cost), 9)} ${pad(eur(r.sales), 9)} ${pad(String(r.orders), 4)} ${r.camp.slice(0, 34)}`)
}

// ── 3. the engine's own cohort — what automation:auto-harvest created ─────────
console.log('\n\n═══ 3 · the engine\'s own cohort ═══\n')
const engineLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_keyword', userId: 'automation:auto-harvest' },
  select: { entityId: true, createdAt: true, payloadAfter: true },
})
console.log(`create_keyword rows written by automation:auto-harvest (all time): ${int(engineLogs.length)}`)
const engIds = new Set(engineLogs.map((l) => l.entityId))
const engTargets = pos.filter((t) => engIds.has(t.id))
console.log(`  still present as positive keyword targets: ${int(engTargets.length)}`)
let engImpr = 0, engSales = 0, engCost = 0, engOrders = 0, engWith = 0
for (const t of engTargets) {
  const g = (byTarget.get(t.id) ?? []).filter((p) => p.date >= t.createdAt)
  const i = g.reduce((s, p) => s + (p.impressions ?? 0), 0)
  if (i > 0) engWith++
  engImpr += i
  engCost += g.reduce((s, p) => s + Math.round(Number(p.costMicros ?? 0n) / 10000), 0)
  engSales += g.reduce((s, p) => s + (p.sales7dCents ?? 0), 0)
  engOrders += g.reduce((s, p) => s + (p.orders7d ?? 0), 0)
}
console.log(`  with impressions after creation: ${engWith} · impressions ${int(engImpr)} · spend ${eur(engCost)} · sales ${eur(engSales)} · orders ${engOrders}`)
console.log(`  reached Amazon: ${engTargets.filter((t) => t.externalTargetId).length} of ${engTargets.length}`)
console.log(`  ⚠ performance rows only cover ${dp._min.date?.toISOString().slice(0, 10)}+, so keywords created before that have no measurable "after"`)

// ── 4. the four dead AdTarget metric columns ──────────────────────────────────
console.log('\n\n═══ 4 · the dead AdTarget metric columns ═══\n')
const nonZero = await prisma.adTarget.count({ where: { OR: [{ impressions: { gt: 0 } }, { clicks: { gt: 0 } }, { spendCents: { gt: 0 } }, { salesCents: { gt: 0 } }, { ordersCount: { gt: 0 } }] } })
const totalT = await prisma.adTarget.count()
console.log(`AdTarget rows with ANY non-zero impressions/clicks/spend/sales/orders: ${int(nonZero)} of ${int(totalT)}`)
console.log(`⇒ any surface reading AdTarget.spendCents/acos sees ${nonZero === 0 ? 'ZERO for every row' : 'partial data'} (confirms the prior study's §5 correction)`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
