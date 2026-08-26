/**
 * BID.S0 — verify `getBidGrid` against production before the route ships.
 *
 * READ-ONLY. Calls the service directly, so a wrong field name fails here rather than as an empty
 * grid on a deployed page. Every assertion below is one the UI depends on being true.
 */
import '../src/env.js'
const { getBidGrid, getBidCursorForRequest, BID_MARKET_ALL } = await import('../src/services/advertising/bid-grid.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✅' : '🔴'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures++
}

const base = {
  market: BID_MARKET_ALL, line: null, portfolio: null, campaign: null,
  view: 'targets' as const, status: 'enabled' as const, kind: [], match: [],
  band: null, measured: 'all' as const, q: null, windowDays: 30,
  sort: null, dir: 'desc' as const, limit: 5000,
}

console.log('\n═══ BID.S0 — service verification on prod ═══\n')

// ── 1. the default view ───────────────────────────────────────────────────────
console.log('1 · default view (all markets, ENABLED, no chips)')
const d = await getBidGrid({ ...base })
console.log(`     targets ${int(d.census.targets)} · campaigns ${int(d.census.campaigns)} · measured ${int(d.census.measured)} · spend ${c2e(d.census.spendCents)}`)
check('rows returned', d.rows.length > 0, `${int(d.rows.length)} rows`)
check('census.targets matches the ENABLED positive population (2,944)', d.census.targets === 2944, `got ${int(d.census.targets)}`)
check('not truncated at the 5,000 cap', !d.truncated)
check('scope is unscoped (null campaign list)', d.scope.campaigns === null)
check('no contradiction', d.scope.contradiction === null)
const r0 = d.rows[0] as Record<string, unknown>
check('first row carries a band + a campaign + a market', !!r0.band && !!r0.campaignName && !!r0.market, `${r0.text} · ${r0.band} · ${r0.market}`)

// ── 2. 🔴 metrics come from the daily table, never the dead columns ───────────
console.log('\n2 · metrics source')
const measuredRows = (d.rows as Array<Record<string, unknown>>).filter((r) => r.measured)
const spendy = measuredRows.filter((r) => Number(r.spendCents) > 0)
check('some rows carry non-zero spend', spendy.length > 0, `${int(spendy.length)} rows with spend > 0`)
check('measured coverage is the ~17.7% the probe measured', d.census.measured / d.census.targets > 0.1 && d.census.measured / d.census.targets < 0.3,
  `${((d.census.measured / d.census.targets) * 100).toFixed(1)}%`)
const unmeasuredWithSpend = (d.rows as Array<Record<string, unknown>>).filter((r) => !r.measured && Number(r.spendCents) > 0)
check('an unmeasured row NEVER reports spend', unmeasuredWithSpend.length === 0, `${unmeasuredWithSpend.length} violations`)
const zeroClickCpc = (d.rows as Array<Record<string, unknown>>).filter((r) => Number(r.clicks) === 0 && r.cpcCents !== null)
check('CPC is null (not 0) when there were no clicks', zeroClickCpc.length === 0, `${zeroClickCpc.length} violations`)

// ── 3. the facets must add up to the census ───────────────────────────────────
console.log('\n3 · facet arithmetic (no chips ⇒ every facet sums to the census)')
const sum = (f: Array<{ count: number }>) => f.reduce((s, x) => s + x.count, 0)
check('kind facet sums to census.targets', sum(d.facets.kind) === d.census.targets, `${int(sum(d.facets.kind))} vs ${int(d.census.targets)}`)
check('match facet sums to census.targets', sum(d.facets.match) === d.census.targets, `${int(sum(d.facets.match))} vs ${int(d.census.targets)}`)
check('band facet sums to census.targets', sum(d.facets.band) === d.census.targets, `${int(sum(d.facets.band))} vs ${int(d.census.targets)}`)
check('measured facet sums to census.targets', sum(d.facets.measured) === d.census.targets, `${int(sum(d.facets.measured))} vs ${int(d.census.targets)}`)
console.log(`     kinds  ${d.facets.kind.map((f) => `${f.value} ${int(f.count)}`).join(' · ')}`)
console.log(`     bands  ${d.facets.band.map((f) => `${f.value} ${int(f.count)}`).join(' · ')}`)
console.log(`     match  ${d.facets.match.length} distinct values`)

// ── 4. 🔴 every facet chip must deliver its own number ────────────────────────
console.log('\n4 · a chip returns exactly the count it advertises (the NEG.1 lesson)')
const topKind = d.facets.kind[0]
const byKind = await getBidGrid({ ...base, kind: [topKind.value] })
check(`kind=${topKind.value} chip`, byKind.rows.length === topKind.count, `chip said ${int(topKind.count)}, returned ${int(byKind.rows.length)}`)
const floorBand = d.facets.band[0]
const byBand = await getBidGrid({ ...base, band: floorBand.value as never })
check(`band=${floorBand.value} chip`, byBand.rows.length === floorBand.count, `chip said ${int(floorBand.count)}, returned ${int(byBand.rows.length)}`)
const measuredYes = d.facets.measured.find((f) => f.value === 'yes')!
const byMeasured = await getBidGrid({ ...base, measured: 'yes' })
check('measured=yes census cell', byMeasured.rows.length === measuredYes.count, `cell said ${int(measuredYes.count)}, returned ${int(byMeasured.rows.length)}`)

// ── 5. facets exclude their own dimension but apply the others ────────────────
console.log('\n5 · facets exclude their own dimension')
check('with kind pinned, the kind facet still lists every kind',
  byKind.facets.kind.length === d.facets.kind.length, `${byKind.facets.kind.length} vs ${d.facets.kind.length}`)
check('with kind pinned, the match facet narrows',
  sum(byKind.facets.match) === topKind.count, `${int(sum(byKind.facets.match))} vs ${int(topKind.count)}`)

// ── 5b. 🔴 live is an intersection, not a status ──────────────────────────────
console.log('\n5b · live = target ENABLED ∧ campaign ENABLED')
console.log(`     ${int(d.census.liveNow)} of ${int(d.census.targets)} ENABLED targets are in an ENABLED campaign · ${int(d.census.liveCampaigns)} of ${int(d.census.campaigns)} campaigns are ENABLED`)
check('liveNow is never greater than targets', d.census.liveNow <= d.census.targets)
check('liveCampaigns is never greater than campaigns', d.census.liveCampaigns <= d.census.campaigns)
const liar = (d.rows as Array<Record<string, unknown>>).filter((r) => r.liveNow && r.campaignStatus !== 'ENABLED')
check('no row claims to be live inside a non-ENABLED campaign', liar.length === 0, `${liar.length} violations`)

// ── 6. the campaign roll-up ───────────────────────────────────────────────────
console.log('\n6 · campaign roll-up')
const cv = await getBidGrid({ ...base, view: 'campaigns' })
check('census.campaigns reproduces its own number', cv.rows.length === d.census.campaigns, `${int(cv.rows.length)} rows vs cell ${int(d.census.campaigns)}`)
const rollTargets = (cv.rows as Array<Record<string, unknown>>).reduce((s, r) => s + Number(r.targets), 0)
check('roll-up target counts sum to the target view', rollTargets === d.census.targets, `${int(rollTargets)} vs ${int(d.census.targets)}`)
const rollSpend = (cv.rows as Array<Record<string, unknown>>).reduce((s, r) => s + Number(r.spendCents), 0)
check('roll-up spend sums to the census spend', Math.abs(rollSpend - d.census.spendCents) < 1, `${c2e(rollSpend)} vs ${c2e(d.census.spendCents)}`)
const badRange = (cv.rows as Array<Record<string, unknown>>).filter((r) => Number(r.bidMinCents) > Number(r.bidMaxCents))
check('bid range is never inverted', badRange.length === 0, `${badRange.length} violations`)
const top = cv.rows[0] as Record<string, unknown>
console.log(`     top by spend: ${top.name} · ${top.market} · ${int(Number(top.targets))} targets · ${c2e(Number(top.bidMinCents))}–${c2e(Number(top.bidMaxCents))} · ${c2e(Number(top.spendCents))}`)

// ── 7. every market resolves ──────────────────────────────────────────────────
console.log('\n7 · all four markets')
let marketSum = 0
for (const m of ['IT', 'DE', 'FR', 'ES']) {
  const g = await getBidGrid({ ...base, market: m })
  marketSum += g.census.targets
  check(`${m}`, g.census.targets > 0 && g.scope.campaigns !== null,
    `${int(g.census.targets)} targets · ${int(g.census.campaigns ?? 0)} campaigns in scope · ${int(g.census.measured)} measured`)
}
check('the four markets partition the account', marketSum === d.census.targets, `${int(marketSum)} vs ${int(d.census.targets)}`)

// ── 8. status ─────────────────────────────────────────────────────────────────
console.log('\n8 · status filter')
const paused = await getBidGrid({ ...base, status: 'paused' })
const archived = await getBidGrid({ ...base, status: 'archived' })
const allSt = await getBidGrid({ ...base, status: 'all' })
check('enabled + paused + archived = all', d.census.targets + paused.census.targets + archived.census.targets === allSt.census.targets,
  `${int(d.census.targets)} + ${int(paused.census.targets)} + ${int(archived.census.targets)} = ${int(allSt.census.targets)}`)
check('all-statuses is the full positive population (3,154)', allSt.census.targets === 3154, `got ${int(allSt.census.targets)}`)

// ── 9. scope grains ───────────────────────────────────────────────────────────
console.log('\n9 · scope grains')
const oneCampaign = (d.rows[0] as Record<string, unknown>).campaignId as string
const scoped = await getBidGrid({ ...base, campaign: oneCampaign })
check('campaign grain narrows', scoped.census.campaigns === 1 && scoped.census.targets < d.census.targets,
  `${int(scoped.census.targets)} targets in 1 campaign · applied: ${scoped.scope.applied.join(' + ') || '(none)'}`)
const pf = await prisma.campaign.findFirst({ where: { portfolioId: { not: null } }, select: { portfolioId: true } })
if (pf?.portfolioId) {
  const byPf = await getBidGrid({ ...base, portfolio: pf.portfolioId })
  check('portfolio grain resolves', byPf.scope.campaigns !== null, `${int(byPf.census.targets)} targets · notes: ${byPf.scope.notes.length}`)
}
const line = await prisma.product.findFirst({ where: { parentId: null, children: { some: {} } }, select: { id: true, sku: true } })
if (line) {
  const byLine = await getBidGrid({ ...base, line: line.id })
  check(`product-line grain resolves (${line.sku})`, byLine.scope.campaigns !== null,
    `${int(byLine.census.targets)} targets · applied: ${byLine.scope.applied.join(' + ')}`)
}

// ── 10. a contradiction is stated, not rendered as an empty grid ──────────────
console.log('\n10 · contradiction')
const itCampaign = await prisma.campaign.findFirst({ where: { marketplace: 'IT' }, select: { id: true } })
if (itCampaign) {
  const contra = await getBidGrid({ ...base, market: 'DE', campaign: itCampaign.id })
  check('an IT campaign under market=DE says why it is empty',
    contra.rows.length === 0 && (contra.scope.contradiction !== null || contra.scope.campaigns === 0),
    contra.scope.contradiction ?? `campaigns=${contra.scope.campaigns}`)
}

// ── 11. sort ──────────────────────────────────────────────────────────────────
console.log('\n11 · sort')
const byBidAsc = await getBidGrid({ ...base, sort: 'bid', dir: 'asc' })
const bidsAsc = (byBidAsc.rows as Array<Record<string, unknown>>).slice(0, 50).map((r) => Number(r.bidCents))
check('sort=bid:asc is ascending', bidsAsc.every((v, i) => i === 0 || v >= bidsAsc[i - 1]), `first five: ${bidsAsc.slice(0, 5).join(', ')}`)
const byAcos = await getBidGrid({ ...base, sort: 'acos', dir: 'desc', measured: 'yes' })
const acosTop = (byAcos.rows as Array<Record<string, unknown>>).slice(0, 5).map((r) => r.acos)
check('a null ACoS never wins a descending sort', acosTop.every((a) => a !== null), `top five: ${acosTop.map((a) => (a == null ? 'null' : Number(a).toFixed(2))).join(', ')}`)

// ── 12. the cursor ────────────────────────────────────────────────────────────
console.log('\n12 · cursor')
const cur = await getBidCursorForRequest({ market: BID_MARKET_ALL, line: null, portfolio: null, campaign: null })
check('cursor carries all three fields', !!cur.targetsAt && cur.n > 0, `targetsAt ${cur.targetsAt} · loggedAt ${cur.loggedAt} · n ${int(cur.n)}`)
const drift = cur.targetsAt && cur.loggedAt ? new Date(cur.targetsAt).getTime() - new Date(cur.loggedAt).getTime() : 0
console.log(`     🔴 targetsAt is ${(drift / 60000).toFixed(0)} min ahead of the audit log — that gap is the unaudited hourly resync`)
check('the cursor scopes with the grid', (await getBidCursorForRequest({ market: 'DE', line: null, portfolio: null, campaign: null })).n < cur.n)

console.log(`\n${failures === 0 ? '✅ all checks passed' : `🔴 ${failures} check(s) FAILED`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
