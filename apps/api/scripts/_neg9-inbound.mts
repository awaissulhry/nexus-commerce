/**
 * NEG.9 — what the gate cannot see. READ-ONLY. No Amazon call, no write of any kind.
 *
 * 🔴 The finding this measures: `protectConverting` and the write gate both bind OUR write path.
 * A negation created at Amazon and mirrored in by the v1 sync passes neither. 60% of the base
 * arrives that way, so this is the majority path, not an edge.
 *
 * Neither existing detector can see it: Detector A needs an ad-group overlap, Detector B needs
 * 30-day silence. A converting term negated yesterday, outside Nexus, in a campaign that still
 * runs it elsewhere, is invisible to both.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.9 — the blind spot ═══\n')

// ── 1 · how much of the base never passed through us ──────────────────────────────────────────
h('1 · negations with no create log — they arrived by the v1 sync')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, status: true, createdAt: true,
    externalTargetId: true, negativeLevel: true,
    adGroup: {
      select: {
        id: true, name: true, externalAdGroupId: true,
        campaign: { select: { id: true, name: true, status: true, marketplace: true, targetingType: true } },
      },
    },
  },
})
// 🔴 the create-log types, exactly as NEG.8 established them
const CREATE_ACTIONS = ['create_negative_keyword', 'create_negative_product_target']
const createLogs = await prisma.advertisingActionLog.findMany({
  where: { entityType: 'AD_TARGET', actionType: { in: CREATE_ACTIONS } },
  select: { entityId: true, createdAt: true, userId: true },
})
const loggedIds = new Set(createLogs.map((l) => l.entityId))
const unlogged = negs.filter((n) => !loggedIds.has(n.id))
console.log(`  negatives ${int(negs.length)}`)
console.log(`  🔴 with NO create log: ${int(unlogged.length)} (${((unlogged.length / negs.length) * 100).toFixed(1)}%) — the gate never ran on these`)
console.log(`  with a create log:     ${int(negs.length - unlogged.length)}`)

// ── 2 · the recent arrivals ───────────────────────────────────────────────────────────────────
h('2 · negations created in the last 3 days')
const d3 = new Date(Date.now() - 3 * 86400_000)
const recent = negs.filter((n) => n.createdAt >= d3)
for (const n of recent) {
  console.log(`  "${n.expressionValue}"  ${n.createdAt.toISOString().slice(0, 16)}  ${n.adGroup?.campaign?.name} › ${n.adGroup?.name}`)
  console.log(`     logged by us: ${loggedIds.has(n.id) ? 'YES' : '🔴 NO — arrived by sync'} · status ${n.status} · amazon ${n.externalTargetId ? 'yes' : 'no'} · campaign ${n.adGroup?.campaign?.status}`)
}
if (recent.length === 0) console.log('  none')

// ── 3 · the traffic behind them ───────────────────────────────────────────────────────────────
h('3 · what those terms earn (30d)')
const since30 = new Date(Date.now() - 30 * 86400_000)
const st = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'adGroupId'],
  where: { date: { gte: since30 } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
const perTerm = new Map<string, { impressions: number; clicks: number; cost: number; orders: number; sales: number; adGroups: Set<string> }>()
for (const r of st) {
  const k = normaliseNegTerm(r.query ?? '')
  if (!k) continue
  const e = perTerm.get(k) ?? { impressions: 0, clicks: 0, cost: 0, orders: 0, sales: 0, adGroups: new Set<string>() }
  e.impressions += r._sum.impressions ?? 0
  e.clicks += r._sum.clicks ?? 0
  e.cost += Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
  e.orders += r._sum.orders7d ?? 0
  e.sales += r._sum.sales7dCents ?? 0
  e.adGroups.add(r.adGroupId)
  perTerm.set(k, e)
}
for (const n of recent) {
  const k = normaliseNegTerm(n.expressionValue ?? '')
  const p = perTerm.get(k)
  console.log(`  "${k}"  ${p ? `${int(p.orders)} orders · ${eur(p.sales)} · ${int(p.impressions)} impr · ${eur(p.cost)} spend · runs in ${p.adGroups.size} ad groups` : 'no traffic in 30d'}`)
}

// ── 4 · the third detector, exactly as §3 defines it ──────────────────────────────────────────
h('4 · the detector — blocking · recent · converting · NOT ours')
const LOOKBACK = 14
const cutoff = new Date(Date.now() - LOOKBACK * 86400_000)
/** NEG.4's predicate verbatim: campaign-level rows cannot participate in an ad-group overlap. */
const blocks = (n: (typeof negs)[number]) =>
  n.externalTargetId != null && String(n.status) === 'ENABLED'
  && n.adGroup?.campaign?.status === 'ENABLED' && n.negativeLevel !== 'CAMPAIGN'

const hits = negs.filter((n) => {
  if (!blocks(n)) return false
  if (n.createdAt < cutoff) return false
  if (loggedIds.has(n.id)) return false // 🔴 ours — it already went through the gate
  const p = perTerm.get(normaliseNegTerm(n.expressionValue ?? ''))
  return (p?.orders ?? 0) >= 1
})
console.log(`  lookback ${LOOKBACK}d · blocking · ≥1 order in 30d · no create log`)
console.log(`  🔴 ${hits.length} row(s):`)
for (const n of hits) {
  const k = normaliseNegTerm(n.expressionValue ?? '')
  const p = perTerm.get(k)!
  console.log(`     "${k}"  ${p.orders} orders · ${eur(p.sales)} · runs in ${p.adGroups.size} ad groups`)
  console.log(`        negated in ${n.adGroup?.campaign?.name} › ${n.adGroup?.name} (targeting ${n.adGroup?.campaign?.targetingType ?? '—'}) on ${n.createdAt.toISOString().slice(0, 10)}`)
}

// the counter-case: a recent blocking negation with ZERO orders must NOT fire
h('4b · the counter-case — it must NOT fire on a non-converting term')
const nonConverting = negs.filter((n) => {
  if (!blocks(n) || n.createdAt < cutoff || loggedIds.has(n.id)) return false
  const p = perTerm.get(normaliseNegTerm(n.expressionValue ?? ''))
  return (p?.orders ?? 0) === 0
})
for (const n of nonConverting.slice(0, 5)) {
  const p = perTerm.get(normaliseNegTerm(n.expressionValue ?? ''))
  console.log(`     "${n.expressionValue}" — ${p ? `${int(p.impressions)} impr, ${eur(p.cost)}, 0 orders` : 'no traffic'} → correctly excluded`)
}
console.log(`  ${nonConverting.length} recent blocking negation(s) with no orders, all excluded`)

// ── 5 · Detectors A and B must not move ───────────────────────────────────────────────────────
h('5 · Detectors A and B — the control')
const { getAttention } = await import('../src/services/advertising/negatives-attention.service.js')
const att = await getAttention({ market: 'all' })
console.log(`  conflicts ${att.conflicts.total} · suppressed ${att.suppressed.total} · split-brain ${att.splitBrain.total}`)
console.log('  🔴 these three are the CONTROL — the new detector must not change any of them')

// ── 6 · Account-wide negative sync ────────────────────────────────────────────────────────────
h('6 · Account-wide negative sync — the diagnosis')
const rule = await prisma.automationRule.findFirst({
  where: { name: 'Account-wide negative sync' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, maxExecutionsPerDay: true, executionCount: true, createdAt: true },
})
console.log(`  ${rule?.name} · enabled=${rule?.enabled} · ${rule?.autonomyLevel} · trigger ${rule?.trigger} · cap ${rule?.maxExecutionsPerDay}/day`)
console.log(`  actions: ${JSON.stringify(rule?.actions)}`)
console.log(`  conditions: ${JSON.stringify(rule?.conditions).slice(0, 300)}`)
const execs = await prisma.automationRuleExecution.findMany({
  where: { ruleId: rule!.id },
  orderBy: { startedAt: 'desc' },
  take: 600,
  select: { startedAt: true, actionResults: true, triggerData: true },
})
let ok = 0, fail = 0
const errs = new Map<string, number>()
const triggerTerms = new Map<string, number>()
for (const e of execs) {
  for (const a of (Array.isArray(e.actionResults) ? (e.actionResults as Array<Record<string, unknown>>) : [])) {
    if (a?.type !== 'sync_negatives_across_campaigns') continue
    if (a.ok) ok++
    else { fail++; const m = String(a.error ?? '—'); errs.set(m, (errs.get(m) ?? 0) + 1) }
  }
  // what the trigger WOULD have handed it
  const td = (e.triggerData ?? {}) as Record<string, unknown>
  const q = String((td.query ?? (td as { searchTerm?: { query?: string } }).searchTerm?.query) ?? '')
  if (q) triggerTerms.set(q, (triggerTerms.get(q) ?? 0) + 1)
}
console.log(`  in ${execs.length} executions: ok ${ok} · failed ${fail}`)
for (const [m, n] of errs) console.log(`    ${n}× "${m}"`)
console.log(`  distinct terms its trigger produced: ${triggerTerms.size}`)
// 🔴 the decision: would it have negated a CONVERTING term?
let convertingWouldHave = 0
const convList: string[] = []
for (const [q] of triggerTerms) {
  const p = perTerm.get(normaliseNegTerm(q))
  if ((p?.orders ?? 0) >= 1) { convertingWouldHave++; convList.push(`${q} (${p!.orders} orders, ${eur(p!.sales)})`) }
}
console.log(`  🔴 of those, terms that CONVERTED in 30d: ${convertingWouldHave}`)
for (const c of convList.slice(0, 10)) console.log(`     ${c}`)

// does it duplicate add_negative_exact at CAMPAIGN scope?
const others = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { name: true, actions: true, enabled: true },
})
const campaignScopeExact = others.filter((r) =>
  (Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : [])
    .some((a) => a?.type === 'add_negative_exact' && a?.scope === 'CAMPAIGN'))
console.log(`  rules already doing add_negative_exact at CAMPAIGN scope: ${campaignScopeExact.length}${campaignScopeExact.length ? ` — ${campaignScopeExact.map((r) => r.name).join(', ')}` : ''}`)

// ── 7 · the GALE pair — is createdAt an ingest date? ──────────────────────────────────────────
h('7 · the GALE pair — testing cause 1 (createdAt is an INGEST date)')
const gale = negs.filter((n) =>
  ['motorrad jacke herren', 'motorradjacke herren'].includes(normaliseNegTerm(n.expressionValue ?? ''))
  && (n.adGroup?.campaign?.name ?? '').includes('GALE BROAD DE'))
for (const g of gale) {
  console.log(`  "${g.expressionValue}" createdAt ${g.createdAt.toISOString().slice(0, 10)} · ${g.adGroup?.campaign?.name} › ${g.adGroup?.name}`)
}
// 🔴 the test: how many negatives share that exact createdAt? A bulk ingest stamps them together.
const cohort = new Map<string, number>()
for (const n of negs) cohort.set(n.createdAt.toISOString().slice(0, 10), (cohort.get(n.createdAt.toISOString().slice(0, 10)) ?? 0) + 1)
const galeDay = gale[0]?.createdAt.toISOString().slice(0, 10)
console.log(`  negatives sharing createdAt=${galeDay}: ${int(cohort.get(galeDay ?? '') ?? 0)}`)
console.log('  the five largest createdAt cohorts:')
for (const [d, n] of [...cohort].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`     ${d}  ${int(n)}`)
// second-by-second clustering is the tell: a human cannot create 1,155 negatives in one minute
const sameDay = negs.filter((n) => n.createdAt.toISOString().slice(0, 10) === galeDay)
const minutes = new Set(sameDay.map((n) => n.createdAt.toISOString().slice(0, 16)))
console.log(`  🔴 those ${int(sameDay.length)} rows span ${minutes.size} distinct MINUTE(s) — an ingest stamp, not ${int(sameDay.length)} decisions`)

// ── 8 · the shipped detector, asserted ────────────────────────────────────────────────────────
h('8 · the SHIPPED detector — assertions')
let failures = 0
const assert = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: ${got}${ok ? '' : `  ← expected ${want}`}`)
}
const truthy = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? '✓' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const at30 = await getAttention({ market: 'all', window: 30 })
const at60 = await getAttention({ market: 'all', window: 60 })

// 🔴 THE CONTROL. The new detector must not move the two that already existed.
assert('Detector A unchanged at 30d', at30.conflicts.total, att.conflicts.total)
assert('Detector B unchanged at 30d', at30.suppressed.total, att.suppressed.total)
assert('split-brain unchanged at 30d', at30.splitBrain.total, att.splitBrain.total)

assert('ungated negations', at60.inbound.ungatedNegations, 1227)
truthy('ungated share is the majority of the base', at60.inbound.ungatedShare > 0.5,
  `${(at60.inbound.ungatedShare * 100).toFixed(1)}%`)
assert('lookback', at60.inbound.lookbackDays, 14)

// 🔴 window-dependent exactly as Detector A is — 0 at 30d, 1 at 60d
assert('inbound at 30d', at30.inbound.total, 0)
assert('inbound at 60d', at60.inbound.total, 1)
truthy('🔴 candidates is NON-ZERO at both windows — the zero at 30d is a POLICY result, not a failed read',
  at30.inbound.candidates > 0 && at60.inbound.candidates > 0,
  `${at30.inbound.candidates} candidates`)
const found = at60.inbound.rows[0]
assert('the row is motorradjacke 4xl', found?.termKey, 'motorradjacke 4xl')
assert('its orders', found?.orders, 2)
assert('its sales', found?.salesCents, 18218)
truthy('it carries the campaign targeting type', found?.campaignTargetingType != null, String(found?.campaignTargetingType))
truthy('it says where the term still runs', (found?.runsIn ?? 0) >= 1, `negated in ${found?.negatedIn}, runs in ${found?.runsIn}`)
truthy('🔴 `veste moto homme homologué` is NOT listed — 0 orders at every window',
  !at60.inbound.rows.some((r) => r.termKey === 'veste moto homme homologué')
  && !at30.inbound.rows.some((r) => r.termKey === 'veste moto homme homologué'))

// 🔴 the detector must EXCLUDE our own writes
const ourIds = new Set(createLogs.map((l) => l.entityId))
truthy('🔴 no row came through our write path', at60.inbound.rows.every((r) => !ourIds.has(r.adTargetId)))
const ourRecentBlocking = negs.filter((n) => blocks(n) && n.createdAt >= cutoff && ourIds.has(n.id))
console.log(`     recent blocking negations WE created: ${ourRecentBlocking.length} — all correctly excluded`)

// an assertion over an empty list must fail
truthy('🔴 an empty candidate set FAILS rather than passing vacuously', at60.inbound.candidates > 0)

console.log(`\n${failures === 0 ? '✓ all assertions passed' : `🔴 ${failures} assertion(s) FAILED`}`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
