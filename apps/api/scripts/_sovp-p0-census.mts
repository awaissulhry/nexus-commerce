import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pct = (n: number) => (n * 100).toFixed(4) + '%'

// ── 1 · rules landscape (post-W7 clean slate)
const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, createdAt: true } })
const sovRules = rules.filter((r) => (r.actions as Array<{ type?: string }>).some((a) => ['sov', 'SOV_BID'].includes(a?.type ?? '')) || r.trigger === 'SOV_BID')
console.log(`### 1 · RULES`)
console.log(`advertising rules total: ${rules.length} · SOV rules: ${sovRules.length}`)
for (const r of rules) console.log(`  "${r.name}" enabled=${r.enabled} ${r.autonomyLevel} trigger=${r.trigger} a0=${(r.actions as Array<{type?:string}>)[0]?.type} created=${r.createdAt.toISOString().slice(0,10)}`)

// ── 2 · the SOV signal exactly as the engine builds it
const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')
const sov = await analyzeShareOfVoice({ windowDays: 30, limit: 1000 })
console.log(`\n### 2 · analyzeShareOfVoice({windowDays:30, limit:1000}) — EXACTLY the engine's call`)
console.log(`totalImpressions (DENOMINATOR): ${sov.totalImpressions.toLocaleString()}`)
console.log(`queries aggregated (pre-limit): ${sov.queries.toLocaleString()}   rows returned (post-limit): ${sov.rows.length}`)
console.log(`summary: ${JSON.stringify(sov.summary)}`)
const sovs = sov.rows.map((r) => r.sovPct).sort((a, b) => b - a)
const q = (p: number) => sovs[Math.min(sovs.length - 1, Math.floor(sovs.length * p))]
console.log(`sovPct  max=${pct(sovs[0] ?? 0)}  p50=${pct(q(0.5))}  p90=${pct(q(0.9))}  min=${pct(sovs[sovs.length-1] ?? 0)}`)
console.log(`sum of returned sovPct = ${pct(sovs.reduce((a,b)=>a+b,0))} (of the whole account's impressions)`)
console.log(`rows with sovPct >= 1%: ${sovs.filter((s)=>s>=0.01).length} · >= 5%: ${sovs.filter((s)=>s>=0.05).length} · >= 20%: ${sovs.filter((s)=>s>=0.2).length} · >= 50%: ${sovs.filter((s)=>s>=0.5).length}`)
const tops = sov.rows.map((r) => r.topCampaignSharePct)
console.log(`topCampaignSharePct: nonNull=${tops.filter((t)=>t!=null).length}/${tops.length} · ==1.0 (single campaign): ${tops.filter((t)=>t===1).length} · <1: ${tops.filter((t)=>t!=null&&t<1).length}`)
console.log(`campaignCount>=2 (cannibalized): ${sov.rows.filter((r)=>r.campaignCount>=2).length}`)
console.log(`\ntop 8 rows by impressions:`)
for (const r of sov.rows.slice(0, 8)) console.log(`  "${r.query}" impr=${r.impressions} sovPct=${pct(r.sovPct)} topShare=${pct(r.topCampaignSharePct)} camps=${r.campaignCount}`)

// ── 3 · would a rule ever fire? the classic thresholds
console.log(`\n### 3 · THRESHOLD SIMULATION on the engine's own numbers`)
for (const t of [0.5, 0.2, 0.1, 0.05, 0.01]) {
  console.log(`  "Share of Voice < ${(t*100).toFixed(0)}%" matches ${sov.rows.filter((r)=>r.sovPct < t).length} / ${sov.rows.length} rows (${pct(sov.rows.filter((r)=>r.sovPct<t).length/Math.max(1,sov.rows.length))})`)
}

// ── 4 · impressionSharePct is literally sovPct (proved from the context builder's line)
console.log(`\n### 4 · Impression Share vs Share of Voice — the builder offers two, the context sets one`)
console.log(`  buildSovBidContexts sets: sovPct: s.sovPct, impressionSharePct: s.sovPct  → identical by construction`)

// ── 5 · marketplace mixing: analyzeShareOfVoice got NO marketplace filter
const byMkt = await prisma.amazonAdsSearchTerm.groupBy({ by: ['marketplace'], where: { date: { gte: new Date(Date.now() - 30 * 864e5) } }, _sum: { impressions: true }, _count: { _all: true } })
console.log(`\n### 5 · MARKETPLACE MIXING (the engine's call passes no marketplace)`)
for (const m of byMkt) console.log(`  ${m.marketplace}: rows=${m._count._all} impressions=${(m._sum.impressions ?? 0).toLocaleString()}`)
console.log(`  → one denominator spans ${byMkt.length} marketplaces`)

// queries that exist in >1 marketplace → their aggregate mixes markets
const rowsMk = await prisma.amazonAdsSearchTerm.groupBy({ by: ['query', 'marketplace'], where: { date: { gte: new Date(Date.now() - 30 * 864e5) } }, _sum: { impressions: true } })
const mkByQuery = new Map<string, Set<string>>()
for (const r of rowsMk) { const k = (r.query || '').trim(); if (!k) continue; if (!mkByQuery.has(k)) mkByQuery.set(k, new Set()); mkByQuery.get(k)!.add(r.marketplace ?? '?') }
const multi = [...mkByQuery.entries()].filter(([, s]) => s.size > 1)
console.log(`  queries present in >1 marketplace: ${multi.length} of ${mkByQuery.size}`)
for (const [k, s] of multi.slice(0, 5)) console.log(`    "${k}" in ${[...s].join('+')}`)

// ── 6 · data freshness: does the 30d window include the settling tail?
const bounds = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true }, _min: { date: true } })
console.log(`\n### 6 · FRESHNESS of AmazonAdsSearchTerm`)
console.log(`  max date = ${bounds._max.date?.toISOString().slice(0,10)}   min = ${bounds._min.date?.toISOString().slice(0,10)}   today = ${new Date().toISOString().slice(0,10)}`)
const lastDays = await prisma.amazonAdsSearchTerm.groupBy({ by: ['date'], where: { date: { gte: new Date(Date.now() - 5 * 864e5) } }, _sum: { impressions: true }, orderBy: { date: 'desc' } })
for (const d of lastDays) console.log(`    ${d.date.toISOString().slice(0,10)}: impr=${(d._sum.impressions ?? 0).toLocaleString()}`)

await prisma.$disconnect()
