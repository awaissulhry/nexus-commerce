import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pct = (n: number) => (n * 100).toFixed(1) + '%'

console.log('### THE SOV BID PREVIEW — what it shows vs what the rule would do')
const allPos = await prisma.adTarget.count({ where: { isNegative: false } })
const byKind = await prisma.adTarget.groupBy({ by: ['kind'], where: { isNegative: false }, _count: { _all: true } })
const byStatus = await prisma.adTarget.groupBy({ by: ['status'], where: { isNegative: false }, _count: { _all: true } })
console.log(`positive AdTarget rows (what /advertising/targets lists): ${allPos}`)
console.log(`  by kind:   ${byKind.map((k)=>`${k.kind}=${k._count._all}`).join(' · ')}`)
console.log(`  by status: ${byStatus.map((k)=>`${k.status}=${k._count._all}`).join(' · ')}`)
console.log(`🔴 the builder fetches ?limit=1500 with NO orderBy → ${allPos > 1500 ? `${allPos-1500} rows (${pct((allPos-1500)/allPos)}) are unreachable by the preview, chosen arbitrarily by Postgres` : 'all rows fit'}`)

// Take the biggest campaign and show the two answers
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, adGroups: { select: { targets: { where: { isNegative: false, kind: 'KEYWORD' }, select: { id: true, expressionValue: true, bidCents: true, status: true } } } } } })
const ranked = camps.map((c) => ({ c, targets: c.adGroups.flatMap((g) => g.targets) })).sort((a, b) => b.targets.length - a.targets.length)
const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')
const sov = await analyzeShareOfVoice({ windowDays: 30, limit: 1000 })
const sovBy = new Map(sov.rows.map((r) => [r.query.trim().toLowerCase(), r]))

console.log(`\nWorked example — a rule "IF Share of Voice < 5% THEN raise bid 20%", top 3 campaigns by target count:`)
for (const { c, targets } of ranked.slice(0, 3)) {
  const previewShows = targets.length                                   // the preview lists every positive target
  const withSignal = targets.filter((t) => sovBy.has((t.expressionValue||'').trim().toLowerCase()))
  const wouldMatch = withSignal.filter((t) => (sovBy.get((t.expressionValue||'').trim().toLowerCase())!.sovPct) < 0.05)
  console.log(`  ${c.marketplace} "${c.name}"`)
  console.log(`    preview would LIST      : ${previewShows} targets (no condition filter is applied)`)
  console.log(`    engine has a SOV signal for: ${withSignal.length} (${pct(withSignal.length/Math.max(1,previewShows))}) — the rest are never evaluated`)
  console.log(`    of those, the condition matches: ${wouldMatch.length} (${pct(wouldMatch.length/Math.max(1,withSignal.length))})`)
  const archived = targets.filter((t) => t.status !== 'ENABLED').length
  console.log(`    preview also lists ${archived} PAUSED/ARCHIVED targets as if they would get a new bid`)
}
await prisma.$disconnect()
