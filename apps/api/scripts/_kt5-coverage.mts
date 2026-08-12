/**
 * _kt5-coverage.mts — the coverage denominator, the cliff dates, and the stop conditions (read-only).
 *
 * KT.2 replaced three of the four watchlists and KT.1b changed the lookback from 56 to 42 days, so
 * every per-market number in the study is stale. Nothing here is inherited; §6 of the KT.5 brief
 * says re-measure and this is that.
 *
 * Order matters: the stop conditions run FIRST, because a new SQP period or a raised ASIN limit
 * changes the design, not just the numbers.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt5-coverage.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS, chooseViewPeriod } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  // ─────────────────────────────────────────────────────────────────────────
  h('STOP CONDITIONS')

  // 1 — has a new SQP period landed since the study's 2026-07-26?
  const periodsByMarket = new Map<string, Array<{ start: Date; rows: number }>>()
  for (const m of MARKETS) {
    const g = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' },
    })
    periodsByMarket.set(m, g.map((x) => ({ start: x.startDate, rows: x._count._all })))
  }
  const newest = MARKETS.map((m) => periodsByMarket.get(m)![0]?.start).filter(Boolean).sort((a, b) => +b! - +a!)[0]
  line(`1 · newest SQP period across all markets: ${d10(newest)} (study recorded 2026-07-26)`)
  line(`    ${d10(newest) === '2026-07-26' ? '✓ unchanged — the study\'s period map still holds' : '🔴 A NEW PERIOD HAS LANDED — stop and re-design'}`)
  const ingestMax = await prisma.searchQueryPerformance.aggregate({ _max: { ingestedAt: true } })
  line(`    most recent ingestedAt anywhere in the table: ${ingestMax._max.ingestedAt?.toISOString().slice(0, 16)}`)

  // 2 — the coverage engine's gate
  const mode = (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase()
  const enabledSets = await prisma.keywordCoverageSet.count({ where: { enabled: true } })
  line(`2 · NEXUS_COVERAGE_ENGINE_MODE=${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? '(unset → observe)'} · enabled coverage sets: ${enabledSets}`)
  line(`    ${mode !== 'auto' && enabledSets === 0 ? '✓ still observing with nothing armed' : '🔴 ARMED — stop and report'}`)

  // 4 — the ASIN limit, and whether the nightly set rotates
  line('4 · the nightly ASIN set (source: sqp.service.ts:242 `args.limit ?? 10`, default 10)')
  for (const m of MARKETS) {
    // distinct ASINs per ingest DAY — if the cron rotated, consecutive nights would differ
    const rows = await prisma.$queryRawUnsafe<Array<{ day: string; asins: bigint }>>(
      `select to_char("ingestedAt",'YYYY-MM-DD') as day, count(distinct "asin")::bigint as asins
       from "SearchQueryPerformance" where marketplace = $1 and "ingestedAt" > now() - interval '10 days'
       group by 1 order by 1 desc limit 6`, m,
    )
    line(`    ${m}: ${rows.map((r) => `${r.day.slice(5)}=${r.asins}`).join(' · ') || '(no ingest in 10 days)'}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  h('§6.1 · rows per period, and how many of EACH market\'s CURRENT watchlist each period holds')
  const watchlists = await prisma.keywordWatchlist.findMany({
    select: { id: true, marketplace: true, name: true, isDefault: true, terms: { select: { term: true, isBranded: true } } },
  })
  const chosenByMarket = new Map<string, ReturnType<typeof chooseViewPeriod>>()
  for (const m of MARKETS) {
    const wl = watchlists.find((w) => w.marketplace === m && w.isDefault) ?? watchlists.find((w) => w.marketplace === m)
    const terms = (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
    const ps = periodsByMarket.get(m)!
    const chosen = chooseViewPeriod(ps)
    chosenByMarket.set(m, chosen)
    line()
    line(`${m} · watchlist "${wl?.name}" — ${terms.length} non-branded terms`)
    line(`   gate: ratio ${SQP_COMPLETENESS_RATIO} of a ${chosen.baselineRows}-row normal week (median of ${SQP_BASELINE_PERIODS}) ⇒ threshold ${Math.round(chosen.threshold)}`)
    line(`   CHOSEN period ${d10(chosen.start)} · ${chosen.rows} rows · reason=${chosen.reason} truncated=${chosen.truncated} · rejected ${JSON.stringify(chosen.rejected)}`)
    line('   period       rows   watchlist terms held   qualifies?')
    for (const p of ps.slice(0, 7)) {
      const held = await prisma.searchQueryPerformance.groupBy({
        by: ['searchQuery'], where: { marketplace: m, startDate: p.start, searchQuery: { in: terms } },
      })
      const q = p.rows >= chosen.threshold
      line(`   ${d10(p.start)}  ${pad(p.rows, 5)}   ${pad(held.length, 6)} of ${terms.length}          ${q ? 'yes' : 'no'}${+p.start === +(chosen.start ?? 0) ? '   ← chosen' : ''}`)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  h('§6.2 · 🔴 THE COVERAGE DENOMINATOR — advertised ASINs vs ASINs the feed measures')
  line('The reach line prints ASINs IN SCOPE. Every share on the page is bounded by the ASINs SQP')
  line('actually covers, which is a different and much smaller number.')
  line()
  line('market   advertised   covered EVER   covered in the CHOSEN week   listings   ACTIVE listings')
  const denom: Record<string, { advertised: number; ever: number; inWeek: number }> = {}
  for (const m of MARKETS) {
    const ads = await prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: m } } }, select: { asin: true },
    })
    const advertised = new Set(ads.map((a) => a.asin!))
    const ever = await prisma.searchQueryPerformance.groupBy({ by: ['asin'], where: { marketplace: m, asin: { not: null } } })
    const everSet = new Set(ever.map((r) => r.asin!))
    const chosen = chosenByMarket.get(m)!
    const inWeek = chosen.start
      ? new Set((await prisma.searchQueryPerformance.groupBy({
        by: ['asin'], where: { marketplace: m, startDate: chosen.start, asin: { not: null } },
      })).map((r) => r.asin!))
      : new Set<string>()
    const listings = await prisma.channelListing.count({ where: { channel: 'AMAZON', OR: [{ marketplace: m }, { region: m }] } })
    const active = await prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: m }, { region: m }] } })
    // the honest denominator: advertised ASINs that the chosen week actually measures
    const coveredAdvertisedEver = [...advertised].filter((a) => everSet.has(a)).length
    const coveredAdvertisedWeek = [...advertised].filter((a) => inWeek.has(a)).length
    denom[m] = { advertised: advertised.size, ever: coveredAdvertisedEver, inWeek: coveredAdvertisedWeek }
    line(`${m.padEnd(8)} ${pad(advertised.size, 10)}   ${pad(coveredAdvertisedEver, 12)}   ${pad(coveredAdvertisedWeek, 26)}   ${pad(listings, 8)}   ${pad(active, 15)}`)
  }
  line()
  line('⇒ the sentence must read "share measured across N of M advertised ASINs":')
  for (const m of MARKETS) line(`   ${m}: ${denom[m].inWeek} of ${denom[m].advertised} in the chosen week (${denom[m].ever} ever)`)

  // ─────────────────────────────────────────────────────────────────────────
  h('§6.3 · the topOfSearchIS LAG (not an age — an age rots overnight)')
  const maxAny = await prisma.amazonAdsPlacementReport.aggregate({ _max: { date: true } })
  const maxIs = await prisma.amazonAdsPlacementReport.aggregate({ where: { topOfSearchIS: { not: null } }, _max: { date: true } })
  const lag = maxAny._max.date && maxIs._max.date ? Math.round((+maxAny._max.date - +maxIs._max.date) / 86_400_000) : null
  line(`placement report MAX(date) = ${d10(maxAny._max.date)} · MAX(date) with topOfSearchIS = ${d10(maxIs._max.date)}`)
  line(`⇒ LAG = ${lag} day(s). Record the lag; the age depends on which day you read it.`)
  const anyC = await prisma.amazonAdsPlacementReport.groupBy({ by: ['campaignId'] })
  const isC = await prisma.amazonAdsPlacementReport.groupBy({ by: ['campaignId'], where: { topOfSearchIS: { not: null } } })
  const totalC = await prisma.campaign.count()
  line(`⇒ denominator: ${isC.length} of the ${anyC.length} campaigns with ANY placement row (${totalC - anyC.length} of ${totalC} have none at all)`)

  // ─────────────────────────────────────────────────────────────────────────
  h('§3.5 · feed health, derived from DATA — never from CronRun.status')
  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 10,
    select: { startedAt: true, status: true, errorMessage: true, outputSummary: true },
  })
  line('the last 10 sqp-ingest runs, with the fact `status` hides:')
  for (const r of runs) {
    line(`   ${r.startedAt.toISOString().slice(0, 16)}  ${String(r.status).padEnd(8)} ${r.outputSummary ?? ''}${r.errorMessage ? `  🔴 errorMessage="${r.errorMessage.slice(0, 34)}"` : ''}`)
  }
  const stale = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest', errorMessage: { contains: 'stale' } } })
  const nonSuccess = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest', status: { not: 'SUCCESS' } } })
  const total = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest' } })
  line(`   ${stale} of ${total} runs carry a "stale" errorMessage; ${nonSuccess} have a non-SUCCESS status ⇒ ${stale - nonSuccess} green-and-dead`)

  line()
  line('yield trajectory — rows WRITTEN per ingest day (the number `rows=N` in the summary):')
  const yieldRows = await prisma.$queryRawUnsafe<Array<{ day: string; rows: bigint }>>(
    `select to_char("ingestedAt",'YYYY-MM-DD') as day, count(*)::bigint as rows
     from "SearchQueryPerformance" where "ingestedAt" > now() - interval '14 days' group by 1 order by 1 desc`,
  )
  line(`   ${yieldRows.map((r) => `${r.day.slice(5)}=${r.rows}`).join(' · ') || '(nothing ingested in 14 days)'}`)
  // 🔴 A day with no rows does not appear in that GROUP BY at all — counting zeros in the result
  // would always return 0. The absent days are the zeros, so walk the calendar, not the rows.
  const byDay = new Map(yieldRows.map((r) => [r.day, Number(r.rows)]))
  const todayIso = new Date(); todayIso.setUTCHours(0, 0, 0, 0)
  let consecutiveZero = 0
  for (let d = 0; d < 14; d++) {
    const day = new Date(+todayIso - d * 86_400_000).toISOString().slice(0, 10)
    if ((byDay.get(day) ?? 0) === 0) consecutiveZero++; else break
  }
  line(`   consecutive most-recent days that wrote NOTHING: ${consecutiveZero}`)
  // and the cron's own claim, which is the number an operator would see
  const summaries = await prisma.cronRun.findMany({
    where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 8, select: { outputSummary: true },
  })
  const claimed = summaries.map((r) => Number(/rows=(\d+)/.exec(r.outputSummary ?? '')?.[1] ?? NaN))
  line(`   the cron's own rows=N, newest first: ${claimed.map((n) => (Number.isNaN(n) ? '—' : n)).join(' · ')}`)
  let zeroNights = 0
  for (const n of claimed) { if (n === 0) zeroNights++; else break }
  line(`   ⇒ ${zeroNights} consecutive night(s) the cron itself reported rows=0`)

  line()
  line('the 5 STRUCTURAL failures — markets the cron iterates that can never succeed:')
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
  for (const c of [...new Set(conns.map((x) => x.marketplace))].sort()) {
    const listings = await prisma.channelListing.count({ where: { channel: 'AMAZON', OR: [{ marketplace: c }, { region: c }] } })
    const active = await prisma.channelListing.count({ where: { channel: 'AMAZON', listingStatus: 'ACTIVE', OR: [{ marketplace: c }, { region: c }] } })
    const flag = listings === 0 ? '🔴 0 listings ⇒ ingestSqp throws every night, forever (structural)' : active === 0 ? '⚠ 0 ACTIVE listings ⇒ "ACTIVE first" ordering is inoperative; the nightly 10 are alphabetical' : ''
    line(`   ${c.padEnd(4)} listings=${pad(listings, 4)} active=${pad(active, 4)} ${flag}`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  h('🔴 THE CLIFF, AS A DATE — recomputed for the 42-day lookback and the new watchlists')
  line('The gate always falls back to the newest period, so the page does not go BLANK — it goes')
  line('officially historical: `reason` flips to outside-lookback and the truncated-week banner fires.')
  line('That is the date to name. Simulated by running chooseViewPeriod with a future clock.')
  line()
  line('🔴 There are TWO dates per market, and the FIRST is the one that matters: the day the chosen')
  line('period ages out of the lookback and the gate falls back to a truncated week. The grid does not')
  line('empty — it collapses to whatever that thin week holds, loudly labelled. The second date is when')
  line('no week is in the window at all.')
  line()
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  for (const m of MARKETS) {
    const ps = periodsByMarket.get(m)!
    const chosen = chosenByMarket.get(m)!
    if (!chosen.start) { line(`${m}: no periods at all`); continue }
    const wl = watchlists.find((w) => w.marketplace === m && w.isDefault) ?? watchlists.find((w) => w.marketplace === m)
    const terms = (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
    line(`${m} — today: ${d10(chosen.start)}, ${chosen.rows} rows, reason=${chosen.reason}`)
    let last = `${d10(chosen.start)}|${chosen.reason}`
    for (let d = 1; d <= 200; d++) {
      const when = +today + d * 86_400_000
      const c = chooseViewPeriod(ps, { now: when })
      const key = `${d10(c.start)}|${c.reason}`
      if (key === last) continue
      last = key
      const held = c.start
        ? (await prisma.searchQueryPerformance.groupBy({
          by: ['searchQuery'], where: { marketplace: m, startDate: c.start, searchQuery: { in: terms } },
        })).length
        : 0
      line(`   ${d10(new Date(when))} (in ${pad(d, 3)}d) → period ${d10(c.start)} · ${pad(c.rows, 4)} rows · reason=${c.reason.padEnd(17)} · ${held} of ${terms.length} terms measurable`)
      if (c.reason === 'outside-lookback') break
    }
  }
  line()
  line('(If the feed writes a complete week before those dates, they move forward. They assume it does not.)')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
