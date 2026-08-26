/**
 * _ktp-sqp-diag.mts — why the SQP feed looks dead when the cron is green (read-only).
 *
 * Hypothesis under test: the cron is NOT dead. It runs daily and succeeds, but it requests
 * only 10 ASINs per market (`ourAsinsForMarketplace(mkt, limit ?? 10)`, deterministic — no
 * rotation despite the comment claiming it cycles). The 2,000-row weeks were produced by the
 * MANUAL backfill/widen scripts, not by the cron. If true, distinct-ASIN-per-week collapses
 * on exactly the weeks the backfills stopped covering.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_ktp-sqp-diag.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)

async function main() {
  h('A · rows, distinct ASINs and distinct queries per stored week')
  const rows = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, startDate: true, asin: true, searchQuery: true, ingestedAt: true, sourceReportId: true },
  })
  const weeks = new Map<string, { n: number; asins: Set<string>; qs: Set<string>; mkts: Map<string, number>; ing: Date[] }>()
  for (const r of rows) {
    const k = d10(r.startDate)
    if (!weeks.has(k)) weeks.set(k, { n: 0, asins: new Set(), qs: new Set(), mkts: new Map(), ing: [] })
    const w = weeks.get(k)!
    w.n++
    if (r.asin) w.asins.add(r.asin)
    w.qs.add(r.searchQuery)
    w.mkts.set(r.marketplace, (w.mkts.get(r.marketplace) ?? 0) + 1)
    w.ing.push(r.ingestedAt)
  }
  line('week         rows   ASINs  queries   ingested (first … last)')
  for (const [k, w] of [...weeks.entries()].sort().reverse()) {
    const s = w.ing.map((d) => +d).sort((a, b) => a - b)
    line(`${k} ${String(w.n).padStart(6)}  ${String(w.asins.size).padStart(6)}  ${String(w.qs.size).padStart(7)}   ${d10(new Date(s[0]))} … ${d10(new Date(s[s.length - 1]))}`)
  }

  h('B · the last 10 SQP-ingest cron runs, verbatim')
  const runs = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 12 })
  for (const r of runs) {
    const secs = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null
    line(`${new Date(r.startedAt).toISOString()}  ${r.status.padEnd(8)} ${secs != null ? `${secs}s`.padStart(6) : '     —'}  ${r.outputSummary ?? r.errorMessage ?? ''}`)
  }
  const all = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest' } })
  const failed = await prisma.cronRun.count({ where: { jobName: 'sqp-ingest', status: { not: 'SUCCESS' } } })
  const first = await prisma.cronRun.findFirst({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'asc' } })
  line(`total sqp-ingest runs: ${all} (non-SUCCESS ${failed}) · first ${first ? new Date(first.startedAt).toISOString() : '—'}`)

  h('C · which 9 marketplaces does the cron iterate, and which have a Marketplace row?')
  const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
  const markets = [...new Set(conns.map((c) => c.marketplace))].sort()
  line(`active AmazonAdsConnection marketplaces (${markets.length}): ${markets.join(' · ')}`)
  const mrows = await prisma.marketplace.findMany({ select: { code: true, channel: true, marketplaceId: true, isActive: true, region: true } })
  line('Marketplace rows (channel AMAZON) — resolveMarketplaceId() needs one of these per market:')
  for (const m of mrows.filter((x) => x.channel === 'AMAZON')) line(`  ${m.code.padEnd(8)} mktId=${m.marketplaceId ?? '—'} region=${m.region ?? '—'} active=${m.isActive}`)
  const haveRow = new Set(mrows.filter((x) => x.channel === 'AMAZON').map((x) => x.code))
  line(`cron markets WITHOUT an AMAZON Marketplace row: ${markets.filter((m) => !haveRow.has(m)).join(' · ') || '(none)'}`)

  h('D · how many ASINs would the cron ask for, per market? (limit = 10)')
  for (const mkt of markets) {
    const listings = await prisma.channelListing.findMany({
      where: { channel: 'AMAZON', OR: [{ marketplace: mkt }, { region: mkt }] },
      select: { externalParentId: true, externalListingId: true, listingStatus: true },
      take: 1000,
    })
    const ordered = [...listings].sort((a, b) => (a.listingStatus === 'ACTIVE' ? -1 : 1) - (b.listingStatus === 'ACTIVE' ? -1 : 1))
    const seen = new Set<string>()
    for (const l of ordered) { const a = l.externalParentId || l.externalListingId; if (a) seen.add(a) }
    const first10: string[] = []
    const s2 = new Set<string>()
    for (const l of ordered) { const a = l.externalParentId || l.externalListingId; if (a && !s2.has(a)) { s2.add(a); first10.push(a) } if (first10.length >= 10) break }
    line(`${mkt.padEnd(6)} listings=${String(listings.length).padStart(4)}  distinct ASINs=${String(seen.size).padStart(4)}  cron asks for: ${first10.join(',') || '(none → ingestSqp THROWS)'}`)
  }

  h('E · which ASINs actually have SQP rows, and in which weeks?')
  const byAsin = new Map<string, Set<string>>()
  for (const r of rows) { if (!r.asin) continue; if (!byAsin.has(r.asin)) byAsin.set(r.asin, new Set()); byAsin.get(r.asin)!.add(d10(r.startDate)) }
  line(`distinct ASINs with any SQP row: ${byAsin.size}`)
  const latest = [...weeks.keys()].sort().reverse()[0]
  const inLatest = [...byAsin.entries()].filter(([, ws]) => ws.has(latest))
  line(`ASINs present in the latest stored week (${latest}): ${inLatest.length} → ${inLatest.map(([a]) => a).join(', ')}`)

  h('F · advertised ASINs vs SQP-covered ASINs')
  const ads = await prisma.adProductAd.findMany({ select: { asin: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } }, take: 5000 })
  const advByMkt = new Map<string, Set<string>>()
  for (const a of ads) { const m = a.adGroup?.campaign?.marketplace ?? '?'; if (!a.asin) continue; if (!advByMkt.has(m)) advByMkt.set(m, new Set()); advByMkt.get(m)!.add(a.asin) }
  for (const [m, set] of [...advByMkt.entries()].sort()) {
    const sqpAsins = new Set(rows.filter((r) => r.marketplace === m && r.asin).map((r) => r.asin!))
    let covered = 0
    for (const a of set) if (sqpAsins.has(a)) covered++
    line(`${m.padEnd(6)} advertised ASINs=${String(set.size).padStart(4)}  with ANY SQP row=${String(covered).padStart(4)}  (${((covered / Math.max(1, set.size)) * 100).toFixed(0)}%)`)
  }

  h('G · the rank engine\'s signal, and its age')
  const engineWeeks = new Map<string, string>()
  for (const m of ['IT', 'DE', 'ES', 'FR']) {
    const r = await prisma.searchQueryPerformance.findFirst({ where: { marketplace: m }, orderBy: { startDate: 'desc' }, select: { startDate: true } })
    engineWeeks.set(m, r ? d10(r.startDate) : '—')
  }
  line(`sqpImpressionShareForAsins() reads MAX(startDate) per market — with no recency guard:`)
  for (const [m, w] of engineWeeks) {
    const ageDays = w === '—' ? null : Math.round((Date.now() - +new Date(w)) / 864e5)
    line(`  ${m}: latest week ${w}${ageDays != null ? ` (${ageDays} days old)` : ''}`)
  }

  line()
  line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
