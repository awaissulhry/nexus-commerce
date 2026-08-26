/**
 * HV — independent verification of HV.1c / HV.2a / HV.2. READ-ONLY.
 *
 * Checks the session's claims rather than trusting them, and in particular tests whether the
 * CVR-by-data-age gradient proves the orders7d freeze, or whether it is an artefact of how the
 * historical rows were loaded. Those have the same symptom and different fixes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const now = Date.now()
const DAY = 86_400_000

console.log('\n═══ HV.2 verification ═══\n')

// ── 1 · HV.0 still held down, HV.1c's claim ──────────────────────────────────
console.log('── 1 · ads-auto-harvest ──')
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 5, select: { startedAt: true, status: true, outputSummary: true } })
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 8)} ${r.outputSummary ?? ''}`)
const since = new Date('2026-08-12T00:00:00Z')
const engineWrites = await prisma.advertisingActionLog.count({ where: { userId: 'automation:auto-harvest', createdAt: { gte: since } } })
console.log(`  automation:auto-harvest audit rows since 2026-08-12: ${engineWrites}`)

// ── 2 · the policy table ─────────────────────────────────────────────────────
console.log('\n── 2 · AdsHarvestPolicy ──')
try {
  const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string }>>(
    `select column_name, data_type, is_nullable from information_schema.columns where table_name = 'AdsHarvestPolicy' order by ordinal_position`,
  )
  if (!cols.length) console.log('  🔴 TABLE NOT FOUND')
  else {
    console.log(`  columns (${cols.length}): ${cols.map((c) => `${c.column_name}:${c.data_type}${c.is_nullable === 'YES' ? '?' : ''}`).join(' · ')}`)
    const n = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`select count(*)::bigint as count from "AdsHarvestPolicy"`)
    console.log(`  rows: ${n[0].count}  ${n[0].count === 0n ? '(empty — the shipping shape)' : ''}`)
    const idx = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(`select indexdef from pg_indexes where tablename = 'AdsHarvestPolicy'`)
    for (const i of idx) console.log(`  ${i.indexdef}`)
  }
} catch (e) { console.log(`  error: ${(e as Error).message}`) }

// ── 3 · reproduce the criteria funnel ────────────────────────────────────────
console.log('\n── 3 · the criteria funnel, recomputed from raw data ──')
const win60 = new Date(now - 60 * DAY)
const rows = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId'],
  where: { date: { gte: win60 } },
  _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true },
})
const ordersOf = (r: { _sum: { orders7d: number | null } }) => r._sum.orders7d ?? 0
const clicksOf = (r: { _sum: { clicks: number | null } }) => r._sum.clicks ?? 0
const costOf = (r: { _sum: { costMicros: bigint | null } }) => Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
const salesOf = (r: { _sum: { sales7dCents: number | null } }) => r._sum.sales7dCents ?? 0

const converted = rows.filter((r) => ordersOf(r) >= 1)
console.log(`  converted at least once (60d):        ${converted.length}   [session said 92]`)
const ge2 = converted.filter((r) => ordersOf(r) >= 2)
console.log(`  after 2+ orders:                      ${ge2.length}   (−${converted.length - ge2.length})   [session said −75 → 17]`)
const ge2c3 = ge2.filter((r) => clicksOf(r) >= 3)
console.log(`  after 3+ clicks:                      ${ge2c3.length}   (−${ge2.length - ge2c3.length})   [session said −2]`)
const acosOk = ge2c3.filter((r) => { const s = salesOf(r); return s > 0 && costOf(r) / s <= 0.45 })
console.log(`  after ACoS <= 45%:                    ${acosOk.length}   (−${ge2c3.length - acosOk.length})   [session said −3]`)

// looser-match: exclude rows where EVERY order came via EXACT (reading A)
const perMatch = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'matchType'],
  where: { date: { gte: win60 } },
  _sum: { orders7d: true },
})
const ordersByKeyMatch = new Map<string, Map<string, number>>()
for (const r of perMatch) {
  const k = `${r.query}|${r.campaignId}|${r.adGroupId}`
  const m = ordersByKeyMatch.get(k) ?? new Map<string, number>()
  m.set(r.matchType ?? 'NULL', (m.get(r.matchType ?? 'NULL') ?? 0) + (r._sum.orders7d ?? 0))
  ordersByKeyMatch.set(k, m)
}
const looser = acosOk.filter((r) => {
  const m = ordersByKeyMatch.get(`${r.query}|${r.campaignId}|${r.adGroupId}`)
  if (!m) return true
  const total = [...m.values()].reduce((a, b) => a + b, 0)
  const exact = m.get('EXACT') ?? 0
  return total === 0 || exact < total // reading A: NOT every order via EXACT
})
console.log(`  after looser-match (reading A):       ${looser.length}   (−${acosOk.length - looser.length})   [session said −4 → 8]`)
console.log(`  ⇒ keyword candidates ${looser.length}; the session's 8 includes product targets separately`)

// ── 4 · 🔴 does the CVR gradient prove a FREEZE, or a LOADING artefact? ───────
console.log('\n── 4 · orders7d by data age — freeze, or backfill artefact? ──')
const raw = await prisma.amazonAdsSearchTerm.findMany({
  where: { date: { gte: new Date(now - 40 * DAY) } },
  select: { date: true, clicks: true, orders7d: true, createdAt: true },
})
type Bucket = { clicks: number; orders: number; rows: number; lagDays: number[] }
const bucket = (label: string) => ({ label, b: { clicks: 0, orders: 0, rows: 0, lagDays: [] as number[] } as Bucket })
const buckets = [bucket('0-2 d'), bucket('3-7 d'), bucket('8-14 d'), bucket('15-30 d'), bucket('31-40 d')]
const pick = (age: number) => age <= 2 ? buckets[0] : age <= 7 ? buckets[1] : age <= 14 ? buckets[2] : age <= 30 ? buckets[3] : buckets[4]
for (const r of raw) {
  const age = Math.floor((now - r.date.getTime()) / DAY)
  const t = pick(age).b
  t.clicks += r.clicks ?? 0
  t.orders += r.orders7d ?? 0
  t.rows++
  // INGEST LAG: how long after the traffic date was this row written?
  t.lagDays.push((r.createdAt.getTime() - r.date.getTime()) / DAY)
}
console.log(`  ${pad('age of the traffic', 20)} ${pad('rows', 8)} ${pad('clicks', 9)} ${pad('orders', 7)} ${pad('CVR', 8)} ingest lag (d): p50 / p90 / max`)
for (const { label, b } of buckets) {
  if (!b.rows) continue
  const cvr = b.clicks ? (b.orders / b.clicks) * 100 : 0
  const l = b.lagDays.sort((x, y) => x - y)
  const q = (p: number) => l.length ? l[Math.min(l.length - 1, Math.floor(l.length * p))].toFixed(1) : '—'
  console.log(`  ${pad(label, 20)} ${pad(int(b.rows), 8)} ${pad(int(b.clicks), 9)} ${pad(int(b.orders), 7)} ${pad(`${cvr.toFixed(2)}%`, 8)} ${q(0.5)} / ${q(0.9)} / ${q(1)}`)
}
console.log('\n  READ THIS: if the ingest lag is ~1d in EVERY bucket, each date was captured once at D+1 and')
console.log('  the CVR gradient CANNOT be a maturation effect — every row is equally immature, so the')
console.log('  gradient is behavioural or a loading artefact. If older buckets show a LARGER lag, those')
console.log('  rows were backfilled with mature attribution and the freeze IS the explanation.')

// is any row ever rewritten? compare createdAt spread per date
const perDate = new Map<string, { rows: number; firstIngest: number; lastIngest: number }>()
for (const r of raw) {
  const k = r.date.toISOString().slice(0, 10)
  const t = perDate.get(k) ?? { rows: 0, firstIngest: Infinity, lastIngest: -Infinity }
  t.rows++
  t.firstIngest = Math.min(t.firstIngest, r.createdAt.getTime())
  t.lastIngest = Math.max(t.lastIngest, r.createdAt.getTime())
  perDate.set(k, t)
}
console.log(`\n  ${pad('traffic date', 14)} ${pad('rows', 7)} ${pad('first ingest', 18)} ${pad('last ingest', 18)} span(h)`)
for (const [d, t] of [...perDate.entries()].sort().slice(-14)) {
  console.log(`  ${pad(d, 14)} ${pad(int(t.rows), 7)} ${pad(new Date(t.firstIngest).toISOString().slice(0, 16), 18)} ${pad(new Date(t.lastIngest).toISOString().slice(0, 16), 18)} ${((t.lastIngest - t.firstIngest) / 3_600_000).toFixed(1)}`)
}
console.log('\n  A span > ~2h on a date means that date WAS revisited after its first capture.')

// ── 5 · the report crons ─────────────────────────────────────────────────────
console.log('\n── 5 · the report chain ──')
for (const jobName of ['ads-report-create-st', 'ads-report-poll', 'ads-report-ingest', 'ads-report-gapfill', 'ads-v1-export-ingest']) {
  const rs = await prisma.cronRun.findMany({ where: { jobName }, orderBy: { startedAt: 'desc' }, take: 3, select: { startedAt: true, status: true, outputSummary: true } })
  const total = await prisma.cronRun.count({ where: { jobName } })
  console.log(`  ${jobName} (${total} runs)${rs.length ? '' : ' — NONE'}`)
  for (const r of rs) console.log(`    ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 8)} ${(r.outputSummary ?? '').slice(0, 110)}`)
}

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
