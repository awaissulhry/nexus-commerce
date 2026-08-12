/**
 * HV.5 — the cohort endpoint, proven. READ-ONLY (pushExistingKeyword is NOT called).
 *
 * The bar HV.1 and HV.2 both held: for several filter combinations, the number the summary claims
 * equals the rows the grid renders equals what an independent query returns.
 */
import '../src/env.js'
const { getHarvestCohort } = await import('../src/services/advertising/harvest-cohort.service.js')
const { default: prisma } = await import('../src/db.js')
const pad=(s:string,n:number)=>(s.length>n?`${s.slice(0,n-1)}…`:s.padEnd(n))
const int=(n:number)=>n.toLocaleString('en-IE')
const eur=(c:number)=>`€${(c/100).toFixed(2)}`
let fail = 0
const ck=(l:string,ok:boolean,d='')=>{ if(!ok) fail++; console.log(`  ${ok?'✅':'🔴'} ${pad(l,58)} ${d}`) }

console.log('\n═══ HV.5 — the cohort, proven ═══\n')
const p = await getHarvestCohort({ market: 'all' })
const c = p.census
console.log(`cohort: ${c.cohort} harvested keywords · excluded ${c.excluded.total} (mirrored ${c.excluded.mirrored} · bulk ${c.excluded.appBulk}) · unclassifiable ${c.unclassifiable}`)
console.log(`by outcome: ${Object.entries(c.byOutcome).map(([k,v])=>`${k}=${v}`).join(' · ')}`)
console.log(`served economics: ${c.served.keywords} kw · ${eur(c.served.spendCents)} · ${eur(c.served.salesCents)} · ${c.served.orders} orders · ACoS ${c.served.acosPct?.toFixed(0)}%`)
console.log(`backlog: ${c.backlog.pushable} pushable · ${c.backlog.asinShaped} ASIN-shaped (never pushable)`)
console.log(`window: ${c.window.start.slice(0,10)} → ${c.window.end?.slice(0,10)}`)
console.log(`comparison verdict: ${p.comparison.verdict} (${p.comparison.servedHarvested} served harvested, ${p.comparison.harvestedOrders} orders)\n`)

// 1 · the four outcomes partition the cohort
const sum = Object.values(c.byOutcome).reduce((a,b)=>a+b,0)
ck('the four outcomes partition the cohort', sum === c.cohort, `${sum} vs ${c.cohort}`)
ck('unclassifiable is zero', c.unclassifiable === 0)
ck('every actor bucket sums to the account', Object.values(c.byActor).reduce((a,b)=>a+b,0) === await prisma.adTarget.count({ where:{isNegative:false,kind:'KEYWORD'} }))

// 2 · independent recount of the outcome split
const indep = await prisma.$queryRaw<Array<{state:string;n:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId","userId" FROM "AdvertisingActionLog" WHERE "actionType"='create_keyword' ORDER BY "entityId","createdAt" ASC),
  pp AS (SELECT "localEntityId" AS id, SUM(impressions)::bigint AS impressions FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT CASE WHEN t."externalTargetId" IS NULL THEN 'local-only'
              WHEN pp.id IS NULL AND t."createdAt" < TIMESTAMP '2026-07-05' THEN 'not-measured'
              WHEN COALESCE(pp.impressions,0)=0 THEN 'never-served' ELSE 'served' END AS state,
         COUNT(*)::bigint AS n
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id LEFT JOIN pp ON pp.id=t.id
  WHERE t."isNegative"=false AND t.kind='KEYWORD' AND f."userId"='automation:auto-harvest'
  GROUP BY 1`
const im = new Map(indep.map(r=>[r.state,Number(r.n)]))
console.log('')
for (const [k,v] of Object.entries(c.byOutcome)) ck(`independent recount matches: ${k}`, (im.get(k) ?? 0) === v, `${im.get(k) ?? 0} vs ${v}`)

// 3 · a blank is not a zero
const notServed = p.rows.filter(r=>r.outcome!=='served')
ck('no non-served row carries a performance object', notServed.every(r=>r.performance===null), `${notServed.length} rows`)
const served = p.rows.filter(r=>r.outcome==='served')
ck('every served row carries impressions > 0', served.every(r=>(r.performance?.impressions ?? 0)>0), `${served.length} rows`)

// 4 · the opening bid
const unknown = p.rows.filter(r=>r.openingBidSource==='unknown')
ck('no opening bid is unknown', unknown.length===0, `${unknown.length} unknown`)
console.log(`     opening-bid sources: ${['unchanged','reconstructed','unknown'].map(s=>`${s}=${p.rows.filter(r=>r.openingBidSource===s).length}`).join(' · ')}`)

// 5 · filters — the summary equals the grid equals a recount
console.log('')
for (const o of ['served','never-served','not-measured','local-only'] as const) {
  const f = await getHarvestCohort({ market:'all', outcome:o })
  ck(`filter outcome=${o} returns exactly its census count`, f.rows.length === c.byOutcome[o] && f.total === c.byOutcome[o], `${f.rows.length} vs ${c.byOutcome[o]}`)
}
for (const m of ['DE','IT']) {
  const f = await getHarvestCohort({ market:m })
  const recount = Object.values(f.census.byOutcome).reduce((a,b)=>a+b,0)
  ck(`market=${m}: outcomes partition its cohort`, recount === f.census.cohort, `${recount} vs ${f.census.cohort}`)
}
// 6 · ASINs are separated and never counted as pushable
const asin = p.rows.filter(r=>r.asinShaped)
ck('ASIN-shaped rows are excluded from the pushable count', c.backlog.pushable === p.rows.filter(r=>r.outcome==='local-only'&&!r.asinShaped).length, `pushable=${c.backlog.pushable} asin=${c.backlog.asinShaped}`)
ck('every ASIN-shaped row is local-only', asin.every(r=>r.outcome==='local-only'))

console.log(`\n═══ ${fail===0?'✅ all checks passed':`🔴 ${fail} FAILED`} ═══\n`)
await prisma.$disconnect()
process.exit(fail===0?0:1)
