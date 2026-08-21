/**
 * NEG-P1 — the wire proven on REAL prod data, no mocks: build the IT pilot-shaped rule the
 * builder would store, translate it through the real adapter, and drive the real handler in
 * dryRun against the real wasting contexts. Nothing is written (dryRun short-circuits before
 * createNegative). Output = what the armed rule's first evaluation would propose.
 */
import '../src/env.js'
const { maybeTranslateAdsRule } = await import('../src/services/advertising/ads-rule-adapter.service.js')
const { ACTION_HANDLERS } = await import('../src/services/automation-rule.service.js')
await import('../src/services/advertising/automation-action-handlers.js') // registers the handlers
const { default: prisma } = await import('../src/db.js')

// The IT cluster: top wasting sources from the census. Look in the GALE IT family's autos/broad,
// negate EXACT in the SAME ad groups (isolation shape: block where it wastes).
const srcNames = ['IT_Auto_Substitute', 'IT_Auto_Close', 'IT_Auto_Loose']
const groups = await prisma.adGroup.findMany({
  where: { name: { in: srcNames }, campaign: { marketplace: 'IT', status: 'ENABLED' } },
  select: { id: true, name: true, externalAdGroupId: true },
})
console.log(`pilot look/negate set: ${groups.map((g) => g.name).join(' · ')}`)
const rule = {
  id: 'negp1-dryrun',
  actions: [{
    type: 'negative-targeting', negationLevel: 'adgroup', protectConverting: true, protectDays: 30,
    dedupe: true, searchTerms: [], filters: { brandExclude: ['xavia', 'gale'], competitorOnly: false },
    mappings: [{ groups: groups.map((g) => ({ id: g.id, look: true, types: { P: false, E: true, product: false } })) }],
  }],
  conditions: [{ match: 'all', conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '5' }] }],
}
const t = maybeTranslateAdsRule(rule as never)
if (!t) { console.log('NOT TRANSLATED'); process.exit(1) }
const a0 = t.actions[0] as Record<string, unknown>
console.log(`translated: type=${a0.type} levels=${JSON.stringify(a0.levels)} wire blocks=${(a0.negative as { blocks: unknown[] }).blocks?.length}`)

// real wasting contexts (the emitter's own query, IT only)
const since = new Date(Date.now() - 32 * 864e5); const until = new Date(Date.now() - 2 * 864e5)
const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
  where: { date: { gte: since, lte: until }, marketplace: 'IT' },
  _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true },
  having: { orders7d: { _sum: { equals: 0 } } },
})
const cands = terms
  .map((x) => ({ q: x.query, ag: x.adGroupId, c: x.campaignId, spend: Math.round(Number(x._sum.costMicros ?? 0) / 10000), clicks: x._sum.clicks ?? 0 }))
  .filter((x) => x.spend >= 300 && x.clicks >= 5)
console.log(`IT wasting candidates at the floor: ${cands.length}`)
let acted = 0, skipped: Record<string, number> = {}
for (const cand of cands) {
  const ctx = { trigger: 'SEARCH_TERM_WASTING', marketplace: 'IT', searchTerm: { query: cand.q, externalCampaignId: cand.c, externalAdGroupId: cand.ag, spendCents: cand.spend, clicks: cand.clicks, orders: 0 } }
  const r = await (ACTION_HANDLERS.add_negative_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; output?: Record<string, unknown> }>)(a0, ctx, { ruleId: 'negp1-dryrun', dryRun: true })
  const out = r.output ?? {}
  if (out.skipped) { skipped[String(out.skipped)] = (skipped[String(out.skipped)] ?? 0) + 1; continue }
  if (out.refusedBy) { skipped[`refused:${out.refusedBy}`] = (skipped[`refused:${out.refusedBy}`] ?? 0) + 1; continue }
  const rows = (out.outcomes ?? []) as Array<{ wouldCreate?: boolean; skipped?: string }>
  const would = rows.filter((o) => o.wouldCreate).length
  if (would > 0) { acted += 1; console.log(`  WOULD NEGATE "${cand.q}" — €${(cand.spend / 100).toFixed(2)}, ${cand.clicks} clicks → ${would} write(s)`) }
  else for (const o of rows) if (o.skipped) skipped[String(o.skipped).slice(0, 40)] = (skipped[String(o.skipped).slice(0, 40)] ?? 0) + 1
}
console.log(`\nwould act on: ${acted} · skips: ${JSON.stringify(skipped)}`)
await prisma.$disconnect()
