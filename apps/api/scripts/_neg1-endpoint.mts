/**
 * NEG.1 — `GET /advertising/negatives`, exercised. READ-ONLY.
 *
 * Calls the service directly (the route is a thin param parser over it) at all five grains, both
 * views, every filter, sort and page — and then checks the numbers against the database rather
 * than against itself. A payload that is internally consistent and wrong is the failure this
 * script exists to catch.
 *
 * Every assertion prints PASS/FAIL and the script exits non-zero on any failure, so it can be
 * re-run after a deploy as a regression check rather than read as prose.
 *
 * `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_neg1-endpoint.mts` from apps/api.
 */
import '../src/env.js'
const { getNegatives, normaliseNegTerm, isBlockingNow } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, got === want, `got ${String(got)}, want ${String(want)}`)

console.log('\n═══ NEG.1 — endpoint verification ═══\n')

// ── The database truth, computed independently of the service ────────────────────────────────
const raw = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, status: true, externalTargetId: true,
    negativeLevel: true, createdAt: true,
    adGroup: { select: { id: true, campaign: { select: { id: true, marketplace: true, status: true, portfolioId: true } } } },
  },
})
const truth = {
  total: raw.length,
  terms: new Set(raw.map((r) => normaliseNegTerm(r.expressionValue))).size,
  blocking: raw.filter((r) => isBlockingNow({ status: String(r.status), externalTargetId: r.externalTargetId, campaignStatus: r.adGroup?.campaign?.status ?? null })).length,
  notAtAmazon: raw.filter((r) => r.externalTargetId == null).length,
  byMarket: new Map<string, number>(),
}
for (const r of raw) {
  const m = r.adGroup?.campaign?.marketplace ?? '—'
  truth.byMarket.set(m, (truth.byMarket.get(m) ?? 0) + 1)
}
console.log(`database: ${int(truth.total)} negatives · ${int(truth.terms)} terms · ${int(truth.blocking)} blocking · ${int(truth.notAtAmazon)} not at Amazon`)
console.log(`by market: ${[...truth.byMarket].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

// ── 1 · the market grain, all four markets ───────────────────────────────────────────────────
h('1 · Market grain — four markets, and they must sum to the base')
let sumRows = 0, sumBlocking = 0, sumNotAtAmazon = 0
for (const market of ['IT', 'DE', 'ES', 'FR']) {
  const t = Date.now()
  const p = await getNegatives({ market })
  sumRows += p.census.negations
  sumBlocking += p.census.blockingNow
  sumNotAtAmazon += p.census.notAtAmazon
  console.log(`  ${market}  ${String(int(p.census.negations)).padStart(5)} negations · ${String(int(p.census.terms)).padStart(4)} terms · ${String(int(p.census.blockingNow)).padStart(5)} blocking · ${String(int(p.census.notAtAmazon)).padStart(3)} not-at-Amazon · ${p.scope.resolved.campaigns} campaigns · ${Date.now() - t}ms`)
  eq(`    ${market} boundBy`, p.scope.boundBy, 'market')
  check(`    ${market} rows returned match the census`, p.total === p.census.negations, `total=${p.total} census=${p.census.negations}`)
  check(`    ${market} market column is uniform`, (p.rows as Array<{ market: string }>).every((r) => r.market === market))
  eq(`    ${market} db cross-check`, p.census.negations, truth.byMarket.get(market) ?? 0)
}
eq('the four markets sum to the whole base', sumRows, truth.total)
eq('the four markets sum to the blocking count', sumBlocking, truth.blocking)
eq('the four markets sum to the not-at-Amazon count', sumNotAtAmazon, truth.notAtAmazon)

// ── 2 · the census is an intersection ────────────────────────────────────────────────────────
h('2 · 🔴 "Blocking now" is an intersection, not the study\'s 1,045')
const it = await getNegatives({ market: 'IT' })
const all = await Promise.all(['IT', 'DE', 'ES', 'FR'].map((m) => getNegatives({ market: m })))
const acct = all.reduce((a, p) => ({
  negations: a.negations + p.census.negations,
  blocking: a.blocking + p.census.blockingNow,
  inInert: a.inInert + p.census.inInertCampaign,
  archived: a.archived + p.census.archived,
  campaignLevel: a.campaignLevel + p.census.campaignLevel,
  notAtAmazon: a.notAtAmazon + p.census.notAtAmazon,
}), { negations: 0, blocking: 0, inInert: 0, archived: 0, campaignLevel: 0, notAtAmazon: 0 })
console.log(`  account-wide: ${int(acct.negations)} negations · ${int(acct.blocking)} blocking · ${int(acct.inInert)} in an inert campaign · ${int(acct.archived)} archived targets · ${int(acct.notAtAmazon)} not at Amazon · ${int(acct.campaignLevel)} campaign-level`)
const inEnabledCampaign = acct.negations - acct.inInert
console.log(`  in an ENABLED campaign (the study's headline): ${int(inEnabledCampaign)}`)
check('blocking is STRICTLY fewer than "in an enabled campaign"', acct.blocking < inEnabledCampaign, `${acct.blocking} vs ${inEnabledCampaign}`)
eq('blocking matches the database', acct.blocking, truth.blocking)

// ── 3 · every finer grain, and the cascade ───────────────────────────────────────────────────
h('3 · The five grains cascade, most specific wins')
const bigCampaign = [...new Map((it.rows as Array<{ campaignId: string; campaignName: string }>).map((r) => [r.campaignId, r.campaignName])).entries()]
  .map(([id, name]) => ({ id, name, n: (it.rows as Array<{ campaignId: string }>).filter((r) => r.campaignId === id).length }))
  .sort((a, b) => b.n - a.n)[0]
const camp = await getNegatives({ market: 'IT', campaign: bigCampaign.id })
eq(`campaign "${bigCampaign.name}" boundBy`, camp.scope.boundBy, 'campaign')
eq(`campaign row count`, camp.census.negations, bigCampaign.n)
check('the campaign grain offers ad groups that all hold a negative', camp.scope.adGroupOptions.length > 0 && camp.scope.adGroupOptions.every((o) => o.negatives > 0), `${camp.scope.adGroupOptions.length} options`)

const ag = camp.scope.adGroupOptions[0]
const agp = await getNegatives({ market: 'IT', campaign: bigCampaign.id, adGroup: ag.id })
eq(`ad group "${ag.name}" boundBy`, agp.scope.boundBy, 'adGroup')
eq('ad-group row count matches the option count', agp.census.negations, ag.negatives)
check('ad group ⊆ campaign', agp.census.negations <= camp.census.negations)

// most-specific-wins: a coarser grain alongside a finer one must not change the answer
const both = await getNegatives({ market: 'IT', portfolio: 'does-not-exist', campaign: bigCampaign.id })
eq('a bogus portfolio alongside a campaign is inert', both.census.negations, camp.census.negations)
const crossMarket = await getNegatives({ market: 'DE', campaign: bigCampaign.id })
eq('🔴 an IT campaign under the DE market resolves to NOTHING', crossMarket.census.negations, 0)
eq('   …and says the campaign grain bound it', crossMarket.scope.boundBy, 'campaign')

// portfolio, with its blind spot stated
const pf = [...new Set((await prisma.campaign.findMany({ where: { marketplace: 'IT', portfolioId: { not: null } }, select: { portfolioId: true } })).map((c) => c.portfolioId!))][0]
if (pf) {
  const p = await getNegatives({ market: 'IT', portfolio: pf })
  eq('portfolio boundBy', p.scope.boundBy, 'portfolio')
  check('🔴 a portfolio view states what it cannot see', p.scope.unreachable != null)
  if (p.scope.unreachable) {
    const u = p.scope.unreachable
    console.log(`    blind to ${int(u.negativesWithoutPortfolio)} of ${int(u.negativesTotal)} IT negatives (${((u.negativesWithoutPortfolio / Math.max(1, u.negativesTotal)) * 100).toFixed(0)}%), across ${int(u.campaignsWithoutPortfolio)} of ${int(u.campaignsInMarket)} campaigns`)
    check('    the blind-spot count is real, not a zero from a swallowed error', u.negativesWithoutPortfolio > 0)
  }
}
const line = (await prisma.product.findFirst({ where: { parentId: null, children: { some: {} } }, select: { id: true, sku: true } }))
if (line) {
  const p = await getNegatives({ market: 'IT', line: line.id })
  eq(`line "${line.sku}" boundBy`, p.scope.boundBy, 'line')
  console.log(`    ${int(p.census.negations)} negations across ${p.scope.resolved.campaigns} campaigns`)
}

// ── 4 · both views ───────────────────────────────────────────────────────────────────────────
h('4 · Two grains, never blurred')
// The client renders the grain the PAYLOAD reports, not the one the URL asked for — they disagree
// for one render on every view switch, and reading the URL crashed the page. That fix depends on
// this echo being present and correct, so it is asserted rather than assumed.
for (const v of ['negations', 'terms'] as const) {
  const p = await getNegatives({ market: 'IT', view: v })
  eq(`the payload echoes view=${v}`, p.view, v)
  const shape = (p.rows as Array<Record<string, unknown>>)[0]
  check(`  rows carry the ${v} shape`, v === 'terms' ? typeof shape?.rows === 'number' : typeof shape?.id === 'string')
}
const terms = await getNegatives({ market: 'IT', view: 'terms' })
eq('terms view row count equals the census term count', terms.total, it.census.terms)
eq('terms view census is identical to the negations view', terms.census.negations, it.census.negations)
const termRows = terms.rows as Array<{ termKey: string; rows: number; adGroups: number; campaigns: number; blockingNow: number }>
const rowsum = termRows.reduce((a, r) => a + r.rows, 0)
eq('the term rows sum to the negation count', rowsum, it.census.negations)
eq('the term rows sum to the blocking count', termRows.reduce((a, r) => a + r.blockingNow, 0), it.census.blockingNow)
console.log('  top 5 IT terms by spread:')
for (const t of termRows.slice(0, 5)) console.log(`    ${t.termKey.padEnd(32)} ${t.rows} rows · ${t.adGroups} ad groups · ${t.campaigns} campaigns · ${t.blockingNow} blocking`)

// ── 5 · every filter, and the consistency law ────────────────────────────────────────────────
h('5 · Filters — the parts must sum to the whole')
const facetSum = async (name: string, key: 'match' | 'level' | 'amazon' | 'state' | 'attribution', param: string) => {
  const base = await getNegatives({ market: 'IT' })
  const facet = base.facets[key]
  let sum = 0
  const parts: string[] = []
  for (const f of facet) {
    const p = await getNegatives({ market: 'IT', [param]: f.value } as never)
    sum += p.total
    parts.push(`${f.value}=${p.total}`)
    check(`  ${name}:${f.value} matches its facet count`, p.total === f.count, `filtered=${p.total} facet=${f.count}`)
  }
  eq(`${name} — the filtered counts sum to the total`, sum, base.census.negations)
  console.log(`    ${parts.join(' · ')}`)
}
await facetSum('match type', 'match', 'match')
await facetSum('level', 'level', 'level')
await facetSum('at Amazon', 'amazon', 'amazon')
await facetSum('attribution', 'attribution', 'attribution')

h('5b · Campaign state — the three named states plus anything else')
const stIt = await getNegatives({ market: 'IT' })
let stSum = 0
for (const s of ['live', 'paused', 'archived'] as const) {
  const p = await getNegatives({ market: 'IT', state: s })
  stSum += p.total
  console.log(`    ${s.padEnd(9)} ${int(p.total)}`)
}
eq('the three campaign states sum to the total', stSum, stIt.census.negations)

h('5d · 🔴 Every census cell\'s number must equal the row count of the filter it applies')
// Found on prod by CLICKING, not by reading: "blocking now" showed 942 and its filter returned
// 1,004 (the 62 ARCHIVED targets in enabled campaigns), and "in a paused campaign" showed 1,014
// and returned 1,013 (the one ARCHIVED campaign). A cell whose number and filter disagree teaches
// the operator that the strip is approximate, which is worse than having no strip.
for (const market of ['IT', 'all']) {
  const base = await getNegatives({ market })
  const cellChecks: Array<[string, number, Record<string, unknown>]> = [
    ['negatives', base.census.negations, {}],
    ['blocking now', base.census.blockingNow, { blocking: 'yes' }],
    ['in a paused campaign', base.census.inInertCampaign, { state: 'inert' }],
    ['never confirmed at Amazon', base.census.notAtAmazon, { amazon: 'no' }],
  ]
  for (const [label, n, filter] of cellChecks) {
    const p = await getNegatives({ market, ...filter } as never)
    check(`${market} · "${label}" reads ${int(n)} and its filter returns ${int(p.total)}`, p.total === n)
  }
  const t = await getNegatives({ market, view: 'terms' })
  check(`${market} · "terms" reads ${int(base.census.terms)} and the terms view returns ${int(t.total)}`, t.total === base.census.terms)
  // The composition that was wrong, kept as a REGRESSION marker rather than deleted: it must stay
  // different from `blocking=yes`, or the bug has quietly come back as a coincidence.
  const composed = await getNegatives({ market, state: 'live', amazon: 'yes' })
  console.log(`    (state=live&amazon=yes returns ${int(composed.total)} — ${composed.total === base.census.blockingNow ? 'equal today, but it is NOT the same predicate' : `${int(composed.total - base.census.blockingNow)} more than blocking=yes, which is the archived-target gap`})`)
}

h('5c · Search')
const qp = await getNegatives({ market: 'IT', q: 'giacca' })
check('a search narrows the rows but never the census', qp.total < qp.census.negations && qp.census.negations === stIt.census.negations, `q=${qp.total} census=${qp.census.negations}`)
check('every returned row actually matches', (qp.rows as Array<{ term: string; campaignName: string; adGroupName: string }>).every((r) => `${r.term} ${r.campaignName} ${r.adGroupName}`.toLowerCase().includes('giacca')))
const qnone = await getNegatives({ market: 'IT', q: 'zzz-no-such-term-zzz' })
eq('an empty search result still carries the full census', qnone.census.negations, stIt.census.negations)
eq('  …and returns no rows', qnone.total, 0)

// ── 6 · sort ─────────────────────────────────────────────────────────────────────────────────
h('6 · Sort — every key, both directions, same row set')
for (const k of ['term', 'match', 'scope', 'market', 'state', 'amazon', 'added', 'by', 'spread'] as const) {
  const asc = await getNegatives({ market: 'IT', sort: k, dir: 'asc' })
  const desc = await getNegatives({ market: 'IT', sort: k, dir: 'desc' })
  const a = (asc.rows as Array<{ id: string }>).map((r) => r.id)
  const d = (desc.rows as Array<{ id: string }>).map((r) => r.id)
  check(`sort=${k} keeps the same rows in both directions`, a.length === d.length && new Set(a).size === new Set([...a, ...d]).size, `${a.length}/${d.length}`)
}

// ── 7 · the match-type churn, and immunity to it ─────────────────────────────────────────────
h('7 · 🔴 The raw column is churning — the page must not care')
console.log(`  raw spellings in IT right now: ${it.facets.rawTypes.map((r) => `${r.value}=${int(r.count)}`).join(' · ')}`)
console.log(`  normalised:                    ${it.facets.match.map((r) => `${r.value}=${int(r.count)}`).join(' · ')}`)
const rawSum = it.facets.rawTypes.reduce((a, r) => a + r.count, 0)
const normSum = it.facets.match.reduce((a, r) => a + r.count, 0)
eq('every raw spelling lands in exactly one normalised bucket', rawSum, normSum)
check('no row falls through to OTHER', !it.facets.match.some((m) => m.value === 'OTHER'), it.facets.match.find((m) => m.value === 'OTHER') ? `${it.facets.match.find((m) => m.value === 'OTHER')!.count} rows are OTHER — a new spelling has appeared` : '')
// Read the raw column twice, ~40s apart, and show whether it moved while this script ran.
const t0 = await prisma.adTarget.groupBy({ by: ['expressionType'], where: { isNegative: true }, _count: { _all: true } })
await new Promise((r) => setTimeout(r, 40000))
const t1 = await prisma.adTarget.groupBy({ by: ['expressionType'], where: { isNegative: true }, _count: { _all: true } })
const fmt = (rows: typeof t0) => rows.map((r) => `${r.expressionType}=${r._count._all}`).sort().join(' · ')
console.log(`  t=0s   ${fmt(t0)}`)
console.log(`  t=40s  ${fmt(t1)}`)
console.log(`  ${fmt(t0) === fmt(t1) ? 'stable over this window' : '🔴 MOVED — a single-spelling filter would return a different row set'}`)

// ── 8 · zeros are verified, never assumed ────────────────────────────────────────────────────
h('8 · Every zero this payload reports, checked against the database')
const zeroChecks: Array<[string, number, () => Promise<number>]> = [
  ['orphaned negatives', 0, () => prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })],
  ['campaign-level rows confirmed at Amazon', 0, () => prisma.adTarget.count({ where: { isNegative: true, negativeLevel: 'CAMPAIGN', externalTargetId: { not: null } } })],
]
for (const [label, expected, q] of zeroChecks) {
  const got = await q()
  check(`${label} = ${expected}`, got === expected, `measured ${got}`)
}
// `evidence: { not: undefined }` is a Prisma NO-OP — it matches every row, and the first run of
// this script printed 856 where the study says 0. Counted in JS instead, which cannot be silently
// satisfied by a filter that was never applied.
const evLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
  select: { evidence: true },
})
const withEvidence = evLogs.filter((l) => l.evidence != null).length
console.log(`  create_negative_* logs: ${int(evLogs.length)} · carrying evidence: ${int(withEvidence)}`)
// NEG-P1 (2026-08-21): the study's zero became a FLOOR, not a pin — NEG.X's protezioni writes
// (2026-08-14) landed WITH evidence, and every wire-path negation mirrors with an audit row, so
// this number should only ever grow. A pin at 0 would report the world improving as a failure.
check('create logs carrying evidence never regress (≥3: the NEG.X protezioni writes)', withEvidence >= 3, `measured ${withEvidence}`)

// ── 9 · timing ───────────────────────────────────────────────────────────────────────────────
h('9 · Cost')
for (const label of ['IT market', 'IT terms view', 'one campaign'] as const) {
  const t = Date.now()
  if (label === 'IT market') await getNegatives({ market: 'IT' })
  else if (label === 'IT terms view') await getNegatives({ market: 'IT', view: 'terms' })
  else await getNegatives({ market: 'IT', campaign: bigCampaign.id })
  console.log(`  ${label.padEnd(16)} ${Date.now() - t}ms`)
}

console.log(`\n${failures === 0 ? '✅ every assertion passed' : `❌ ${failures} assertion(s) failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
