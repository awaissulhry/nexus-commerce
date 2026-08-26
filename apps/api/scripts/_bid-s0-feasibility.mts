/**
 * BID.S0 — can `GET /advertising/targets` serve the S0 grid, or is a new read needed?
 *
 * READ-ONLY. No writes, no mutations.
 *
 * The brief says prefer the existing route. Before agreeing or disagreeing, measure the four
 * things that decide it:
 *   1. how many positive AdTarget rows exist vs the route's hard `take` cap of 2,000;
 *   2. how many of them carry a 30-day AmazonAdsDailyPerformance row at all — the metric columns
 *      are only worth rendering if they are populated;
 *   3. what a campaign roll-up needs (campaigns holding positive targets, per market);
 *   4. the bid-band buckets the FilterBar is supposed to offer.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ BID.S0 — grid feasibility ═══\n')

// ── 1. the population the grid must show ────────────────────────────────────
const positives = await prisma.adTarget.count({ where: { isNegative: false } })
const byStatus = await prisma.adTarget.groupBy({
  by: ['status'],
  where: { isNegative: false },
  _count: { _all: true },
})
console.log(`positive AdTarget rows        ${int(positives)}   (route cap: take=2000)`)
for (const s of byStatus.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`  ${String(s.status ?? '(null)').padEnd(12)} ${int(s._count._all)}`)
}
console.log(positives > 2000
  ? `🔴 ${int(positives - 2000)} rows are UNREACHABLE through /advertising/targets, and it has no orderBy — the truncation is non-deterministic.`
  : '✅ fits inside the cap.')

// ── the same question at the ENABLED grain the page defaults to ─────────────
const enabledPositives = await prisma.adTarget.count({ where: { isNegative: false, status: 'ENABLED' } })
console.log(`\nENABLED positive targets      ${int(enabledPositives)}`)

// ── 2. metric coverage: is there anything to render in Impr/Clicks/CPC/ACoS? ─
const since = new Date(Date.now() - 30 * 86400_000)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'AD_TARGET', date: { gte: since } },
  _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true },
})
const perfIds = new Set(perf.map((p) => p.localEntityId).filter((x): x is string => !!x))
const withImpr = perf.filter((p) => (p._sum.impressions ?? 0) > 0).length
const withClicks = perf.filter((p) => (p._sum.clicks ?? 0) > 0).length
const withSpend = perf.filter((p) => Number(p._sum.costMicros ?? 0) > 0).length
console.log(`\n30-day AD_TARGET perf rows    ${int(perf.length)} distinct targets`)
console.log(`  with impressions > 0        ${int(withImpr)}`)
console.log(`  with clicks > 0             ${int(withClicks)}`)
console.log(`  with spend > 0              ${int(withSpend)}`)

// how many of the ENABLED positives are covered — a target with no perf row shows blank metrics
const enabledIds = await prisma.adTarget.findMany({
  where: { isNegative: false, status: 'ENABLED' },
  select: { id: true, bidCents: true, kind: true, expressionType: true },
})
const covered = enabledIds.filter((t) => perfIds.has(t.id)).length
console.log(`\nENABLED positives WITH a 30d perf row   ${int(covered)} of ${int(enabledIds.length)} (${((covered / Math.max(1, enabledIds.length)) * 100).toFixed(1)}%)`)
console.log(covered / Math.max(1, enabledIds.length) < 0.5
  ? '🔴 the majority of rows will render blank metrics — the page has to say why, not show "—".'
  : '✅ most rows carry metrics.')

// ── 3. the campaign roll-up view ────────────────────────────────────────────
const camps = await prisma.campaign.findMany({
  where: { adGroups: { some: { targets: { some: { isNegative: false } } } } },
  select: { id: true, name: true, marketplace: true, status: true, minBidCents: true, maxBidCents: true },
})
const byMkt = new Map<string, number>()
for (const c of camps) byMkt.set(c.marketplace ?? '(null)', (byMkt.get(c.marketplace ?? '(null)') ?? 0) + 1)
console.log(`\ncampaigns holding a positive target   ${int(camps.length)}`)
console.log(`  by market   ${[...byMkt.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(' · ')}`)
console.log(`  ENABLED     ${int(camps.filter((c) => c.status === 'ENABLED').length)}`)
console.log(`  with maxBidCents set   ${int(camps.filter((c) => c.maxBidCents != null).length)}`)
console.log(`  with minBidCents set   ${int(camps.filter((c) => c.minBidCents != null).length)}`)

// ── 4. the bid bands the FilterBar offers ───────────────────────────────────
const bands: Array<[string, (b: number) => boolean]> = [
  ['0-5¢', (b) => b <= 5],
  ['6-20¢', (b) => b >= 6 && b <= 20],
  ['21-50¢', (b) => b >= 21 && b <= 50],
  ['51-100¢', (b) => b >= 51 && b <= 100],
  ['100¢+', (b) => b > 100],
]
console.log('\nENABLED positive targets by bid band (a clock reading — the floor population swings ~400 overnight):')
for (const [label, f] of bands) {
  const rows = enabledIds.filter((t) => f(t.bidCents ?? 0))
  console.log(`  ${label.padEnd(9)} ${String(int(rows.length)).padStart(6)}`)
}
const nullBid = enabledIds.filter((t) => t.bidCents == null).length
console.log(`  (null bid) ${String(int(nullBid)).padStart(6)}${nullBid > 0 ? '   ← inherits the ad group default; a band filter must not silently drop these' : ''}`)

// kind / match split, for the two filter chips the study says cannot be shared
const kinds = new Map<string, number>()
const matches = new Map<string, number>()
for (const t of enabledIds) {
  kinds.set(t.kind ?? '(null)', (kinds.get(t.kind ?? '(null)') ?? 0) + 1)
  matches.set(t.expressionType ?? '(null)', (matches.get(t.expressionType ?? '(null)') ?? 0) + 1)
}
console.log(`\nkind    ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${int(n)}`).join(' · ')}`)
console.log(`match   ${[...matches.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${int(n)}`).join(' · ')}`)

// ── 5. a cursor to poll: what moves, and does it carry a monotonic clock? ────
const newestLog = await prisma.advertisingActionLog.findFirst({
  where: { actionType: 'AD_BID_UPDATE' },
  orderBy: { createdAt: 'desc' },
  select: { id: true, createdAt: true },
})
const newestTarget = await prisma.adTarget.findFirst({
  where: { isNegative: false },
  orderBy: { updatedAt: 'desc' },
  select: { id: true, updatedAt: true },
})
console.log(`\nnewest AD_BID_UPDATE log row   ${newestLog?.createdAt?.toISOString() ?? '(none)'}`)
console.log(`newest AdTarget.updatedAt      ${newestTarget?.updatedAt?.toISOString() ?? '(none)'}`)

const bidsTotal = enabledIds.map((t) => t.bidCents ?? 0).filter((b) => b > 0).reduce((a, b) => a + b, 0)
console.log(`\nsum of ENABLED positive bids   ${c2e(bidsTotal)} (sanity check only)\n`)

await prisma.$disconnect()
