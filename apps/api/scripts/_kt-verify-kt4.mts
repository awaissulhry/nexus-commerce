/**
 * _kt-verify-kt4.mts — what a per-keyword history drawer actually has to draw (read-only).
 *
 * KT.4 is the drawer: one term, over time, with the ASINs and campaigns behind it. Before
 * specifying a chart, measure whether there is a series to chart.
 *
 *   A. how many SQP weeks hold each watchlist term (a sparkline over 2 points is not a chart)
 *   B. how many of OUR ASINs compete per term, and their share spread
 *   C. is the SQP funnel (click / cart-add / purchase share) actually populated?
 *   D. which campaigns bid each term, and with what match types
 *   E. how many weeks of spend history exist per term
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-kt4.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const hist = (ns: number[]) => {
  const m = new Map<number, number>()
  for (const n of ns) m.set(n, (m.get(n) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' · ')
}

async function main() {
  const wl = await (prisma as unknown as {
    keywordWatchlist: { findMany: (a: unknown) => Promise<Array<{ marketplace: string; name: string; isDefault: boolean; terms: Array<{ term: string; isBranded: boolean }> }>> }
  }).keywordWatchlist.findMany({ include: { terms: true } })
  const byMkt = new Map<string, string[]>()
  for (const w of wl) {
    if (!w.isDefault && byMkt.has(w.marketplace)) continue
    byMkt.set(w.marketplace, w.terms.filter((t) => !t.isBranded).map((t) => t.term.trim().toLowerCase()))
  }

  const sqp = await prisma.searchQueryPerformance.findMany({
    select: {
      marketplace: true, startDate: true, searchQuery: true, asin: true,
      impressionShare: true, clickShare: true, cartAddShare: true, purchaseShare: true,
      impressionsBrand: true, clicksBrand: true, purchasesBrand: true, searchQueryVolume: true,
    },
  })

  // ── A · weeks per term ───────────────────────────────────────────────────
  h('A · How many SQP weeks hold each watchlist term?')
  const allWeeks = [...new Set(sqp.map((r) => +r.startDate))].sort((a, b) => b - a)
  line(`SQP holds ${allWeeks.length} distinct weeks: ${allWeeks.map((t) => d10(new Date(t))).join(' · ')}`)
  for (const m of MARKETS) {
    const terms = byMkt.get(m) ?? []
    const counts: number[] = []
    for (const t of terms) {
      const ws = new Set(sqp.filter((r) => r.marketplace === m && r.searchQuery.trim().toLowerCase() === t).map((r) => +r.startDate))
      counts.push(ws.size)
    }
    const charted = counts.filter((c) => c >= 3).length
    line(`${m}: ${terms.length} terms · weeks-per-term histogram: ${hist(counts)}`)
    line(`    with >=2 weeks (a delta): ${counts.filter((c) => c >= 2).length} · >=3 weeks (a line worth drawing): ${charted}`)
  }

  // ── B · our ASINs per term ───────────────────────────────────────────────
  h('B · How many of OUR ASINs compete per term, and how far apart are they?')
  for (const m of MARKETS) {
    const terms = byMkt.get(m) ?? []
    const perTerm: number[] = []
    let biggestSpread: { term: string; n: number; best: number; worst: number; sum: number } | null = null
    for (const t of terms) {
      const rows = sqp.filter((r) => r.marketplace === m && r.searchQuery.trim().toLowerCase() === t)
      if (!rows.length) continue
      const latest = Math.max(...rows.map((r) => +r.startDate))
      const inWeek = rows.filter((r) => +r.startDate === latest)
      perTerm.push(inWeek.length)
      const shares = inWeek.map((r) => Number(r.impressionShare)).sort((a, b) => b - a)
      const sum = shares.reduce((a, b) => a + b, 0)
      if (inWeek.length > 1 && (!biggestSpread || inWeek.length > biggestSpread.n)) {
        biggestSpread = { term: t, n: inWeek.length, best: shares[0], worst: shares[shares.length - 1], sum }
      }
    }
    line(`${m}: ASINs-per-term (latest week holding it): ${hist(perTerm)}`)
    if (biggestSpread) {
      line(`    widest: "${biggestSpread.term}" — ${biggestSpread.n} ASINs · best ${(biggestSpread.best * 100).toFixed(3)}% · worst ${(biggestSpread.worst * 100).toFixed(3)}% · summed bound ${(biggestSpread.sum * 100).toFixed(3)}%`)
    }
  }

  // ── C · is the funnel populated? ─────────────────────────────────────────
  h('C · The SQP funnel — is there anything below impression share?')
  for (const m of MARKETS) {
    const terms = new Set(byMkt.get(m) ?? [])
    const rows = sqp.filter((r) => r.marketplace === m && terms.has(r.searchQuery.trim().toLowerCase()))
    const nz = (f: (r: typeof rows[number]) => number) => rows.filter((r) => f(r) > 0).length
    line(`${m}: ${rows.length} watchlist SQP rows`)
    line(`    impressionShare>0 ${nz((r) => Number(r.impressionShare))} · clickShare>0 ${nz((r) => Number(r.clickShare))} · cartAddShare>0 ${nz((r) => Number(r.cartAddShare))} · purchaseShare>0 ${nz((r) => Number(r.purchaseShare))}`)
    line(`    raw counts>0: impressions ${nz((r) => r.impressionsBrand)} · clicks ${nz((r) => r.clicksBrand)} · purchases ${nz((r) => r.purchasesBrand)}`)
  }

  // ── D · which campaigns bid each term ────────────────────────────────────
  h('D · Campaigns bidding each watchlist term (exact expressionValue match)')
  const targets = await prisma.adTarget.findMany({
    where: { kind: 'KEYWORD', isNegative: false },
    select: {
      expressionValue: true, expressionType: true, bidCents: true, status: true,
      adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true, status: true } } } },
    },
    take: 5000,
  })
  for (const m of MARKETS) {
    const terms = byMkt.get(m) ?? []
    const counts: number[] = []
    let widest: { term: string; camps: number; groups: number; types: string[] } | null = null
    for (const t of terms) {
      const mine = targets.filter((x) => (x.expressionValue ?? '').trim().toLowerCase() === t && x.adGroup?.campaign?.marketplace === m)
      counts.push(new Set(mine.map((x) => x.adGroup?.campaign?.id)).size)
      const camps = new Set(mine.map((x) => x.adGroup?.campaign?.id)).size
      if (camps > 0 && (!widest || camps > widest.camps)) {
        widest = { term: t, camps, groups: new Set(mine.map((x) => x.adGroup?.name)).size, types: [...new Set(mine.map((x) => x.expressionType ?? '?'))] }
      }
    }
    line(`${m}: campaigns-per-term histogram: ${hist(counts)}`)
    if (widest) line(`    widest: "${widest.term}" — ${widest.camps} campaigns · ${widest.groups} ad groups · match types ${widest.types.join('/')}`)
    line(`    terms with NO campaign bidding them: ${counts.filter((c) => c === 0).length} of ${terms.length}`)
  }

  // ── E · spend history depth ──────────────────────────────────────────────
  h('E · Weeks of spend history per term (AmazonAdsSearchTerm, exact query)')
  const stAll = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'marketplace', 'date'],
    _sum: { costMicros: true, clicks: true, orders7d: true },
  })
  for (const m of MARKETS) {
    const terms = byMkt.get(m) ?? []
    const weeks: number[] = []
    let deepest: { term: string; days: number; span: string } | null = null
    for (const t of terms) {
      const rows = stAll.filter((r) => r.marketplace === m && r.query.trim().toLowerCase() === t)
      if (!rows.length) { weeks.push(0); continue }
      const ds = rows.map((r) => +r.date).sort((a, b) => a - b)
      const wk = new Set(rows.map((r) => Math.floor(+r.date / (7 * 864e5)))).size
      weeks.push(wk)
      if (!deepest || rows.length > deepest.days) deepest = { term: t, days: rows.length, span: `${d10(new Date(ds[0]))}…${d10(new Date(ds[ds.length - 1]))}` }
    }
    line(`${m}: distinct spend-weeks per term: ${hist(weeks)}`)
    if (deepest) line(`    deepest: "${deepest.term}" — ${deepest.days} day-rows, ${deepest.span}`)
  }

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
