import '../src/env.js'
const { maybeTranslateAdsRule } = await import('../src/services/advertising/ads-rule-adapter.service.js')
const { ACTION_HANDLERS } = await import('../src/services/automation-rule.service.js')
await import('../src/services/advertising/automation-action-handlers.js')
const { default: prisma } = await import('../src/db.js')
const rule = await prisma.automationRule.findFirst({ where: { name: { contains: 'GALE IT' } } })
if (!rule) { console.log('NOT FOUND'); process.exit(1) }
const t = maybeTranslateAdsRule(rule as never)!
const a0 = t.actions[0] as Record<string, unknown>
console.log(`translated: ${a0.type} levels=${JSON.stringify(a0.levels)} protect=${a0.protectConverting}/${a0.protectDays}d blocks=${(a0.negative as { blocks: unknown[] }).blocks?.length} dedupe=${(a0.negative as { dedupe: boolean }).dedupe}`)
const since = new Date(Date.now() - 32 * 864e5); const until = new Date(Date.now() - 2 * 864e5)
const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
  where: { date: { gte: since, lte: until }, marketplace: 'IT' },
  _sum: { orders7d: true, clicks: true, costMicros: true },
  having: { orders7d: { _sum: { equals: 0 } } },
})
const cands = terms.map((x) => ({ q: x.query, ag: x.adGroupId, c: x.campaignId, spend: Math.round(Number(x._sum.costMicros ?? 0) / 10000), clicks: x._sum.clicks ?? 0 })).filter((x) => x.spend >= 300 && x.clicks >= 5)
let acted = 0; const skips: Record<string, number> = {}
for (const cand of cands) {
  const ctx = { trigger: 'SEARCH_TERM_WASTING', marketplace: 'IT', searchTerm: { query: cand.q, externalCampaignId: cand.c, externalAdGroupId: cand.ag, spendCents: cand.spend, clicks: cand.clicks, orders: 0 } }
  const r = await (ACTION_HANDLERS.add_negative_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown> }>)(a0, ctx, { ruleId: rule.id, dryRun: true })
  const out = r.output ?? {}
  if (out.skipped) { skips[String(out.skipped)] = (skips[String(out.skipped)] ?? 0) + 1; continue }
  const rows = (out.outcomes ?? []) as Array<{ wouldCreate?: boolean; adGroupId?: string }>
  const would = rows.filter((o) => o.wouldCreate)
  if (would.length) { acted += 1; console.log(`WOULD NEGATE "${cand.q}" — €${(cand.spend / 100).toFixed(2)}, ${cand.clicks} clicks → ${would.length} ad-group negative(s)`) }
}
console.log(`acted=${acted} skips=${JSON.stringify(skips)}`)
await prisma.$disconnect()
