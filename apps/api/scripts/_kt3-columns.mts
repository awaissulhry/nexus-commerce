/**
 * _kt3-columns.mts — the stop conditions, and the numbers the Δ and spend columns rest on (read-only).
 *
 * KT.3's whole design is contingent: whether Δ is worth a column depends on how many rows carry one
 * and how far apart the two periods are; whether Spend uses the share's week or 30 days depends on
 * how thin the same-week join is. So this measures first and the design follows.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt3-columns.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { chooseViewPeriod, KT_LOOKBACK_DAYS } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  h('STOP CONDITIONS')

  // ── 1 · has a new SQP period landed? ──
  const periodsByMarket = new Map<string, Array<{ start: Date; rows: number }>>()
  for (const m of MARKETS) {
    const g = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' },
    })
    periodsByMarket.set(m, g.map((x) => ({ start: x.startDate, rows: x._count._all })))
  }
  const newest = [...periodsByMarket.values()].map((ps) => ps[0]?.start).filter(Boolean).sort((a, b) => +b! - +a!)[0]
  line(`1 · newest SQP period: ${d10(newest)} — KT.5 recorded 2026-07-26`)
  line(`    ${d10(newest) === '2026-07-26' ? '✓ unchanged' : '🔴 A NEW PERIOD HAS LANDED — every number below changes; stop'}`)

  // ── 2 · does the gate return truncated for any market? ──
  const chosen = new Map<string, ReturnType<typeof chooseViewPeriod>>()
  line('2 · the gate, per market:')
  let anyTruncated = false
  for (const m of MARKETS) {
    const c = chooseViewPeriod(periodsByMarket.get(m)!)
    chosen.set(m, c)
    if (c.truncated) anyTruncated = true
    line(`    ${m}: ${d10(c.start)} · ${c.rows} rows · reason=${c.reason} truncated=${c.truncated}`)
  }
  line(`    ${anyTruncated ? '🔴 A MARKET IS ON A TRUNCATED WEEK — a Δ would compare truncated to complete; stop' : '✓ every market is on a complete week'}`)

  // ── 3 · is AdTarget still empty of money? ──
  const adTargetMoney = await prisma.adTarget.aggregate({
    where: { isNegative: false, expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] } },
    _sum: { spendCents: true, salesCents: true, impressions: true }, _count: { _all: true },
  })
  line(`3 · AdTarget (positive keyword targets): n=${adTargetMoney._count._all} spend=${adTargetMoney._sum.spendCents} sales=${adTargetMoney._sum.salesCents} impressions=${adTargetMoney._sum.impressions}`)
  line(`    ${(adTargetMoney._sum.spendCents ?? 0) === 0 ? '✓ still all zero — spend must come from AmazonAdsSearchTerm' : '🔴 AdTarget now carries money — the spend source may change; report'}`)
  // the control the brief demands: prove a zero is a measurement, not a broken query
  const stSum = await prisma.amazonAdsSearchTerm.aggregate({ _sum: { costMicros: true }, _count: { _all: true } })
  line(`    control — AmazonAdsSearchTerm: n=${stSum._count._all} cost=${eur(Number(stSum._sum.costMicros ?? 0n) / 10_000)} (a 0 here would mean the query is wrong)`)

  // ── the watchlists ──
  const watchlists = await prisma.keywordWatchlist.findMany({
    select: { marketplace: true, name: true, isDefault: true, terms: { select: { term: true, isBranded: true } } },
  })
  const termsFor = (m: string) => {
    const wl = watchlists.find((w) => w.marketplace === m && w.isDefault) ?? watchlists.find((w) => w.marketplace === m)
    return (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
  }
  const asinsFor = async (m: string) => {
    const ads = await prisma.adProductAd.findMany({
      where: { asin: { not: null }, adGroup: { campaign: { marketplace: m } } }, select: { asin: true },
    })
    return [...new Set(ads.map((a) => a.asin!))]
  }

  // ─────────────────────────────────────────────────────────────────────────
  h('§3.1 · Δ — how many rows carry one, and how far apart the two periods are')
  line('The prior period is the newest one BEFORE the chosen week that holds the same term for an')
  line('in-scope ASIN. Unbounded on purpose (the same rule KT.1b uses for last-seen): a gap is worth')
  line('stating at any size. Both bounded and unbounded are shown so the choice is visible.')
  line()
  line('market  measured  Δ (unbounded)  Δ (≤42d)   7d   14d   21d   28d   35d+   no prior')
  const deltaDetail = new Map<string, Array<{ term: string; share: number; prior: number; gapDays: number }>>()
  for (const m of MARKETS) {
    const terms = termsFor(m)
    const asins = await asinsFor(m)
    const c = chosen.get(m)!
    if (!c.start || !terms.length) { line(`${m}: nothing to measure`); continue }
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, searchQuery: { in: terms }, asin: { in: asins } },
      select: { searchQuery: true, startDate: true, impressionShare: true },
    })
    // best-ASIN share per (term, period) — the same value the grid renders
    const best = new Map<string, Map<number, number>>()
    for (const r of rows) {
      const k = norm(r.searchQuery)
      const per = best.get(k) ?? new Map<number, number>()
      const t = +r.startDate
      per.set(t, Math.max(per.get(t) ?? -1, Number(r.impressionShare)))
      best.set(k, per)
    }
    const chosenT = +c.start
    const gaps: Record<string, number> = { '7': 0, '14': 0, '21': 0, '28': 0, '35+': 0 }
    let unbounded = 0, bounded = 0, noPrior = 0
    const detail: Array<{ term: string; share: number; prior: number; gapDays: number }> = []
    for (const [term, per] of best) {
      if (!per.has(chosenT)) continue
      const prior = [...per.keys()].filter((t) => t < chosenT).sort((a, b) => b - a)[0]
      if (prior == null) { noPrior++; continue }
      const gapDays = Math.round((chosenT - prior) / 86_400_000)
      unbounded++
      if (gapDays <= KT_LOOKBACK_DAYS) bounded++
      const k = gapDays <= 7 ? '7' : gapDays <= 14 ? '14' : gapDays <= 21 ? '21' : gapDays <= 28 ? '28' : '35+'
      gaps[k]++
      detail.push({ term, share: per.get(chosenT)!, prior: per.get(prior)!, gapDays })
    }
    deltaDetail.set(m, detail)
    const measured = [...best.values()].filter((p) => p.has(chosenT)).length
    line(`${m.padEnd(7)} ${pad(measured, 8)}  ${pad(unbounded, 13)}  ${pad(bounded, 8)}  ${pad(gaps['7'], 3)}  ${pad(gaps['14'], 4)}  ${pad(gaps['21'], 4)}  ${pad(gaps['28'], 4)}  ${pad(gaps['35+'], 5)}   ${pad(noPrior, 8)}`)
  }

  h('stop condition 4 · does any Δ exceed the share it is derived from?')
  let violations = 0
  for (const [m, detail] of deltaDetail) {
    for (const d of detail) {
      const deltaPP = Math.abs(d.share - d.prior) * 100
      const cap = Math.max(d.share, d.prior) * 100
      if (deltaPP > cap + 1e-9) { violations++; line(`   🔴 ${m} "${d.term}" |Δ|=${deltaPP.toFixed(2)}pp > max(share)=${cap.toFixed(2)}pp`) }
    }
  }
  line(`   ${violations === 0 ? '✓ no violation in any market — the two periods are comparable' : `🔴 ${violations} violations — the column is wrong; stop`}`)

  h('what a Δ row actually looks like — the biggest movers in IT, with their gaps')
  const it = (deltaDetail.get('IT') ?? []).slice().sort((a, b) => Math.abs(b.share - b.prior) - Math.abs(a.share - a.prior))
  line('term                                 prior     now      Δ (pp)   gap')
  for (const d of it.slice(0, 10)) {
    const dp = (d.share - d.prior) * 100
    line(`${d.term.slice(0, 34).padEnd(34)} ${pad((d.prior * 100).toFixed(2) + '%', 8)} ${pad((d.share * 100).toFixed(2) + '%', 8)} ${pad((dp >= 0 ? '+' : '') + dp.toFixed(2), 8)}   ${d.gapDays}d`)
  }
  line()
  const wide = it.filter((d) => d.gapDays > 7)
  line(`rows whose "change" spans more than 7 days: ${wide.length} → ${wide.map((d) => `${d.term.slice(0, 22)}(${d.gapDays}d)`).join(' · ')}`)

  // ─────────────────────────────────────────────────────────────────────────
  h('§3.2 · the spend join — the share\'s week vs 30 days')
  line('AmazonAdsSearchTerm joins on exact query text and has NO ASIN column, so spend cannot be')
  line('attributed to a product while the share beside it is one ASIN\'s.')
  line()
  line('market  terms  paid 30d          paid in the SHARE WEEK   neither  orders(week)  orders(30d)')
  for (const m of MARKETS) {
    const terms = termsFor(m)
    const c = chosen.get(m)!
    if (!c.start || !terms.length) continue
    const weekEnd = new Date(+c.start + 6 * 86_400_000)
    const since30 = new Date(); since30.setUTCDate(since30.getUTCDate() - 30); since30.setUTCHours(0, 0, 0, 0)
    const [w, d30] = await Promise.all([
      prisma.amazonAdsSearchTerm.groupBy({
        by: ['query'], where: { marketplace: m, query: { in: terms }, date: { gte: c.start, lte: weekEnd } },
        _sum: { costMicros: true, orders7d: true, clicks: true },
      }),
      prisma.amazonAdsSearchTerm.groupBy({
        by: ['query'], where: { marketplace: m, query: { in: terms }, date: { gte: since30 } },
        _sum: { costMicros: true, orders7d: true, clicks: true },
      }),
    ])
    const sum = (g: typeof w) => g.reduce((a, r) => a + Number(r._sum.costMicros ?? 0n), 0) / 10_000
    const ord = (g: typeof w) => g.reduce((a, r) => a + (r._sum.orders7d ?? 0), 0)
    const wPaid = w.filter((r) => Number(r._sum.costMicros ?? 0n) > 0)
    const dPaid = d30.filter((r) => Number(r._sum.costMicros ?? 0n) > 0)
    const neither = terms.length - new Set([...dPaid.map((r) => norm(r.query))]).size
    line(`${m.padEnd(7)} ${pad(terms.length, 5)}  ${pad(dPaid.length, 3)} · ${pad(eur(sum(d30)), 10)}  ${pad(wPaid.length, 3)} · ${pad(eur(sum(w)), 10)}        ${pad(neither, 7)}  ${pad(ord(w), 12)}  ${pad(ord(d30), 11)}`)
  }
  line()
  line('🔴 the design question: is same-week spend thick enough to be a column, or does 30d win?')

  // ─────────────────────────────────────────────────────────────────────────
  h('§4.3 · does topOfSearchIS vary by ROW? (if not, it is not a column)')
  const maxAny = await prisma.amazonAdsPlacementReport.aggregate({ _max: { date: true } })
  const maxIs = await prisma.amazonAdsPlacementReport.aggregate({ where: { topOfSearchIS: { not: null } }, _max: { date: true } })
  line(`placement MAX(date)=${d10(maxAny._max.date)} · MAX(date) with IS=${d10(maxIs._max.date)} ⇒ lag ${maxAny._max.date && maxIs._max.date ? Math.round((+maxAny._max.date - +maxIs._max.date) / 86_400_000) : '?'} day(s)`)
  const anyC = await prisma.amazonAdsPlacementReport.groupBy({ by: ['campaignId'] })
  const isC = await prisma.amazonAdsPlacementReport.groupBy({ by: ['campaignId'], where: { topOfSearchIS: { not: null } } })
  line(`campaigns with any placement row ${anyC.length} · with an IS reading ${isC.length} ⇒ the honest denominator is ${isC.length} of ${anyC.length}`)
  line()
  line('market  campaigns in scope  with an IS reading  avg IS (latest day per campaign)')
  for (const m of MARKETS) {
    const camps = await prisma.campaign.findMany({
      where: { marketplace: m, status: { not: 'ARCHIVED' }, externalCampaignId: { not: null } },
      select: { externalCampaignId: true },
    })
    const ext = camps.map((c) => c.externalCampaignId!)
    if (!ext.length) { line(`${m}: none`); continue }
    const rows = await prisma.amazonAdsPlacementReport.findMany({
      where: { campaignId: { in: ext }, topOfSearchIS: { not: null } },
      select: { campaignId: true, date: true, topOfSearchIS: true },
      orderBy: { date: 'desc' },
    })
    const latest = new Map<string, number>()
    for (const r of rows) if (!latest.has(r.campaignId)) latest.set(r.campaignId, Number(r.topOfSearchIS))
    const avg = latest.size ? [...latest.values()].reduce((a, b) => a + b, 0) / latest.size : 0
    line(`${m.padEnd(7)} ${pad(ext.length, 18)}  ${pad(latest.size, 18)}  ${(avg * 100).toFixed(2)}%`)
  }
  line()
  line('⇒ one number per CAMPAIGN. On a market-scope grid every row would carry the same average of')
  line('  many campaigns; under a campaign scope, the identical number on every row. Not a column.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
