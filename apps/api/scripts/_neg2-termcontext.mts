/**
 * NEG.2 — `GET /advertising/negatives/term-context`, asserted. READ-ONLY.
 *
 * Four terms, chosen because each breaks a different way. The one that matters is
 * `saponette moto`: it is the ONLY term in the account with a live ad-group overlap, so it is the
 * only fixture that can tell a correct join from the broken one. Everything else in this file
 * would pass with `AmazonAdsSearchTerm.adGroupId` (external) joined against `AdGroup.id` (local),
 * which returns 0 for every term forever and looks exactly like good news.
 *
 * `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_neg2-termcontext.mts` from apps/api.
 * Exits non-zero on any failed assertion.
 */
import '../src/env.js'
const { getTermContext, normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const eq = (label: string, got: unknown, want: unknown) => check(label, got === want, `got ${String(got)}, want ${String(want)}`)

console.log('\n═══ NEG.2 — term-context, asserted ═══\n')

// ── 1 · giacca moto — the widest spread in the account ───────────────────────────────────────
h('1 · giacca moto — the widest spread')
const gm = await getTermContext({ term: 'giacca moto', market: 'all' })
if (!gm) { console.log('  ✗ FAIL — no context returned'); failures++ } else {
  eq('negations', gm.spread.rows, 72)
  eq('ad groups (local, every negation — the grid chip\'s number)', gm.spread.adGroups, 49)
  eq('campaigns', gm.spread.campaigns, 41)
  console.log(`    runsIn ${gm.runsIn.length} · overlap ${gm.overlap.length} · 30d ${int(gm.performance.impressions)} impr / ${gm.performance.orders} orders / ${eur(gm.performance.salesCents)}`)
  console.log(`    comparable: ${gm.comparable.negatedAdGroups} ad-group-scoped (external) · ${gm.comparable.campaignLevel} campaign-wide, ${gm.comparable.campaignLevelAtAmazon} of them at Amazon`)
  // 🔴 The two ad-group numbers differ BY DESIGN and the drawer says so. 49 counts local ad groups
  // over every row; 48 counts external ids over the ad-group-scoped rows only, because a
  // campaign-level row's ad group is an FK convenience and not a place Amazon blocks anything.
  check('the two ad-group counts differ exactly by the campaign-level rows\' ad groups',
    gm.spread.adGroups > gm.comparable.negatedAdGroups && gm.comparable.campaignLevel > 0,
    `${gm.spread.adGroups} local vs ${gm.comparable.negatedAdGroups} comparable, ${gm.comparable.campaignLevel} campaign-level`)
  check('every negation is accounted for in the list', gm.negations.length === gm.spread.rows)
}

// ── 2 · saponette moto — THE join test ───────────────────────────────────────────────────────
h('2 · 🔴 saponette moto — the only live overlap in the account')
const sap = await getTermContext({ term: 'saponette moto', market: 'all' })
if (!sap) { console.log('  ✗ FAIL — no context returned'); failures++ } else {
  eq('runsIn', sap.runsIn.length, 5)
  eq('🔴 overlap — 0 here means the external↔local join is back', sap.overlap.length, 1)
  // 🔴 Two grains, one level down from the term/negation split. ONE ad group overlaps; it holds
  // TWO negation rows for the term (`_PHRASE` and `_EXACT`), because an ad group can negate the
  // same term at more than one match type. My first assertion here said 1 and was wrong — the code
  // was right. Both numbers are now returned, because "clear the overlap" is 2 writes, not 1, and
  // NEG.3's confirm must say so.
  eq('overlapRows — the WRITES it would take to clear it', sap.overlapRows, 2)
  eq('the negation rows agree with it', sap.negations.filter((n) => n.overlaps).length, sap.overlapRows)
  check('overlapRows is never fewer than the overlapping ad groups', sap.overlapRows >= sap.overlap.length)
  eq('and the two rows sit in the SAME ad group', new Set(sap.negations.filter((n) => n.overlaps).map((n) => n.externalAdGroupId)).size, 1)
  const ov = sap.overlap[0]
  console.log(`    overlapping ad group: ${ov?.adGroupName ?? ov?.externalAdGroupId} · ${int(ov?.impressions ?? 0)} impr · ${ov?.orders ?? 0} orders · ${eur(ov?.salesCents ?? 0)}`)
  check('the overlapping traffic row is marked negated', ov?.negated === true)
  check('the other four traffic rows are NOT marked negated', sap.runsIn.filter((r) => !r.negated).length === 4)
  // Independent re-derivation of the same number, straight from the two tables, so a bug in the
  // service cannot agree with itself.
  const since = new Date(Date.now() - 30 * 86400_000)
  const perAg = await prisma.amazonAdsSearchTerm.groupBy({ by: ['adGroupId'], where: { date: { gte: since }, query: 'saponette moto' }, _sum: { impressions: true } })
  const negs = await prisma.adTarget.findMany({
    where: { isNegative: true, negativeLevel: { not: 'CAMPAIGN' } },
    select: { expressionValue: true, adGroup: { select: { externalAdGroupId: true } } },
  })
  const negExt = new Set(negs.filter((n) => normaliseNegTerm(n.expressionValue) === 'saponette moto').map((n) => n.adGroup?.externalAdGroupId).filter(Boolean))
  const independent = perAg.filter((r) => negExt.has(r.adGroupId)).length
  eq('an independent re-derivation agrees', independent, sap.overlap.length)
}

// ── 3 · xavia — protected, dark for 30 days, earning in 120 ──────────────────────────────────
h('3 · xavia — the suppressed-earner shape')
const xv = await getTermContext({ term: 'xavia', market: 'all' })
if (!xv) { console.log('  ✗ FAIL — no context returned'); failures++ } else {
  eq('negations', xv.spread.rows, 16)
  eq('all of them sit in an ENABLED campaign', xv.negations.filter((n) => n.campaignStatus === 'ENABLED').length, 16)
  eq('no impressions in the last 30 days', xv.performance.impressions, 0)
  eq('but orders in the last 120', xv.history.orders, 1)
  eq('and sales to go with them', xv.history.salesCents, 12291)
  check('the protection badge fires', xv.term.protectedBy.length === 1, JSON.stringify(xv.term.protectedBy))
  eq('and names the semantics', xv.term.protectedBy[0]?.matchType, 'CONTAINS')
  // 🔴 ACoS must be null, not 0, when there are no sales in the window. A 0% ACoS reads as "free".
  eq('acos is null with no sales in the window, never 0', xv.performance.acos, null)
}

// ── 4 · a campaign-level negation ────────────────────────────────────────────────────────────
h('4 · A campaign-level negation — no ad group Amazon can match, no Amazon id')
const campRow = await prisma.adTarget.findFirst({ where: { isNegative: true, negativeLevel: 'CAMPAIGN' }, select: { expressionValue: true } })
const ct = campRow ? await getTermContext({ term: campRow.expressionValue, market: 'all' }) : null
if (!ct) { console.log('  ✗ FAIL — no campaign-level negation found'); failures++ } else {
  const camp = ct.negations.filter((n) => n.level === 'CAMPAIGN')
  console.log(`    「${ct.term.key}」 ${camp.length} campaign-wide of ${ct.negations.length}`)
  check('at least one campaign-level row', camp.length > 0)
  eq('none of them is confirmed at Amazon', camp.filter((n) => n.atAmazon).length, 0)
  eq('none of them counts as blocking', camp.filter((n) => n.blockingNow).length, 0)
  eq('🔴 none of them is ever marked as overlapping', camp.filter((n) => n.overlaps).length, 0)
  check('and they are excluded from the comparable ad-group set', ct.comparable.campaignLevel === camp.length)
}

// ── 5 · the remainder — the guard the section exists for ─────────────────────────────────────
h('5 · The remainder sentence changes with the scope')
if (gm) {
  eq('account-wide, everything is in scope', gm.remainder.inScope, gm.remainder.total)
  eq('account-wide, the remainder is zero', gm.remainder.remainderRows, 0)
  check('and the payload says the scope IS the whole account', gm.remainder.scopeIsWholeAccount === true)

  const biggest = [...gm.negations.reduce((m, n) => m.set(n.campaignId, (m.get(n.campaignId) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])[0]
  const scoped = await getTermContext({ term: 'giacca moto', market: 'all', campaign: biggest[0] })
  if (scoped) {
    console.log(`    scoped to one campaign: ${scoped.remainder.inScope} of ${scoped.remainder.total} in scope · ${scoped.remainder.remainderRows} rows in ${scoped.remainder.remainderCampaigns} other campaigns`)
    eq('in-scope matches that campaign\'s share', scoped.remainder.inScope, biggest[1])
    eq('the remainder is everything else', scoped.remainder.remainderRows, gm.spread.rows - biggest[1])
    check('the remainder spans more than one campaign', scoped.remainder.remainderCampaigns > 1)
    check('and the payload no longer claims to be the whole account', scoped.remainder.scopeIsWholeAccount === false)
    eq('the negation list is still complete — scope highlights, it never filters', scoped.negations.length, gm.spread.rows)
    check('in-scope rows sort first', scoped.negations.slice(0, scoped.remainder.inScope).every((n) => n.inScope))
  }
  // A market scope is not the whole account either, and must say so.
  const itScoped = await getTermContext({ term: 'giacca moto', market: 'IT' })
  if (itScoped) check('a single-market scope does not claim to be the whole account', itScoped.remainder.scopeIsWholeAccount === false)
}

// ── 6 · the four empty states are four ───────────────────────────────────────────────────────
h('6 · A term nobody negated is a 404, not an empty context')
const none = await getTermContext({ term: 'zzz-no-such-term-zzz', market: 'all' })
check('never-negated returns null so the route can 404 it', none === null)
const blank = await getTermContext({ term: '   ', market: 'all' })
check('an empty term returns null rather than matching everything', blank === null)

// ── 7 · windows ──────────────────────────────────────────────────────────────────────────────
h('7 · The window binds, and 120d is always the history')
for (const w of [30, 60, 120]) {
  const r = await getTermContext({ term: 'giacca moto', market: 'all', window: w })
  console.log(`    ${String(w).padStart(3)}d → ${int(r?.performance.impressions ?? 0)} impr · ${r?.performance.orders ?? 0} orders · runsIn ${r?.runsIn.length ?? 0}`)
  eq(`      window echoed as ${w}`, r?.window.days, w)
  eq('      history stays 120d whatever the window', r?.history.days, 120)
}
const w30 = await getTermContext({ term: 'giacca moto', market: 'all', window: 30 })
const w120 = await getTermContext({ term: 'giacca moto', market: 'all', window: 120 })
check('a wider window cannot see fewer impressions', (w120?.performance.impressions ?? 0) >= (w30?.performance.impressions ?? 0))
const bad = await getTermContext({ term: 'giacca moto', market: 'all', window: 7 })
eq('an unsupported window falls back to 30, it does not return 7 days of data', bad?.window.days, 30)

// ── 8 · every zero verified ──────────────────────────────────────────────────────────────────
h('8 · Zeros, checked against the database rather than trusted')
const totalNegs = await prisma.adTarget.count({ where: { isNegative: true } })
console.log(`  negatives in the account: ${int(totalNegs)} (a real count — a swallowed error would read as 0)`)
check('the base is non-empty, so a 0 above would be a bug and not an empty account', totalNegs > 0)
if (xv) check('xavia\'s 30d zero is a real zero: its 120d window is NOT zero', xv.history.impressions > 0)

console.log(`\n${failures === 0 ? '✅ every assertion passed' : `❌ ${failures} assertion(s) failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
