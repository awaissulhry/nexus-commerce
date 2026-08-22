/**
 * PLC-P Phase 0 — read-only prod census for the Placement tab + its builder.
 * Writes nothing. Every number is measured, none is inferred.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const line = (s: string) => console.log(s)
const H = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 72 - s.length))}`)

// ── 1. the fleet: which rules land on the Placement tab ──────────────────────
H('1. rules that carry a placement action')
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, scopeMarketplace: true, createdAt: true, updatedAt: true },
})
line(`advertising rules total: ${all.length}`)
const PLACEMENT_ACTS = new Set(['placement', 'placement_apply', 'set_placement_multiplier', 'defend_top_of_search'])
const actTypes = (r: { actions: unknown }) => (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: string })?.type ?? ''))
const plc = all.filter((r) => actTypes(r).some((t) => PLACEMENT_ACTS.has(t)))
line(`rules with a placement action: ${plc.length}`)
for (const r of plc) {
  const a0 = (Array.isArray(r.actions) ? r.actions[0] : {}) as Record<string, unknown>
  const conds = Array.isArray(r.conditions) ? r.conditions : []
  const scopes = conds.flatMap((g) => (Array.isArray((g as { conditions?: unknown }).conditions) ? (g as { conditions: Array<Record<string, unknown>> }).conditions : [])).map((c) => String(c.scope ?? '—'))
  line(`  · "${r.name}" [${r.id}] enabled=${r.enabled} autonomy=${r.autonomyLevel} trigger=${r.trigger} mkt=${r.scopeMarketplace ?? 'all'}`)
  line(`      actions=${JSON.stringify(actTypes(r))} windowDays=${JSON.stringify(a0.windowDays ?? null)} campaigns=${Array.isArray(a0.campaigns) ? (a0.campaigns as unknown[]).length : 'n/a'}`)
  line(`      groups=${conds.length} condition scopes=${JSON.stringify(scopes)}`)
  line(`      floor/ceiling=${JSON.stringify(a0.placeFloor ?? null)}/${JSON.stringify(a0.placeCeiling ?? null)}`)
}

// ── 2. has any placement rule ever acted? ────────────────────────────────────
H('2. execution history for those rules')
if (plc.length) {
  const ids = plc.map((r) => r.id)
  const ex = await prisma.automationExecution.findMany({
    where: { ruleId: { in: ids } },
    select: { ruleId: true, status: true, executedAt: true, actionResults: true },
    orderBy: { executedAt: 'desc' }, take: 400,
  })
  line(`executions (latest 400): ${ex.length}`)
  const byRule = new Map<string, { n: number; last: Date | null; acted: number; failed: number; statuses: Record<string, number> }>()
  for (const e of ex) {
    const k = e.ruleId
    const v = byRule.get(k) ?? { n: 0, last: null, acted: 0, failed: 0, statuses: {} }
    v.n++
    if (!v.last || e.executedAt > v.last) v.last = e.executedAt
    v.statuses[e.status] = (v.statuses[e.status] ?? 0) + 1
    const res = Array.isArray(e.actionResults) ? e.actionResults : []
    for (const r of res as Array<Record<string, unknown>>) {
      if (r?.ok === true && !(r.output as Record<string, unknown> | undefined)?.noChange && !(r.output as Record<string, unknown> | undefined)?.skipped) v.acted++
      if (r?.ok === false) v.failed++
    }
    byRule.set(k, v)
  }
  for (const [id, v] of byRule) {
    const nm = plc.find((r) => r.id === id)?.name ?? id
    line(`  · "${nm}": ${v.n} runs · last ${v.last?.toISOString() ?? 'never'} · real acts ${v.acted} · failed results ${v.failed} · ${JSON.stringify(v.statuses)}`)
  }
  for (const id of ids) if (!byRule.has(id)) line(`  · "${plc.find((r) => r.id === id)?.name}": NEVER RAN`)
} else line('no placement rules → no history')

// ── 3. what a placement rule can reach (the context floor) ───────────────────
H('3. reach — the CAMPAIGN_PERFORMANCE_BUDGET context floor')
const enabled = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, adProduct: true, dynamicBidding: true, liveBidWritesEnabled: true } })
const total = await prisma.campaign.count()
line(`campaigns total ${total} · ENABLED ${enabled.length}`)
const since = new Date(Date.now() - 9 * 864e5), until = new Date(Date.now() - 2 * 864e5)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: enabled.map((c) => c.id) }, date: { gte: since, lte: until } }, _sum: { costMicros: true } })
const reach = perf.filter((p) => Number(p._sum.costMicros ?? 0) > 0)
line(`ENABLED with spend in the 7 settled days (a placement rule's max reach): ${reach.length}`)
const spCount = enabled.filter((c) => c.adProduct === 'SP').length
line(`of the ENABLED, adProduct=SP: ${spCount} (placement multipliers are an SP construct)`)
const gateOpen = enabled.filter((c) => c.liveBidWritesEnabled).length
line(`ENABLED with liveBidWritesEnabled: ${gateOpen}`)
const reachIds = new Set(reach.map((p) => p.localEntityId!))
const reachSpGate = enabled.filter((c) => reachIds.has(c.id) && c.adProduct === 'SP' && c.liveBidWritesEnabled).length
line(`🔴 ENABLED ∧ spend ∧ SP ∧ gate-open — the campaigns a placement rule could actually WRITE to: ${reachSpGate}`)

// ── 4. the multiplier, at this hour ──────────────────────────────────────────
H('4. current multipliers (a CLOCK READING — records the hour)')
const now = new Date()
line(`read at ${now.toISOString()} (Europe/Rome ${now.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })})`)
type PB = { placementBidding?: Array<{ placement: string; percentage: number }> }
const laneCount: Record<string, number> = { PLACEMENT_TOP: 0, PLACEMENT_PRODUCT_PAGE: 0, PLACEMENT_REST_OF_SEARCH: 0 }
let carrying = 0, twoLane = 0
for (const c of enabled) {
  const pb = ((c.dynamicBidding as PB | null)?.placementBidding) ?? []
  const live = pb.filter((x) => Number(x.percentage) > 0)
  if (live.length) carrying++
  if (live.length >= 2) twoLane++
  for (const x of live) if (x.placement in laneCount) laneCount[x.placement]++
}
line(`ENABLED carrying a non-zero multiplier on any lane: ${carrying} · on TWO+ lanes: ${twoLane}`)
line(`per lane: ${JSON.stringify(laneCount)}`)
const scheds = await prisma.adSchedule.count({ where: { enabled: true } }).catch(() => -1)
line(`enabled AdSchedule rows (the engine that zeroes lanes hourly): ${scheds}`)

// ── 5. is per-placement performance data even available? ─────────────────────
H('5. AmazonAdsPlacementReport — can an IF-placement condition be measured?')
const p30 = new Date(Date.now() - 30 * 864e5)
const pr = await prisma.amazonAdsPlacementReport.groupBy({ by: ['placement'], where: { date: { gte: p30 } }, _count: { _all: true }, _sum: { impressions: true, clicks: true, costMicros: true } })
for (const g of pr) line(`  ${g.placement}: rows ${g._count._all} · impressions ${g._sum.impressions} · clicks ${g._sum.clicks} · cost ${(Number(g._sum.costMicros ?? 0) / 1e6).toFixed(2)}`)
const prTotal = await prisma.amazonAdsPlacementReport.count({ where: { date: { gte: p30 } } })
const prNullLocal = await prisma.amazonAdsPlacementReport.count({ where: { date: { gte: p30 }, localCampaignId: null } })
line(`rows 30d: ${prTotal} · with localCampaignId NULL (the join trap): ${prNullLocal}`)
const prCamps = await prisma.amazonAdsPlacementReport.findMany({ where: { date: { gte: p30 }, localCampaignId: { not: null } }, select: { localCampaignId: true }, distinct: ['localCampaignId'] })
line(`distinct local campaigns with placement data in 30d: ${prCamps.length}`)
const latest = await prisma.amazonAdsPlacementReport.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
line(`freshest placement-report date: ${latest?.date.toISOString().slice(0, 10) ?? 'none'} (today ${new Date().toISOString().slice(0, 10)})`)
// how many campaigns clear an evidence floor per lane (≥20 clicks in 30d) — can a rule DECIDE?
const perLane = await prisma.amazonAdsPlacementReport.groupBy({ by: ['localCampaignId', 'placement'], where: { date: { gte: p30 }, localCampaignId: { not: null } }, _sum: { clicks: true, costMicros: true, sales7dCents: true } })
const clears = perLane.filter((g) => Number(g._sum.clicks ?? 0) >= 20)
line(`campaign×lane cells with ≥20 clicks in 30d (decidable): ${clears.length} of ${perLane.length}`)
const byLane: Record<string, number> = {}
for (const g of clears) byLane[g.placement] = (byLane[g.placement] ?? 0) + 1
line(`  decidable per lane: ${JSON.stringify(byLane)}`)

// ── 6. placement writes that actually happened ───────────────────────────────
H('6. placement writes — the ledger')
const d30 = new Date(Date.now() - 30 * 864e5)
const logs = await prisma.advertisingActionLog.groupBy({ by: ['actionType'], where: { createdAt: { gte: d30 } }, _count: { _all: true } })
for (const g of logs.filter((g) => /PLACEMENT|BID_ADJUST|CAMPAIGN_UPDATE/i.test(g.actionType))) line(`  ${g.actionType}: ${g._count._all} in 30d`)
const hist = await prisma.campaignBidHistory.groupBy({ by: ['field', 'changedBy'], where: { changedAt: { gte: d30 }, field: { contains: 'lacement' } }, _count: { _all: true } })
line(`CampaignBidHistory placement-ish rows 30d: ${hist.length ? '' : 'none'}`)
for (const g of hist) line(`  field=${g.field} by=${g.changedBy}: ${g._count._all}`)
const allFields = await prisma.campaignBidHistory.groupBy({ by: ['field'], where: { changedAt: { gte: d30 } }, _count: { _all: true } })
line(`  all CampaignBidHistory fields in 30d: ${JSON.stringify(allFields.map((f) => [f.field, f._count._all]))}`)

// ── 7. suggestions queue — where a PROPOSE placement rule's output lands ─────
H('7. suggestion queue for placement')
const sug = await prisma.adsSuggestion.groupBy({ by: ['kind', 'status'], _count: { _all: true } }).catch(() => null)
if (sug) for (const g of sug) line(`  ${g.kind} / ${g.status}: ${g._count._all}`)
else line('  (AdsSuggestion not queryable under that name)')

await prisma.$disconnect()
