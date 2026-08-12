/**
 * _sqp1-gate.mts — SQP.1 §6, the measurement the widening gate needs. READ-ONLY, no Amazon call.
 *
 * Widening the SQP feed changes a number the rank engine STEERS ON, so the gate is not "is more data
 * better" but "what moves, by how much, and for how many campaigns". Four things, in order:
 *
 *   1. The signal as it stands, per rank-schedule group — `sqpImpressionShareForAsins` is IMPORTED
 *      and called exactly as `ad-rank-defend.job.ts:567` calls it, so this is the value the engine
 *      reads and not a reconstruction of it.
 *   2. What it would become under full ASIN coverage. Projected the only honest way available without
 *      calling Amazon: the same impressions-weighted computation, but pooling each ASIN's OWN most
 *      recent week instead of requiring the campaign's ASINs to share one. That is what widening
 *      approximates, and it is stated as an approximation.
 *   3. How many campaigns move from no-signal to signal — the count that decides whether widening
 *      changes behaviour or merely changes a number nobody reads.
 *   4. Report volume, which SQP.1 Phase A established is the binding constraint: Amazon generates
 *      this account's reports ONE AT A TIME, so widening is priced in queue hours, not in minutes.
 *
 * 🔴 A trap this probe is built around: `sqpImpressionShareForAsins` does NOT use the globally
 *    latest week. It takes the newest week present for THAT ASIN SET, so two campaigns can be
 *    steered by shares from different weeks with nothing on screen saying so. That is measured below.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp1-gate.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { sqpImpressionShareForAsins } from '../src/services/advertising/sqp.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(3)}%`)

async function main() {
  h('§6.1 · the rank-schedule groups, and the campaigns they steer')
  const groups = await prisma.rankScheduleGroup.findMany({
    select: {
      id: true, name: true, marketplace: true, enabled: true, defaultTargetKey: true, portfolioId: true,
      schedules: { select: { campaignId: true, enabled: true, defaultTargetKey: true, lastApplied: true } },
    },
    orderBy: { name: 'asc' },
  })
  line(`RankScheduleGroup rows: ${groups.length} (${groups.filter((g) => g.enabled).length} enabled)`)

  const allCampIds = [...new Set(groups.flatMap((g) => g.schedules.map((s) => s.campaignId)))]
  const camps = await prisma.campaign.findMany({
    where: { id: { in: allCampIds } },
    select: { id: true, name: true, marketplace: true, status: true },
  })
  const campById = new Map(camps.map((c) => [c.id, c]))

  // ENABLED product ads per campaign — the same filter ad-rank-defend uses.
  const ads = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId: { in: allCampIds } }, status: 'ENABLED' },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })
  const asinsByCampaign = new Map<string, Set<string>>()
  for (const a of ads) {
    const cid = a.adGroup?.campaignId
    if (!cid || !a.asin) continue
    const s = asinsByCampaign.get(cid) ?? new Set<string>()
    s.add(a.asin); asinsByCampaign.set(cid, s)
  }

  // ── the SQP universe, once ────────────────────────────────────────────────────────────────────
  const sqpRows = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, asin: true, startDate: true, impressionsBrand: true, impressionsTotal: true },
  })
  /** per (market|asin) → that ASIN's own most recent week, with its impression totals summed */
  const newestByAsin = new Map<string, { week: number; brand: number; total: number }>()
  for (const r of sqpRows) {
    if (!r.asin) continue
    const k = `${r.marketplace}|${r.asin}`
    const wk = +r.startDate
    const cur = newestByAsin.get(k)
    if (!cur || wk > cur.week) newestByAsin.set(k, { week: wk, brand: r.impressionsBrand, total: r.impressionsTotal })
    else if (cur && wk === cur.week) { cur.brand += r.impressionsBrand; cur.total += r.impressionsTotal }
  }
  /** the week each (market|asin) pair's signal comes from — used to expose the mixed-week hazard */
  const weekOf = (mkt: string, asin: string) => newestByAsin.get(`${mkt}|${asin}`)?.week ?? null

  /** projection: pool each ASIN's OWN newest week — what full coverage approximates */
  const projected = (mkt: string, asins: string[]): { share: number | null; contributing: number } => {
    let brand = 0, total = 0, contributing = 0
    for (const a of asins) {
      const e = newestByAsin.get(`${mkt}|${a}`)
      if (!e) continue
      brand += e.brand; total += e.total; contributing += 1
    }
    return { share: total > 0 ? Math.max(0, Math.min(1, brand / total)) : null, contributing }
  }

  h('§6.2 · the signal today vs projected, per group')
  line(`${padr('group', 30)} ${padr('mkt', 4)} ${pad('camp', 4)} ${pad('ASINs', 6)} ${pad('cov', 5)} ${pad('now', 9)} ${pad('projected', 10)} weeks in play`)
  let campsWithSignal = 0, campsNoSignal = 0, campsGained = 0, campsMoved = 0
  const moves: Array<{ group: string; camp: string; now: number | null; proj: number | null; cov: string }> = []

  for (const g of groups) {
    const gAsins = new Set<string>()
    let nowVals: Array<number | null> = []
    let projVals: Array<number | null> = []
    const weeks = new Set<string>()
    let covered = 0, totalAsins = 0

    for (const s of g.schedules) {
      const c = campById.get(s.campaignId)
      if (!c) continue
      const asins = [...(asinsByCampaign.get(c.id) ?? [])]
      for (const a of asins) gAsins.add(a)
      totalAsins += asins.length
      const mkt = c.marketplace ?? g.marketplace ?? ''
      // exactly as ad-rank-defend.job.ts does it
      const now = asins.length && mkt ? await sqpImpressionShareForAsins(mkt, asins) : null
      const p = projected(mkt, asins)
      covered += p.contributing
      for (const a of asins) { const w = weekOf(mkt, a); if (w) weeks.add(d10(new Date(w))) }
      nowVals.push(now); projVals.push(p.share)
      if (now == null) campsNoSignal++; else campsWithSignal++
      if (now == null && p.share != null) { campsGained++; moves.push({ group: g.name, camp: c.name, now, proj: p.share, cov: `${p.contributing}/${asins.length}` }) }
      else if (now != null && p.share != null && Math.abs(now - p.share) > 0.001) { campsMoved++; moves.push({ group: g.name, camp: c.name, now, proj: p.share, cov: `${p.contributing}/${asins.length}` }) }
    }

    const avg = (xs: Array<number | null>) => {
      const v = xs.filter((x): x is number => x != null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    }
    line(`${padr(g.name.slice(0, 29), 30)} ${padr(g.marketplace ?? '—', 4)} ${pad(g.schedules.length, 4)} ${pad(gAsins.size, 6)} ${pad(totalAsins ? `${Math.round((covered / totalAsins) * 100)}%` : '—', 5)} ${pad(pct(avg(nowVals)), 9)} ${pad(pct(avg(projVals)), 10)} ${weeks.size <= 1 ? [...weeks][0] ?? '—' : `🔴 ${weeks.size}: ${[...weeks].sort().join(' ')}`}`)
  }

  h('§6.2b · 🔴 how many of a campaign\'s ASINs actually contribute to the value today?')
  line('`sqpImpressionShareForAsins` takes rows[0].startDate as "latest" and sums ONLY that week. So')
  line('the week is chosen by whichever single ASIN has the freshest row, and every ASIN whose newest')
  line('data is older is silently dropped from the average. This counts the survivors.')
  line()
  line(`${padr('campaign', 36)} ${pad('ASINs', 6)} ${pad('measured', 9)} ${pad('week used', 11)} ${pad('contributing', 12)} ${pad('share', 9)}`)
  const contribution: number[] = []
  for (const c of camps) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    const mkt = c.marketplace ?? ''
    if (!asins.length || !mkt) continue
    const weeks = asins.map((a) => weekOf(mkt, a)).filter((w): w is number => w != null)
    if (!weeks.length) continue
    const used = Math.max(...weeks)
    const contributing = asins.filter((a) => weekOf(mkt, a) === used).length
    const share = await sqpImpressionShareForAsins(mkt, asins)
    contribution.push(contributing / asins.length)
    line(`${padr(c.name.slice(0, 35), 36)} ${pad(asins.length, 6)} ${pad(weeks.length, 9)} ${pad(d10(new Date(used)), 11)} ${pad(`${contributing} (${Math.round((contributing / asins.length) * 100)}%)`, 12)} ${pad(pct(share), 9)}`)
  }
  const avgContrib = contribution.length ? contribution.reduce((a, b) => a + b, 0) / contribution.length : 0
  line()
  line(`⇒ across ${contribution.length} campaigns, on average only ${(avgContrib * 100).toFixed(0)}% of a campaign's ASINs contribute to`)
  line(`  the share the rank engine steers on. ${contribution.filter((x) => x <= 0.25).length} campaigns are steered by a QUARTER or less of their ASINs.`)
  line('  This is not a coverage problem the feed can fix by itself: even at full coverage the function')
  line('  would still collapse to one week. It is a second, independent defect in the READER.')

  h('§6.3 · does widening change BEHAVIOUR, or just a number?')
  line(`campaigns under a rank-schedule group: ${allCampIds.length}`)
  line(`  with a signal today            : ${campsWithSignal}`)
  line(`  open-loop today (null)         : ${campsNoSignal}`)
  line(`  would GAIN a signal            : ${campsGained}`)
  line(`  signal would MOVE by >0.1pp    : ${campsMoved}`)
  line()
  if (moves.length) {
    line(`${padr('group', 24)} ${padr('campaign', 34)} ${pad('cov', 7)} ${pad('now', 9)} → ${pad('projected', 9)}`)
    for (const m of moves.slice(0, 30)) {
      line(`${padr(m.group.slice(0, 23), 24)} ${padr(m.camp.slice(0, 33), 34)} ${pad(m.cov, 7)} ${pad(pct(m.now), 9)} → ${pad(pct(m.proj), 9)}`)
    }
    if (moves.length > 30) line(`  … and ${moves.length - 30} more`)
  } else {
    line('nothing moves — widening would not change any campaign\'s signal on today\'s data.')
  }
  line()
  line('🔴 Read this as a LOWER BOUND on the change, not an estimate of it. The projection can only')
  line('  pool weeks the feed has ALREADY written; a widened feed would add ASINs that have never')
  line('  appeared at all, and those cannot be projected from stored data at any confidence.')

  h('§6.4 · what widening would COST — priced in reports, not minutes')
  const distinctAsins = new Set<string>()
  for (const [, s] of asinsByCampaign) for (const a of s) distinctAsins.add(a)
  const byMarket = new Map<string, Set<string>>()
  for (const c of camps) {
    const mkt = c.marketplace ?? ''
    const s = byMarket.get(mkt) ?? new Set<string>()
    for (const a of asinsByCampaign.get(c.id) ?? []) s.add(a)
    byMarket.set(mkt, s)
  }
  line(`distinct ENABLED ASINs across rank-governed campaigns: ${distinctAsins.size}`)
  for (const [mkt, s] of [...byMarket].sort()) {
    const measured = [...s].filter((a) => newestByAsin.has(`${mkt}|${a}`)).length
    line(`  ${padr(mkt, 4)} ${pad(s.size, 4)} ASINs · ${pad(measured, 4)} have ever been measured (${s.size ? Math.round((measured / s.size) * 100) : 0}%)`)
  }
  line()
  // Amazon's measured behaviour: serial generation, and 104 of 104 abandoned reports finished.
  const GEN_P50_S = 33, GEN_P90_S = 154
  line(`Today's cron requests 40 reports/night (4 markets × 10). Full coverage would need ${distinctAsins.size}.`)
  line(`Amazon generates this account's reports SERIALLY (measured: each processingStartTime equals the`)
  line(`previous processingEndTime, 104/104 samples). So the queue, not our loop, sets the wall clock:`)
  for (const n of [40, 100, distinctAsins.size]) {
    line(`  ${pad(n, 4)} reports ⇒ ${pad((n * GEN_P50_S / 3600).toFixed(1), 5)}h at the p50 generation time (33s) · ${pad((n * GEN_P90_S / 3600).toFixed(1), 5)}h at p90 (154s)`)
  }
  line()
  line('And the other daily report crons share that one slot: ~50-70 reports/day already')
  line('(FLAT_FILE_RETURNS + FBA_FULFILLMENT_CUSTOMER_RETURNS hourly, FBA_INVENTORY_PLANNING).')
  line('🔴 Which means full coverage is NOT schedulable as one nightly synchronous pass at any poll')
  line('  ceiling. It needs the asynchronous collector in §10 of the feed doc first, and probably')
  line('  rotation on top. That ordering is a finding of this gate, not a preference.')

  h('§6.5 · the 100-row ceiling bounds what coverage can buy')
  const capped = await prisma.amazonReportRun.count({ where: { reportType: { contains: 'BRAND_ANALYTICS' }, rowCount: 100 } })
  const over = await prisma.amazonReportRun.count({ where: { reportType: { contains: 'BRAND_ANALYTICS' }, rowCount: { gt: 100 } } })
  line(`reports at exactly 100 rows: ${capped} · above 100: ${over}`)
  line(over === 0
    ? '⇒ 100 is a hard per-report ceiling, so widening buys BREADTH (more ASINs) and never DEPTH.'
    : '⇒ not a ceiling after all — re-read before projecting.')

  h('control')
  line(`RankScheduleGroup ${groups.length} · AdSchedule members ${groups.reduce((a, g) => a + g.schedules.length, 0)} · campaigns resolved ${camps.length}`)
  line(`SearchQueryPerformance rows ${sqpRows.length} · distinct (market,asin) with data ${newestByAsin.size}`)
  line(`newest week anywhere ${d10(new Date(Math.max(...[...newestByAsin.values()].map((v) => v.week))))}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
