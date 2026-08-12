/**
 * HV.3a (2) — the same question, with the contamination removed and a sharper instrument.
 * READ-ONLY, ZERO QUOTA.
 *
 * Run 1 found the late-observed group is not clean: some gapfilled cells carry ZERO clicks where
 * the search-term feed has hundreds (the gap was "healed" by writing an empty day), one carries
 * **−1 clicks**, and a cluster of June IT dates shows a daily-performance/search-term click ratio
 * of ~2.0 rather than the ~1.2 every other cell shows. A ratio-of-ratios computed over that is not
 * evidence of anything.
 *
 * Two things here:
 *
 *   1. the same comparison, restricted to cells where BOTH feeds plausibly measured the same day
 *   2. 🔴 the sharper instrument, if the column is populated: `sales1dCents` vs `sales7dCents` on
 *      the SAME row. On a row observed at D+1 only ~1 day of the 7-day window has elapsed, so the
 *      two should be near-equal. On a row observed at D+14 the window has fully closed, so
 *      `sales7d / sales1d` IS the maturation factor, measured inside one table with no join and no
 *      quota.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date) => d.toISOString().slice(0, 10)
const H = 3_600_000

console.log('\n═══ HV.3a (2) — cleaned comparison + the 1d/7d instrument ═══\n')

// ── 1 · is sales1dCents populated at all? ─────────────────────────────────────
console.log('═══ 1 · the sharper instrument: is sales1dCents written? ═══\n')
const s1 = await prisma.$queryRaw<Array<{ rows: bigint; nonzero1d: bigint; nonzero7d: bigint }>>`
  SELECT COUNT(*)::bigint AS rows,
         COUNT(*) FILTER (WHERE COALESCE("sales1dCents",0) <> 0)::bigint AS nonzero1d,
         COUNT(*) FILTER (WHERE COALESCE("sales7dCents",0) <> 0)::bigint AS nonzero7d
  FROM "AmazonAdsDailyPerformance" WHERE "adProduct" = 'SPONSORED_PRODUCTS'`
console.log(`SP daily-performance rows: ${int(Number(s1[0].rows))} · with sales1dCents ≠ 0: ${int(Number(s1[0].nonzero1d))} · with sales7dCents ≠ 0: ${int(Number(s1[0].nonzero7d))}`)
if (Number(s1[0].nonzero1d) === 0) {
  console.log('🔴 sales1dCents is NEVER written — the upsert at ads-reports.service.ts:585/595 sets')
  console.log('   sales7dCents and sales14dCents only. The 1d/7d instrument is unavailable, and the')
  console.log('   column is dead weight on 42k rows. Recorded, not fixed.')
}
// sales14d is written — 14d vs 7d on a matured row is the same idea one window wider
const s14 = await prisma.$queryRaw<Array<{ rows: bigint; nz: bigint }>>`
  SELECT COUNT(*)::bigint AS rows, COUNT(*) FILTER (WHERE COALESCE("sales14dCents",0) <> 0)::bigint AS nz
  FROM "AmazonAdsDailyPerformance" WHERE "adProduct" = 'SPONSORED_PRODUCTS'`
console.log(`   sales14dCents ≠ 0 on ${int(Number(s14[0].nz))} rows`)

// ── 2 · 🔴 sales14d vs sales7d, by how mature the row is ──────────────────────
// A row observed at D+1 cannot know its 14-day sales; a row observed at D+14 can. If attribution
// accrues materially after the first day, the 14d/7d ratio must be larger on mature rows.
console.log('\n\n═══ 2 · sales14d ÷ sales7d, by observation maturity ═══\n')
const mat = await prisma.$queryRaw<Array<{ bucket: string; rows: bigint; s7: bigint; s14: bigint; ord: bigint; clk: bigint }>>`
  SELECT CASE
           WHEN EXTRACT(EPOCH FROM ("reportedAt" - date))/86400 < 3  THEN 'a. observed < 3d'
           WHEN EXTRACT(EPOCH FROM ("reportedAt" - date))/86400 < 8  THEN 'b. observed 3-8d'
           ELSE 'c. observed > 8d'
         END AS bucket,
         COUNT(*)::bigint AS rows,
         SUM(COALESCE("sales7dCents",0))::bigint  AS s7,
         SUM(COALESCE("sales14dCents",0))::bigint AS s14,
         SUM(COALESCE("orders7d",0))::bigint AS ord,
         SUM(clicks)::bigint AS clk
  FROM "AmazonAdsDailyPerformance"
  WHERE "adProduct" = 'SPONSORED_PRODUCTS' AND "entityType" = 'CAMPAIGN' AND clicks > 0
  GROUP BY 1 ORDER BY 1`
console.log(`${pad('maturity', 20)} ${pad('rows', 7)} ${pad('clicks', 8)} ${pad('orders', 7)} ${pad('sales7d', 12)} ${pad('sales14d', 12)} 14d/7d`)
for (const r of mat) {
  const s7 = Number(r.s7), s14 = Number(r.s14)
  console.log(`${pad(r.bucket, 20)} ${pad(int(Number(r.rows)), 7)} ${pad(int(Number(r.clk)), 8)} ${pad(int(Number(r.ord)), 7)} ${pad(`€${(s7 / 100).toFixed(2)}`, 12)} ${pad(`€${(s14 / 100).toFixed(2)}`, 12)} ${s7 > 0 ? (s14 / s7).toFixed(3) : '—'}`)
}
console.log('\n⇒ if 14d/7d is ~1.000 on rows observed late, the 7-day window was already closed when')
console.log('  we read it, and a D+1 read loses little. If it is materially > 1, attribution keeps')
console.log('  accruing and the D+1 snapshot is genuinely short.')

// ── 3 · the cleaned cross-feed comparison ─────────────────────────────────────
console.log('\n\n═══ 3 · the cross-feed comparison, contamination removed ═══\n')
const dp = await prisma.$queryRaw<Array<{ d: Date; mkt: string; lastSeen: Date; ord: bigint; clk: bigint }>>`
  SELECT date AS d, marketplace AS mkt, MAX("reportedAt") AS "lastSeen",
         SUM(COALESCE("orders7d",0))::bigint AS ord, SUM(clicks)::bigint AS clk
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN' AND "adProduct" = 'SPONSORED_PRODUCTS'
  GROUP BY date, marketplace`
const st = await prisma.$queryRaw<Array<{ d: Date; mkt: string; ord: bigint; clk: bigint }>>`
  SELECT date AS d, marketplace AS mkt, SUM(COALESCE("orders7d",0))::bigint AS ord, SUM(clicks)::bigint AS clk
  FROM "AmazonAdsSearchTerm" WHERE "adProduct" = 'SPONSORED_PRODUCTS'
  GROUP BY date, marketplace`
const stK = new Map(st.map((r) => [`${day(r.d)}|${r.mkt}`, r]))

interface C { d: Date; mkt: string; matureD: number; dpO: number; stO: number; dpC: number; stC: number; cr: number }
const cells: C[] = []
for (const r of dp) {
  const s = stK.get(`${day(r.d)}|${r.mkt}`); if (!s) continue
  const dpC = Number(r.clk), stC = Number(s.clk)
  if (dpC <= 0 || stC <= 0) continue                       // the gapfill wrote an empty day, or worse
  const cr = dpC / stC
  cells.push({ d: r.d, mkt: r.mkt, matureD: (r.lastSeen.getTime() - r.d.getTime()) / H / 24, dpO: Number(r.ord), stO: Number(s.ord), dpC, stC, cr })
}
// A plausible cell is one where the two feeds saw comparable traffic. The ~1.2 click ratio is the
// normal coverage gap; anything near 2.0 or near 0 is a different defect, not a maturity signal.
const plausible = cells.filter((c) => c.cr >= 0.7 && c.cr <= 1.6)
console.log(`joined cells: ${cells.length} · with a plausible click ratio (0.7–1.6): ${plausible.length} · discarded: ${cells.length - plausible.length}`)
const disc = cells.filter((c) => !(c.cr >= 0.7 && c.cr <= 1.6))
console.log(`  discarded click ratios: ${disc.slice(0, 12).map((c) => `${day(c.d)}/${c.mkt}=${c.cr.toFixed(2)}`).join(' · ')}${disc.length > 12 ? ' …' : ''}`)

const summarise = (rows: C[], label: string) => {
  const dpO = rows.reduce((a, r) => a + r.dpO, 0), stO = rows.reduce((a, r) => a + r.stO, 0)
  const dpC = rows.reduce((a, r) => a + r.dpC, 0), stC = rows.reduce((a, r) => a + r.stC, 0)
  const oR = stO > 0 ? dpO / stO : NaN, cR = stC > 0 ? dpC / stC : NaN
  console.log(`${pad(label, 34)} cells ${pad(String(rows.length), 4)} dpOrd ${pad(int(dpO), 5)} stOrd ${pad(int(stO), 5)} ordersRatio ${pad(Number.isNaN(oR) ? '—' : oR.toFixed(3), 7)} clicksRatio ${pad(cR.toFixed(3), 7)} normalised ${(oR / cR).toFixed(3)}`)
  return { oR, cR, norm: oR / cR, n: rows.length }
}
console.log('')
const onT = summarise(plausible.filter((c) => c.matureD <= 3), 'daily-perf observed ≤ 3d (immature)')
const lateG = summarise(plausible.filter((c) => c.matureD > 3), 'daily-perf observed > 3d (MATURE)')
if (!Number.isNaN(onT.norm) && !Number.isNaN(lateG.norm)) {
  const lift = ((lateG.norm / onT.norm) - 1) * 100
  console.log(`\n🔴 normalised orders lift in the MATURE group: ${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%   (n=${lateG.n} vs ${onT.n} cells)`)
  console.log('   "normalised" divides the orders ratio by the clicks ratio, so a coverage difference')
  console.log('   between the two feeds cancels and only the attribution difference remains.')
}

// ── 4 · what it would mean for the page ───────────────────────────────────────
console.log('\n\n═══ 4 · the only number that decides anything ═══\n')
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const p = await getKeywordHarvest({ market: 'all' })
console.log(`candidates at the shipped criteria today: ${p.census.candidates}`)
console.log(`attrition: ${p.attrition.steps.map((s) => `${s.label} −${s.removed}`).join(' · ')}`)
console.log('')
console.log('If attribution were uplifted by a factor F, every term\'s orders would scale by ~F and the')
console.log('minOrders threshold would admit more terms. The table below is what the candidate count')
console.log('would become if today\'s orders were multiplied by F — the sensitivity of the page to the')
console.log('very effect HV.2a claimed:')
for (const F of [1.0, 1.1, 1.25, 1.5, 2.0]) {
  // simulate by lowering the threshold proportionally: orders*F >= 2  <=>  orders >= 2/F
  const eff = Math.max(1, Math.ceil(2 / F))
  const q = await getKeywordHarvest({ market: 'all', minOrders: eff })
  console.log(`  uplift ×${F.toFixed(2)}  ⇒ effective threshold ${eff}+ orders  ⇒ ${q.census.candidates} candidates (today: ${p.census.candidates})`)
}

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
