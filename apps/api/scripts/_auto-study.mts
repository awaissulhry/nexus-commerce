/**
 * AUTO — Automations page study. READ-ONLY: no writes, no mutations.
 *
 * This is the section's control plane: one page for all 51 rules, an autonomy dial, scope binding,
 * conflict detection and a graduation board. Nine previous studies found specific things happening
 * in this account. The question here is whether this page — the one surface meant to govern all of
 * it — can show them.
 *
 * The conflict detector below is copied VERBATIM from
 * apps/web/.../automations/ruleText.ts:239-292 so the answer is the page's own logic, not mine.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')
const { ruleCategory, RULE_CATEGORY_META } = await import('../src/services/advertising/rule-category.js')
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true,
    actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true,
    scopeCampaignId: true, scopeProductId: true, maxExecutionsPerDay: true,
    evaluationCount: true, matchCount: true, executionCount: true, lastExecutedAt: true,
  },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? '')).filter(Boolean)

console.log(`\n═══ AUTO — the control plane over ${rules.length} rules ═══\n`)

// ── 1. the census ─────────────────────────────────────────────────────────────
const byLevel = new Map<string, number>(); const byCat = new Map<string, number>()
let canWrite = 0, autoNotifyOnly = 0
for (const r of rules) {
  const lvl = resolveAutonomy(r as never)
  byLevel.set(lvl, (byLevel.get(lvl) ?? 0) + 1)
  const cat = ruleCategory(types(r.actions))
  byCat.set(cat, (byCat.get(cat) ?? 0) + 1)
  const writes = types(r.actions).some((t) => !['notify', 'alert_operator', 'log_only'].includes(t))
  if (levelActs(lvl)) { if (writes) canWrite++; else autoNotifyOnly++ }
}
console.log(`by level    : ${['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'].map((l) => `${l}=${byLevel.get(l) ?? 0}`).join(' · ')}`)
console.log(`by family   : ${[...byCat].map(([k, v]) => `${RULE_CATEGORY_META[k as never].label}=${v}`).join(' · ')}`)
console.log(`on AUTO and able to write : ${canWrite}`)
console.log(`on AUTO but notify-only   : ${autoNotifyOnly}`)

// ── 2. scope ──────────────────────────────────────────────────────────────────
const scoped = rules.filter((r) => r.scopeMarketplace || r.scopePortfolioId || r.scopeCampaignId || r.scopeProductId)
console.log(`\nscope       : ${scoped.length} of ${rules.length} rules are bound to anything at all`)
for (const r of scoped) console.log(`   ${pad(r.name, 44)} mkt=${r.scopeMarketplace ?? '—'} pf=${r.scopePortfolioId ?? '—'} camp=${r.scopeCampaignId ?? '—'} prod=${r.scopeProductId ?? '—'}`)

// ── 3. ceilings — what the graduation model will allow ────────────────────────
const ceil = new Map<string, number>()
for (const r of rules) ceil.set(graduationCeiling({ actionTypes: types(r.actions) }).maxLevel, (ceil.get(graduationCeiling({ actionTypes: types(r.actions) }).maxLevel) ?? 0) + 1)
console.log(`\nceilings    : ${[...ceil].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const wantAutoBlocked = rules.filter((r) => graduationCeiling({ actionTypes: types(r.actions) }).maxLevel !== 'AUTO')
console.log(`   rules the model will NEVER let reach AUTO: ${wantAutoBlocked.length}`)

// ── 4. the page's own conflict detector, run against the real rules ───────────
const OPPOSED: Array<[string, string]> = [
  ['bid_up', 'bid_down'], ['pause_campaign', 'resume_campaign'], ['pause_campaign', 'enable_campaign'],
  ['pause_all_campaigns', 'resume_campaign'], ['pause_all_campaigns', 'enable_campaign'],
  ['pause_ad_group', 'resume_campaign'], ['lower_bid_to_floor', 'bid_up'],
  ['lower_bid_to_floor', 'raise_bids_for_rank_defense'],
]
const conflicts = new Map<string, string[]>()
const add = (id: string, reason: string) => { const a = conflicts.get(id) ?? []; if (!a.includes(reason)) a.push(reason); conflicts.set(id, a) }
const live = rules.filter((r) => resolveAutonomy(r as never) !== 'OFF')
for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
  const a = live[i], b = live[j]
  const sameScope = !a.scopeMarketplace || !b.scopeMarketplace || a.scopeMarketplace === b.scopeMarketplace
  if (a.trigger !== b.trigger || !sameScope) continue
  if (JSON.stringify(a.actions) === JSON.stringify(b.actions) && JSON.stringify(a.conditions) === JSON.stringify(b.conditions)) {
    add(a.id, `Duplicate of “${b.name}”`); add(b.id, `Duplicate of “${a.name}”`); continue
  }
  const sa = new Set(types(a.actions)), sb = new Set(types(b.actions))
  for (const [x, y] of OPPOSED) if ((sa.has(x) && sb.has(y)) || (sa.has(y) && sb.has(x))) {
    add(a.id, `May fight “${b.name}”`); add(b.id, `May fight “${a.name}”`)
  }
}
console.log(`\n── the page's conflict detector, on ${live.length} live rules ──`)
console.log(`   rules flagged: ${conflicts.size}`)
for (const [id, why] of conflicts) console.log(`   ${pad(rules.find((r) => r.id === id)!.name, 44)} ${why.join(' | ')}`)

// ── 5. 🔴 the conflicts nine studies found — does it catch them? ──────────────
console.log(`\n── the real conflicts, measured in studies 1-9, vs what the detector sees ──`)
const byName = (n: string) => rules.find((r) => r.name === n)
const check = (label: string, aName: string, bName: string) => {
  const a = byName(aName), b = byName(bName)
  if (!a || !b) { console.log(`   ${pad(label, 46)} (rule not found)`); return }
  const same = a.trigger === b.trigger
  const flagged = (conflicts.get(a.id) ?? []).some((s) => s.includes(b.name))
  console.log(`   ${pad(label, 46)} triggers ${same ? 'SAME' : `differ (${a.trigger} vs ${b.trigger})`} → ${flagged ? 'FLAGGED' : '🔴 NOT FLAGGED'}`)
}
check('the budget ratchet pair (study 6)', 'Trim budget on weak ACOS', 'Campaign ACOS rebalance (cut + scale)')
check('duplicate trim rules (study 6)', 'Trim budget on weak ACOS', 'Trim budget on weak ACOS')
const acosRules = rules.filter((r) => types(r.actions).includes('bid_to_target_acos') && resolveAutonomy(r as never) !== 'OFF')
console.log(`   ${pad('six overlapping bid_to_target_acos (study 9)', 46)} ${acosRules.length} live rules, same action`)
const flaggedAcos = acosRules.filter((r) => conflicts.has(r.id)).length
console.log(`   ${pad('  …of which flagged', 46)} ${flaggedAcos} → ${flaggedAcos === 0 ? '🔴 NONE' : 'some'}`)
console.log(`   ${pad('  triggers among them', 46)} ${[...new Set(acosRules.map((r) => r.trigger))].join(', ')}`)

// ── 6. what the page CANNOT see at all ────────────────────────────────────────
console.log(`\n── things happening in this account that no rule row can express ──`)
const since = new Date(Date.now() - 60 * 86_400_000)
const [bidW, budW, plcW, negW, kwW] = await Promise.all([
  prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: 'AD_BID_UPDATE' } }),
  prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: 'AD_BUDGET_UPDATE' } }),
  prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: 'update_placement_bidding' } }),
  prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: 'create_negative_keyword' } }),
  prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: 'create_keyword' } }),
])
const fromRules = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, executionId: { not: null } } })
const total = bidW + budW + plcW + negW + kwW
console.log(`   writes in 60d: bids ${int(bidW)} · budgets ${int(budW)} · placements ${int(plcW)} · negatives ${int(negW)} · keywords ${int(kwW)}`)
console.log(`   total ${int(total)} — of which attributed to a RULE EXECUTION: ${int(fromRules)}  (${((fromRules / Math.max(1, total)) * 100).toFixed(1)}%)`)
console.log(`   → the rest come from engines (rank-defend, budget-manager, auto-harvest) and operators.`)
console.log(`     This page governs rules. It does not govern the things making the writes.`)

// ── 7. cap refusals — the invisible policy ────────────────────────────────────
const caps = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId'], where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' }, _count: { _all: true },
})
const capTotal = caps.reduce((a, c) => a + c._count._all, 0)
console.log(`\n── DAILY_CAP_EXCEEDED, 60d: ${int(capTotal)} across ${caps.length} rules ──`)
for (const c of caps.sort((a, b) => b._count._all - a._count._all).slice(0, 6)) {
  console.log(`   ${pad(rules.find((r) => r.id === c.ruleId)?.name ?? c.ruleId, 44)} ${int(c._count._all)}`)
}

await prisma.$disconnect()
