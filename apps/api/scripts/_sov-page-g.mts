/**
 * SOV.1 scoping — part G. READ-ONLY.
 *
 * Part F found IT's chosen period holds a 50.00% impression share, and a distribution full of
 * suspiciously round fractions (10.53% = 2/19, 9.52% = 2/21, 4.76% = 1/21, 9.09% = 1/11). That is
 * the signature of a TINY DENOMINATOR, not of dominance.
 *
 * If true it matters more than any column: SOV.1's natural default sort is share descending, and
 * that would rank pure noise at the top of the page. Same tail as the 0.00% defect SOV.0 fixed at
 * the formatter, seen from the other end.
 *
 * Measures the top of the share distribution against the market size that produced it, and how
 * much of each market's demand the high-share rows actually represent.
 *
 * No writes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { chooseViewPeriod } = await import('../src/services/advertising/keyword-tracker.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`
const day = (d: Date) => d.toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

console.log('\n═══ SOV.1 scoping — G: is the top of the share scale real? ═══\n')

const all = await prisma.searchQueryPerformance.findMany({
  select: { marketplace: true, startDate: true, searchQuery: true, asin: true, impressionsBrand: true, impressionsTotal: true, searchQueryVolume: true, clicksBrand: true, clicksTotal: true },
})

for (const mk of MARKETS) {
  const periods = new Map<string, number>()
  for (const r of all) if (r.marketplace === mk) periods.set(day(r.startDate), (periods.get(day(r.startDate)) ?? 0) + 1)
  const chosen = chooseViewPeriod([...periods.entries()].map(([k, rows]) => ({ start: new Date(`${k}T00:00:00.000Z`), rows })), { lookbackDays: 56 })
  if (!chosen.start) continue
  const k = day(chosen.start)
  const rows = all.filter((r) => r.marketplace === mk && day(r.startDate) === k)

  const byQuery = new Map<string, { brand: number; total: number; vol: number; asins: number; cb: number; ct: number }>()
  for (const r of rows) {
    const q = r.searchQuery.trim().toLowerCase()
    const e = byQuery.get(q) ?? { brand: 0, total: 0, vol: 0, asins: 0, cb: 0, ct: 0 }
    e.brand += r.impressionsBrand
    e.total = Math.max(e.total, r.impressionsTotal)
    e.vol = Math.max(e.vol, r.searchQueryVolume)
    e.cb += r.clicksBrand
    e.ct = Math.max(e.ct, r.clicksTotal)
    e.asins++
    byQuery.set(q, e)
  }
  const list = [...byQuery.entries()].filter(([, v]) => v.total > 0).map(([q, v]) => ({ q, ...v, share: v.brand / v.total }))

  console.log(`\n═══ ${mk} · period ${k} · ${int(list.length)} queries ═══`)
  console.log(`\n  TOP 12 BY SHARE — what a "sort by share desc" default would put on screen first:`)
  console.log(`  ${pad('query', 38)} ${pad('share', 8)} ${pad('our impr', 9)} ${pad('mkt impr', 9)} ${pad('mkt vol', 8)} asins`)
  for (const r of [...list].sort((a, b) => b.share - a.share).slice(0, 12)) {
    console.log(`  ${pad(r.q, 38)} ${pad(p2(r.share), 8)} ${pad(int(r.brand), 9)} ${pad(int(r.total), 9)} ${pad(int(r.vol), 8)} ${r.asins}`)
  }

  console.log(`\n  TOP 12 BY MARKET IMPRESSIONS — the queries that actually matter:`)
  console.log(`  ${pad('query', 38)} ${pad('share', 8)} ${pad('our impr', 9)} ${pad('mkt impr', 9)} ${pad('mkt vol', 8)} asins`)
  for (const r of [...list].sort((a, b) => b.total - a.total).slice(0, 12)) {
    console.log(`  ${pad(r.q, 38)} ${pad(p2(r.share), 8)} ${pad(int(r.brand), 9)} ${pad(int(r.total), 9)} ${pad(int(r.vol), 8)} ${r.asins}`)
  }

  // How much of the market's total demand sits in the high-share rows?
  const grand = list.reduce((a, r) => a + r.total, 0)
  for (const cut of [0.10, 0.05, 0.01]) {
    const hi = list.filter((r) => r.share > cut)
    const impr = hi.reduce((a, r) => a + r.total, 0)
    console.log(`\n  queries above ${p2(cut)} share: ${int(hi.length)} — they carry ${int(impr)} of ${int(grand)} market impressions = ${p2(impr / Math.max(1, grand))} of the demand`)
  }
  // the denominator behind the top of the scale
  const top = [...list].sort((a, b) => b.share - a.share).slice(0, 20)
  const medTotal = [...list].map((r) => r.total).sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0
  console.log(`  median market impressions across all queries: ${int(medTotal)}`)
  console.log(`  median market impressions in the TOP-20 by share: ${int([...top].map((r) => r.total).sort((a, b) => a - b)[10] ?? 0)}`)
}

await prisma.$disconnect()
console.log('\n═══ end G ═══\n')
