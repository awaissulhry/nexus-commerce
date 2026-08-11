/**
 * _kt1b-verify.mts — the fix, and the four study corrections, measured against prod (read-only).
 *
 * The claim to prove is structural: **a view renders exactly one SQP period**, so the number of
 * cross-period pairs on any grid is 0, so the inversion count is 0 by construction rather than by
 * luck. Reported for the three scopes the brief names.
 *
 * Also re-measures the four numbers §4 of the brief says the study got wrong, because a correction
 * inherited is a correction unverified.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt1b-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')

async function report(label: string, q: Parameters<typeof getKeywordTracker>[0]) {
  const t0 = Date.now()
  const r = await getKeywordTracker(q)
  const ms = Date.now() - t0
  const measured = r.rows.filter((x) => x.state === 'measured')
  const periods = new Set(measured.map((x) => x.asOf))
  // one period ⇒ zero cross-period pairs ⇒ zero inversions, by construction
  const n = measured.length
  const crossPairs = periods.size <= 1 ? 0 : 'NON-ZERO — THE FIX IS NOT HOLDING'
  line(`${label}`)
  line(`   period=${r.window.period} (${r.window.periodAgeDays}d) reason=${r.window.reason} truncated=${r.window.truncated}`)
  line(`   gate: ${r.window.periodRows} rows in period · normal week ${r.window.baselineRows} · threshold ${r.window.threshold} · rejected ${JSON.stringify(r.window.rejected)}`)
  line(`   rows: measured=${n} noRowThisPeriod=${r.scope.resolved.keywordsNoRowThisPeriod} neverMeasured=${r.scope.resolved.keywordsNeverMeasured} (watched ${r.scope.resolved.keywordsWatched})`)
  line(`   distinct asOf among measured rows = ${periods.size} ${periods.size <= 1 ? '✓' : '🔴'} → cross-period pairs = ${crossPairs} → INVERSIONS = ${crossPairs === 0 ? 0 : '?'}`)
  line(`   campaigns=${r.scope.resolved.campaigns} asins=${r.scope.resolved.asins} · list "${r.scope.list?.name}" enabled=${r.scope.list?.enabled} · ${ms}ms`)
  const ex = measured.sort((a, b) => (b.marketVolume ?? 0) - (a.marketVolume ?? 0)).slice(0, 3)
  for (const e of ex) line(`      ${e.keyword.slice(0, 34).padEnd(34)} vol=${String(e.marketVolume).padStart(6)} rank=#${e.marketRank} share=${((e.impressionShare ?? 0) * 100).toFixed(2)}% asOf=${e.asOf}`)
  const aged = r.rows.filter((x) => x.state === 'no-row-this-period').slice(0, 3)
  for (const a of aged) line(`      (blank) ${a.keyword.slice(0, 26).padEnd(26)} last seen ${a.lastSeen} (${a.lastSeenAgeDays}d)`)
  return r
}

async function main() {
  h('1 · the fix, on the three scopes the brief names')
  await report('IT · default (market scope)', { market: 'IT' })

  const pf = '182512333091276'
  await report(`IT · portfolio IT_Gale (${pf})`, { market: 'IT', portfolio: pf })

  const gale = await prisma.campaign.findFirst({ where: { name: { contains: 'Gale Jacket Yellow Only' } }, select: { id: true, name: true, status: true } })
  if (gale) await report(`IT · campaign "${gale.name}" (${gale.status})`, { market: 'IT', campaign: gale.id })
  else line('⚠ campaign "Gale Jacket Yellow Only" not found')

  h('2 · the other three markets')
  for (const m of ['DE', 'ES', 'FR'] as const) await report(`${m} · default`, { market: m })

  h('3 · branded=1 and the two blank states side by side (IT)')
  const b = await getKeywordTracker({ market: 'IT', branded: true })
  const byState = new Map<string, string[]>()
  for (const r of b.rows) { const a = byState.get(r.state) ?? []; a.push(r.keyword); byState.set(r.state, a) }
  for (const [st, kws] of byState) line(`   ${st.padEnd(20)} ${kws.length}  e.g. ${kws.slice(0, 6).join(', ')}`)

  h('4 · study correction — topOfSearchIS lag (§4.2)')
  const maxAny = await prisma.amazonAdsPlacementReport.aggregate({ _max: { date: true } })
  const maxIs = await prisma.amazonAdsPlacementReport.aggregate({ where: { topOfSearchIS: { not: null } }, _max: { date: true } })
  const lagDays = maxAny._max.date && maxIs._max.date
    ? Math.round((+maxAny._max.date - +maxIs._max.date) / 86_400_000) : null
  line(`max placement date (any row) = ${d10(maxAny._max.date)}`)
  line(`max placement date WITH topOfSearchIS = ${d10(maxIs._max.date)}   → the IS column lags the report by ${lagDays} day(s)`)
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  line(`today ${d10(today)} ⇒ topOfSearchIS is T-${maxIs._max.date ? Math.round((+today - +maxIs._max.date) / 86_400_000) : '?'}, placement rows are T-${maxAny._max.date ? Math.round((+today - +maxAny._max.date) / 86_400_000) : '?'}`)

  h('5 · study correction — the honest topOfSearchIS denominator (§4.2)')
  const allCampaigns = await prisma.campaign.count()
  const withAnyPlacement = await prisma.amazonAdsPlacementReport.groupBy({ by: ['campaignId'], _count: { _all: true } })
  const withIs = await prisma.amazonAdsPlacementReport.groupBy({ by: ['campaignId'], where: { topOfSearchIS: { not: null } }, _count: { _all: true } })
  // the placement report keys campaigns by EXTERNAL id; count how many of ours map
  const externals = new Set((await prisma.campaign.findMany({ where: { externalCampaignId: { not: null } }, select: { externalCampaignId: true } })).map((c) => c.externalCampaignId!))
  const anyMapped = withAnyPlacement.filter((x) => externals.has(x.campaignId)).length
  const isMapped = withIs.filter((x) => externals.has(x.campaignId)).length
  line(`campaigns total ${allCampaigns}`)
  line(`campaigns with ANY placement row: ${withAnyPlacement.length} (${anyMapped} map to a local Campaign)`)
  line(`campaigns with a topOfSearchIS reading: ${withIs.length} (${isMapped} map to a local Campaign)`)
  line(`→ the honest denominator is ${withIs.length} of ${withAnyPlacement.length}, not ${withIs.length} of ${allCampaigns}; ${allCampaigns - withAnyPlacement.length} campaigns have no placement row at all`)

  h('6 · study correction — sqp-ingest runs that are SUCCESS *and* carry an error (§3)')
  // NB: this select first named a field `summary`, which does not exist on CronRun. Prisma THREW.
  // That is the whole argument against `.catch(() => [])` around a query: the same mistake behind a
  // swallowing catch would have printed "0 stale runs" and read as a clean feed.
  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 14,
    select: { startedAt: true, status: true, errorMessage: true, outputSummary: true },
  })
  let successWithError = 0
  for (const r of runs) {
    const stale = r.errorMessage ? ` errorMessage="${r.errorMessage.slice(0, 46)}"` : ''
    if (r.status === 'SUCCESS' && r.errorMessage) successWithError++
    line(`${new Date(r.startedAt).toISOString().slice(0, 16)}  ${String(r.status).padEnd(8)}${stale}`)
  }
  const allStale = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest', errorMessage: { contains: 'stale' } } })
  const failed = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest', status: { not: 'SUCCESS' } } })
  line(`runs carrying a "stale" errorMessage, all time: ${allStale} · runs with status != SUCCESS: ${failed} · SUCCESS-with-an-error in the last 14: ${successWithError}`)

  h('7 · the archived-campaign count (§5)')
  const it = await prisma.campaign.groupBy({ by: ['status'], where: { marketplace: 'IT' }, _count: { _all: true } })
  line(`IT campaigns by status: ${it.map((x) => `${x.status}=${x._count._all}`).join(' · ')}`)
  const r = await getKeywordTracker({ market: 'IT' })
  line(`the page now prints ${r.scope.resolved.campaigns} IT campaigns (was 150 — 1 archived)`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
