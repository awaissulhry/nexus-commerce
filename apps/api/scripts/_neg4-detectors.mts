/**
 * NEG.4 — the detectors, asserted in TWO STAGES. READ-ONLY.
 *
 * 🔴 Why two stages. Detector A's correct answer is currently **0**, and a broken join returns 0
 * too. A single-stage suite that asserted "Detector A = 0" would pass against a query joining
 * external ids to local cuids — the exact bug NEG.2 was built to avoid — and would be
 * indistinguishable from a correct one.
 *
 *   Stage 1 proves the JOIN, on the relaxed set (any negation state). It must be NON-ZERO.
 *   Stage 2 proves the POLICY filter. It must be zero, and only means anything if stage 1 passed.
 *
 * **A stage-2 pass with a stage-1 failure means the detector is broken and its zeros are fake.**
 *
 * `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_neg4-detectors.mts` from apps/api.
 */
import '../src/env.js'
const { getAttention, isBlockingAdGroupNegation } = await import('../src/services/advertising/negatives-attention.service.js')
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
let stage1Failures = 0
const check = (l: string, ok: boolean, d = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${l}${d ? ` — ${d}` : ''}`); return ok }
const eq = (l: string, g: unknown, w: unknown) => check(l, g === w, `got ${String(g)}, want ${String(w)}`)

console.log('\n═══ NEG.4 — the detectors ═══\n')

const A = await getAttention({ market: 'all' })

// ══ STAGE 1 — the JOIN ════════════════════════════════════════════════════════════════════════
h('STAGE 1 · The join. Everything below is meaningless if this fails.')
console.log(`  search-term rows read: ${int(A.coverage.searchTermRows)} · terms with traffic ${int(A.coverage.termsWithTraffic)} of ${int(A.coverage.termsTotal)}`)
// 🔴 The single most dangerous trap in this section: `.catch(() => [])` and an empty IN list both
// read as a quiet account. A zero here is a failed read, never good news.
stage1Failures += check('search-term rows were actually read — 0 would be a failed read, not a quiet account', A.coverage.searchTermRows > 0, `${A.coverage.searchTermRows} rows`) ? 0 : 1
stage1Failures += check('🔴 the RELAXED overlap is NON-ZERO — this is the join working', A.conflicts.overlapsRelaxedUnscoped > 0, `${A.conflicts.overlapsRelaxedUnscoped}`) ? 0 : 1

// Re-derive both joins independently, so a bug in the service cannot agree with itself.
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, status: true, externalTargetId: true, negativeLevel: true,
    adGroup: { select: { id: true, externalAdGroupId: true, campaign: { select: { status: true, name: true } } } },
  },
})
const byTerm = new Map<string, typeof negs>()
for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }
const since = new Date(Date.now() - 30 * 86400_000)
const perAg = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'adGroupId'], where: { date: { gte: since }, query: { in: [...byTerm.keys()] } },
  _sum: { impressions: true, orders7d: true, sales7dCents: true },
})
let indepRelaxed = 0, indepBroken = 0
const relaxedTerms = new Set<string>()
for (const r of perAg) {
  const t = normaliseNegTerm(r.query)
  const rows = (byTerm.get(t) ?? []).filter((x) => x.negativeLevel !== 'CAMPAIGN')
  if (rows.some((x) => x.adGroup?.externalAdGroupId === r.adGroupId)) { indepRelaxed++; relaxedTerms.add(t) }
  // the BROKEN join — external traffic id against our local cuid
  if (rows.some((x) => x.adGroup?.id === r.adGroupId)) indepBroken++
}
eq('an independent re-derivation of the relaxed overlap agrees', indepRelaxed, A.conflicts.overlapsRelaxedUnscoped)
stage1Failures += check('🔴 the BROKEN join (external↔local) returns 0 — and therefore differs from the correct one', indepBroken === 0 && indepRelaxed !== indepBroken, `correct=${indepRelaxed} broken=${indepBroken}`) ? 0 : 1
console.log(`  terms with a relaxed overlap: ${[...relaxedTerms].map((t) => `「${t}」`).join(' ')}`)

// ══ STAGE 2 — the POLICY ══════════════════════════════════════════════════════════════════════
h('STAGE 2 · The policy filter. Only meaningful if stage 1 passed.')
if (stage1Failures > 0) console.log('  🔴 STAGE 1 FAILED — the zeros below are FAKE. Do not read them as a clean account.')

console.log(`  Detector A: ${int(A.conflicts.total)} conflicts of ${int(A.denominators.blockingNegations)} blocking negations`)
eq('Detector A finds 0 blocking conflicts today', A.conflicts.total, 0)
check('and it says what it counted against', A.denominators.blockingNegations > 0, `${A.denominators.blockingNegations}`)
eq('the blocking denominator is 942', A.denominators.blockingNegations, 942)

h('Why the relaxed overlaps are not conflicts — the collapse, on the record')
for (const e of A.conflicts.relaxedExplained) console.log(`  「${e.termKey}」 ad group ${e.externalAdGroupId} · ${e.rows} row(s) — ${e.reason}`)
eq('every relaxed overlap is explained', A.conflicts.relaxedExplained.length, A.conflicts.overlapsRelaxedUnscoped)

h('The blocking predicate excludes what it must')
const blocking = negs.filter((n) => isBlockingAdGroupNegation({ status: String(n.status), externalTargetId: n.externalTargetId, negativeLevel: n.negativeLevel, campaignStatus: n.adGroup?.campaign?.status ?? null }))
eq('no local-only row is ever blocking', blocking.filter((n) => !n.externalTargetId).length, 0)
eq('no ARCHIVED target is ever blocking', blocking.filter((n) => String(n.status) === 'ARCHIVED').length, 0)
eq('no campaign-level row is ever blocking', blocking.filter((n) => n.negativeLevel === 'CAMPAIGN').length, 0)
eq('no row in a non-ENABLED campaign is blocking', blocking.filter((n) => n.adGroup?.campaign?.status !== 'ENABLED').length, 0)
eq('the count matches the payload', blocking.length, A.denominators.blockingNegationsUnscoped)

// ══ Detector B ════════════════════════════════════════════════════════════════════════════════
h('Detector B · suppressed earners')
console.log(`  findings ${int(A.suppressed.total)} · explained ${int(A.suppressed.explained)}`)
for (const s of A.suppressed.rows) console.log(`    🔴 ${s.termKey.padEnd(30)} ${s.negations} negations, ${s.blocking} blocking · ${s.history.orders} orders / ${eur(s.history.salesCents)} in ${s.history.days}d · thin=${s.thin} · actionable=${s.actionable}`)
check('there are findings to assert about — an empty list here would be a silent pass', A.suppressed.rows.length > 0, `${A.suppressed.rows.length}`)
eq('3 genuine findings', A.suppressed.total, 3)
eq('1 explained', A.suppressed.explained, 1)
const xavia = A.suppressed.rows.find((s) => s.termKey === 'xavia')
check('xavia is a finding', !!xavia)
eq('  xavia has 16 negations', xavia?.negations, 16)
eq('  all 16 of them block', xavia?.blocking, 16)
eq('  0 impressions in the window', xavia?.windowImpressions, 0)
eq('  1 order in 120d', xavia?.history.orders, 1)
eq('  €122.91 in 120d', xavia?.history.salesCents, 12291)
check('  and it is flagged as THIN evidence — one order is a signal, not a proven loss', xavia?.thin === true)
// 🔴 The one that must be explained rather than listed: nothing blocks it, so the negative is not
// the cause. A detector that lists it makes the operator do the elimination it exists to do.
const explainedTerm = 'giacca in pelle moto uomo'
check(`🔴 「${explainedTerm}」 is NOT in the findings`, !A.suppressed.rows.some((s) => s.termKey === explainedTerm))

// ══ split-brain ═══════════════════════════════════════════════════════════════════════════════
h('Split-brain')
console.log(`  ${int(A.splitBrain.total)} rows · byReason ${JSON.stringify(A.splitBrain.byReason)}`)
eq('40 rows', A.splitBrain.total, 40)
check('there are rows to assert about', A.splitBrain.rows.length > 0)
eq('every one has no Amazon id', A.splitBrain.rows.filter((r) => r.reason.length === 0).length, 0)
const dbSplit = await prisma.adTarget.count({ where: { isNegative: true, externalTargetId: null } })
eq('the count matches the database', A.splitBrain.total, dbSplit)
eq('every split-brain row is actionable — a local delete never touches the gate', A.splitBrain.rows.filter((r) => !r.actionable).length, 0)

// ══ scope ═════════════════════════════════════════════════════════════════════════════════════
h('Scope — "N of M elsewhere" needs both numbers')
const it = await getAttention({ market: 'IT' })
console.log(`  IT: conflicts ${it.conflicts.total}/${it.conflicts.totalUnscoped} · suppressed ${it.suppressed.total}/${it.suppressed.totalUnscoped} · split-brain ${it.splitBrain.total}/${it.splitBrain.totalUnscoped}`)
check('the unscoped totals are carried alongside the scoped ones', it.splitBrain.totalUnscoped >= it.splitBrain.total)
eq('the unscoped split-brain total is the account figure', it.splitBrain.totalUnscoped, 40)
check('a market scope narrows something', it.splitBrain.total <= A.splitBrain.total)

const camp = await prisma.adTarget.findFirst({ where: { isNegative: true, externalTargetId: null }, select: { adGroup: { select: { campaign: { select: { id: true, name: true, marketplace: true } } } } } })
if (camp?.adGroup?.campaign) {
  const c = await getAttention({ market: camp.adGroup.campaign.marketplace!, campaign: camp.adGroup.campaign.id })
  console.log(`  campaign "${camp.adGroup.campaign.name}": split-brain ${c.splitBrain.total} of ${c.splitBrain.totalUnscoped} account-wide`)
  check('a campaign scope shows fewer than the account', c.splitBrain.total < c.splitBrain.totalUnscoped)
  check('and the account total is still stated, so 0-in-scope cannot read as 0-everywhere', c.splitBrain.totalUnscoped === 40)
}

// ══ windows ═══════════════════════════════════════════════════════════════════════════════════
h('The window binds, and the history does not move with it')
for (const w of [30, 60, 120]) {
  const r = await getAttention({ market: 'all', window: w })
  console.log(`  ${String(w).padStart(3)}d → conflicts ${r.conflicts.total} (relaxed ${r.conflicts.overlapsRelaxedUnscoped}) · suppressed ${r.suppressed.total} · terms with traffic ${r.coverage.termsWithTraffic}`)
  eq(`  window echoed as ${w}`, r.window.days, w)
  eq('  history stays 120d', r.thresholds.historyDays, 120)
  check('  the join still works at this window', r.coverage.searchTermRows > 0)
}
const wide = await getAttention({ market: 'all', window: 120 })
check('a wider window cannot see fewer terms with traffic', wide.coverage.termsWithTraffic >= A.coverage.termsWithTraffic)
check('and a wider window finds fewer or equal suppressed earners (more terms have traffic)', wide.suppressed.total <= A.suppressed.total)
eq('an unsupported window falls back to 30', (await getAttention({ market: 'all', window: 7 })).window.days, 30)

// ══ reconciliation with the oracle ════════════════════════════════════════════════════════════
h('🔴 Reconciliation with `_neg-page-conflict.mts` §A')
// The oracle prints "converting terms whose traffic ad group is ALSO a negating ad group: 1".
// That is the CONVERTING subset, not the overlap count. Our relaxed count covers every term.
const convertingWithOverlap = [...relaxedTerms].filter((t) => {
  const rows = perAg.filter((r) => normaliseNegTerm(r.query) === t)
  return rows.reduce((a, r) => a + (r._sum.orders7d ?? 0), 0) > 0
})
console.log(`  relaxed overlaps (all terms):       ${indepRelaxed}`)
console.log(`  …restricted to CONVERTING terms:    ${convertingWithOverlap.length}  ← the oracle's "1"`)
console.log(`  converting terms with an overlap:   ${convertingWithOverlap.map((t) => `「${t}」`).join(' ')}`)
eq('the converting subset reproduces the oracle exactly', convertingWithOverlap.length, 1)
check('and the oracle number is a SUBSET of ours, not a disagreement', indepRelaxed >= convertingWithOverlap.length)

console.log(`\n${failures === 0 ? '✅ both stages passed — the join works AND the account is genuinely clean' : `❌ ${failures} assertion(s) failed`}`)
if (stage1Failures > 0) console.log('🔴 STAGE 1 FAILED — treat every zero above as unproven.\n')
else console.log('')
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
