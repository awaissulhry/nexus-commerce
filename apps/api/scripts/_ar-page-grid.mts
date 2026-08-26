/**
 * AR page study — READ-ONLY. What the Apply Rules grid could show if every column had a value.
 *
 * Measures ONLY what the AR tab study did not: the payload the grid already receives, whether
 * the stored metric columns are usable without a date range, per-campaign write attribution,
 * and the reach of the 51 automations at campaign grain.
 *
 * No writes. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_ar-page-grid.mts`
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`)

// ── 1 · exactly the select GET /advertising/campaigns runs ────────────────────
const camps = await prisma.campaign.findMany({
  orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
  take: 500,
  select: {
    id: true, name: true, type: true, adProduct: true, status: true, marketplace: true,
    externalCampaignId: true, dailyBudget: true, biddingStrategy: true,
    impressions: true, clicks: true, spend: true, sales: true, acos: true, roas: true,
    trueProfitCents: true, trueProfitMarginPct: true, lastSyncedAt: true, lastSyncStatus: true,
    deliveryStatus: true, startDate: true, endDate: true, portfolioId: true,
    dynamicBidding: true, minBidCents: true, maxBidCents: true,
    // NOT in the payload today — measured to price adding them:
    liveBidWritesEnabled: true, pinBids: true, pinBudget: true, pinPlacement: true,
    pinnedBy: true, targetAcosPct: true, bidsSuppressedAt: true,
    liveBidWritesToday: true, liveBidWritesDay: true,
  },
})
type C = (typeof camps)[number]
const db = (c: C) => (c.dynamicBidding ?? {}) as {
  targetAcos?: number; bidAutomation?: boolean; cpcCeiling?: number
  maxBidChangePct?: number; maxWritesPerDay?: number
  placementBidding?: Array<{ placement?: string; percentage?: number }>
}
const N = camps.length
const live = camps.filter((c) => c.status === 'ENABLED')
const paused = camps.filter((c) => c.status === 'PAUSED')

console.log(`\n═══ AR page — ${int(N)} campaigns (${int(live.length)} ENABLED · ${int(paused.length)} PAUSED · ${int(N - live.length - paused.length)} other) ═══`)

// ── 2 · the metric columns the payload ALREADY carries, without any date param ──
console.log('\n── A · stored metric columns (what the grid receives today and ignores) ──')
const nz = (f: (c: C) => number) => camps.filter((c) => f(c) > 0).length
const num = (v: unknown) => Number(v ?? 0)
const rows: Array<[string, number]> = [
  ['dailyBudget > 0', nz((c) => num(c.dailyBudget))],
  ['impressions > 0', nz((c) => c.impressions)],
  ['clicks > 0', nz((c) => c.clicks)],
  ['spend > 0', nz((c) => num(c.spend))],
  ['sales > 0', nz((c) => num(c.sales))],
  ['acos not null', camps.filter((c) => c.acos != null).length],
  ['roas not null', camps.filter((c) => c.roas != null).length],
  ['trueProfitCents not null', camps.filter((c) => c.trueProfitCents != null).length],
  ['deliveryStatus not null', camps.filter((c) => c.deliveryStatus != null).length],
]
for (const [k, v] of rows) console.log(`   ${pad(k, 26)} ${String(int(v)).padStart(4)} / ${N}   ${pct(v, N)}`)
const totalSpend = camps.reduce((a, c) => a + num(c.spend), 0)
const totalBudget = camps.reduce((a, c) => a + num(c.dailyBudget), 0)
console.log(`   Σ stored spend €${totalSpend.toFixed(2)} · Σ dailyBudget €${totalBudget.toFixed(2)}/day`)
const synced = camps.filter((c) => c.lastSyncedAt).map((c) => c.lastSyncedAt!.getTime()).sort((a, b) => b - a)
if (synced.length) {
  const ageH = (t: number) => ((Date.now() - t) / 3_600_000).toFixed(1)
  console.log(`   lastSyncedAt: newest ${ageH(synced[0])}h ago · median ${ageH(synced[Math.floor(synced.length / 2)])}h · oldest ${ageH(synced[synced.length - 1])}h · null on ${N - synced.length}`)
}

// ── 3 · the SAME metrics windowed — does a date control move a pixel? ─────────
console.log('\n── B · window-derived metrics (what ?preset= would change) ──')
const ids = camps.map((c) => c.id)
const extIds = camps.map((c) => c.externalCampaignId).filter(Boolean) as string[]
const m2c = (v: bigint | number | null | undefined) => Math.round(Number(v ?? 0) / 10000)
for (const days of [7, 30, 60]) {
  const since = new Date(Date.now() - days * 86_400_000)
  const g = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: { gte: since } },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true },
  })
  const withSpend = g.filter((r) => m2c(r._sum.costMicros) > 0)
  const spend = g.reduce((a, r) => a + m2c(r._sum.costMicros), 0) / 100
  const sales = g.reduce((a, r) => a + Number(r._sum.sales7dCents ?? 0) + Number(r._sum.sales14dCents ?? 0), 0) / 100
  console.log(`   last ${String(days).padStart(2)}d: ${String(int(g.length)).padStart(3)} campaigns with rows · ${String(int(withSpend.length)).padStart(3)} with spend>0 · €${spend.toFixed(2)} spend · €${sales.toFixed(2)} sales · ACoS ${sales > 0 ? ((spend / sales) * 100).toFixed(1) : '—'}%`)
}
const extOnly = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['entityId'],
  where: { entityType: 'CAMPAIGN', entityId: { in: extIds }, localEntityId: null, date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  _sum: { costMicros: true },
})
console.log(`   unlinked-fallback rows (entityId, localEntityId null) in 30d: ${int(extOnly.length)} campaigns`)

// ── 4 · governance per campaign: what is enforced and invisible ───────────────
console.log('\n── C · enforced-per-campaign controls (none of these are on the grid) ──')
const gov: Array<[string, number]> = [
  ['liveBidWritesEnabled', camps.filter((c) => c.liveBidWritesEnabled).length],
  ['minBidCents set', camps.filter((c) => c.minBidCents != null).length],
  ['maxBidCents set', camps.filter((c) => c.maxBidCents != null).length],
  ['cpcCeiling (JSON)', camps.filter((c) => db(c).cpcCeiling != null).length],
  ['maxBidChangePct (JSON)', camps.filter((c) => db(c).maxBidChangePct != null).length],
  ['maxWritesPerDay (JSON)', camps.filter((c) => db(c).maxWritesPerDay != null).length],
  ['pinBids', camps.filter((c) => c.pinBids).length],
  ['pinBudget', camps.filter((c) => c.pinBudget).length],
  ['pinPlacement', camps.filter((c) => c.pinPlacement).length],
  ['placementBidding lanes', camps.filter((c) => (db(c).placementBidding ?? []).length > 0).length],
  ['targetAcos (live field)', camps.filter((c) => db(c).targetAcos != null).length],
  ['bidAutomation true', camps.filter((c) => db(c).bidAutomation === true).length],
  ['targetAcosPct (DEAD col)', camps.filter((c) => c.targetAcosPct != null).length],
  ['bidsSuppressedAt set', camps.filter((c) => c.bidsSuppressedAt != null).length],
  ['liveBidWritesToday > 0', camps.filter((c) => (c.liveBidWritesToday ?? 0) > 0).length],
]
for (const [k, v] of gov) console.log(`   ${pad(k, 26)} ${String(int(v)).padStart(4)} / ${N}   ${pct(v, N)}`)

// is maxBidCents exactly the gate-open set?
const gateOpen = new Set(camps.filter((c) => c.liveBidWritesEnabled).map((c) => c.id))
const hasMax = new Set(camps.filter((c) => c.maxBidCents != null).map((c) => c.id))
const both = [...hasMax].filter((i) => gateOpen.has(i)).length
console.log(`   maxBidCents ∩ gate-open = ${both}  (maxBidCents ${hasMax.size} · gate-open ${gateOpen.size})`)
const maxVals = camps.filter((c) => c.maxBidCents != null).map((c) => c.maxBidCents!)
if (maxVals.length) {
  const s = [...new Set(maxVals)].sort((a, b) => a - b)
  console.log(`   distinct maxBidCents values: ${s.slice(0, 12).map((v) => `${v}¢`).join(' · ')}${s.length > 12 ? ` …${s.length} distinct` : ''}`)
}

// ── 5 · the default filter: what Status=Enabled hides ────────────────────────
console.log('\n── D · what the default Status=Enabled filter hides ──')
const tos = (c: C) => {
  const p = (db(c).placementBidding ?? []).find((x) => String(x.placement ?? '').toLowerCase().includes('top'))
  return p?.percentage ?? null
}
const pausedWithLane = paused.filter((c) => (db(c).placementBidding ?? []).length > 0)
const pausedHotTos = paused.filter((c) => (tos(c) ?? 0) >= 100)
const pausedGate = paused.filter((c) => c.liveBidWritesEnabled)
const pausedBudget = paused.reduce((a, c) => a + num(c.dailyBudget), 0)
console.log(`   hidden rows                       ${int(N - live.length)} of ${N}  (${pct(N - live.length, N)})`)
console.log(`   …carrying a placement lane        ${int(pausedWithLane.length)}`)
console.log(`   …with Top-of-Search ≥ 100%        ${int(pausedHotTos.length)}`)
console.log(`   …with the write gate OPEN         ${int(pausedGate.length)}`)
console.log(`   …standing daily budget            €${pausedBudget.toFixed(2)}/day`)
for (const c of [...pausedHotTos].sort((a, b) => (tos(b) ?? 0) - (tos(a) ?? 0)).slice(0, 6)) {
  console.log(`      ${pad(c.name, 46)} ${c.marketplace}  ToS +${tos(c)}%  gate ${c.liveBidWritesEnabled ? 'OPEN' : 'shut'}  €${num(c.dailyBudget).toFixed(2)}/d`)
}

// ── 6 · the Automations column: how many rules can reach each campaign ───────
console.log('\n── E · Automations reach at campaign grain (read-only column) ──')
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, autonomyLevel: true, actions: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
  },
})
console.log(`   advertising rules: ${int(rules.length)}  (enabled ${int(rules.filter((r) => r.enabled).length)})`)
const scoped = rules.filter((r) => r.scopeMarketplace || r.scopePortfolioId || r.scopeCampaignId || r.scopeProductId)
console.log(`   carrying ANY scope: ${int(scoped.length)}  — market ${rules.filter((r) => r.scopeMarketplace).length} · portfolio ${rules.filter((r) => r.scopePortfolioId).length} · campaign ${rules.filter((r) => r.scopeCampaignId).length} · product ${rules.filter((r) => r.scopeProductId).length}`)

// product-scope expansion (parent → children), exactly as the evaluator does
const prodScopeIds = rules.map((r) => r.scopeProductId).filter(Boolean) as string[]
const expanded = new Map<string, string[]>()
if (prodScopeIds.length) {
  const kids = await prisma.product.findMany({ where: { parentId: { in: prodScopeIds } }, select: { id: true, parentId: true } })
  for (const id of prodScopeIds) expanded.set(id, [id, ...kids.filter((k) => k.parentId === id).map((k) => k.id)])
}
// campaign → productIds
const ads = await prisma.adProductAd.findMany({ select: { productId: true, adGroup: { select: { campaignId: true } } } })
const prodByCampaign = new Map<string, Set<string>>()
for (const a of ads) {
  const cid = a.adGroup?.campaignId
  if (!cid || !a.productId) continue
  if (!prodByCampaign.has(cid)) prodByCampaign.set(cid, new Set())
  prodByCampaign.get(cid)!.add(a.productId)
}
const { ruleMatchesScope } = await import('../src/services/automation-rule-scope.js')
const reach = new Map<string, number>()
const reachLive = new Map<string, number>()
for (const c of camps) {
  const ctx = {
    marketplace: c.marketplace ?? null,
    campaignId: c.id,
    portfolioId: c.portfolioId ?? null,
    productIds: [...(prodByCampaign.get(c.id) ?? [])],
  }
  let n = 0, nLive = 0
  for (const r of rules) {
    const ok = ruleMatchesScope({
      scopeMarketplace: r.scopeMarketplace, scopePortfolioId: r.scopePortfolioId,
      scopeCampaignId: r.scopeCampaignId,
      scopeProductIds: r.scopeProductId ? (expanded.get(r.scopeProductId) ?? [r.scopeProductId]) : null,
    }, ctx)
    if (!ok) continue
    n += 1
    if (r.enabled && r.autonomyLevel === 'AUTO') nLive += 1
  }
  reach.set(c.id, n)
  reachLive.set(c.id, nLive)
}
const distinct = new Map<string, number>()
for (const v of reach.values()) distinct.set(String(v), (distinct.get(String(v)) ?? 0) + 1)
console.log(`   "rules that can reach this campaign" — distinct values across ${N} rows:`)
for (const [k, v] of [...distinct].sort((a, b) => Number(b[0]) - Number(a[0]))) console.log(`      ${String(k).padStart(3)} rules → ${int(v)} campaigns`)
const distinctLive = new Map<string, number>()
for (const v of reachLive.values()) distinctLive.set(String(v), (distinctLive.get(String(v)) ?? 0) + 1)
console.log(`   of those, on AUTO *and* enabled (can write):`)
for (const [k, v] of [...distinctLive].sort((a, b) => Number(b[0]) - Number(a[0]))) console.log(`      ${String(k).padStart(3)} rules → ${int(v)} campaigns`)
// the honest reading: reach vs permitted
const reachableAndOpen = camps.filter((c) => (reachLive.get(c.id) ?? 0) > 0 && c.liveBidWritesEnabled).length
const reachableShut = camps.filter((c) => (reachLive.get(c.id) ?? 0) > 0 && !c.liveBidWritesEnabled).length
console.log(`   🔴 matched by a writing rule but gate SHUT: ${int(reachableShut)}  ·  matched AND permitted: ${int(reachableAndOpen)}`)

// ── 7 · per-campaign write attribution — the "last changed" column ───────────
console.log('\n── F · writes per campaign in 60d (AdvertisingActionLog) ──')
const since60 = new Date(Date.now() - 60 * 86_400_000)
const logs = await prisma.advertisingActionLog.groupBy({
  by: ['entityId'],
  where: { entityType: 'CAMPAIGN', createdAt: { gte: since60 } },
  _count: { _all: true },
})
const byCampaign = new Map(logs.map((l) => [l.entityId, l._count._all]))
const touched = camps.filter((c) => byCampaign.has(c.id))
console.log(`   CAMPAIGN-entity rows: ${int(logs.reduce((a, l) => a + l._count._all, 0))} across ${int(logs.length)} entity ids`)
console.log(`   campaigns on THIS grid with ≥1 row: ${int(touched.length)} / ${N}  ${pct(touched.length, N)}`)
const actors = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { entityType: 'CAMPAIGN', createdAt: { gte: since60 } }, _count: { _all: true },
})
console.log(`   by actor: ${actors.sort((a, b) => b._count._all - a._count._all).slice(0, 8).map((a) => `${a.userId}×${int(a._count._all)}`).join(' · ')}`)
const types = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'], where: { entityType: 'CAMPAIGN', createdAt: { gte: since60 } }, _count: { _all: true },
})
console.log(`   by actionType: ${types.sort((a, b) => b._count._all - a._count._all).slice(0, 10).map((a) => `${a.actionType}×${int(a._count._all)}`).join(' · ')}`)

// ── 8 · does anything write to a TARGET inside these campaigns? (bid grain) ──
const tgt = await prisma.advertisingActionLog.groupBy({
  by: ['entityType'], where: { createdAt: { gte: since60 } }, _count: { _all: true },
})
console.log(`   all entity types in 60d: ${tgt.sort((a, b) => b._count._all - a._count._all).map((t) => `${t.entityType}×${int(t._count._all)}`).join(' · ')}`)

await prisma.$disconnect()
console.log('\n═══ done — read-only, nothing written ═══\n')
