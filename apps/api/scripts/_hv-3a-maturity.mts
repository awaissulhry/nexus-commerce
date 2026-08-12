/**
 * HV.3a — is `orders7d` materially truncated by the D+1 snapshot? READ-ONLY, ZERO QUOTA.
 *
 * ── 🔴 Why this does not do what the brief asked ──────────────────────────────────────────────
 *
 * The brief's experiment (re-request 3–5 past dates and diff) **cannot be run safely.** The stop
 * condition it names is met:
 *
 *   · `AmazonAdsSearchTerm` has **NO unique constraint** — three plain indexes and nothing else.
 *   · `ingestSearchTermRows` (`ads-reports.service.ts:611`) is `createMany`, i.e. INSERT, and its
 *     only idempotence is `deleteMany({ where: { reportRunId: job.id } })` — scoped to ONE job id.
 *     Its own comment says so: *"clearing by reportRunId avoids needing a composite unique
 *     constraint."*
 *   · A re-request creates a NEW job with a NEW id, so that delete matches nothing and the insert
 *     lands a second full copy of every row for the date.
 *
 * Every consumer (`previewHarvest`, `keyword-harvest.service.ts`, the evaluator) reads through
 * `groupBy` + `_sum`, so duplicated rows would **double** clicks, spend, orders and sales for the
 * re-requested dates — silently, permanently, and with nothing anywhere to dedupe them.
 *
 * ── The natural experiment production has already run, for free ───────────────────────────────
 *
 * `AmazonAdsDailyPerformance` is **upserted** on `(profileId, adProduct, entityType, entityId,
 * date)`, and the upsert sets `reportedAt: new Date()` while leaving `createdAt` at first write.
 * So **`reportedAt − date` is the maturity of the number currently stored**, and
 * `reportedAt > createdAt` means the row was re-observed.
 *
 * And `ads-report-gapfill` re-requests **daily performance only** — never search terms
 * (`findPerformanceGaps` reads daily-performance rows; the service imports only CAMPAIGN and
 * ADVERTISED_PRODUCT report types). It re-requested Italy's 2026-07-28 → 08-04 outage days *late*.
 *
 * That gives a controlled within-account comparison at zero quota cost:
 *
 *   ratio(date) = daily-performance orders ÷ search-term orders
 *
 *   · on a normally-ingested date both feeds are frozen at D+1 → the ratio reflects only the
 *     grain/coverage difference between the two tables
 *   · on a late-observed date the daily-performance number is MATURE while the search-term number
 *     is still D+1 → if maturation matters, the ratio must rise
 *
 * A flat ratio across both groups is positive evidence that D+1 is already close to final.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date) => d.toISOString().slice(0, 10)
const H = 3_600_000

console.log('\n═══ HV.3a — is orders7d materially truncated? (zero quota) ═══\n')

// ── 0 · the stop condition, restated from the schema itself ───────────────────
console.log('═══ 0 · why the re-request experiment is refused ═══\n')
const dupCheck = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM (
    SELECT "profileId", date, "campaignId", "adGroupId", query, "matchType", COUNT(*) AS c
    FROM "AmazonAdsSearchTerm" GROUP BY 1,2,3,4,5,6 HAVING COUNT(*) > 1
  ) t`
console.log(`AmazonAdsSearchTerm natural-key groups already holding >1 row: ${int(Number(dupCheck[0].n))}`)
const runsPerDate = await prisma.$queryRaw<Array<{ d: Date; runs: bigint; rows: bigint }>>`
  SELECT date AS d, COUNT(DISTINCT "reportRunId")::bigint AS runs, COUNT(*)::bigint AS rows
  FROM "AmazonAdsSearchTerm" GROUP BY date HAVING COUNT(DISTINCT "reportRunId") > 2
  ORDER BY date DESC LIMIT 10`
console.log(`dates whose rows come from more than 2 report runs (SP+SB is 2, so >2 = re-ingested): ${runsPerDate.length}`)
for (const r of runsPerDate) console.log(`   ${day(r.d)}  runs=${r.runs}  rows=${int(Number(r.rows))}`)
console.log('⇒ a re-request would ADD a third copy, not replace the first two.')

// ── 1 · search-term maturity: frozen at D+1, never revisited ──────────────────
console.log('\n\n═══ 1 · search-term ingest lag, all time ═══\n')
const stLag = await prisma.$queryRaw<Array<{ d: Date; first: Date; last: Date; n: bigint }>>`
  SELECT date AS d, MIN("createdAt") AS first, MAX("createdAt") AS last, COUNT(*)::bigint AS n
  FROM "AmazonAdsSearchTerm" GROUP BY date ORDER BY date DESC`
const lags = stLag.map((r) => (r.first.getTime() - r.d.getTime()) / H)
const spans = stLag.map((r) => (r.last.getTime() - r.first.getTime()) / H)
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)]
console.log(`dates held: ${stLag.length}`)
console.log(`  first-write lag (h)  min ${Math.min(...lags).toFixed(1)} · p50 ${q(lags, .5).toFixed(1)} · p90 ${q(lags, .9).toFixed(1)} · max ${Math.max(...lags).toFixed(1)}`)
console.log(`  write span   (h)     min ${Math.min(...spans).toFixed(1)} · p50 ${q(spans, .5).toFixed(1)} · max ${Math.max(...spans).toFixed(1)}   (0 = the date was written once and never revisited)`)
const revisited = stLag.filter((r) => (r.last.getTime() - r.first.getTime()) / H > 2)
console.log(`  dates written over a span > 2h: ${revisited.length}${revisited.length ? ` → ${revisited.slice(0, 5).map((r) => day(r.d)).join(', ')}` : ''}`)

// ── 2 · daily-performance maturity — find the late-observed dates ─────────────
console.log('\n\n═══ 2 · daily performance: which dates were RE-observed, and how late? ═══\n')
const dpLag = await prisma.$queryRaw<Array<{ d: Date; mkt: string; firstSeen: Date; lastSeen: Date; rows: bigint; orders: bigint; clicks: bigint }>>`
  SELECT date AS d, marketplace AS mkt,
         MIN("createdAt") AS "firstSeen", MAX("reportedAt") AS "lastSeen",
         COUNT(*)::bigint AS rows, SUM("orders7d")::bigint AS orders, SUM(clicks)::bigint AS clicks
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN' AND "adProduct" = 'SPONSORED_PRODUCTS'
  GROUP BY date, marketplace ORDER BY date DESC`
const LATE_H = 72
const late = dpLag.filter((r) => (r.lastSeen.getTime() - r.d.getTime()) / H > LATE_H)
console.log(`(date × market) cells: ${dpLag.length} · observed more than ${LATE_H}h after the date: ${late.length}`)
console.log(`\n${pad('date', 12)} ${pad('mkt', 4)} ${pad('firstSeen lag', 14)} ${pad('lastSeen lag', 13)} ${pad('clicks', 8)} orders`)
for (const r of late.slice(0, 20)) {
  console.log(`${pad(day(r.d), 12)} ${pad(r.mkt, 4)} ${pad(`${((r.firstSeen.getTime() - r.d.getTime()) / H / 24).toFixed(1)}d`, 14)} ${pad(`${((r.lastSeen.getTime() - r.d.getTime()) / H / 24).toFixed(1)}d`, 13)} ${pad(int(Number(r.clicks)), 8)} ${r.orders}`)
}
if (!late.length) console.log('  (none — every daily-performance cell was observed once, at D+1)')

// ── 3 · 🔴 the comparison ─────────────────────────────────────────────────────
console.log('\n\n═══ 3 · the controlled comparison ═══\n')
const stByDateMkt = await prisma.$queryRaw<Array<{ d: Date; mkt: string; orders: bigint; clicks: bigint }>>`
  SELECT date AS d, marketplace AS mkt, SUM("orders7d")::bigint AS orders, SUM(clicks)::bigint AS clicks
  FROM "AmazonAdsSearchTerm" WHERE "adProduct" = 'SPONSORED_PRODUCTS'
  GROUP BY date, marketplace`
const stKey = new Map(stByDateMkt.map((r) => [`${day(r.d)}|${r.mkt}`, r]))

interface Row { key: string; d: Date; mkt: string; dpOrders: number; stOrders: number; dpClicks: number; stClicks: number; matureH: number }
const joined: Row[] = []
for (const r of dpLag) {
  const s = stKey.get(`${day(r.d)}|${r.mkt}`)
  if (!s) continue
  joined.push({
    key: `${day(r.d)}|${r.mkt}`, d: r.d, mkt: r.mkt,
    dpOrders: Number(r.orders), stOrders: Number(s.orders),
    dpClicks: Number(r.clicks), stClicks: Number(s.clicks),
    matureH: (r.lastSeen.getTime() - r.d.getTime()) / H,
  })
}
const group = (rows: Row[], label: string) => {
  const dpO = rows.reduce((a, r) => a + r.dpOrders, 0)
  const stO = rows.reduce((a, r) => a + r.stOrders, 0)
  const dpC = rows.reduce((a, r) => a + r.dpClicks, 0)
  const stC = rows.reduce((a, r) => a + r.stClicks, 0)
  console.log(`${pad(label, 40)} cells ${pad(String(rows.length), 5)} dpOrders ${pad(int(dpO), 6)} stOrders ${pad(int(stO), 6)} ratio ${stO > 0 ? (dpO / stO).toFixed(3) : '—'}   (dpClicks ${int(dpC)} / stClicks ${int(stC)} = ${stC > 0 ? (dpC / stC).toFixed(3) : '—'})`)
  return { cells: rows.length, dpO, stO, ratio: stO > 0 ? dpO / stO : NaN }
}
console.log('Both feeds cover the same (date × market). Search terms are ALWAYS D+1. Daily performance')
console.log('is D+1 except where gapfill re-observed it later. If maturation matters, the late group')
console.log('must show a HIGHER orders ratio than the on-time group.\n')
const onTime = joined.filter((r) => r.matureH <= LATE_H)
const lateJ = joined.filter((r) => r.matureH > LATE_H)
const a = group(onTime, 'observed at D+1 (both immature)')
const b = group(lateJ, `re-observed later than ${LATE_H}h (dp MATURE)`)
if (!Number.isNaN(a.ratio) && !Number.isNaN(b.ratio)) {
  const lift = ((b.ratio / a.ratio) - 1) * 100
  console.log(`\n🔴 orders-ratio lift in the late-observed group: ${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%`)
  console.log(`   A clicks ratio near 1.000 in BOTH groups is the control: clicks do not mature, so if the`)
  console.log(`   clicks ratio matches and only the orders ratio moves, the movement IS attribution maturing.`)
}

// per-date detail for the late group
if (lateJ.length) {
  console.log(`\n${pad('date', 12)} ${pad('mkt', 4)} ${pad('mature', 8)} ${pad('dpOrd', 6)} ${pad('stOrd', 6)} ${pad('ratio', 7)} ${pad('dpClk', 7)} ${pad('stClk', 7)} clickRatio`)
  for (const r of lateJ.sort((x, y) => y.matureH - x.matureH).slice(0, 25)) {
    console.log(`${pad(day(r.d), 12)} ${pad(r.mkt, 4)} ${pad(`${(r.matureH / 24).toFixed(1)}d`, 8)} ${pad(String(r.dpOrders), 6)} ${pad(String(r.stOrders), 6)} ${pad(r.stOrders ? (r.dpOrders / r.stOrders).toFixed(2) : '—', 7)} ${pad(int(r.dpClicks), 7)} ${pad(int(r.stClicks), 7)} ${r.stClicks ? (r.dpClicks / r.stClicks).toFixed(2) : '—'}`)
  }
}

// ── 4 · the CVR gradient, with the confidence the counts actually support ─────
console.log('\n\n═══ 4 · the CVR gradient, with binomial bounds ═══\n')
console.log('HV.2a read a gradient as evidence of truncation. The brief corrected that: the lag is')
console.log('identical in every bucket, so a maturation artefact would render CVR FLAT. Here are the')
console.log('bounds the order counts actually support.\n')
const buckets: Array<[number, number, string]> = [[0, 3, '0–2 d'], [3, 8, '3–7 d'], [8, 15, '8–14 d'], [15, 31, '15–30 d'], [31, 41, '31–40 d']]
const now = Date.now()
const stAll = await prisma.$queryRaw<Array<{ d: Date; clicks: bigint; orders: bigint }>>`
  SELECT date AS d, SUM(clicks)::bigint AS clicks, SUM("orders7d")::bigint AS orders
  FROM "AmazonAdsSearchTerm" GROUP BY date`
console.log(`${pad('age', 10)} ${pad('clicks', 8)} ${pad('orders', 7)} ${pad('CVR', 8)} 95% CI (Wilson)`)
for (const [lo, hi, label] of buckets) {
  const rows = stAll.filter((r) => { const age = (now - r.d.getTime()) / 86_400_000; return age >= lo && age < hi })
  const c = rows.reduce((s, r) => s + Number(r.clicks), 0)
  const o = rows.reduce((s, r) => s + Number(r.orders), 0)
  if (!c) { console.log(`${pad(label, 10)} (no clicks)`); continue }
  const p = o / c, z = 1.96, d2 = 1 + z * z / c
  const centre = (p + z * z / (2 * c)) / d2
  const half = (z * Math.sqrt(p * (1 - p) / c + z * z / (4 * c * c))) / d2
  console.log(`${pad(label, 10)} ${pad(int(c), 8)} ${pad(int(o), 7)} ${pad(`${(p * 100).toFixed(2)}%`, 8)} ${((centre - half) * 100).toFixed(2)}% – ${((centre + half) * 100).toFixed(2)}%`)
}
console.log('\n⇒ overlapping intervals mean the gradient is not distinguishable from noise at these counts.')

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
