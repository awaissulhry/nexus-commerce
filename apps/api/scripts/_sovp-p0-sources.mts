import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(2) + '%'

console.log('### REAL SIGNAL SOURCES — what an honest "share of voice" could be sourced from')

// ── 1 · Amazon's TRUE top-of-search impression share (campaign-day)
const placCount = await prisma.amazonAdsPlacementReport.count()
const placIS = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
const placRecent = await prisma.amazonAdsPlacementReport.findMany({ where: { topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, take: 5, select: { date: true, campaignId: true, placement: true, topOfSearchIS: true } })
console.log(`\n1 · AmazonAdsPlacementReport.topOfSearchIS (Amazon's REAL TOS impression share, campaign×day)`)
console.log(`   rows total ${placCount} · with topOfSearchIS ${placIS} (${pct(placIS/Math.max(1,placCount))})`)
for (const p of placRecent) console.log(`     ${p.date.toISOString().slice(0,10)} camp=${p.campaignId} ${p.placement} IS=${Number(p.topOfSearchIS).toFixed(4)}`)
const dailyIS = await prisma.amazonAdsDailyPerformance.count({ where: { topOfSearchIS: { not: null } } })
const dailyAll = await prisma.amazonAdsDailyPerformance.count({ where: { entityType: 'CAMPAIGN' } })
console.log(`   AmazonAdsDailyPerformance(CAMPAIGN).topOfSearchIS: ${dailyIS} of ${dailyAll} campaign rows`)

// ── 2 · SQP impressionShare — Amazon Brand Analytics' own per-QUERY market share
console.log(`\n2 · SearchQueryPerformance.impressionShare (Amazon's OWN per-query market share, weekly×ASIN)`)
const weeks = await prisma.searchQueryPerformance.groupBy({ by: ['startDate', 'marketplace'], _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 16 })
for (const w of weeks.slice(0, 12)) console.log(`   ${w.startDate.toISOString().slice(0,10)} ${w.marketplace}: ${w._count._all} rows`)
const sqpTot = await prisma.searchQueryPerformance.count()
const sqpNonZero = await prisma.searchQueryPerformance.count({ where: { impressionsTotal: { gt: 0 } } })
console.log(`   rows total ${sqpTot} · with a real market total ${sqpNonZero} (${pct(sqpNonZero/Math.max(1,sqpTot))})`)

// ── 3 · could the SOV context be re-sourced per keyword from SQP? coverage test
console.log(`\n3 · RE-SOURCING TEST — join positive keyword targets → SQP by (marketplace, lowercased query)`)
const targets = await prisma.adTarget.findMany({ where: { kind: 'KEYWORD', isNegative: false }, select: { id: true, expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } }, take: 3000 })
for (const nWeeks of [1, 2, 4, 8]) {
  const wk = (await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], orderBy: { startDate: 'desc' }, take: nWeeks })).map((w) => w.startDate)
  const rows = await prisma.searchQueryPerformance.findMany({ where: { startDate: { in: wk } }, select: { searchQuery: true, marketplace: true, impressionsTotal: true, impressionsBrand: true } })
  const m = new Map<string, { b: number; t: number }>()
  for (const r of rows) { const k = `${r.marketplace}|${(r.searchQuery||'').trim().toLowerCase()}`; const a = m.get(k) ?? { b: 0, t: 0 }; a.b += r.impressionsBrand ?? 0; a.t += r.impressionsTotal ?? 0; m.set(k, a) }
  let hit = 0, real = 0
  for (const t of targets) { const k = `${t.adGroup?.campaign?.marketplace}|${(t.expressionValue||'').trim().toLowerCase()}`; const a = m.get(k); if (a) { hit++; if (a.t > 0) real++ } }
  console.log(`   last ${nWeeks} week(s) [${wk.map((w)=>w.toISOString().slice(0,10)).join(',')}]: ${hit}/${targets.length} targets matched (${pct(hit/targets.length)}), ${real} with a real market total (${pct(real/targets.length)})`)
}

// ── 4 · the current engine's coverage, for the same denominator
const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')
const sov = await analyzeShareOfVoice({ windowDays: 30, limit: 1000 })
const cur = new Set(sov.rows.map((r) => r.query.trim().toLowerCase()))
let curHit = 0
for (const t of targets) if (cur.has((t.expressionValue||'').trim().toLowerCase())) curHit++
console.log(`\n4 · the CURRENT source covers ${curHit}/${targets.length} targets (${pct(curHit/targets.length)}) — for comparison`)

// ── 5 · KeywordRank (H10's actual SOV vocabulary is position-based)
const kr = await prisma.keywordRank.count()
console.log(`\n5 · KeywordRank rows (H10's SOV criteria are POSITION metrics — Avg Position, Page-1 Frequency): ${kr}`)
await prisma.$disconnect()
