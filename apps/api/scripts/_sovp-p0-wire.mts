import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(4) + '%'

const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')
const sovLimited = await analyzeShareOfVoice({ windowDays: 30, limit: 1000 })   // the engine's call
const sovAll = await analyzeShareOfVoice({ windowDays: 30, limit: 100000 })     // the whole aggregate

const mapLimited = new Map(sovLimited.rows.map((r) => [r.query.trim().toLowerCase(), r]))
const mapAll = new Map(sovAll.rows.map((r) => [r.query.trim().toLowerCase(), r]))

// exactly the engine's target query
const targets = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { id: true, expressionValue: true, bidCents: true, status: true, deliveryStatus: true, adGroup: { select: { id: true, campaign: { select: { id: true, marketplace: true, name: true } } } } },
  take: 3000,
})
const totalTargets = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
console.log(`### A · TARGET JOIN`)
console.log(`positive KEYWORD targets in DB: ${totalTargets} · fetched by the emitter (take:3000): ${targets.length}`)
let matchedLimited = 0, matchedAll = 0, blankKey = 0
const missedByLimit: string[] = []
for (const t of targets) {
  const key = (t.expressionValue ?? '').trim().toLowerCase()
  if (!key) { blankKey++; continue }
  const inL = mapLimited.has(key), inA = mapAll.has(key)
  if (inL) matchedLimited++
  if (inA) matchedAll++
  if (!inL && inA) missedByLimit.push(key)
}
console.log(`matched with the engine's limit:1000 → ${matchedLimited} contexts (${pct(matchedLimited/Math.max(1,targets.length))} of targets)`)
console.log(`matched with NO limit             → ${matchedAll} (${pct(matchedAll/Math.max(1,targets.length))})`)
console.log(`🔴 targets silently dropped by limit:1000 alone: ${missedByLimit.length} (${[...new Set(missedByLimit)].length} distinct keywords)`)
console.log(`   e.g. ${[...new Set(missedByLimit)].slice(0,6).map((k)=>`"${k}"`).join(', ')}`)
console.log(`targets with NO search-term row at all: ${targets.length - matchedAll - blankKey} · blank expressionValue: ${blankKey}`)

// state of the matched targets — would a bid write even be legal?
const matchedTargets = targets.filter((t) => mapLimited.has((t.expressionValue ?? '').trim().toLowerCase()))
const byState: Record<string, number> = {}
for (const t of matchedTargets) byState[t.status ?? '?'] = (byState[t.status ?? "?"] ?? 0) + 1
console.log(`matched-target status: ${JSON.stringify(byState)}`)
const supp = matchedTargets.filter((t) => (t.bidCents ?? 999) <= 3)
console.log(`matched targets at a suppression bid (<=3c): ${supp.length}`)

// ── B · cross-market contamination on the ACTUAL joins
console.log(`\n### B · CROSS-MARKET CONTAMINATION on the joins the engine makes`)
const stRows = await prisma.amazonAdsSearchTerm.groupBy({ by: ['query', 'marketplace'], where: { date: { gte: new Date(Date.now() - 30 * 864e5) } }, _sum: { impressions: true } })
const imprByQueryMkt = new Map<string, Map<string, number>>()
for (const r of stRows) { const k = (r.query || '').trim().toLowerCase(); if (!k) continue; if (!imprByQueryMkt.has(k)) imprByQueryMkt.set(k, new Map()); imprByQueryMkt.get(k)!.set(r.marketplace ?? '?', r._sum.impressions ?? 0) }
let contaminated = 0
const examples: string[] = []
for (const t of matchedTargets) {
  const key = (t.expressionValue ?? '').trim().toLowerCase()
  const tm = t.adGroup?.campaign?.marketplace
  const m = imprByQueryMkt.get(key)
  if (!m || !tm) continue
  const own = m.get(tm) ?? 0, all = [...m.values()].reduce((a, b) => a + b, 0)
  if (all > 0 && own / all < 0.999) { contaminated++; if (examples.length < 5) examples.push(`"${key}" target in ${tm}: own ${own} of ${all} impressions across ${[...m.keys()].join('+')}`) }
}
console.log(`matched targets whose SOV number mixes another marketplace's impressions: ${contaminated} of ${matchedTargets.length}`)
for (const e of examples) console.log(`   ${e}`)

// ── C · the SOV number vs the SQP-derived market share, same query
console.log(`\n### C · TWO SOURCES, ONE NAME — sovPct (engine) vs SQP market share (the parked page)`)
const sqpWeeks = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 4 })
console.log(`SQP latest weeks: ${sqpWeeks.map((w)=>`${w.startDate.toISOString().slice(0,10)}(${w._count._all})`).join(' ')}`)
const week = sqpWeeks[0]?.startDate
if (week) {
  const top = sovLimited.rows.slice(0, 40)
  let shown = 0
  for (const r of top) {
    const sq = await prisma.searchQueryPerformance.findMany({ where: { startDate: week, searchQuery: { equals: r.query, mode: 'insensitive' } }, select: { searchQuery: true, marketplace: true, impressionsTotal: true, impressionsBrand: true, impressionShare: true, asin: true } })
    if (!sq.length) continue
    const brand = sq.reduce((a, s) => a + (s.impressionsBrand ?? 0), 0)
    const total = sq.reduce((a, s) => a + (s.impressionsTotal ?? 0), 0)
    const sqpShare = total > 0 ? brand / total : null
    console.log(`  "${r.query}"  engine sovPct=${pct(r.sovPct)}   SQP market share=${sqpShare == null ? 'null (no market total)' : pct(sqpShare)}  (brand ${brand} / total ${total}, ${sq.length} ASIN rows, ${[...new Set(sq.map(s=>s.marketplace))].join('+')})`)
    if (++shown >= 8) break
  }
  if (!shown) console.log('  (no overlap between the top SOV queries and the latest SQP week)')
}
await prisma.$disconnect()
