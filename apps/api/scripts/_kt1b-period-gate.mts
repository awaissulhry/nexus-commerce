/**
 * _kt1b-period-gate.mts — size the completeness gate before pinning its constants (read-only).
 *
 * KT.1 gave every ROW its own SQP period. That silently ranks a 26 Jul share against a 19 Jul share,
 * and 26 Jul is a truncated week (8 IT rows against 655 / 1,066 / 989 in the three before it). This
 * measures the replacement — ONE period per view, chosen by a completeness gate — across the whole
 * constant space, so the two numbers are picked from a table instead of by taste.
 *
 * Two candidate definitions of "the median row count of the surrounding periods", because they do
 * not agree and the choice changes which markets fall to the truncated-week branch:
 *   LOCAL    median over the candidate periods inside the lookback (self-referential: a truncated
 *            week drags the very baseline that is supposed to catch it)
 *   BASELINE median over the last BASELINE_PERIODS periods for that market, whatever the lookback
 *            (a stable "what a normal week looks like here")
 *
 * Also measures, for the CURRENT shipped rule, the inversion count it produces — the defect itself.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt1b-period-gate.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const age = (d: Date) => Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const RATIOS = [0.3, 0.4, 0.5, 0.6]
const LOOKBACKS = [28, 42, 56]
const BASELINE_PERIODS = 12

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  // ── the watchlist, exactly as the service builds it ──
  const sets = await prisma.keywordCoverageSet.findMany({ select: { id: true, name: true, marketplace: true, enabled: true } })
  const terms = await prisma.keywordCoverageTerm.findMany({ where: { setId: { in: sets.map((s) => s.id) } }, select: { term: true } })
  const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true } })
  const protectedTerms = [...new Set(prot.map((p) => norm(p.term)))]
  const coverage = [...new Set(terms.map((t) => norm(t.term)))]
  const watchAll = [...new Set([...coverage, ...protectedTerms])]           // 107 — branded=1
  const isBranded = (t: string) => protectedTerms.some((p) => t.includes(p))
  const watchDefault = watchAll.filter((t) => !isBranded(t))                 // 97 — the default view
  line(`watchlist: ${coverage.length} coverage + ${protectedTerms.length} protected = ${watchAll.length}; default view (branded excluded) = ${watchDefault.length}`)
  line(`sets: ${sets.map((s) => `"${s.name}" ${s.marketplace} enabled=${s.enabled}`).join(' · ')}`)

  // ── every period, per market, with its row count ──
  const periodsByMarket = new Map<string, Array<{ start: Date; rows: number }>>()
  for (const m of MARKETS) {
    const g = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' },
    })
    periodsByMarket.set(m, g.map((x) => ({ start: x.startDate, rows: x._count._all })))
  }

  h('1 · the feed, per market: every period and its row count')
  for (const m of MARKETS) {
    const ps = periodsByMarket.get(m)!
    line(`${m} (${ps.length} periods): ${ps.slice(0, 12).map((p) => `${d10(p.start)}=${p.rows}`).join(' · ')}`)
    line(`   BASELINE median (last ${BASELINE_PERIODS}) = ${median(ps.slice(0, BASELINE_PERIODS).map((p) => p.rows))}`)
  }

  h('2 · the constant space — which period does the gate select?')
  line('legend: period(rowsInPeriod, ageDays) · watchlistTermsHeld(of 97 default) · TRUNCATED = nothing qualified')
  for (const m of MARKETS) {
    const ps = periodsByMarket.get(m)!
    const baseMedian = median(ps.slice(0, BASELINE_PERIODS).map((p) => p.rows))
    line()
    line(`── ${m} · baseline median = ${baseMedian}`)
    for (const lb of LOOKBACKS) {
      const cand = ps.filter((p) => age(p.start) <= lb)
      const localMedian = median(cand.map((p) => p.rows))
      line(`  lookback ${lb}d → ${cand.length} candidate periods (${cand.map((p) => `${d10(p.start)}:${p.rows}`).join(', ') || 'none'}); LOCAL median ${localMedian}`)
      for (const ratio of RATIOS) {
        const pickBy = (med: number) => cand.find((p) => p.rows >= ratio * med) ?? null
        const L = pickBy(localMedian)
        const B = pickBy(baseMedian)
        const held = async (p: { start: Date } | null) => {
          if (!p) return '—'
          const rows = await prisma.searchQueryPerformance.findMany({
            where: { marketplace: m, startDate: p.start, searchQuery: { in: watchDefault } }, select: { searchQuery: true },
          })
          return String(new Set(rows.map((r) => norm(r.searchQuery))).size)
        }
        const hL = await held(L), hB = await held(B)
        const fmt = (p: { start: Date; rows: number } | null, hh: string) =>
          p ? `${d10(p.start)}(${p.rows}r, ${age(p.start)}d) held=${hh}` : 'TRUNCATED'
        const same = (L?.start && B?.start && +L.start === +B.start) || (!L && !B)
        line(`    ratio ${ratio}: LOCAL ${fmt(L, hL).padEnd(38)} BASELINE ${fmt(B, hB).padEnd(38)} ${same ? '' : '⚠ differ'}`)
      }
    }
  }

  // ── the defect, measured: inversions under the CURRENT shipped rule ──
  h('3 · the defect: inverted term pairs under the shipped per-row rule')

  const campaigns = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true } })
  const ads = await prisma.adProductAd.findMany({
    where: { asin: { not: null } },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })
  const asinsForCampaigns = (ids: Set<string>) =>
    [...new Set(ads.filter((a) => a.adGroup && ids.has(a.adGroup.campaignId)).map((a) => a.asin!))]

  const LOOKBACK = 56
  const since = new Date(); since.setUTCDate(since.getUTCDate() - LOOKBACK); since.setUTCHours(0, 0, 0, 0)

  async function inversionsFor(label: string, market: string, asins: string[] | null) {
    const rows = await prisma.searchQueryPerformance.findMany({
      where: {
        marketplace: market, startDate: { gte: since }, searchQuery: { in: watchDefault },
        ...(asins ? { asin: { in: asins } } : {}),
      },
      select: { searchQuery: true, asin: true, startDate: true, impressionShare: true },
    })
    // best-ASIN share per (term, period) — the row the grid renders
    const best = new Map<string, Map<number, number>>()
    for (const r of rows) {
      const t = norm(r.searchQuery)
      const per = best.get(t) ?? new Map<number, number>()
      const k = +r.startDate
      per.set(k, Math.max(per.get(k) ?? -1, Number(r.impressionShare)))
      best.set(t, per)
    }
    // the shipped rule: newest period per term
    const shipped = [...best.entries()].map(([t, per]) => {
      const newest = Math.max(...per.keys())
      return { term: t, period: newest, share: per.get(newest)! }
    })
    let inversions = 0, comparable = 0, incomparable = 0
    for (let i = 0; i < shipped.length; i++) {
      for (let j = i + 1; j < shipped.length; j++) {
        const a = shipped[i], b = shipped[j]
        if (a.period === b.period) continue
        // the newest period where BOTH have a row — the only fair comparison
        const pa = best.get(a.term)!, pb = best.get(b.term)!
        const common = [...pa.keys()].filter((k) => pb.has(k)).sort((x, y) => y - x)[0]
        if (common == null) { incomparable++; continue }
        comparable++
        const shown = Math.sign(a.share - b.share)
        const truth = Math.sign(pa.get(common)! - pb.get(common)!)
        if (shown !== 0 && truth !== 0 && shown !== truth) inversions++
      }
    }
    const periods = new Set(shipped.map((s) => s.period))
    line(`${label}: terms=${shipped.length} periods=${periods.size} (${[...periods].sort((a, b) => b - a).map((p) => d10(new Date(p))).join(', ')})`)
    line(`   cross-period pairs: comparable=${comparable} incomparable=${incomparable} → **INVERSIONS = ${inversions}**`)
    return { inversions, shipped, best }
  }

  const itAll = await inversionsFor('IT default (market scope)', 'IT', null)

  const pfGale = '182512333091276'
  const pfIds = new Set(campaigns.filter((c) => c.marketplace === 'IT' && c.portfolioId === pfGale).map((c) => c.id))
  await inversionsFor(`IT portfolio IT_Gale (${pfIds.size} campaigns)`, 'IT', asinsForCampaigns(pfIds))

  const gale = campaigns.find((c) => /Gale Jacket Yellow Only/i.test(c.name))
  if (gale) {
    await inversionsFor(`IT campaign "${gale.name}"`, 'IT', asinsForCampaigns(new Set([gale.id])))
    line(`   (campaign id ${gale.id}, status=${gale.status})`)
  } else {
    line('⚠ campaign "Gale Jacket Yellow Only" NOT FOUND — candidates:')
    for (const c of campaigns.filter((c) => /yellow/i.test(c.name))) line(`   "${c.name}" ${c.marketplace} ${c.status}`)
  }

  h('4 · the two terms the prompt names, verbatim from the feed')
  for (const t of ['giubbotto moto', 'pantaloni moto uomo estivi']) {
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', searchQuery: t, startDate: { gte: since } },
      select: { startDate: true, asin: true, impressionShare: true, searchQueryVolume: true },
      orderBy: { startDate: 'desc' },
    })
    const byP = new Map<string, typeof rows>()
    for (const r of rows) { const k = d10(r.startDate); const a = byP.get(k) ?? []; a.push(r); byP.set(k, a) }
    line(`"${t}":`)
    for (const [p, rs] of byP) {
      const b = Math.max(...rs.map((r) => Number(r.impressionShare)))
      line(`   ${p}  best share ${(b * 100).toFixed(2)}%  our ASIN rows ${rs.length}  volume ${rs[0].searchQueryVolume}`)
    }
  }
  // its rank in the shipped grid vs on a common week
  const sh = itAll.shipped.slice().sort((a, b) => b.share - a.share)
  const rankShipped = sh.findIndex((s) => s.term === 'giubbotto moto') + 1
  const commonWeek = [...itAll.best.get('giubbotto moto')!.keys()].sort((a, b) => b - a).find((k) => k !== Math.max(...itAll.best.get('giubbotto moto')!.keys()))
  const onCommon = [...itAll.best.entries()].filter(([, per]) => per.has(commonWeek!)).map(([t, per]) => ({ t, s: per.get(commonWeek!)! })).sort((a, b) => b.s - a.s)
  line(`"giubbotto moto" renders at share-rank #${rankShipped} of ${sh.length} today; on ${d10(new Date(commonWeek!))} it is #${onCommon.findIndex((x) => x.t === 'giubbotto moto') + 1} of ${onCommon.length}`)

  h('5 · consequence for NARROW scopes: does a market-level chosen period leave them rows?')
  for (const [label, ids] of [
    ['portfolio IT_Gale', pfIds],
    ...(gale ? [[`campaign ${gale.name}`, new Set([gale.id])] as [string, Set<string>]] : []),
  ] as Array<[string, Set<string>]>) {
    const asins = asinsForCampaigns(ids)
    const ps = periodsByMarket.get('IT')!
    for (const p of ps.slice(0, 4)) {
      const rows = await prisma.searchQueryPerformance.findMany({
        where: { marketplace: 'IT', startDate: p.start, searchQuery: { in: watchDefault }, asin: { in: asins } },
        select: { searchQuery: true },
      })
      line(`  ${label.padEnd(34)} ${d10(p.start)} → ${new Set(rows.map((r) => norm(r.searchQuery))).size} of 97 terms`)
    }
  }

  h('6 · §5 checks: archived campaigns, and reportPeriod')
  const byStatus = await prisma.campaign.groupBy({ by: ['status', 'marketplace'], _count: { _all: true } })
  for (const m of MARKETS) {
    const rows = byStatus.filter((b) => b.marketplace === m)
    line(`${m}: ${rows.map((r) => `${r.status}=${r._count._all}`).join(' · ')}`)
  }
  const rp = await prisma.searchQueryPerformance.groupBy({ by: ['reportPeriod'], _count: { _all: true } })
  line(`reportPeriod across the whole table: ${rp.map((r) => `${r.reportPeriod}=${r._count._all}`).join(' · ')}`)
  // control for the .catch(()=>[]) trap: prove a zero is a zero by asking a question with a known answer
  const sanity = await prisma.searchQueryPerformance.count({ where: { marketplace: 'IT', searchQuery: { in: watchDefault } } })
  line(`control — IT watchlist rows all-time: ${sanity} (a 0 here would mean the query, not the data, is wrong)`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
