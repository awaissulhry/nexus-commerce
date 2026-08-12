/**
 * _kt4-drawer.mts — the stop conditions, and the shapes the drawer has to survive (read-only).
 *
 * KT.4's three decisions are all sized by data: how many terms have enough weeks to draw a line,
 * how wide the ASIN and campaign lists get, and whether the SQP funnel is a funnel at all.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt4-drawer.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { chooseViewPeriod } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const hist = (xs: number[]) => {
  const m = new Map<number, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' · ')
}

async function main() {
  h('STOP CONDITIONS')
  const periodsByMarket = new Map<string, Array<{ start: Date; rows: number }>>()
  for (const m of MARKETS) {
    const g = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' },
    })
    periodsByMarket.set(m, g.map((x) => ({ start: x.startDate, rows: x._count._all })))
  }
  const newest = [...periodsByMarket.values()].map((p) => p[0]?.start).filter(Boolean).sort((a, b) => +b! - +a!)[0]
  line(`1 · newest SQP period ${d10(newest)} — ${d10(newest) === '2026-07-26' ? '✓ unchanged' : '🔴 NEW PERIOD; stop'}`)
  const chosen = new Map<string, ReturnType<typeof chooseViewPeriod>>()
  let trunc = false
  for (const m of MARKETS) {
    const c = chooseViewPeriod(periodsByMarket.get(m)!); chosen.set(m, c)
    if (c.truncated) trunc = true
    line(`    ${m}: chart's newest point = ${d10(c.start)} (${c.rows} rows, ${c.reason})`)
  }
  line(`2 · ${trunc ? '🔴 A MARKET IS TRUNCATED — the newest chart point would not be comparable; stop' : '✓ no market truncated'}`)
  const at = await prisma.adTarget.aggregate({
    where: { isNegative: false, expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] } },
    _sum: { spendCents: true, salesCents: true, impressions: true }, _count: { _all: true },
  })
  line(`3 · AdTarget positive keywords n=${at._count._all} spend=${at._sum.spendCents} sales=${at._sum.salesCents} impr=${at._sum.impressions} → ${(at._sum.spendCents ?? 0) === 0 ? '✓ still moneyless; never show a metric from AdTarget' : '🔴 now carries money; report'}`)
  const negs = await prisma.adTarget.count({ where: { isNegative: true } })
  const negTypes = await prisma.adTarget.groupBy({ by: ['expressionType'], where: { isNegative: true }, _count: { _all: true } })
  line(`    isNegative still distinguishes: ${negs} negatives, spread across expressionType ${negTypes.map((t) => `${t.expressionType}=${t._count._all}`).join(' · ')}`)
  line(`    ⇒ expressionType is the MATCH TYPE, not negativity — filter on isNegative explicitly`)

  const watchlists = await prisma.keywordWatchlist.findMany({
    select: { marketplace: true, isDefault: true, terms: { select: { term: true, isBranded: true } } },
  })
  const termsFor = (m: string) => {
    const wl = watchlists.find((w) => w.marketplace === m && w.isDefault) ?? watchlists.find((w) => w.marketplace === m)
    return (wl?.terms ?? []).filter((t) => !t.isBranded).map((t) => norm(t.term))
  }
  const asinsFor = async (m: string) => [...new Set((await prisma.adProductAd.findMany({
    where: { asin: { not: null }, adGroup: { campaign: { marketplace: m } } }, select: { asin: true },
  })).map((a) => a.asin!))]

  h('§3.1 · how many weeks does each term have? (a line needs ≥3)')
  line('market  terms  ≥2 wk (a Δ)  ≥3 wk (a LINE)  exactly 1  weeks-per-term histogram')
  const weeksByMarket = new Map<string, Map<string, Date[]>>()
  for (const m of MARKETS) {
    const terms = termsFor(m); const asins = await asinsFor(m)
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, searchQuery: { in: terms }, asin: { in: asins } },
      select: { searchQuery: true, startDate: true },
    })
    const per = new Map<string, Set<number>>()
    for (const r of rows) {
      const k = norm(r.searchQuery); const s = per.get(k) ?? new Set<number>(); s.add(+r.startDate); per.set(k, s)
    }
    weeksByMarket.set(m, new Map([...per].map(([k, v]) => [k, [...v].sort().map((t) => new Date(t))])))
    const counts = [...per.values()].map((s) => s.size)
    line(`${m.padEnd(7)} ${pad(terms.length, 5)}  ${pad(counts.filter((c) => c >= 2).length, 11)}  ${pad(counts.filter((c) => c >= 3).length, 14)}  ${pad(counts.filter((c) => c === 1).length, 9)}  ${hist(counts)}`)
  }
  line()
  line('🔴 gaps: a term with weeks 17 May, 31 May, 19 Jul has TWO missing weeks between them. Sample:')
  const itWeeks = weeksByMarket.get('IT')!
  const gappy = [...itWeeks.entries()].filter(([, ws]) => ws.length >= 3).slice(0, 3)
  for (const [term, ws] of gappy) {
    const spans = ws.slice(1).map((w, i) => Math.round((+w - +ws[i]) / 86_400_000))
    line(`   ${term.slice(0, 30).padEnd(30)} ${ws.length} weeks: ${ws.map(d10).join(' → ')}`)
    line(`   ${' '.repeat(30)} spans (days): ${spans.join(' · ')} ${spans.some((s) => s > 7) ? '← has a GAP' : ''}`)
  }

  h('§3.2 · our ASINs per term, in the newest week holding it')
  line('market  ASINs-per-term histogram')
  for (const m of MARKETS) {
    const terms = termsFor(m); const asins = await asinsFor(m); const c = chosen.get(m)!
    if (!c.start) continue
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, startDate: c.start, searchQuery: { in: terms }, asin: { in: asins } },
      select: { searchQuery: true, asin: true, impressionShare: true },
    })
    const per = new Map<string, Array<{ asin: string; share: number }>>()
    for (const r of rows) {
      const k = norm(r.searchQuery); const a = per.get(k) ?? []; a.push({ asin: r.asin!, share: Number(r.impressionShare) }); per.set(k, a)
    }
    line(`${m.padEnd(7)} ${hist([...per.values()].map((v) => v.length))}`)
    const widest = [...per.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (widest) {
      const shares = widest[1].map((x) => x.share).sort((a, b) => b - a)
      line(`        widest: "${widest[0]}" — ${widest[1].length} ASINs · best ${(shares[0] * 100).toFixed(3)}% · worst ${(shares[shares.length - 1] * 100).toFixed(3)}% · bound ≤${(shares.reduce((a, b) => a + b, 0) * 100).toFixed(3)}%`)
    }
  }

  h('§3.3 · campaigns per term — and the unbid case')
  line('market  terms with NO campaign  campaigns-per-term histogram')
  for (const m of MARKETS) {
    const terms = termsFor(m)
    const targets = await prisma.adTarget.findMany({
      where: {
        isNegative: false, expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] },
        expressionValue: { in: terms }, adGroup: { campaign: { marketplace: m } },
      },
      select: { expressionValue: true, expressionType: true, adGroupId: true, adGroup: { select: { campaignId: true } } },
    })
    const camps = new Map<string, Set<string>>(); const groups = new Map<string, Set<string>>()
    for (const t of targets) {
      const k = norm(t.expressionValue)
      const c = camps.get(k) ?? new Set<string>(); c.add(t.adGroup!.campaignId); camps.set(k, c)
      const g = groups.get(k) ?? new Set<string>(); g.add(t.adGroupId); groups.set(k, g)
    }
    const counts = terms.map((t) => camps.get(t)?.size ?? 0)
    line(`${m.padEnd(7)} ${pad(counts.filter((c) => c === 0).length, 21)}  ${hist(counts)}`)
    const widest = [...camps.entries()].sort((a, b) => b[1].size - a[1].size)[0]
    if (widest) {
      const mt = [...new Set(targets.filter((t) => norm(t.expressionValue) === widest[0]).map((t) => t.expressionType))].sort()
      line(`        widest: "${widest[0]}" — ${widest[1].size} campaigns · ${groups.get(widest[0])?.size} ad groups · match types ${mt.join('/')}`)
    }
  }

  h('§3.4 · does the SQP funnel survive below clicks?')
  line('market   rows  imprShare>0  clickShare>0  cartAddShare>0  purchaseShare>0  purchasesBrand>0')
  for (const m of MARKETS) {
    const terms = termsFor(m); const asins = await asinsFor(m)
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, searchQuery: { in: terms }, asin: { in: asins } },
      select: { impressionShare: true, clickShare: true, cartAddShare: true, purchaseShare: true, purchasesBrand: true },
    })
    const gt = (f: (r: typeof rows[number]) => unknown) => rows.filter((r) => Number(f(r)) > 0).length
    line(`${m.padEnd(8)} ${pad(rows.length, 5)}  ${pad(gt((r) => r.impressionShare), 11)}  ${pad(gt((r) => r.clickShare), 12)}  ${pad(gt((r) => r.cartAddShare), 14)}  ${pad(gt((r) => r.purchaseShare), 15)}  ${pad(gt((r) => r.purchasesBrand), 16)}`)
  }
  line()
  line('⇒ impression + click share are real series. Below that they are counts on a handful of rows.')

  h('§3.5 · spend history depth, and how far past the share it runs')
  for (const m of MARKETS) {
    const terms = termsFor(m); const c = chosen.get(m)!
    const rows = await prisma.amazonAdsSearchTerm.findMany({
      where: { marketplace: m, query: { in: terms } }, select: { query: true, date: true },
    })
    const per = new Map<string, Set<string>>()
    for (const r of rows) {
      const k = norm(r.query); const s = per.get(k) ?? new Set<string>()
      // aggregate to the SQP week so the chart's buckets line up
      const wk = new Date(+r.date - ((new Date(r.date).getUTCDay() + 6) % 7) * 86_400_000)
      s.add(d10(wk)); per.set(k, s)
    }
    const maxDate = rows.length ? new Date(Math.max(...rows.map((r) => +r.date))) : null
    line(`${m}: spend-weeks per term ${hist(terms.map((t) => per.get(t)?.size ?? 0))}`)
    line(`   share ends ${d10(c.start)} · spend runs to ${d10(maxDate)} ⇒ the chart's right edge is ${maxDate && c.start ? Math.round((+maxDate - +c.start) / 86_400_000) : '?'} days past its share`)
  }

  h('control — prove the zeros are measurements')
  line(`SQP rows ${await prisma.searchQueryPerformance.count()} · search-term rows ${await prisma.amazonAdsSearchTerm.count()} · positive targets ${at._count._all}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
