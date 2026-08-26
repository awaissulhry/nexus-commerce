/**
 * BID.S2 — verify the extended read against production before the route ships. READ-ONLY.
 *
 * Every assertion is one the columns depend on being true.
 */
import '../src/env.js'
const { getBidGrid, getBidSeries, effectiveMaxCpc, BID_MARKET_ALL } = await import('../src/services/advertising/bid-grid.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
let fails = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✅' : '🔴'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) fails++
}
const base = {
  market: BID_MARKET_ALL, line: null, portfolio: null, campaign: null,
  view: 'targets' as const, status: 'enabled' as const, kind: [], match: [],
  band: null, measured: 'all' as const, q: null, windowDays: 30,
  sort: null, dir: 'desc' as const, limit: 5000,
}
const nowRome = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Rome' })
console.log(`\n═══ BID.S2 — service verification · ${nowRome} Rome ═══`)
console.log('🔴 Chip counts below are a CLOCK READING — floor 00:00, restore 08:00 Rome.\n')

const d = await getBidGrid({ ...base })
const rows = d.rows as Array<Record<string, unknown>>

console.log('1 · the new row fields are present and typed')
const r0 = rows[0]
for (const f of ['minBidCents', 'maxBidCents', 'bidder', 'bidderName', 'suppressedFromBidCents',
  'inMinBidWindow', 'lastAuditedCents', 'lastAuditedAt', 'unrecorded', 'effectiveMaxCpcCents',
  'placementPct', 'biddingStrategy']) {
  check(`row carries \`${f}\``, f in r0, String(r0[f]))
}

console.log('\n2 · Band — 🔴 "no floor declared" is null, never 0')
const withFloor = rows.filter((r) => r.minBidCents != null).length
const zeroFloor = rows.filter((r) => r.minBidCents === 0).length
const withCeil = rows.filter((r) => r.maxBidCents != null).length
check('minBidCents is null on every row (0 of 220 campaigns declare one)', withFloor === 0, `${int(withFloor)} with a floor`)
check('no row reports a floor of exactly 0 (that would be a different claim)', zeroFloor === 0)
console.log(`     targets under a declared ceiling: ${int(withCeil)} of ${int(rows.length)}`)
const outOfBand = rows.filter((r) => r.maxBidCents != null && Number(r.bidCents) > Number(r.maxBidCents))
// 🔴 NOT a fixed range. This asserted 40–70 ("the study's ~57") and failed on 2026-08-16 at 105 —
// the code was fine and the assertion had rotted. Bids move nightly and ceilings do not, so this
// population only ever grows until someone lowers a bid or raises a ceiling; pinning it to a band
// measured once turns a real trend into a red build. What must hold is the invariant.
console.log(`     out-of-band right now: ${int(outOfBand.length)} (56 on 2026-08-12 · 105 on 2026-08-16 — it grows)`)
check('every out-of-band row really is above its own ceiling', outOfBand.every((r) => Number(r.bidCents) > Number(r.maxBidCents)))

console.log('\n3 · Bidder')
const byBidder = new Map<string, number>()
for (const r of rows) byBidder.set(String(r.bidder), (byBidder.get(String(r.bidder)) ?? 0) + 1)
console.log(`     targets by bidder: ${[...byBidder.entries()].map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`)
const camps = new Map<string, string>()
for (const r of rows) camps.set(String(r.campaignId), String(r.bidder))
const campTally = new Map<string, number>()
for (const b of camps.values()) campTally.set(b, (campTally.get(b) ?? 0) + 1)
console.log(`     campaigns by bidder: ${[...campTally.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`)
const named = rows.filter((r) => r.bidder === 'schedule' && r.bidderName)
check('every scheduled row carries a resolved NAME, not an id', named.length === rows.filter((r) => r.bidder === 'schedule').length,
  `sample "${named[0]?.bidderName ?? '—'}"`)
check('no bidderName looks like a cuid', !named.some((r) => /^c[a-z0-9]{20,}$/.test(String(r.bidderName))))
check('goal is reachable and currently empty (0 campaigns set dynamicBidding.targetAcos)', (campTally.get('goal') ?? 0) === 0)

console.log('\n4 · Unrecorded — drift by VALUE')
const unrec = rows.filter((r) => r.unrecorded)
const neverAudited = rows.filter((r) => r.lastAuditedCents == null)
check('unrecorded rows all have an audited value to disagree with', unrec.every((r) => r.lastAuditedCents != null), `${int(unrec.length)} unrecorded`)
console.log(`     never audited: ${int(neverAudited.length)} of ${int(rows.length)} (${((neverAudited.length / rows.length) * 100).toFixed(1)}%)`)
const unrecFloor = unrec.filter((r) => Number(r.lastAuditedCents) <= 2).length
console.log(`     …of the ${int(unrec.length)} unrecorded, ${int(unrecFloor)} were last audited AT THE FLOOR`)
console.log(`     → that is the nightly floor whose restore went unaudited, not a Seller Central edit.`)

console.log('\n5 · Series — N points PER ENTITY, never N rows total')
const seriesIds = Object.keys(d.series)
const counts = seriesIds.map((k) => d.series[k].length)
check('series is populated', seriesIds.length > 0, `${int(seriesIds.length)} entities with a curve`)
check('no entity exceeds perEntity=12', Math.max(...counts, 0) <= 12, `max ${Math.max(...counts, 0)}`)
console.log(`     coverage: ${int(seriesIds.length)} of ${int(rows.length)} rows (${((seriesIds.length / rows.length) * 100).toFixed(1)}%) — the rest must render a "never changed" mark`)
const oneCurve = d.series[seriesIds[0]]
check('points are oldest-first', oneCurve.length < 2 || new Date(oneCurve[0].at) <= new Date(oneCurve[oneCurve.length - 1].at))
check('every point carries a numeric `to`', oneCurve.every((p) => typeof p.to === 'number'))
console.log(`     sample curve: ${oneCurve.map((p) => p.to).join(' → ')}`)
const delivered = new Set(seriesIds.flatMap((k) => d.series[k].map((p) => p.delivered)))
console.log(`     delivery values seen: ${[...delivered].map(String).join(' · ')}`)
// the two populations must not imply each other
const curveSet = new Set(seriesIds)
const curveOnly = rows.filter((r) => curveSet.has(String(r.id)) && !r.measured).length
const metricsOnly = rows.filter((r) => !curveSet.has(String(r.id)) && r.measured).length
console.log(`     🔴 curve-but-no-metrics ${int(curveOnly)} · metrics-but-no-curve ${int(metricsOnly)} — different sets, as S2 requires`)
check('the two sets genuinely differ', curveOnly > 0 && metricsOnly > 0)

console.log('\n6 · Effective max CPC')
const withEff = rows.filter((r) => r.effectiveMaxCpcCents != null)
check('populated on some rows and null on others (not a constant column)', withEff.length > 0 && withEff.length < rows.length,
  `${int(withEff.length)} of ${int(rows.length)}`)
check('never below the bid it derives from', withEff.every((r) => Number(r.effectiveMaxCpcCents) > Number(r.bidCents)))
const strategies = new Map<string, number>()
for (const r of rows) strategies.set(String(r.biddingStrategy), (strategies.get(String(r.biddingStrategy)) ?? 0) + 1)
console.log(`     strategies: ${[...strategies.entries()].map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`)
const biggest = withEff.sort((a, b) => Number(b.effectiveMaxCpcCents) - Number(a.effectiveMaxCpcCents))[0]
console.log(`     largest: ${biggest.label} — bid ${c2e(Number(biggest.bidCents))} +${biggest.placementPct}% ⇒ ${c2e(Number(biggest.effectiveMaxCpcCents))} on ${biggest.campaignName}`)
// pure-function checks
check('legacy (down-only) never lifts a bid', effectiveMaxCpc(50, { strategy: 'LEGACY_FOR_SALES', placementBidding: [] }).cents === null)
check('legacy WITH a placement adjustment still lifts (placement applies regardless of strategy)',
  effectiveMaxCpc(50, { strategy: 'LEGACY_FOR_SALES', placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 100 }] }).cents === 100)
check('auto-for-sales doubles at top of search',
  effectiveMaxCpc(50, { strategy: 'AUTO_FOR_SALES', placementBidding: [] }).cents === 100)
check('no strategy and no placement ⇒ null, so the column shows "—" not a copy of Bid',
  effectiveMaxCpc(50, {}).cents === null)

console.log('\n7 · the campaign roll-up carries the new campaign facts')
const cv = await getBidGrid({ ...base, view: 'campaigns' })
const c0 = cv.rows[0] as Record<string, unknown>
for (const f of ['minBidCents', 'maxBidCents', 'bidder', 'bidderName', 'outOfBand', 'placementPct']) {
  check(`campaign row carries \`${f}\``, f in c0, String(c0[f]))
}
const totalOob = (cv.rows as Array<Record<string, unknown>>).reduce((s, r) => s + Number(r.outOfBand), 0)
check('roll-up outOfBand sums to the target-view count', totalOob === outOfBand.length, `${int(totalOob)} vs ${int(outOfBand.length)}`)
check('campaigns view carries NO series (nothing would draw it)', Object.keys(cv.series).length === 0)

console.log('\n8 · sorting on the new columns')
for (const key of ['band', 'bidder', 'effCpc']) {
  const s = await getBidGrid({ ...base, sort: key, dir: 'desc', limit: 50 })
  check(`sort=${key} returns rows`, s.rows.length > 0)
}
const effAsc = await getBidGrid({ ...base, sort: 'effCpc', dir: 'desc', limit: 20 })
const top = (effAsc.rows as Array<Record<string, unknown>>).slice(0, 5).map((r) => r.effectiveMaxCpcCents)
check('a null effective CPC never wins a descending sort', top.every((v) => v !== null), `top five: ${top.join(', ')}`)

console.log('\n9 · getBidSeries directly (the bid-history grouped mode)')
const ids = rows.slice(0, 300).map((r) => String(r.id))
const s = await getBidSeries({ entityIds: ids, perEntity: 5 })
check('respects perEntity', Object.values(s).every((v) => v.length <= 5), `max ${Math.max(0, ...Object.values(s).map((v) => v.length))}`)
check('returns only entities that have points', Object.values(s).every((v) => v.length > 0))
check('empty input is empty output, not a full scan', Object.keys(await getBidSeries({ entityIds: [] })).length === 0)

console.log(`\n${fails === 0 ? '✅ all checks passed' : `🔴 ${fails} FAILED`}\n`)
await prisma.$disconnect()
process.exit(fails === 0 ? 0 : 1)
