/**
 * HV — independent verification of HV.4a / HV.4. READ-ONLY.
 *
 * The first check is the one that matters: HV.4a says my "157 duplicated rows" finding was wrong
 * because the natural key omits matchedKeywordId, and that acting on it would have destroyed real
 * spend. Test that properly before anything else.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ HV.4 verification ═══\n')

// ── 1 · 🔴 was my duplicate finding wrong? ───────────────────────────────────
console.log('── 1 · the natural key, four ways ──')
const BASE = `"profileId", date, "campaignId", "adGroupId", query, coalesce("matchType",'~')`
const keys: Array<[string, string, number]> = [
  ['as the ingest comment names it', BASE, 6],
  ['+ matchedKeywordId', `${BASE}, coalesce("matchedKeywordId",'~')`, 7],
  ['+ matchedTargetId', `${BASE}, coalesce("matchedTargetId",'~')`, 7],
  ['+ both', `${BASE}, coalesce("matchedKeywordId",'~'), coalesce("matchedTargetId",'~')`, 8],
]
for (const [label, cols, n] of keys) {
  const g = Array.from({ length: n }, (_, i) => i + 1).join(',')
  const r = await prisma.$queryRawUnsafe<Array<{ keys: bigint; dup: bigint; extra: bigint }>>(
    `with k as (select ${cols}, count(*) c from "AmazonAdsSearchTerm" group by ${g})
     select count(*)::bigint keys, count(*) filter (where c>1)::bigint dup, coalesce(sum(c-1) filter (where c>1),0)::bigint extra from k`)
  console.log(`  ${pad(label, 34)} keys ${pad(int(Number(r[0].keys)), 8)} dup-keys ${pad(int(Number(r[0].dup)), 6)} redundant ${int(Number(r[0].extra))}`)
}

// the actual rows behind one "duplicate" group — are they distinct Amazon facts?
console.log('\n  a group my key called duplicated, expanded:')
const sample = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  with k as (
    select "profileId", date, "campaignId", "adGroupId", query, coalesce("matchType",'~') mt, count(*) c
    from "AmazonAdsSearchTerm" group by 1,2,3,4,5,6 having count(*) > 1 order by c desc limit 1)
  select t.date, t.query, t."matchType", t."matchedKeywordId", t."matchedTargetId", t."reportRunId",
         t.clicks, t.impressions, t."costMicros"::text as cost, t."orders7d", t."adProduct"
  from "AmazonAdsSearchTerm" t join k on t."profileId"=k."profileId" and t.date=k.date
   and t."campaignId"=k."campaignId" and t."adGroupId"=k."adGroupId" and t.query=k.query
   and coalesce(t."matchType",'~')=k.mt order by t."matchedKeywordId"`)
for (const r of sample) {
  console.log(`    ${String(r.date).slice(0, 10)} "${r.query}" mt=${r.matchType ?? '-'} kwId=${r.matchedKeywordId ?? '-'} tgtId=${r.matchedTargetId ?? '-'} clicks=${r.clicks} cost=${r.cost} orders=${r.orders7d} run=${String(r.reportRunId ?? '').slice(0, 8)}`)
}
const distinctRuns = new Set(sample.map((r) => r.reportRunId)).size
console.log(`  → distinct reportRunId across those rows: ${distinctRuns}  ${distinctRuns === 1 ? '✅ one report — NOT a re-ingest' : '🔴 more than one report'}`)
console.log(`  → distinct matchedKeywordId: ${new Set(sample.map((r) => r.matchedKeywordId)).size} of ${sample.length} rows`)

// ── 2 · would collapsing have changed a candidate? ───────────────────────────
console.log('\n── 2 · what the collapse I demanded would have done ──')
const win60 = new Date(Date.now() - 60 * 86_400_000)
const full = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId'], where: { date: { gte: win60 } },
  _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true },
})
const collapsed = await prisma.$queryRawUnsafe<Array<{ query: string; c: string; a: string; orders: bigint; clicks: bigint; cost: string }>>(`
  with d as (select distinct on ("profileId", date, "campaignId", "adGroupId", query, coalesce("matchType",'~'))
               query, "campaignId" c, "adGroupId" a, clicks, "costMicros", "orders7d"
             from "AmazonAdsSearchTerm" where date >= $1
             order by "profileId", date, "campaignId", "adGroupId", query, coalesce("matchType",'~'), "createdAt" desc)
  select query, c, a, sum("orders7d")::bigint orders, sum(clicks)::bigint clicks, sum("costMicros")::text cost
  from d group by 1,2,3`, win60)
const cmap = new Map(collapsed.map((r) => [`${r.query}|${r.c}|${r.a}`, r]))
let changedOrders = 0, changedClicks = 0, lostClicks = 0, lostCostCents = 0
for (const f of full) {
  const c = cmap.get(`${f.query}|${f.campaignId}|${f.adGroupId}`)
  if (!c) continue
  if ((f._sum.orders7d ?? 0) !== Number(c.orders)) changedOrders++
  if ((f._sum.clicks ?? 0) !== Number(c.clicks)) { changedClicks++; lostClicks += (f._sum.clicks ?? 0) - Number(c.clicks) }
  lostCostCents += Math.round((Number(f._sum.costMicros ?? 0n) - Number(c.cost)) / 10000)
}
console.log(`  rollup keys in 60d: ${int(full.length)}`)
console.log(`  keys whose ORDERS would change: ${changedOrders}`)
console.log(`  keys whose CLICKS would change: ${changedClicks}  (clicks discarded: ${int(lostClicks)})`)
console.log(`  spend that would have been discarded: ${eur(lostCostCents)}   ${lostCostCents > 0 ? '🔴 REAL SPEND — the collapse was destructive' : ''}`)

// ── 3 · the negative-scope decision, checked ─────────────────────────────────
console.log('\n── 3 · AD_GROUP vs CAMPAIGN negatives ──')
const negs = await prisma.adTarget.groupBy({ by: ['negativeLevel'], where: { kind: 'KEYWORD', isNegative: true }, _count: { _all: true } })
for (const n of negs) {
  const atAmazon = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: true, negativeLevel: n.negativeLevel, externalTargetId: { not: null } } })
  const pct = Math.round((atAmazon / n._count._all) * 100)
  console.log(`  ${pad(n.negativeLevel ?? '(null)', 12)} ${pad(int(n._count._all), 7)} rows · at Amazon ${pad(int(atAmazon), 7)} (${pct}%)`)
}

// ── 4 · state after HV.4 ─────────────────────────────────────────────────────
console.log('\n── 4 · shipped state ──')
const pol = await prisma.$queryRawUnsafe<Array<{ t: string; n: bigint }>>(`
  select 'AdsHarvestPolicy' t, count(*)::bigint n from "AdsHarvestPolicy"
  union all select 'AdsHarvestDestination', count(*)::bigint from "AdsHarvestDestination"`)
console.log(`  ${pol.map((p) => `${p.t}=${p.n}`).join(' · ')}`)
const dest = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`select * from "AdsHarvestDestination"`)
for (const d of dest) console.log(`    ${JSON.stringify(d)}`)

const since = new Date('2026-08-12T00:00:00Z')
const newTargets = await prisma.adTarget.count({ where: { createdAt: { gte: since } } })
const newLogs = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: { in: ['create_keyword', 'create_negative_keyword'] } } })
console.log(`  AdTarget rows created since 2026-08-12: ${newTargets}`)
console.log(`  create_keyword / create_negative_keyword audit rows since 2026-08-12: ${newLogs}`)
console.log(`  ⇒ the live write ${newTargets === 0 && newLogs === 0 ? 'has NOT run' : 'HAS run'}`)

const runs = await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 2, select: { startedAt: true, outputSummary: true } })
for (const r of runs) console.log(`  ads-auto-harvest ${r.startedAt.toISOString().slice(0, 16)} ${r.outputSummary}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
