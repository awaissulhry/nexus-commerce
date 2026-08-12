/**
 * PLC.0 — does the endpoint's own logic reproduce the study's numbers?
 *
 * READ-ONLY. No writes, no mutations. It imports `placement-grid.service.ts` and calls it, so
 * what this prints is what the route returns — not a second implementation that could agree with
 * the study while the route disagrees with both.
 *
 * The gate: **governed ≈ 23 and unmanaged ≈ 144.** If those are wrong the owner derivation is
 * wrong, and a grid that reports the wrong owner is worse than the tab it replaces.
 *
 * Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_plc-page-basis.mts
 */
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const {
  getPlacementGrid, REPORT_TO_BID_KEY, PLC_LANES, KEY_BY_LANE, PLC_MARKET_ALL,
} = await import('../src/services/advertising/placement-grid.service.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const H = (t: string) => console.log(`\n${'─'.repeat(80)}\n${t}\n${'─'.repeat(80)}`)
const check = (label: string, got: number | string | null, want: number | string | null, tol = 0) => {
  const ok = typeof got === 'number' && typeof want === 'number' ? Math.abs(got - want) <= tol : got === want
  console.log(`  ${ok ? '✅' : '🔴'} ${pad(label, 46)} got ${pad(String(got), 12)} study said ${want}`)
  return ok
}

// The study measured a 60-day window on 2026-08-11. Expressed as explicit dates so this script
// asks the endpoint the same question the study asked the database.
const today = new Date()
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const end = ymd(today)
const startD = new Date(today); startD.setUTCDate(startD.getUTCDate() - 59)
const start = ymd(startD)

console.log('\n═══ PLC.0 — the endpoint against the study ═══')
console.log(`now=${new Date().toISOString()}   60-day window ${start} → ${end}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('0 · The two-vocabulary trap — is the label set still exactly three?')

const labels = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['placement'], _count: { _all: true }, _max: { date: true },
})
for (const l of labels.sort((a, b) => b._count._all - a._count._all)) {
  const mapped = REPORT_TO_BID_KEY[l.placement]
  console.log(`  ${mapped ? '✅' : '🔴 UNMAPPED'} ${pad(l.placement, 30)} rows=${pad(int(l._count._all), 9)} latest=${l._max.date ? ymd(l._max.date) : '—'} → ${mapped ?? '(dropped)'}`)
}
check('distinct report labels', labels.length, 3)

// Is topOfSearchIS really TOP-only? The service attributes every non-null share to the Top lane.
const isByLabel = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['placement'],
  where: { topOfSearchIS: { not: null }, date: { gte: startD } },
  _count: { _all: true },
})
console.log(`\n  topOfSearchIS non-null rows by label, 60d: ${isByLabel.map((r) => `${r.placement}=${int(r._count._all)}`).join(' · ') || '(none)'}`)
check('labels carrying topOfSearchIS', isByLabel.length, 1)
check('…and it is the TOP label', isByLabel[0]?.placement ?? '(none)', 'Top of Search on-Amazon')

// join integrity — the report's campaignId is EXTERNAL
const repCamps = await prisma.amazonAdsPlacementReport.findMany({
  where: { date: { gte: startD } }, select: { campaignId: true }, distinct: ['campaignId'],
})
const allCamps = await prisma.campaign.findMany({ select: { id: true, externalCampaignId: true, marketplace: true } })
const extSet = new Set(allCamps.map((c) => c.externalCampaignId).filter((x): x is string => !!x))
const joinable = repCamps.filter((r) => extSet.has(r.campaignId)).length
console.log(`\n  report campaigns 60d ${repCamps.length} · joinable ${joinable} · orphan ${repCamps.length - joinable}`)
check('report campaigns in 60d', repCamps.length, 74)
check('orphans', repCamps.length - joinable, 0)

const byMkt = new Map<string, number>()
for (const c of allCamps) byMkt.set(c.marketplace ?? '(null)', (byMkt.get(c.marketplace ?? '(null)') ?? 0) + 1)
console.log(`  campaigns by marketplace: ${[...byMkt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('1 · The endpoint, unscoped, 60 days — §5.5 line by line')

const t0 = Date.now()
const all = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all', q: null, sort: null, dir: 'desc',
})
console.log(`  endpoint returned in ${Date.now() - t0} ms · ${int(all.rows.length)} rows\n`)

let pass = true
pass = check('campaigns', all.counts.campaigns, 220) && pass
pass = check('carrying, governed by nothing', all.counts.unmanaged, 144) && pass
pass = check('governed campaigns (hour-independent)', all.counts.governedTotal, 33) && pass
pass = check('campaigns with a report row in 60d', all.counts.withReportRow, 74) && pass
pass = check('dataThrough', all.dataThrough, '2026-08-10') && pass
pass = check('rows = campaigns × 3', all.rows.length, all.counts.campaigns * 3) && pass

/**
 * 🔴 `carrying` and `governed` are NOT constants, and the study's 167 / 23 is a ~13:00 reading.
 *
 * `_plc-page-hour.mts` proved it: at 02:56 Europe/Rome all 33 live goal-mode schedules held
 * `pause` (biasPct 0), and between 22:06 and 22:16 the night before the engine wrote 40 lanes
 * from 375/102/98/75/60% down to 0, each reasoned `rank — Min bid placement N→0%`. So the same
 * code reads 145 / 1 overnight and ~167 / ~23 in the working day.
 *
 * The invariants that DO hold at every hour, and are therefore what this script gates on:
 *   · carrying  === governed + unmanaged
 *   · unmanaged === 144 — nothing steers them, so nothing moves them
 *   · governedTotal === 33 — a campaign holding `pause` is still governed
 *   · governed + governedAtZero === governedTotal
 */
console.log('')
pass = check('carrying === governed + unmanaged', all.counts.carrying, all.counts.governed + all.counts.unmanaged) && pass
pass = check('governed + atZero === governedTotal', all.counts.governed + all.engine.governedAtZero, all.counts.governedTotal) && pass
pass = check('carrying, no report row (= carrying − 34)', all.counts.carryingNoReportRow, all.counts.carrying - 34) && pass
console.log(`\n  the engine's own receipt (AdSchedule.lastApplied — NOT a second resolver):`)
console.log(`    ${all.engine.goalSchedules} live goal-mode schedules · ${all.engine.enabledPlans} enabled plans · last looked ${all.engine.lastEvaluatedAt ?? 'never'}`)
console.log(`    holding: ${all.engine.holding.map((h) => `${h.targetKey}=${h.campaigns}`).join(' · ')}`)
console.log(`    governed campaigns carrying 0 on every lane right now: ${all.engine.governedAtZero} of ${all.counts.governedTotal}`)
console.log(`\n  → carrying ${all.counts.carrying} (study measured 167 at ~13:00) · governed ${all.counts.governed} (study: 23)`)
console.log(`    the study's 167 = ${all.counts.carrying} carrying now + ${all.engine.governedAtZero} governed-at-zero = ${all.counts.carrying + all.engine.governedAtZero}`)

// the two ownership inputs, printed so a drift is attributable
const scheds = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { windows: true, defaultTargetKey: true } })
const { isGoalMode } = await import('../src/jobs/ad-rank-defend.job.js')
const goal = scheds.filter((s) => isGoalMode(s.windows, s.defaultTargetKey)).length
const plans = await prisma.productRankPlan.findMany({ select: { enabled: true } })
pass = check('ENABLED goal-mode AdSchedule rows', goal, 33) && pass
pass = check('ENABLED ProductRankPlan rows', plans.filter((p) => p.enabled).length, 0) && pass
console.log(`  (ProductRankPlan rows in total: ${plans.length} — the study said 2)`)

// the unmanaged breakdown the study gives: 103 PAUSED · 40 ENABLED · 1 ARCHIVED
const carryingRows = new Map<string, (typeof all.rows)[number]>()
for (const r of all.rows) if (!carryingRows.has(r.campaignId)) carryingRows.set(r.campaignId, r)
const perCampaign = new Map<string, { any: boolean; owner: string; status: string }>()
for (const r of all.rows) {
  const cur = perCampaign.get(r.campaignId) ?? { any: false, owner: r.owner, status: r.status }
  if (r.multiplierPct > 0) cur.any = true
  perCampaign.set(r.campaignId, cur)
}
const unmanagedByStatus = new Map<string, number>()
for (const [, v] of perCampaign) {
  if (!v.any || v.owner !== 'none') continue
  unmanagedByStatus.set(v.status, (unmanagedByStatus.get(v.status) ?? 0) + 1)
}
console.log(`\n  unmanaged by campaign status: ${[...unmanagedByStatus].sort().map(([k, v]) => `${k}=${v}`).join(' · ')}   (study: PAUSED=103 ENABLED=40 ARCHIVED=1)`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('2 · Account-wide lane totals, 60 days — the §5.5 second table')

const laneTotal = new Map<string, { impressions: number; clicks: number; spend: number; sales: number; orders: number }>()
for (const r of all.rows) {
  const cur = laneTotal.get(r.lane) ?? { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 }
  cur.impressions += r.impressions; cur.clicks += r.clicks
  cur.spend += r.spendCents; cur.sales += r.salesCents; cur.orders += r.orders
  laneTotal.set(r.lane, cur)
}
const WANT: Record<string, { impressions: number; spend: string; roas: string; cpc: string; cvr: string }> = {
  PLACEMENT_TOP: { impressions: 59630, spend: '€1,681.68', roas: '1.80', cpc: '€0.72', cvr: '1.7%' },
  PLACEMENT_REST_OF_SEARCH: { impressions: 556787, spend: '€1,325.33', roas: '3.11', cpc: '€0.40', cvr: '1.4%' },
  PLACEMENT_PRODUCT_PAGE: { impressions: 1926999, spend: '€716.44', roas: '2.39', cpc: '€0.45', cvr: '1.2%' },
}
console.log(`  ${pad('lane', 10)} ${pad('impressions', 13)} ${pad('spend', 12)} ${pad('ROAS', 7)} ${pad('CPC', 8)} ${pad('CVR', 7)}  |  study`)
for (const lane of PLC_LANES) {
  const t = laneTotal.get(lane)!
  const w = WANT[lane]
  console.log(
    `  ${pad(KEY_BY_LANE[lane], 10)} ${pad(int(t.impressions), 13)} ${pad(eur(t.spend), 12)} ${pad((t.sales / (t.spend || 1)).toFixed(2), 7)} ${pad(eur(Math.round(t.spend / (t.clicks || 1))), 8)} ${pad(`${((t.orders / (t.clicks || 1)) * 100).toFixed(1)}%`, 7)}  |  ${int(w.impressions)} ${w.spend} ${w.roas} ${w.cpc} ${w.cvr}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('3 · The window moves the delivery columns and nothing else')

const d30 = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'last30', start: null, end: null, lane: 'all', q: null, sort: null, dir: 'desc',
})
console.log(`  last30 resolved to ${d30.range.start} → ${d30.range.end} (${d30.range.days}d, includesToday=${d30.range.includesToday})`)
console.log(`  campaigns ${d30.counts.campaigns} · carrying ${d30.counts.carrying} · governed ${d30.counts.governed} · unmanaged ${d30.counts.unmanaged}`)
console.log(`  withReportRow ${d30.counts.withReportRow} (60d: ${all.counts.withReportRow}) · dataThrough ${d30.dataThrough}`)
pass = check('carrying is window-independent', d30.counts.carrying, all.counts.carrying) && pass
pass = check('governed is window-independent', d30.counts.governed, all.counts.governed) && pass
pass = check('dataThrough is window-independent', d30.dataThrough, all.dataThrough) && pass

const noPreset = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: null, start: null, end: null, lane: 'all', q: null, sort: null, dir: 'desc',
})
console.log(`\n  the documented default (no preset, no dates) resolved to ${noPreset.range.start} → ${noPreset.range.end} (${noPreset.range.days}d)`)
pass = check('default window is 30 days', noPreset.range.days, 30) && pass

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('4 · The four empty states are reachable')

const topOnly = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'top', q: null, sort: null, dir: 'desc',
})
console.log(`  lane=top → ${int(topOnly.rows.length)} rows (expected ${all.counts.campaigns})`)
console.log(`  · "not set"            multiplierPct === 0 : ${int(all.rows.filter((r) => r.multiplierPct === 0).length)} rows`)
console.log(`  · "no delivery"        hasReportRow false  : ${int(all.rows.filter((r) => !r.hasReportRow).length)} rows`)
console.log(`  · "no share for lane"  IS null on Rest/Prod: ${int(all.rows.filter((r) => r.laneKey !== 'top' && r.topOfSearchIS == null).length)} rows`)
console.log(`  · "Top with a share"                       : ${int(all.rows.filter((r) => r.laneKey === 'top' && r.topOfSearchIS != null).length)} rows`)

const empty = await getPlacementGrid({
  market: 'DE', line: null, portfolio: null, campaign: 'not-a-real-campaign-id',
  preset: 'custom', start, end, lane: 'all', q: null, sort: null, dir: 'desc',
})
console.log(`\n  · "scope is empty"     a DE market + an IT-shaped campaign id → ${empty.rows.length} rows`)
console.log(`    contradiction: ${empty.scope.contradiction ?? '(none)'}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('5 · Scope and sort behave')

for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const r = await getPlacementGrid({
    market: m, line: null, portfolio: null, campaign: null,
    preset: 'custom', start, end, lane: 'all', q: null, sort: null, dir: 'desc',
  })
  console.log(`  ${m}: campaigns ${pad(String(r.counts.campaigns), 5)} carrying ${pad(String(r.counts.carrying), 5)} governed ${pad(String(r.counts.governed), 4)} unmanaged ${pad(String(r.counts.unmanaged), 5)} rows ${r.rows.length}`)
}
const sumPerMarket = await Promise.all(['IT', 'DE', 'ES', 'FR'].map((m) => getPlacementGrid({
  market: m, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all', q: null, sort: null, dir: 'desc',
})))
const summed = sumPerMarket.reduce((s, r) => s + r.counts.campaigns, 0)
console.log(`  four markets sum to ${summed} campaigns; "all" says ${all.counts.campaigns} (difference = campaigns with no marketplace)`)

console.log('\n  top 5 rows by spend:')
for (const r of all.rows.slice(0, 5)) {
  console.log(`    ${pad(r.name, 34)} ${pad(r.marketplace ?? '—', 3)} ${pad(KEY_BY_LANE[r.lane], 8)} ${pad(`${r.multiplierPct}%`, 6)} ${pad(eur(r.spendCents), 11)} roas=${pad(r.roas?.toFixed(2) ?? '—', 6)} owner=${r.owner}${r.ownerLabel ? ` (${r.ownerLabel})` : ''}`)
}

const asc = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all', q: null, sort: 'multiplier', dir: 'asc',
})
console.log(`\n  sort=multiplier&dir=asc → first ${asc.rows[0]?.multiplierPct}% · last ${asc.rows[asc.rows.length - 1]?.multiplierPct}%`)
const roasDesc = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all', q: null, sort: 'roas', dir: 'desc',
})
console.log(`  sort=roas&dir=desc → first row roas=${roasDesc.rows[0]?.roas?.toFixed(2) ?? '—'} (a null must NOT lead)`)

const q = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all', q: 'GALE', sort: null, dir: 'desc',
})
console.log(`  q=GALE → ${q.rows.length} rows over ${new Set(q.rows.map((r) => r.campaignId)).size} campaigns (a multiple of 3: ${q.rows.length % 3 === 0})`)

/**
 * 🔴 The search narrows the ROWS and must never narrow the COUNTS.
 *
 * Found by typing into the box on production, not here: with the counts computed over the searched
 * set, `?q=zzzz` collapsed `campaigns` to 0 and the page told the operator to widen a scope that
 * held 220. A count that moves when you type answers a different question from the one its label
 * asks. Pinned in both directions — a matching search and a matching-nothing one.
 */
console.log('')
const qNone = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all', q: 'zzzznothingmatchesthis', sort: null, dir: 'desc',
})
pass = check('q=GALE leaves `campaigns` alone', q.counts.campaigns, all.counts.campaigns) && pass
pass = check('q=GALE leaves `carrying` alone', q.counts.carrying, all.counts.carrying) && pass
pass = check('q=GALE leaves `unmanaged` alone', q.counts.unmanaged, all.counts.unmanaged) && pass
pass = check('q=GALE sets matchedCampaigns', q.counts.matchedCampaigns, q.rows.length / 3) && pass
pass = check('q=<no match> leaves `campaigns`', qNone.counts.campaigns, all.counts.campaigns) && pass
pass = check('q=<no match> → 0 rows', qNone.rows.length, 0) && pass
pass = check('q=<no match> → 0 matched', qNone.counts.matchedCampaigns, 0) && pass
pass = check('q=<no match> keeps dataThrough', qNone.dataThrough, all.dataThrough) && pass
console.log(`  → the empty grid can now say "220 campaigns in this scope, the search hides all of them" rather than "no campaigns in this scope"`)

// The lane filter is the same rule: it narrows rows, never counts.
const laneOnly = await getPlacementGrid({
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'rest', q: null, sort: null, dir: 'desc',
})
pass = check('lane=rest leaves `carrying` alone', laneOnly.counts.carrying, all.counts.carrying) && pass
pass = check('lane=rest → one row per campaign', laneOnly.rows.length, all.counts.campaigns) && pass

await prisma.$disconnect()
console.log(`\n═══ ${pass ? 'ALL §5.5 CHECKS PASSED' : '🔴 AT LEAST ONE §5.5 CHECK FAILED — do not build UI on this'} — read-only, nothing written ═══\n`)
