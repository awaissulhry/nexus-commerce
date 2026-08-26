/**
 * HV — independent verification of HV.3a / HV.3. READ-ONLY.
 *
 * The headline check is one nobody has run: AmazonAdsSearchTerm has no unique constraint and its
 * ingest is deleteMany(reportRunId) + createMany. HV.3a refused a re-request on that basis.
 * Has the hazard ALREADY fired — is any date in the table double-ingested today?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const now = Date.now()
const DAY = 86_400_000

console.log('\n═══ HV.3 verification ═══\n')

// ── 1 · both policy tables ───────────────────────────────────────────────────
console.log('── 1 · policy tables ──')
for (const t of ['AdsHarvestPolicy', 'AdsHarvestDestination']) {
  const cols = await prisma.$queryRawUnsafe<Array<{ c: string }>>(
    `select column_name::text as c from information_schema.columns where table_name = $1 order by ordinal_position`, t)
  const n = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`select count(*)::bigint as count from "${t}"`)
  console.log(`  ${pad(t, 24)} ${cols.length ? `${cols.length} cols · ${n[0].count} rows` : '🔴 NOT FOUND'}`)
  if (cols.length) console.log(`    ${cols.map((x) => x.c).join(' · ')}`)
}

// ── 2 · 🔴 has the double-ingest hazard already fired? ───────────────────────
console.log('\n── 2 · AmazonAdsSearchTerm — duplicate natural keys ──')
console.log('  natural key: (profileId, date, campaignId, adGroupId, query, matchType)')
const dupes = await prisma.$queryRawUnsafe<Array<{ n: bigint; keys: bigint; extra: bigint }>>(`
  with k as (
    select "profileId", date, "campaignId", "adGroupId", query, coalesce("matchType",'~') as mt, count(*) as c
    from "AmazonAdsSearchTerm" group by 1,2,3,4,5,6
  )
  select count(*) filter (where c > 1)::bigint as n,
         count(*)::bigint as keys,
         coalesce(sum(c - 1) filter (where c > 1), 0)::bigint as extra
  from k`)
console.log(`  distinct natural keys: ${int(Number(dupes[0].keys))}`)
console.log(`  keys appearing more than once: ${int(Number(dupes[0].n))}`)
console.log(`  redundant rows: ${int(Number(dupes[0].extra))}   ${Number(dupes[0].extra) === 0 ? '✅ the hazard has NOT fired' : '🔴 THE TABLE IS ALREADY DOUBLED'}`)

const perDate = await prisma.$queryRawUnsafe<Array<{ d: Date; runs: bigint; rows: bigint }>>(`
  select date as d, count(distinct "reportRunId")::bigint as runs, count(*)::bigint as rows
  from "AmazonAdsSearchTerm" where date >= now() - interval '30 days'
  group by date order by date desc limit 30`)
const multi = perDate.filter((r) => Number(r.runs) > 4)
console.log(`\n  dates in 30d: ${perDate.length} · distinct reportRunId per date should equal the ${'#'} of (profile,adProduct) jobs`)
console.log(`  ${pad('date', 12)} ${pad('reportRunIds', 13)} rows`)
for (const r of perDate.slice(0, 8)) console.log(`  ${pad(r.d.toISOString().slice(0, 10), 12)} ${pad(String(r.runs), 13)} ${int(Number(r.rows))}`)
console.log(`  dates with an unusually high run count (>4): ${multi.length}`)

// ── 3 · dead attribution columns ─────────────────────────────────────────────
console.log('\n── 3 · dead columns on AmazonAdsDailyPerformance ──')
const dead = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
  select count(*)::bigint as total,
         count(*) filter (where "sales1dCents"  is not null and "sales1dCents"  <> 0)::bigint as s1,
         count(*) filter (where "sales7dCents"  is not null and "sales7dCents"  <> 0)::bigint as s7,
         count(*) filter (where "sales14dCents" is not null and "sales14dCents" <> 0)::bigint as s14,
         count(*) filter (where "sales30dCents" is not null and "sales30dCents" <> 0)::bigint as s30,
         count(*) filter (where "orders7d" is not null and "orders7d" <> 0)::bigint as o7
  from "AmazonAdsDailyPerformance"`)
const d = dead[0]
console.log(`  rows ${int(Number(d.total))} · non-zero: sales1d ${int(Number(d.s1))} · sales7d ${int(Number(d.s7))} · sales14d ${int(Number(d.s14))} · sales30d ${int(Number(d.s30))} · orders7d ${int(Number(d.o7))}`)

// ── 4 · candidates still 8? ──────────────────────────────────────────────────
console.log('\n── 4 · the shipped criteria, recomputed ──')
const win60 = new Date(now - 60 * DAY)
const rows = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId'],
  where: { date: { gte: win60 } },
  _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true },
})
const ord = (r: typeof rows[number]) => r._sum.orders7d ?? 0
const clk = (r: typeof rows[number]) => r._sum.clicks ?? 0
const cost = (r: typeof rows[number]) => Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
const sal = (r: typeof rows[number]) => r._sum.sales7dCents ?? 0
const perMatch = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'matchType'], where: { date: { gte: win60 } }, _sum: { orders7d: true },
})
const byKey = new Map<string, Map<string, number>>()
for (const r of perMatch) {
  const k = `${r.query}|${r.campaignId}|${r.adGroupId}`
  const m = byKey.get(k) ?? new Map<string, number>()
  m.set(r.matchType ?? 'NULL', (m.get(r.matchType ?? 'NULL') ?? 0) + (r._sum.orders7d ?? 0))
  byKey.set(k, m)
}
const survive = rows
  .filter((r) => ord(r) >= 2).filter((r) => clk(r) >= 3)
  .filter((r) => { const s = sal(r); return s > 0 && cost(r) / s <= 0.45 })
  .filter((r) => { const m = byKey.get(`${r.query}|${r.campaignId}|${r.adGroupId}`); if (!m) return true
    const t = [...m.values()].reduce((a, b) => a + b, 0); return t === 0 || (m.get('EXACT') ?? 0) < t })
console.log(`  candidates surviving 2+ orders · 3+ clicks · ACoS<=45% · looser-match: ${survive.length}   [session said 8]`)

// uplift sensitivity — HV.3a's deciding number
for (const u of [1.0, 1.1, 1.25, 1.5, 2.0]) {
  const n = rows
    .filter((r) => ord(r) * u >= 2).filter((r) => clk(r) >= 3)
    .filter((r) => { const s = sal(r); return s > 0 && cost(r) / s <= 0.45 })
    .filter((r) => { const m = byKey.get(`${r.query}|${r.campaignId}|${r.adGroupId}`); if (!m) return true
      const t = [...m.values()].reduce((a, b) => a + b, 0); return t === 0 || (m.get('EXACT') ?? 0) < t }).length
  console.log(`  at orders uplift ×${u.toFixed(2)}: ${n} candidates`)
}

// ── 5 · resolver ambiguity, spot-checked ─────────────────────────────────────
console.log('\n── 5 · destination ambiguity ──')
const ags = await prisma.adGroup.findMany({
  select: { id: true, name: true, externalAdGroupId: true,
    campaign: { select: { id: true, name: true, marketplace: true, targetingType: true } },
    productAds: { select: { productId: true } } },
})
const byProduct = new Map<string, string[]>()
for (const a of ags) for (const p of a.productAds) {
  if (!p.productId) continue
  const g = byProduct.get(p.productId) ?? []; g.push(a.id); byProduct.set(p.productId, g)
}
const isExactDest = (a: typeof ags[number]) =>
  a.campaign?.targetingType === 'MANUAL' && /EXACT/i.test(`${a.campaign?.name ?? ''} ${a.name}`)
const counts: number[] = []
let none = 0, uniq = 0
for (const a of ags) {
  const prods = [...new Set(a.productAds.map((p) => p.productId).filter(Boolean) as string[])]
  const cand = new Set<string>()
  for (const p of prods) for (const other of byProduct.get(p) ?? []) {
    const o = ags.find((x) => x.id === other)
    if (o && o.id !== a.id && o.campaign?.marketplace === a.campaign?.marketplace && isExactDest(o)) cand.add(o.id)
  }
  if (cand.size === 0) none++
  else { counts.push(cand.size); if (cand.size === 1) uniq++ }
}
counts.sort((x, y) => x - y)
console.log(`  ad groups: ${ags.length} · no EXACT destination by product+market: ${none} · resolve: ${counts.length}`)
console.log(`  uniquely resolved: ${uniq} (${Math.round((uniq / Math.max(1, ags.length)) * 100)}%)  [session said 38 of 287 = 13%]`)
if (counts.length) console.log(`  candidates per source: min ${counts[0]} · median ${counts[Math.floor(counts.length / 2)]} · max ${counts[counts.length - 1]}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
