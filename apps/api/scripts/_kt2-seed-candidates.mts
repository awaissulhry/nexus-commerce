/**
 * _kt2-seed-candidates.mts — what a per-market watchlist could be seeded FROM (read-only).
 *
 * KT.2's rule is "measure before you choose, and don't write 7,799 terms". This counts every
 * candidate source per market, shows how they overlap, and prices the choice — a tracker over ~100
 * chosen terms is a product, over 7,799 it is a bill.
 *
 * It also settles §4.4: the branded flag is currently a blanket `term.includes(protected)` sweep.
 * `AdKeywordProtection` carries `matchType` (EXACT | PREFIX | CONTAINS) and a nullable
 * `marketplace`, and neither is honoured. This measures what changes when they are.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt2-seed-candidates.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 68 - s.length))}`) }
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const pad = (s: string | number, n: number) => String(s).padStart(n)

async function main() {
  // ── A · what we BID on: positive KEYWORD targets, per market ──
  const targets = await prisma.adTarget.findMany({
    where: { isNegative: false, expressionType: { in: ['EXACT', 'PHRASE', 'BROAD'] } },
    select: {
      expressionValue: true, expressionType: true, status: true, bidCents: true,
      adGroup: { select: { campaign: { select: { marketplace: true, status: true } } } },
    },
  })
  const bidByMarket = new Map<string, Map<string, { enabled: number; total: number }>>()
  for (const t of targets) {
    const m = t.adGroup?.campaign?.marketplace
    if (!m) continue
    const k = norm(t.expressionValue)
    const per = bidByMarket.get(m) ?? new Map()
    const cur = per.get(k) ?? { enabled: 0, total: 0 }
    cur.total += 1
    if (String(t.status) === 'ENABLED') cur.enabled += 1
    per.set(k, cur); bidByMarket.set(m, per)
  }

  // ── B · SQP queries with a row in the last 90 days, per market, by volume band ──
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 90); since.setUTCHours(0, 0, 0, 0)
  const sqp = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace', 'searchQuery'],
    where: { startDate: { gte: since } },
    _max: { searchQueryVolume: true, startDate: true },
  })
  const sqpByMarket = new Map<string, Array<{ q: string; vol: number }>>()
  for (const r of sqp) {
    const a = sqpByMarket.get(r.marketplace) ?? []
    a.push({ q: norm(r.searchQuery), vol: r._max.searchQueryVolume ?? 0 })
    sqpByMarket.set(r.marketplace, a)
  }

  // ── C · queries we PAID on in the last 30 days, per market ──
  const since30 = new Date(); since30.setUTCDate(since30.getUTCDate() - 30); since30.setUTCHours(0, 0, 0, 0)
  const paid = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['marketplace', 'query'],
    where: { date: { gte: since30 } },
    _sum: { costMicros: true, clicks: true },
  })
  const paidByMarket = new Map<string, Array<{ q: string; eur: number; clicks: number }>>()
  for (const r of paid) {
    const a = paidByMarket.get(r.marketplace) ?? []
    a.push({ q: norm(r.query), eur: Number(r._sum.costMicros ?? 0n) / 1_000_000, clicks: r._sum.clicks ?? 0 })
    paidByMarket.set(r.marketplace, a)
  }

  // ── D · the existing coverage set (import source only) ──
  const sets = await prisma.keywordCoverageSet.findMany({ select: { id: true, name: true, marketplace: true, enabled: true } })
  const coverage = new Map<string, string[]>()
  for (const s of sets) {
    const t = await prisma.keywordCoverageTerm.findMany({ where: { setId: s.id }, select: { term: true } })
    coverage.set(s.marketplace, t.map((x) => norm(x.term)))
  }

  // ── E · protections, WITH their matchType and marketplace ──
  const prot = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' },
    select: { term: true, matchType: true, isPrefix: true, marketplace: true },
  })

  h('the candidate sources, per market')
  line('market   bid keywords (enabled)   SQP 90d   SQP vol≥500   SQP vol≥100   paid 30d (with spend)   coverage set')
  for (const m of MARKETS) {
    const bid = bidByMarket.get(m) ?? new Map()
    const bidEnabled = [...bid.values()].filter((v) => v.enabled > 0).length
    const s = sqpByMarket.get(m) ?? []
    const p = paidByMarket.get(m) ?? []
    const paidSpending = p.filter((x) => x.eur > 0).length
    line(`${m.padEnd(8)} ${pad(bid.size, 8)} (${pad(bidEnabled, 4)})       ${pad(s.length, 6)}     ${pad(s.filter((x) => x.vol >= 500).length, 6)}        ${pad(s.filter((x) => x.vol >= 100).length, 6)}        ${pad(p.length, 6)} (${pad(paidSpending, 5)})          ${pad((coverage.get(m) ?? []).length, 5)}`)
  }

  h('overlap: do the sources agree on what matters? (per market)')
  for (const m of MARKETS) {
    const bid = new Set([...(bidByMarket.get(m) ?? new Map()).keys()])
    const sqpSet = new Set((sqpByMarket.get(m) ?? []).map((x) => x.q))
    const paidSet = new Set((paidByMarket.get(m) ?? []).filter((x) => x.eur > 0).map((x) => x.q))
    const inter = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length
    line(`${m}: bid=${bid.size} sqp90=${sqpSet.size} paid30=${paidSet.size}`)
    line(`   bid ∩ sqp = ${inter(bid, sqpSet)}   ·   bid ∩ paid = ${inter(bid, paidSet)}   ·   paid ∩ sqp = ${inter(paidSet, sqpSet)}`)
    line(`   bid with NO sqp row at all = ${[...bid].filter((x) => !sqpSet.has(x)).length}   ·   paid with no sqp row = ${[...paidSet].filter((x) => !sqpSet.has(x)).length}`)
  }

  h('🔴 the proposal, priced: "terms we bid on that SQP can actually measure", per market')
  line('This is the intersection that makes a tracker row possible: we chose to bid on it, AND Brand')
  line('Analytics reports it, so the row can carry volume, rank and share. Plus the paid-but-unmeasured')
  line('count, which is what such a list would NOT cover.')
  line()
  line('market   proposed seed   (of which enabled)   paid-but-SQP-blind   whole-SQP alternative')
  const proposal = new Map<string, string[]>()
  for (const m of MARKETS) {
    const bid = bidByMarket.get(m) ?? new Map()
    const sqpSet = new Set((sqpByMarket.get(m) ?? []).map((x) => x.q))
    const seed = [...bid.entries()].filter(([q]) => sqpSet.has(q))
    const paidSet = new Set((paidByMarket.get(m) ?? []).filter((x) => x.eur > 0).map((x) => x.q))
    proposal.set(m, seed.map(([q]) => q))
    line(`${m.padEnd(8)} ${pad(seed.length, 8)}       ${pad(seed.filter(([, v]) => v.enabled > 0).length, 10)}        ${pad([...paidSet].filter((x) => !sqpSet.has(x)).length, 8)}             ${pad(sqpSet.size, 8)}`)
  }
  line()
  line('IT keeps the 97 curated coverage terms (copied) — a hand-made list beats a derived one where')
  line('one exists. The other three markets have none, which is the whole defect.')
  for (const m of MARKETS) {
    const seed = proposal.get(m) ?? []
    const cov = coverage.get(m) ?? []
    const chosen = cov.length ? cov : seed
    line(`   ${m}: would seed ${chosen.length} terms from ${cov.length ? 'the existing coverage set (copied)' : 'bid ∩ SQP'}`)
    line(`      e.g. ${chosen.slice(0, 6).join(' · ')}`)
  }

  h('§4.4 · branded: the blanket sweep vs matchType + marketplace')
  line(`protections (${prot.length}):`)
  for (const p of prot) line(`   "${p.term}" matchType=${p.matchType ?? `(null → isPrefix=${p.isPrefix})`} marketplace=${p.marketplace ?? 'ALL'}`)
  const blanket = (t: string) => prot.some((p) => t.includes(norm(p.term)))
  /** What §4.4 asks for: honour matchType AND the nullable marketplace. */
  const honoured = (t: string, market: string) => prot.some((p) => {
    if (p.marketplace && p.marketplace !== market) return false
    const needle = norm(p.term)
    const mt = (p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')).toUpperCase()
    return mt === 'EXACT' ? t === needle : mt === 'PREFIX' ? t.startsWith(needle) : t.includes(needle)
  })
  line()
  line('market   list size   branded (blanket)   branded (matchType+market)   differ')
  for (const m of MARKETS) {
    const cov = coverage.get(m) ?? []
    const chosen = cov.length ? cov : (proposal.get(m) ?? [])
    const b = chosen.filter(blanket)
    const hh = chosen.filter((t) => honoured(t, m))
    const diff = [...new Set([...b.filter((x) => !hh.includes(x)), ...hh.filter((x) => !b.includes(x))])]
    line(`${m.padEnd(8)} ${pad(chosen.length, 8)}    ${pad(b.length, 10)}          ${pad(hh.length, 14)}        ${pad(diff.length, 6)} ${diff.length ? `→ ${diff.slice(0, 5).join(', ')}` : ''}`)
  }
  line()
  line('...and on the 10 protected terms themselves, which the page also watches:')
  for (const m of ['IT'] as const) {
    for (const p of prot) {
      const t = norm(p.term)
      line(`   "${t}" in ${m}: blanket=${blanket(t)} honoured=${honoured(t, m)}`)
    }
  }

  h('control — a query with a known non-zero answer, to prove the queries are wired')
  line(`AdTarget positive rows scanned: ${targets.length} (0 here would mean the filter, not the data, is wrong)`)
  line(`SQP query×market pairs in 90d: ${sqp.length} · paid query×market pairs in 30d: ${paid.length}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
