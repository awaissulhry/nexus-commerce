import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(2) + '%'

const { buildSovBidContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')
const { maybeTranslateAdsRule } = await import('../src/services/advertising/ads-rule-adapter.service.js')

const ctxs = await buildSovBidContexts()
console.log(`### CONTEXTS BUILT: ${ctxs.length}   [before P1: 1,178, of which the number was wrong]`)

// 1 · every offered metric must resolve to a DEFINED value on a real context — the "compares
//     against undefined and silently never matches" guard, run against live data.
const OFFERED = ['Share of Voice', 'Campaign Concentration', 'ACOS', 'Spend', 'Sales', 'Orders']
const t = maybeTranslateAdsRule({
  id: 'verify', actions: [{ type: 'sov' }],
  conditions: [{ match: 'all', conditions: OFFERED.map((m) => ({ metric: m, op: 'gte', value: '0' })) }],
})
console.log(`\n### TRANSLATION`)
console.log(`  untranslatable: ${JSON.stringify(t?.untranslatable ?? [])} (must be [])`)
const get = (o: unknown, path: string) => path.split('.').reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o)
for (const c of t!.conditions) {
  const defined = ctxs.filter((x) => get(x, (c as { field: string }).field) !== undefined).length
  const nonNull = ctxs.filter((x) => get(x, (c as { field: string }).field) != null).length
  const flag = defined === 0 ? '🔴 NEVER DEFINED' : nonNull === 0 ? '⚠ always null' : '✅'
  console.log(`  ${flag} ${(c as { field: string }).field.padEnd(28)} defined on ${defined}/${ctxs.length}, non-null on ${nonNull}`)
}

// 2 · the removed metric must be gone from BOTH sides
const gone = maybeTranslateAdsRule({ id: 'gone', actions: [{ type: 'sov' }], conditions: [{ match: 'all', conditions: [{ metric: 'Impression Share', op: 'lt', value: '5' }] }] })
console.log(`\n### REMOVED METRIC REFUSES (never silently drops)`)
console.log(`  'Impression Share' untranslatable: ${JSON.stringify(gone?.untranslatable ?? [])} (must name it)`)
console.log(`  any context still carrying impressionSharePct: ${ctxs.filter((c: any) => c.adTarget?.impressionSharePct !== undefined).length} (must be 0)`)

// 3 · the share is real, discriminating, market-correct
const shares = ctxs.map((c: any) => c.adTarget.sovPct as number).sort((a, b) => b - a)
console.log(`\n### THE SHARE`)
console.log(`  max=${pct(shares[0])} p50=${pct(shares[Math.floor(shares.length/2)])} min=${pct(shares[shares.length-1])}`)
for (const th of [0.2, 0.1, 0.05, 0.01]) console.log(`  "Share of Voice < ${(th*100).toFixed(0)}%" → ${ctxs.filter((c: any) => c.adTarget.sovPct < th).length}/${ctxs.length} (${pct(ctxs.filter((c: any) => c.adTarget.sovPct < th).length/ctxs.length)})`)
console.log(`  fabricated zeros (sovPct === 0): ${shares.filter((s) => s === 0).length} (must be 0)`)
console.log(`  sovPct > 1: ${shares.filter((s) => s > 1).length} (must be 0)`)

// 4 · cross-market contamination must be GONE — every context's share must come from its own market
const { keywordMarketShares, sovShareKey } = await import('../src/services/advertising/ads-sov-keyword-share.service.js')
const km = await keywordMarketShares()
let wrongMarket = 0
const tgt = new Map((await prisma.adTarget.findMany({ where: { kind: 'KEYWORD', isNegative: false }, select: { id: true, expressionValue: true }, take: 3000 })).map((x) => [x.id, x.expressionValue]))
for (const c of ctxs as any[]) {
  const row = km.byKey.get(sovShareKey(c.marketplace, tgt.get(c.adTarget.id)))
  if (!row || Math.abs(row.sharePct - c.adTarget.sovPct) > 1e-12) wrongMarket++
}
console.log(`\n### MARKET CORRECTNESS`)
console.log(`  contexts whose share is not their OWN market's reading: ${wrongMarket} (must be 0)  [before P1: 69 contaminated]`)
console.log(`  distinct markets represented: ${[...new Set(ctxs.map((c: any) => c.marketplace))].sort().join(', ')}`)

// 5 · Campaign Concentration coverage (null is a real state — say how often)
const withConc = ctxs.filter((c: any) => c.adTarget.topSharePct != null).length
console.log(`\n### CAMPAIGN CONCENTRATION`)
console.log(`  non-null on ${withConc}/${ctxs.length} (${pct(withConc/ctxs.length)}) — null = we ran no ads on that query, a real state`)
const cc = ctxs.filter((c: any) => c.adTarget.topSharePct != null).map((c: any) => c.adTarget.topSharePct as number)
console.log(`  === 1.0 (single campaign): ${cc.filter((x) => x === 1).length} · < 1.0 (cannibalised): ${cc.filter((x) => x < 1).length}`)
await prisma.$disconnect()
