/**
 * AUTO page study — the governance model, measured. READ-ONLY: no writes, no mutations.
 *
 * Measures only what is specific to this page or what the earlier study asserted and I doubt:
 *
 *   1. 🔴 IS THE CAP BUG FIXED? `_auto-study.mts` reported 693,704 DAILY_CAP_EXCEEDED rows as
 *      "the current sixty-day count"; `ads-graduation-readiness.service.ts:279` says the newest
 *      is 2026-08-03 and the bug was fixed 2026-08-04. Both cannot be true. This settles it by
 *      bucketing the rows BY DAY.
 *   2. Every actor that wrote to Amazon in 60 days — the row list an "all actors" page needs.
 *   3. The proposal queue, by age and by rule — the input to a queue design.
 *   4. Scope coverage and the reach of each unscoped rule.
 *   5. The engine levers exactly as the existing registry reports them.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const DAY = 86_400_000
const since = new Date(Date.now() - 60 * DAY)

// ── 1. 🔴 the refusals, BY DAY — is the cap bug live or historical? ──────────────────────────
console.log('\n═══ 1 · DAILY_CAP_EXCEEDED — live defect, or residue? ═══\n')
const capRows = await prisma.automationRuleExecution.findMany({
  where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' },
  select: { startedAt: true, ruleId: true },
})
console.log(`rows in 60d : ${int(capRows.length)}`)
if (capRows.length > 0) {
  const byDay = new Map<string, number>()
  for (const r of capRows) {
    const k = r.startedAt.toISOString().slice(0, 10)
    byDay.set(k, (byDay.get(k) ?? 0) + 1)
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  console.log(`newest row  : ${days[days.length - 1][0]}   oldest: ${days[0][0]}`)
  console.log('\nlast 14 days with any refusal:')
  for (const [d, n] of days.slice(-14)) console.log(`   ${d}  ${int(n)}`)
  const cutoff = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)
  const last7 = days.filter(([d]) => d >= cutoff).reduce((a, [, n]) => a + n, 0)
  console.log(`\nrefusals in the LAST 7 DAYS: ${int(last7)}`)
}
// The whole execution table, so "99% refusals" is checkable rather than repeated.
const [execTotal, execFailed] = await Promise.all([
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, status: 'FAILED' } }),
])
console.log(`\nexecution rows 60d: ${int(execTotal)} · FAILED ${int(execFailed)} · of which cap ${int(capRows.length)}`)
console.log(`real failures     : ${int(execFailed - capRows.length)}`)

// ── 2. every actor that changed the account ─────────────────────────────────────────────────
console.log('\n═══ 2 · Every actor that wrote to Amazon in 60 days ═══\n')
const logs = await prisma.advertisingActionLog.groupBy({
  by: ['userId', 'actionType'],
  where: { createdAt: { gte: since } },
  _count: { _all: true },
})
const byActor = new Map<string, { total: number; kinds: Map<string, number> }>()
for (const g of logs) {
  const key = g.userId ?? '(null userId)'
  const e = byActor.get(key) ?? { total: 0, kinds: new Map<string, number>() }
  e.total += g._count._all
  e.kinds.set(g.actionType, (e.kinds.get(g.actionType) ?? 0) + g._count._all)
  byActor.set(key, e)
}
const actors = [...byActor.entries()].sort((a, b) => b[1].total - a[1].total)
console.log(`distinct actors: ${actors.length}   total rows: ${int(actors.reduce((a, [, v]) => a + v.total, 0))}\n`)
for (const [name, v] of actors.slice(0, 25)) {
  const kinds = [...v.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}:${int(n)}`).join(' ')
  console.log(`   ${pad(name, 46)} ${String(int(v.total)).padStart(7)}   ${kinds}`)
}
if (actors.length > 25) console.log(`   …${actors.length - 25} more`)

// Collapse the rank-defend family — every one of them is ONE engine.
const family = new Map<string, number>()
for (const [name, v] of actors) {
  const m = /^automation:([a-z-]+?)(-cm[a-z0-9]+)?$/.exec(name)
  const key = m ? `automation:${m[1]}` : name
  family.set(key, (family.get(key) ?? 0) + v.total)
}
console.log('\ncollapsed to the ACTOR an operator would recognise:')
for (const [k, n] of [...family.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`   ${pad(k, 46)} ${String(int(n)).padStart(7)}`)
}

const fromRules = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, executionId: { not: null } } })
const allWrites = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
console.log(`\nall action-log rows 60d: ${int(allWrites)} · carrying an executionId (a rule): ${int(fromRules)} (${((fromRules / Math.max(1, allWrites)) * 100).toFixed(2)}%)`)
const withEvidence = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, evidence: { not: undefined } } })
console.log(`rows carrying structured evidence: ${int(withEvidence)}`)

// ── 3. the proposal queue ────────────────────────────────────────────────────────────────────
console.log('\n═══ 3 · The proposal queue ═══\n')
const sugg = await prisma.adsRuleSuggestion.findMany({
  select: { id: true, ruleId: true, ruleName: true, status: true, createdAt: true, decidedAt: true, entityType: true, proposedKey: true, marketplace: true },
})
const byStatus = new Map<string, number>()
for (const s of sugg) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1)
console.log(`total ${int(sugg.length)} — ${[...byStatus].map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`)
const pend = sugg.filter((s) => s.status === 'pending')
if (pend.length) {
  const ages = pend.map((s) => Math.floor((Date.now() - s.createdAt.getTime()) / DAY)).sort((a, b) => a - b)
  console.log(`pending age (days): min ${ages[0]} · median ${ages[Math.floor(ages.length / 2)]} · max ${ages[ages.length - 1]}`)
  const buckets = { '0-1': 0, '2-7': 0, '8-30': 0, '31+': 0 }
  for (const a of ages) buckets[a <= 1 ? '0-1' : a <= 7 ? '2-7' : a <= 30 ? '8-30' : '31+']++
  console.log(`age buckets: ${Object.entries(buckets).map(([k, v]) => `${k}d ${v}`).join(' · ')}`)
  const byRule = new Map<string, number>()
  const byKind = new Map<string, number>()
  const byEntity = new Map<string, number>()
  for (const s of pend) {
    byRule.set(s.ruleName ?? s.ruleId, (byRule.get(s.ruleName ?? s.ruleId) ?? 0) + 1)
    byKind.set(s.proposedKey.split(':')[0], (byKind.get(s.proposedKey.split(':')[0]) ?? 0) + 1)
    byEntity.set(s.entityType, (byEntity.get(s.entityType) ?? 0) + 1)
  }
  console.log('\npending by rule:')
  for (const [k, v] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`   ${pad(k, 46)} ${v}`)
  console.log(`\npending by action kind: ${[...byKind].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  console.log(`pending by entity type: ${[...byEntity].map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  // How many DISTINCT decisions the queue really represents — one per (kind × entity).
  const distinct = new Set(pend.map((s) => `${s.proposedKey}|${s.entityType}`))
  console.log(`distinct (proposedKey × entityType) combinations: ${distinct.size}`)
}
const applied = sugg.filter((s) => s.status === 'applied')
console.log(`\napplied ever: ${applied.length}${applied.length ? ` — ${applied.map((s) => `${s.ruleName ?? s.ruleId} on ${s.decidedAt?.toISOString().slice(0, 10)}`).join(', ')}` : ''}`)

// ── 4. scope, and the reach of what is unbound ───────────────────────────────────────────────
console.log('\n═══ 4 · Scope ═══\n')
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true,
    actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true,
    scopeCampaignId: true, scopeProductId: true, maxExecutionsPerDay: true,
    maxValueCentsEur: true, maxDailyAdSpendCentsEur: true, lastExecutedAt: true,
  },
})
const levels = new Map<string, number>()
for (const r of rules) levels.set(resolveAutonomy(r as never), (levels.get(resolveAutonomy(r as never)) ?? 0) + 1)
console.log(`levels: ${['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'].map((l) => `${l}=${levels.get(l) ?? 0}`).join(' · ')}`)
const bound = rules.filter((r) => r.scopeMarketplace || r.scopePortfolioId || r.scopeCampaignId || r.scopeProductId)
console.log(`bound to anything: ${bound.length} of ${rules.length}`)
console.log(`   by market ${rules.filter((r) => r.scopeMarketplace).length} · portfolio ${rules.filter((r) => r.scopePortfolioId).length} · campaign ${rules.filter((r) => r.scopeCampaignId).length} · product ${rules.filter((r) => r.scopeProductId).length}`)
const campaigns = await prisma.campaign.findMany({ select: { id: true, marketplace: true, status: true, liveBidWritesEnabled: true } })
const enabledC = campaigns.filter((c) => c.status === 'ENABLED')
console.log(`campaigns: ${campaigns.length} total · ${enabledC.length} ENABLED · ${campaigns.filter((c) => c.liveBidWritesEnabled).length} write-gate open`)
const liveRules = rules.filter((r) => resolveAutonomy(r as never) !== 'OFF')
const unscopedLive = liveRules.filter((r) => !r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeProductId)
console.log(`LIVE rules with NO scope at all: ${unscopedLive.length} of ${liveRules.length} — each may act on all ${campaigns.length} campaigns`)

// Do any rules name campaigns INSIDE their action bodies? That is scope-by-hand.
let inBody = 0
for (const r of rules) {
  const acts = Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : []
  if (acts.some((a) => Array.isArray(a?.campaignIds) && (a.campaignIds as unknown[]).length > 0)) inBody++
}
console.log(`rules naming campaigns inside an ACTION body (scope-by-hand): ${inBody}`)

// ── 5. the engine registry as it already exists ──────────────────────────────────────────────
console.log('\n═══ 5 · The engine levers, from the existing registry ═══\n')
const { getEngineLevers } = await import('../src/services/advertising/ads-control-room.service.js')
const { levers, global } = await getEngineLevers()
console.log(`account: autonomy=${global.autonomy} halted=${global.halted} envKill=${global.envKill}\n`)
console.log(`${pad('engine', 24)} ${pad('mode', 8)} ${pad('halt', 8)} ${pad('runs7d', 7)} ${pad('fail', 5)} scope`)
for (const l of levers) {
  console.log(`   ${pad(l.name, 24)} ${pad(l.mode, 8)} ${pad(l.haltBehaviour, 8)} ${String(l.runs7d).padStart(6)} ${String(l.failures7d).padStart(5)}  ${l.scope ?? '—'}`)
  if (l.warning) console.log(`      ⚠ ${l.warning}`)
}

await prisma.$disconnect()
