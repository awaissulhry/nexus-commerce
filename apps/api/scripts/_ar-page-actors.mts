/**
 * AR page study 3 — READ-ONLY. "What can change THIS campaign?" at campaign grain.
 *
 * The Automations column's real question. Counts every actor that can reach a campaign:
 * AutomationRules (by ruleMatchesScope), rank/dayparting schedule membership, budget-schedule
 * membership, and the campaign-level engines. Also checks the two dead columns for a referent.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const camps = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, portfolioId: true, liveBidWritesEnabled: true, externalCampaignId: true },
})
const byId = new Map(camps.map((c) => [c.id, c]))
console.log(`\n═══ actors per campaign — ${camps.length} campaigns ═══`)

// ── 1 · do the two "dead" columns have ANY referent? ─────────────────────────
console.log('\n── the two dead columns: is there anything to point at? ──')
const budgetSchedules = await prisma.budgetSchedule.findMany({ select: { id: true, name: true, kind: true, enabled: true, campaigns: true } })
console.log(`   BudgetSchedule rows: ${int(budgetSchedules.length)}  (enabled ${budgetSchedules.filter((b) => b.enabled).length})`)
const bsMembers = new Map<string, string[]>()
for (const b of budgetSchedules) {
  for (const c of (Array.isArray(b.campaigns) ? b.campaigns : []) as Array<{ id?: string }>) {
    if (!c?.id) continue
    if (!bsMembers.has(c.id)) bsMembers.set(c.id, [])
    bsMembers.get(c.id)!.push(b.name)
  }
}
console.log(`   campaigns named by a BudgetSchedule: ${int(bsMembers.size)}`)
// Amazon-native budget rules: has this codebase ever stored one?
const nativeCols = await prisma.$queryRawUnsafe<Array<{ column_name: string; table_name: string }>>(
  `SELECT table_name, column_name FROM information_schema.columns WHERE column_name ILIKE '%budgetrule%' OR table_name ILIKE '%budgetrule%'`,
).catch((e) => { console.log(`   [native budget-rule column probe FAILED: ${String(e).slice(0, 80)}]`); return null })
console.log(`   DB columns/tables mentioning "budgetrule": ${nativeCols == null ? 'probe failed' : nativeCols.length === 0 ? 'NONE' : nativeCols.map((r) => `${r.table_name}.${r.column_name}`).join(', ')}`)
// Bid Rule: is there any per-campaign bid-algorithm field anywhere?
const algoCols = await prisma.$queryRawUnsafe<Array<{ column_name: string; table_name: string }>>(
  `SELECT table_name, column_name FROM information_schema.columns WHERE table_name = 'Campaign' AND (column_name ILIKE '%algo%' OR column_name ILIKE '%bidstrateg%' OR column_name ILIKE '%bidding%')`,
).catch(() => null)
console.log(`   Campaign columns for a bid algorithm: ${algoCols == null ? 'probe failed' : algoCols.length === 0 ? 'NONE' : algoCols.map((r) => r.column_name).join(', ')}`)
const strat = await prisma.campaign.groupBy({ by: ['biddingStrategy'], _count: { _all: true } })
console.log(`   Campaign.biddingStrategy distribution: ${strat.map((s) => `${s.biddingStrategy}×${s._count._all}`).join(' · ')}`)

// ── 2 · rank / dayparting schedule membership ────────────────────────────────
console.log('\n── clocks: which campaigns a schedule names ──')
const groups = await prisma.rankScheduleGroup.findMany({ select: { id: true, name: true, enabled: true, marketplace: true } })
console.log(`   RankScheduleGroup: ${int(groups.length)} (enabled ${groups.filter((g) => g.enabled).length})`)
const scheds = await prisma.adSchedule.findMany({ select: { id: true, campaignId: true, enabled: true, groupId: true } }).catch(() => null)
if (scheds == null) console.log('   [AdSchedule read FAILED — not a zero]')
else {
  const enabledGroupIds = new Set(groups.filter((g) => g.enabled).map((g) => g.id))
  const perCampaign = new Map<string, number>()
  const perCampaignLive = new Map<string, number>()
  for (const s of scheds) {
    if (!s.campaignId) continue
    perCampaign.set(s.campaignId, (perCampaign.get(s.campaignId) ?? 0) + 1)
    if (s.enabled && (!s.groupId || enabledGroupIds.has(s.groupId))) perCampaignLive.set(s.campaignId, (perCampaignLive.get(s.campaignId) ?? 0) + 1)
  }
  console.log(`   AdSchedule rows: ${int(scheds.length)} · campaigns named: ${int(perCampaign.size)} · campaigns under a LIVE schedule: ${int(perCampaignLive.size)}`)
  const gridLive = camps.filter((c) => perCampaignLive.has(c.id))
  console.log(`   of those, on this grid: ${int(gridLive.length)} — gate open on ${gridLive.filter((c) => c.liveBidWritesEnabled).length}`)
}

// ── 3 · rules, by resolved scope, split by what they can DO ─────────────────
console.log('\n── rules that can reach each campaign, by capability ──')
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, actions: true, trigger: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true },
})
const { ruleMatchesScope } = await import('../src/services/automation-rule-scope.js')
const actionTypes = (r: (typeof rules)[number]) => (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? ''))
const WRITES_BID = ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense']
const WRITES_BUDGET = ['adjust_ad_budget']
const WRITES_PLACEMENT = ['set_placement_multiplier', 'defend_top_of_search', 'refresh_dayparting']
const WRITES_STATE = ['pause_campaign', 'pause_ad_group', 'pause_all_campaigns', 'resume_campaign']
const cap = (r: (typeof rules)[number]) => {
  const t = actionTypes(r)
  return {
    bid: t.some((x) => WRITES_BID.includes(x)),
    budget: t.some((x) => WRITES_BUDGET.includes(x)),
    placement: t.some((x) => WRITES_PLACEMENT.includes(x)),
    state: t.some((x) => WRITES_STATE.includes(x)),
  }
}
const armed = (r: (typeof rules)[number]) => r.enabled && r.autonomyLevel === 'AUTO'
const tallies = { bid: new Map<string, number>(), budget: new Map<string, number>(), placement: new Map<string, number>(), state: new Map<string, number>() }
for (const c of camps) {
  const ctx = { marketplace: c.marketplace ?? null, campaignId: c.id, portfolioId: c.portfolioId ?? null }
  for (const r of rules) {
    if (!armed(r)) continue
    if (!ruleMatchesScope({ scopeMarketplace: r.scopeMarketplace, scopePortfolioId: r.scopePortfolioId, scopeCampaignId: r.scopeCampaignId, scopeProductIds: null }, ctx)) continue
    const k = cap(r)
    for (const dim of ['bid', 'budget', 'placement', 'state'] as const) {
      if (k[dim]) tallies[dim].set(c.id, (tallies[dim].get(c.id) ?? 0) + 1)
    }
  }
}
for (const dim of ['bid', 'budget', 'placement', 'state'] as const) {
  const dist = new Map<number, number>()
  for (const c of camps) dist.set(tallies[dim].get(c.id) ?? 0, (dist.get(tallies[dim].get(c.id) ?? 0) ?? 0) + 1)
  console.log(`   ARMED rules that can change ${pad(dim, 10)} → ${[...dist].sort((a, b) => b[0] - a[0]).map(([k, v]) => `${k} rules on ${v} campaigns`).join(' · ')}`)
}

// ── 4 · rules carrying a campaignId in their CONFIG (not the scope column) ──
console.log('\n── rules that name campaigns inside their config JSON (invisible to scope) ──')
const cfgRules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, enabled: true, autonomyLevel: true, actions: true } })
let namedCount = 0
for (const r of cfgRules) {
  const blob = JSON.stringify(r.actions ?? {})
  const m = blob.match(/"campaignIds?"\s*:/)
  if (m) {
    namedCount += 1
    const ids = [...blob.matchAll(/"campaignIds?"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)].map((x) => x[1]).join(' ')
    const resolved = [...ids.matchAll(/"([a-z0-9]{20,})"/g)].map((x) => byId.get(x[1])?.name ?? `«${x[1].slice(0, 8)}… unknown»`)
    console.log(`   ${pad(r.name, 44)} ${r.enabled ? r.autonomyLevel : 'OFF'}  → ${resolved.length} campaign(s): ${resolved.slice(0, 4).join(', ')}${resolved.length > 4 ? ` +${resolved.length - 4}` : ''}`)
  }
}
console.log(`   rules with a campaign named in config: ${namedCount} of ${cfgRules.length}`)

// ── 5 · the engines: campaign-level actors that are not rules ───────────────
console.log('\n── engines that wrote to a CAMPAIGN in 30d, by actor prefix ──')
const since = new Date(Date.now() - 30 * 86_400_000)
const acts = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { createdAt: { gte: since } }, _count: { _all: true },
})
const prefix = new Map<string, number>()
for (const a of acts) {
  const p = a.userId == null ? '«null»' : String(a.userId).split(':')[0] + ':' + (String(a.userId).split(':')[1] ?? '').replace(/[a-z0-9]{20,}$/, '<id>')
  prefix.set(p, (prefix.get(p) ?? 0) + a._count._all)
}
for (const [k, v] of [...prefix].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${pad(k, 40)} ${String(int(v)).padStart(8)}`)

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
