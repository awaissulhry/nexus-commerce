/**
 * HV.5 — the cohort: what happened to every keyword this account harvested. READ-ONLY.
 *
 * HV.1 §4.3 measured that this view is buildable; this re-measures it fresh, because every number
 * on it will be rendered and the last measurement is a day old.
 *
 * 🔴 Two laws it inherits, both already paid for:
 *   · NEVER read AdTarget.impressions/clicks/spendCents/salesCents/ordersCount — 0 on all rows.
 *     Performance lives in AmazonAdsDailyPerformance, joined on localEntityId.
 *   · Performance rows begin 2026-07-05. A keyword created before that has no measurable "after"
 *     and must render `not measurable`, never a zero. That is the difference between "we looked
 *     and it did nothing" and "we cannot see".
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ HV.5 — the harvested cohort, re-measured ═══\n')

// ── 1 · the join ──────────────────────────────────────────────────────────────
console.log('═══ 1 · does the join still work? ═══\n')
const perf = await prisma.amazonAdsDailyPerformance.aggregate({
  where: { entityType: 'AD_TARGET' }, _count: true, _min: { date: true }, _max: { date: true },
})
console.log(`AmazonAdsDailyPerformance entityType=AD_TARGET: ${int(perf._count)} rows · ${perf._min.date?.toISOString().slice(0,10)} → ${perf._max.date?.toISOString().slice(0,10)}`)
const resolved = await prisma.$queryRaw<Array<{ rows: bigint; resolved: bigint; targets: bigint }>>`
  SELECT COUNT(*)::bigint AS rows,
         COUNT(*) FILTER (WHERE t.id IS NOT NULL)::bigint AS resolved,
         COUNT(DISTINCT t.id)::bigint AS targets
  FROM "AmazonAdsDailyPerformance" p
  LEFT JOIN "AdTarget" t ON t.id = p."localEntityId" AND t."isNegative" = false AND t.kind = 'KEYWORD'
  WHERE p."entityType" = 'AD_TARGET'`
const r0 = resolved[0]
console.log(`  resolve to a positive KEYWORD AdTarget: ${int(Number(r0.resolved))} of ${int(Number(r0.rows))} (${((Number(r0.resolved)/Number(r0.rows))*100).toFixed(0)}%)`)
console.log(`  distinct keywords with a performance row: ${int(Number(r0.targets))}`)

// 🔴 the five dead columns, re-checked rather than assumed
const dead = await prisma.adTarget.count({ where: { OR: [{ impressions: { gt: 0 } }, { clicks: { gt: 0 } }, { spendCents: { gt: 0 } }, { salesCents: { gt: 0 } }, { ordersCount: { gt: 0 } }] } })
const allT = await prisma.adTarget.count()
console.log(`\nAdTarget rows with ANY non-zero built-in metric: ${dead} of ${int(allT)}  ${dead === 0 ? '(still dead — never read them)' : '🔴 CHANGED'}`)

// ── 2 · the cohort ────────────────────────────────────────────────────────────
console.log('\n\n═══ 2 · every positive keyword, and what it did AFTER creation ═══\n')
const cohort = await prisma.$queryRaw<Array<{
  bucket: string; n: bigint; reached: bigint; measurable: bigint; withImpr: bigint
  impressions: bigint; clicks: bigint; cost: bigint; sales: bigint; orders: bigint
}>>`
  WITH k AS (
    SELECT t.id, t."createdAt", t."externalTargetId",
           CASE WHEN t."createdAt" < TIMESTAMP '2026-07-05' THEN 'created before perf data'
                ELSE 'measurable (created 2026-07-05+)' END AS bucket
    FROM "AdTarget" t WHERE t."isNegative" = false AND t.kind = 'KEYWORD'
  ), p AS (
    SELECT "localEntityId" AS id,
           SUM(impressions)::bigint AS impressions, SUM(clicks)::bigint AS clicks,
           SUM("costMicros")::bigint AS cost, SUM(COALESCE("sales7dCents",0))::bigint AS sales,
           SUM(COALESCE("orders7d",0))::bigint AS orders
    FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET' GROUP BY "localEntityId"
  )
  SELECT k.bucket,
         COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE k."externalTargetId" IS NOT NULL)::bigint AS reached,
         COUNT(*) FILTER (WHERE p.id IS NOT NULL)::bigint AS measurable,
         COUNT(*) FILTER (WHERE COALESCE(p.impressions,0) > 0)::bigint AS "withImpr",
         COALESCE(SUM(p.impressions),0)::bigint AS impressions, COALESCE(SUM(p.clicks),0)::bigint AS clicks,
         COALESCE(SUM(p.cost),0)::bigint AS cost, COALESCE(SUM(p.sales),0)::bigint AS sales,
         COALESCE(SUM(p.orders),0)::bigint AS orders
  FROM k LEFT JOIN p ON p.id = k.id GROUP BY k.bucket ORDER BY k.bucket`
console.log(`${pad('bucket',34)} ${pad('keywords',9)} ${pad('at Amazon',10)} ${pad('measurable',11)} ${pad('had impr',9)} ${pad('spend',11)} ${pad('sales',11)} ${pad('orders',7)} ACoS`)
for (const b of cohort) {
  const cost = Math.round(Number(b.cost)/10000), sales = Number(b.sales)
  console.log(`${pad(b.bucket,34)} ${pad(int(Number(b.n)),9)} ${pad(int(Number(b.reached)),10)} ${pad(int(Number(b.measurable)),11)} ${pad(int(Number(b.withImpr)),9)} ${pad(eur(cost),11)} ${pad(eur(sales),11)} ${pad(String(b.orders),7)} ${sales>0?`${((cost/sales)*100).toFixed(0)}%`:'—'}`)
}

// ── 3 · who wrote them ────────────────────────────────────────────────────────
console.log('\n\n═══ 3 · by writer — the engine vs everyone else ═══\n')
const byWriter = await prisma.$queryRaw<Array<{ writer: string; n: bigint; reached: bigint; withImpr: bigint; cost: bigint; sales: bigint; orders: bigint }>>`
  WITH first_log AS (
    SELECT DISTINCT ON ("entityId") "entityId", "userId"
    FROM "AdvertisingActionLog" WHERE "actionType" = 'create_keyword' ORDER BY "entityId", "createdAt" ASC
  ), p AS (
    SELECT "localEntityId" AS id, SUM(impressions)::bigint AS impressions, SUM("costMicros")::bigint AS cost,
           SUM(COALESCE("sales7dCents",0))::bigint AS sales, SUM(COALESCE("orders7d",0))::bigint AS orders
    FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET' GROUP BY "localEntityId"
  )
  SELECT COALESCE(f."userId",'(no audit row)') AS writer, COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NOT NULL)::bigint AS reached,
         COUNT(*) FILTER (WHERE COALESCE(p.impressions,0) > 0)::bigint AS "withImpr",
         COALESCE(SUM(p.cost),0)::bigint AS cost, COALESCE(SUM(p.sales),0)::bigint AS sales,
         COALESCE(SUM(p.orders),0)::bigint AS orders
  FROM "AdTarget" t LEFT JOIN first_log f ON f."entityId" = t.id LEFT JOIN p ON p.id = t.id
  WHERE t."isNegative" = false AND t.kind = 'KEYWORD'
  GROUP BY 1 ORDER BY COUNT(*) DESC`
console.log(`${pad('writer',28)} ${pad('keywords',9)} ${pad('at Amazon',10)} ${pad('had impr',9)} ${pad('spend',11)} ${pad('sales',11)} ${pad('orders',7)} ACoS`)
for (const w of byWriter) {
  const cost = Math.round(Number(w.cost)/10000), sales = Number(w.sales)
  console.log(`${pad(w.writer,28)} ${pad(int(Number(w.n)),9)} ${pad(int(Number(w.reached)),10)} ${pad(int(Number(w.withImpr)),9)} ${pad(eur(cost),11)} ${pad(eur(sales),11)} ${pad(String(w.orders),7)} ${sales>0?`${((cost/sales)*100).toFixed(0)}%`:'—'}`)
}
console.log('\n🔴 "at Amazon" is the column that reframes the tab: a keyword that never reached Amazon')
console.log('   cannot have performance, so counting it as a 0-impression failure is a category error.')
await prisma.$disconnect()
