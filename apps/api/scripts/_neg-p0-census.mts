import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// 1 · rules landscape post-W7
const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true } })
const negRules = rules.filter((r) => (r.actions as Array<{ type?: string }>).some((a) => ['negative-targeting', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns'].includes(a?.type ?? '')))
console.log(`advertising rules total: ${rules.length} · negative rules: ${negRules.length}`)
for (const r of rules) console.log(`  rule: "${r.name}" enabled=${r.enabled} ${r.autonomyLevel} trigger=${r.trigger} a0=${(r.actions as Array<{type?:string}>)[0]?.type}`)

// 2 · wasting candidates at the emitter's own floor (30d settled, spend>=300c, clicks>=5, orders=0)
const since = new Date(Date.now() - 32 * 864e5); const until = new Date(Date.now() - 2 * 864e5)
const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
  where: { date: { gte: since, lte: until } },
  _sum: { orders7d: true, clicks: true, costMicros: true },
  having: { orders7d: { _sum: { equals: 0 } } },
})
const cands = terms.map((t) => ({ m: t.marketplace, spend: Math.round(Number(t._sum.costMicros ?? 0) / 10000), clicks: t._sum.clicks ?? 0 })).filter((x) => x.spend >= 300 && x.clicks >= 5)
const byM: Record<string, number> = {}; let spendSum = 0
for (const c of cands) { byM[c.m ?? '?'] = (byM[c.m ?? '?'] ?? 0) + 1; spendSum += c.spend }
console.log(`wasting candidates at emitter floor: ${cands.length} (€${(spendSum / 100).toFixed(2)} wasted spend) by market: ${JSON.stringify(byM)}`)

// 3 · negatives base + protections + review marks
const [negTotal, blocking, protections, reviews] = await Promise.all([
  prisma.adTarget.count({ where: { isNegative: true } }),
  prisma.adTarget.count({ where: { isNegative: true, status: 'ENABLED', externalTargetId: { not: null }, adGroup: { campaign: { status: 'ENABLED' } } } }),
  prisma.adKeywordProtection.count(),
  prisma.adNegativeReview.count().catch(() => -1),
])
console.log(`negatives total: ${negTotal} · blocking: ${blocking} · protections: ${protections} · review marks: ${reviews}`)

// 4 · pending negative suggestions + protect-converting refusal record since W7
const pend = await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } })
console.log(`pending suggestions (all types): ${pend}`)
await prisma.$disconnect()
