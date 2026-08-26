/**
 * BID page study — bounds, the 2¢ population, and what the rules would do if armed.
 *
 * READ-ONLY. No writes, no mutations.
 *
 * Three questions the tab study left open:
 *  1. Is the 2¢ population deliberate suppression (suppressedFromBidCents set) or drift?
 *  2. `lower_bid_to_floor` sets max(5, floorCents). What does that do to a 2¢ keyword?
 *  3. Which of the 18 rules can actually write, per resolveAutonomy/levelActs — and does the
 *     RuleListTab's `actions[0].control === 'automate'` toggle agree with it?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ BID page — bounds, the floor, and the rules ═══\n')

console.log(`NEXUS_BID_OPTIMIZER_SOURCE = ${process.env.NEXUS_BID_OPTIMIZER_SOURCE ?? '(unset → "legacy")'}`)
console.log(`NEXUS_ENABLE_RANK_DEFEND   = ${process.env.NEXUS_ENABLE_RANK_DEFEND ?? '(unset)'}`)
console.log(`NEXUS_AMAZON_ADS_MODE      = ${process.env.NEXUS_AMAZON_ADS_MODE ?? '(unset)'}`)
console.log(`NEXUS_ADS_GRACE_MS         = ${process.env.NEXUS_ADS_GRACE_MS ?? '(unset → 5 min)'}`)

// ── 1. is `bid_to_target_acos` capable of proposing anything at all? ─────────
const deadCols = await prisma.adTarget.aggregate({
  where: { isNegative: false },
  _max: { spendCents: true, clicks: true, salesCents: true, ordersCount: true },
  _count: { _all: true },
})
console.log(`\n── the optimiser's LEGACY metric source (AdTarget denormalised columns) ──`)
console.log(`  rows ${int(deadCols._count._all)} · MAX spendCents ${deadCols._max.spendCents} · MAX clicks ${deadCols._max.clicks} · MAX salesCents ${deadCols._max.salesCents}`)
console.log(`  ← previewBidOptimization's legacy WHERE is spendCents > 0. A max of 0 means it selects NOTHING.`)

const withSpend = await prisma.adTarget.count({ where: { isNegative: false, spendCents: { gt: 0 } } })
console.log(`  targets the legacy source would even consider: ${int(withSpend)}`)

// what the DAILY source would see instead
const since30 = new Date(Date.now() - 30 * 86_400_000)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'AD_TARGET', date: { gte: since30 }, localEntityId: { not: null } },
  _sum: { costMicros: true, clicks: true },
})
const spending = perf.filter((p) => Math.round(Number(p._sum.costMicros ?? 0) / 10_000) > 0)
const with5Clicks = spending.filter((p) => Number(p._sum.clicks ?? 0) >= 5)
console.log(`  targets the DAILY source would consider (30d, spend>0): ${int(spending.length)}  ·  of those with ≥5 clicks (MIN_CLICKS): ${int(with5Clicks.length)}`)
console.log(`  ← flipping one env var moves this engine from 0 candidates to ${int(with5Clicks.length)}.`)

// ── 2. the 2¢ population: deliberate or drift? ───────────────────────────────
const live = await prisma.adTarget.findMany({
  where: { isNegative: false, status: 'ENABLED' },
  select: {
    id: true, kind: true, bidCents: true, suppressedFromBidCents: true, baseBidFromCents: true, orphanedAt: true,
    adGroup: { select: { defaultBidCents: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, minBidCents: true, maxBidCents: true, pinBids: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true, dynamicBidding: true } } } },
  },
})
console.log(`\n── ${int(live.length)} ENABLED positive targets ──`)
const kinds = new Map<string, number>()
for (const t of live) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1)
console.log(`  by kind: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

const atFloor = live.filter((t) => t.bidCents > 0 && t.bidCents <= 2)
const remembered = atFloor.filter((t) => t.suppressedFromBidCents != null)
const campSuppressed = atFloor.filter((t) => t.adGroup?.campaign?.bidsSuppressedAt != null)
console.log(`\n  at ≤2¢: ${int(atFloor.length)}`)
console.log(`    …with suppressedFromBidCents SET (a bid to restore)      : ${int(remembered.length)}`)
console.log(`    …in a campaign flagged bidsSuppressedAt                  : ${int(campSuppressed.length)}`)
console.log(`    …with NEITHER — at 2¢ with nothing saying why           : ${int(atFloor.filter((t) => t.suppressedFromBidCents == null && t.adGroup?.campaign?.bidsSuppressedAt == null).length)}`)
console.log(`  ← "28% of live keywords are deliberately suppressed" is only true of the remembered ones.`)

const sub5 = live.filter((t) => t.bidCents > 0 && t.bidCents < 5)
console.log(`\n  🔴 below the 5¢ handler floor: ${int(sub5.length)}`)
console.log(`     lower_bid_to_floor sets max(5, floorCents) UNCONDITIONALLY, so on these it is a RAISE.`)
const raiseValue = sub5.reduce((s, t) => s + (5 - t.bidCents), 0)
console.log(`     if the two lower_bid_to_floor rules were moved to AUTO they would raise ${int(sub5.length)} bids by a total of ${c2e(raiseValue)} (avg +${((raiseValue / Math.max(1, sub5.length)) / 1) .toFixed(1)}¢ each, ${(((5 / 2) - 1) * 100).toFixed(0)}% on a 2¢ bid).`)
const sub5Remembered = sub5.filter((t) => t.suppressedFromBidCents != null).length
console.log(`     ${int(sub5Remembered)} of them are mid-suppression, so the raise would un-suppress them.`)

// bid distribution, restated over the same population
const bids = live.map((t) => t.bidCents).filter((b) => b > 0).sort((a, b) => a - b)
const at = (p: number) => bids[Math.min(bids.length - 1, Math.floor(bids.length * p))] ?? 0
console.log(`\n  distribution: min ${c2e(at(0))} · p25 ${c2e(at(0.25))} · median ${c2e(at(0.5))} · p75 ${c2e(at(0.75))} · p90 ${c2e(at(0.9))} · max ${c2e(at(1))}`)
const over100 = live.filter((t) => t.bidCents > 100)
console.log(`  over €1.00: ${int(over100.length)} — campaigns: ${[...new Set(over100.map((t) => t.adGroup?.campaign?.name ?? '?'))].slice(0, 6).join(' · ')}`)
const at205 = live.filter((t) => t.bidCents === 205)
console.log(`  exactly €2.05 (the known unhealed SB drift): ${int(at205.length)}`)

// ── 3. the bounds ────────────────────────────────────────────────────────────
const camps = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, minBidCents: true, maxBidCents: true, pinBids: true, pinPlacement: true, pinBudget: true, liveBidWritesEnabled: true, dynamicBidding: true, bidsSuppressedAt: true },
})
const dyn = (c: { dynamicBidding: unknown }) => (c.dynamicBidding ?? {}) as { maxBidChangePct?: number; cpcCeiling?: unknown; targetAcos?: number; bidAutomation?: boolean }
console.log(`\n── per-campaign bid governance, ${int(camps.length)} campaigns ──`)
const rows: Array<[string, number]> = [
  ['minBidCents set', camps.filter((c) => c.minBidCents != null).length],
  ['maxBidCents set', camps.filter((c) => c.maxBidCents != null).length],
  ['pinBids (hands off)', camps.filter((c) => c.pinBids).length],
  ['maxBidChangePct set', camps.filter((c) => Number.isFinite(Number(dyn(c).maxBidChangePct)) && Number(dyn(c).maxBidChangePct) > 0).length],
  ['cpcCeiling set', camps.filter((c) => dyn(c).cpcCeiling != null).length],
  ['dynamicBidding.targetAcos set', camps.filter((c) => dyn(c).targetAcos != null).length],
  ['dynamicBidding.bidAutomation true', camps.filter((c) => dyn(c).bidAutomation === true).length],
  ['write gate OPEN', camps.filter((c) => c.liveBidWritesEnabled).length],
  ['currently bidsSuppressedAt', camps.filter((c) => c.bidsSuppressedAt != null).length],
  ['ENABLED', camps.filter((c) => c.status === 'ENABLED').length],
]
for (const [k, v] of rows) console.log(`  ${pad(k, 36)} ${String(int(v)).padStart(5)} of ${int(camps.length)}`)

const gateOpen = camps.filter((c) => c.liveBidWritesEnabled)
const maxSet = camps.filter((c) => c.maxBidCents != null)
console.log(`\n  maxBidCents set AND gate open : ${int(camps.filter((c) => c.maxBidCents != null && c.liveBidWritesEnabled).length)}`)
console.log(`  gate open WITHOUT a maxBidCents: ${int(gateOpen.filter((c) => c.maxBidCents == null).length)}`)
console.log(`  maxBidCents values in use      : ${[...new Set(maxSet.map((c) => c.maxBidCents))].sort((a, b) => (a ?? 0) - (b ?? 0)).map((v) => `${v}¢`).join(' · ')}`)

// does any live bid already exceed its campaign's ceiling? (a ceiling set after the fact)
const overCeiling = live.filter((t) => { const m = t.adGroup?.campaign?.maxBidCents; return m != null && t.bidCents > m })
console.log(`  🔴 live bids ABOVE their campaign ceiling (set after the bid): ${int(overCeiling.length)}`)
for (const t of overCeiling.slice(0, 8)) console.log(`     ${pad(t.adGroup?.campaign?.name ?? '?', 34)} bid ${c2e(t.bidCents)} > max ${c2e(t.adGroup!.campaign!.maxBidCents!)}`)

// ── 4. the rules, with the REAL autonomy contract ────────────────────────────
const BID_ACTIONS = ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense']
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, trigger: true, actions: true, conditions: true, maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true, executionCount: true, lastExecutedAt: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, createdAt: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => BID_ACTIONS.includes(t)))
console.log(`\n── the ${int(rules.length)} rules this tab lists ──`)
console.log(`${pad('rule', 40)} ${pad('on', 3)} ${pad('level', 8)} ${pad('acts?', 6)} ${pad('ctrl', 6)} ${pad('scope', 8)} ${pad('execs', 8)} action`)
for (const r of rules.sort((a, b) => b.executionCount - a.executionCount)) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const ba = acts.find((a) => BID_ACTIONS.includes(String(a.type)))
  const lvl = resolveAutonomy(r as never)
  const scope = [r.scopeMarketplace && 'mkt', r.scopePortfolioId && 'pf', r.scopeCampaignId && 'camp', r.scopeProductId && 'prod'].filter(Boolean).join('+') || '—'
  const desc = ba ? `${ba.type}${ba.percent != null ? ` percent=${ba.percent}` : ''}${ba.floorCents != null ? ` floor=${ba.floorCents}` : ''}${ba.targetAcos != null ? ` targetAcos=${JSON.stringify(ba.targetAcos)}` : ''}${ba.target != null ? ` target=${ba.target}` : ''}${Array.isArray(ba.campaignIds) ? ` campaignIds[${(ba.campaignIds as unknown[]).length}]` : ''}${ba.profitMode ? ' profitMode' : ''}${ba.bayesian ? ' bayesian' : ''}` : ''
  console.log(`${pad(r.name, 40)} ${pad(r.enabled ? 'ON' : '—', 3)} ${pad(String(lvl), 8)} ${pad(levelActs(lvl) ? 'WRITES' : 'no', 6)} ${pad(String(acts[0]?.control ?? '—'), 6)} ${pad(scope, 8)} ${pad(int(r.executionCount), 8)} ${desc}`)
}
const canWrite = rules.filter((r) => r.enabled && levelActs(resolveAutonomy(r as never)))
console.log(`\n  enabled AND levelActs → CAN WRITE: ${int(canWrite.length)}`)
for (const r of canWrite) console.log(`     ${r.name}`)

console.log(`\n  🔴 the RuleListTab toggle reads actions[0].control === 'automate', NOT the autonomy dial:`)
for (const r of rules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const shown = acts[0]?.control === 'automate'
  const real = r.enabled && levelActs(resolveAutonomy(r as never))
  if (shown !== real) console.log(`     ${pad(r.name, 44)} tab shows ${shown ? 'ON ' : 'OFF'} · truth ${real ? 'WRITES' : 'cannot write'}`)
}

// zero-execution rules
const never = rules.filter((r) => r.executionCount === 0)
console.log(`\n  rules with ZERO executions: ${int(never.length)}`)
for (const r of never) console.log(`     ${pad(r.name, 44)} created ${r.createdAt.toISOString().slice(0, 10)} · trigger ${r.trigger} · enabled ${r.enabled}`)

// ── 5. executions: what did the bid rules actually DO ────────────────────────
const SINCE = new Date(Date.now() - 60 * 86_400_000)
const execs = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId', 'status'],
  where: { startedAt: { gte: SINCE }, ruleId: { in: rules.map((r) => r.id) } },
  _count: { _all: true },
})
const nameOf = new Map(rules.map((r) => [r.id, r.name]))
const agg = new Map<string, Map<string, number>>()
for (const e of execs) {
  const n = nameOf.get(e.ruleId) ?? e.ruleId
  if (!agg.has(n)) agg.set(n, new Map())
  agg.get(n)!.set(e.status, e._count._all)
}
console.log(`\n── 60d executions by status (DAILY_CAP_EXCEEDED is a REFUSAL, not a failure) ──`)
for (const [n, m] of [...agg].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  console.log(`  ${pad(n, 42)} ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
}

await prisma.$disconnect()
