/**
 * HV.5 — the measurements the plan rests on. READ-ONLY.
 *   1. has the live write run?
 *   2. provenance: who wrote each keyword, and how many cannot be classified
 *   3. the four outcome states, and the discriminator between "not measured" and "never served"
 *   4. how far back an opening bid is recoverable
 *   5. the §4.7 comparison, with its confounds
 *   6. the 209 local-only backlog, and whether HV.4's write path fits it
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const PERF_START = new Date('2026-07-05T00:00:00Z')

// ── 1 ─────────────────────────────────────────────────────────────────────────
const wrote = await prisma.adTarget.count({ where: { adGroupId: 'cmpedj42c04ypoj0144it19cz', expressionValue: { equals: 'motorradjacke 4xl', mode: 'insensitive' } } })
const newLogs = await prisma.advertisingActionLog.count({ where: { actionType: 'create_keyword', createdAt: { gte: new Date('2026-08-12T12:00:00Z') } } })
console.log(`\n═══ 1 · the live write ═══\n  keyword in destination: ${wrote} · create_keyword rows since 12 Aug 12:00Z: ${newLogs}  ⇒ ${wrote ? 'RAN' : 'NOT RUN'}`)

// ── 2 · provenance ────────────────────────────────────────────────────────────
console.log('\n\n═══ 2 · provenance — who wrote each positive keyword ═══\n')
const prov = await prisma.$queryRaw<Array<{ writer: string; hasExec: bigint; hasEvidence: bigint; n: bigint; firstAt: Date; lastAt: Date }>>`
  WITH f AS (
    SELECT DISTINCT ON ("entityId") "entityId", "userId", "executionId", evidence, "createdAt"
    FROM "AdvertisingActionLog" WHERE "actionType" = 'create_keyword' ORDER BY "entityId", "createdAt" ASC
  )
  SELECT COALESCE(f."userId", '(no create_keyword audit row)') AS writer,
         COUNT(*) FILTER (WHERE f."executionId" IS NOT NULL)::bigint AS "hasExec",
         COUNT(*) FILTER (WHERE f.evidence IS NOT NULL)::bigint AS "hasEvidence",
         COUNT(*)::bigint AS n, MIN(t."createdAt") AS "firstAt", MAX(t."createdAt") AS "lastAt"
  FROM "AdTarget" t LEFT JOIN f ON f."entityId" = t.id
  WHERE t."isNegative" = false AND t.kind = 'KEYWORD' GROUP BY 1 ORDER BY COUNT(*) DESC`
console.log(`${pad('writer',34)} ${pad('keywords',9)} ${pad('w/ execId',10)} ${pad('w/ evidence',12)} created`)
for (const p of prov) console.log(`${pad(p.writer,34)} ${pad(int(Number(p.n)),9)} ${pad(String(p.hasExec),10)} ${pad(String(p.hasEvidence),12)} ${p.firstAt?.toISOString().slice(0,10)} → ${p.lastAt?.toISOString().slice(0,10)}`)

// what ARE the no-audit-row ones? if they carry lastSyncedAt they were mirrored in by the ingest
const noAudit = await prisma.$queryRaw<Array<{ synced: bigint; never: bigint; withExt: bigint; n: bigint }>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog" WHERE "actionType" = 'create_keyword')
  SELECT COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE t."lastSyncedAt" IS NOT NULL)::bigint AS synced,
         COUNT(*) FILTER (WHERE t."lastSyncedAt" IS NULL)::bigint AS never,
         COUNT(*) FILTER (WHERE t."externalTargetId" IS NOT NULL)::bigint AS "withExt"
  FROM "AdTarget" t LEFT JOIN f ON f."entityId" = t.id
  WHERE t."isNegative" = false AND t.kind = 'KEYWORD' AND f."entityId" IS NULL`
console.log(`\nthe no-audit-row group: ${int(Number(noAudit[0].n))} · lastSyncedAt set ${noAudit[0].synced} · never synced ${noAudit[0].never} · with an Amazon id ${noAudit[0].withExt}`)
console.log('  ⇒ if nearly all carry an Amazon id AND a sync stamp, they were MIRRORED IN from Amazon,')
console.log('    i.e. they pre-date this system writing anything and were never "harvested" by us.')

// user:anonymous — burst pattern
const anon = await prisma.$queryRaw<Array<{ d: Date; n: bigint; ags: bigint }>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId","userId","createdAt" FROM "AdvertisingActionLog" WHERE "actionType"='create_keyword' ORDER BY "entityId","createdAt" ASC)
  SELECT DATE(f."createdAt") AS d, COUNT(*)::bigint AS n, COUNT(DISTINCT t."adGroupId")::bigint AS ags
  FROM f JOIN "AdTarget" t ON t.id = f."entityId" WHERE f."userId" = 'user:anonymous'
  GROUP BY 1 ORDER BY 1`
console.log(`\nuser:anonymous create_keyword rows by day (${anon.length} days):`)
for (const a of anon) console.log(`  ${a.d.toISOString().slice(0,10)}  ${pad(int(Number(a.n)),5)} keywords across ${a.ags} ad groups`)

// ── 3 · the four outcome states ───────────────────────────────────────────────
console.log('\n\n═══ 3 · the four outcome states ═══\n')
const states = await prisma.$queryRaw<Array<{ state: string; n: bigint; cost: bigint; sales: bigint; orders: bigint }>>`
  WITH p AS (
    SELECT "localEntityId" AS id, SUM(impressions)::bigint AS impressions, SUM("costMicros")::bigint AS cost,
           SUM(COALESCE("sales7dCents",0))::bigint AS sales, SUM(COALESCE("orders7d",0))::bigint AS orders
    FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' GROUP BY "localEntityId")
  SELECT CASE
      WHEN t."externalTargetId" IS NULL THEN 'a · never reached Amazon'
      WHEN p.id IS NULL AND t."createdAt" < ${PERF_START} THEN 'b · not measured (pre-window, no rows)'
      WHEN COALESCE(p.impressions,0) = 0 THEN 'c · reached Amazon, never served'
      ELSE 'd · served' END AS state,
    COUNT(*)::bigint AS n, COALESCE(SUM(p.cost),0)::bigint AS cost,
    COALESCE(SUM(p.sales),0)::bigint AS sales, COALESCE(SUM(p.orders),0)::bigint AS orders
  FROM "AdTarget" t LEFT JOIN p ON p.id = t.id
  WHERE t."isNegative" = false AND t.kind = 'KEYWORD' GROUP BY 1 ORDER BY 1`
console.log(`${pad('state',42)} ${pad('keywords',9)} ${pad('spend',11)} ${pad('sales',11)} ${pad('orders',7)} ACoS`)
for (const s of states) {
  const c = Math.round(Number(s.cost)/10000), sa = Number(s.sales)
  console.log(`${pad(s.state,42)} ${pad(int(Number(s.n)),9)} ${pad(eur(c),11)} ${pad(eur(sa),11)} ${pad(String(s.orders),7)} ${sa>0?`${((c/sa)*100).toFixed(0)}%`:'—'}`)
}

// ── 4 · opening bid recoverability ────────────────────────────────────────────
console.log('\n\n═══ 4 · how far back is an OPENING bid recoverable? ═══\n')
const bidActions = await prisma.advertisingActionLog.groupBy({ by: ['actionType'], where: { actionType: { contains: 'bid', mode: 'insensitive' } }, _count: true })
console.log(`bid-ish action types: ${bidActions.map(b=>`${b.actionType}=${b._count}`).join(' · ') || '(none)'}`)
const kwLogs = await prisma.$queryRaw<Array<{ n: bigint; withPayload: bigint }>>`
  SELECT COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE "payloadAfter" ? 'bidEur' OR "payloadAfter" ? 'bidCents' OR "payloadAfter" ? 'bid')::bigint AS "withPayload"
  FROM "AdvertisingActionLog" WHERE "actionType" = 'create_keyword'`
console.log(`create_keyword audit rows: ${kwLogs[0].n} · carrying a bid in payloadAfter: ${kwLogs[0].withPayload}`)
try {
  const cbh = await prisma.campaignBidHistory.aggregate({ _count: true, _min: { createdAt: true }, _max: { createdAt: true } })
  console.log(`CampaignBidHistory: ${int(cbh._count)} rows · ${cbh._min.createdAt?.toISOString().slice(0,10)} → ${cbh._max.createdAt?.toISOString().slice(0,10)}`)
} catch (e) { console.log(`CampaignBidHistory: ${(e as Error).message.slice(0,80)}`) }
const bh = await prisma.$queryRaw<Array<{ t: string; n: bigint }>>`
  SELECT "entityType" AS t, COUNT(*)::bigint AS n FROM "AdvertisingActionLog"
  WHERE "actionType" ILIKE '%bid%' GROUP BY 1 ORDER BY 2 DESC`
console.log(`bid actions by entityType: ${bh.map(b=>`${b.t}=${b.n}`).join(' · ') || '(none)'}`)

// ── 5 · the comparison ────────────────────────────────────────────────────────
console.log('\n\n═══ 5 · harvested vs the rest, DE + IT, served only ═══\n')
const cmp = await prisma.$queryRaw<Array<{ grp: string; mkt: string; n: bigint; cost: bigint; sales: bigint; orders: bigint; medAge: number }>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId","userId" FROM "AdvertisingActionLog" WHERE "actionType"='create_keyword' ORDER BY "entityId","createdAt" ASC),
  p AS (SELECT "localEntityId" AS id, SUM(impressions)::bigint AS impressions, SUM("costMicros")::bigint AS cost,
               SUM(COALESCE("sales7dCents",0))::bigint AS sales, SUM(COALESCE("orders7d",0))::bigint AS orders
        FROM "AmazonAdsDailyPerformance" WHERE "entityType"='AD_TARGET' GROUP BY "localEntityId")
  SELECT CASE WHEN f."userId" = 'automation:auto-harvest' THEN 'harvested (engine)'
              WHEN f."userId" IS NULL THEN 'mirrored from Amazon' ELSE 'created in-app' END AS grp,
         c.marketplace AS mkt, COUNT(*)::bigint AS n,
         COALESCE(SUM(p.cost),0)::bigint AS cost, COALESCE(SUM(p.sales),0)::bigint AS sales,
         COALESCE(SUM(p.orders),0)::bigint AS orders,
         AVG(EXTRACT(EPOCH FROM (NOW() - t."createdAt"))/86400)::float AS "medAge"
  FROM "AdTarget" t LEFT JOIN f ON f."entityId"=t.id LEFT JOIN p ON p.id=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."isNegative"=false AND t.kind='KEYWORD' AND COALESCE(p.impressions,0)>0 AND c.marketplace IN ('DE','IT')
  GROUP BY 1,2 ORDER BY 2,1`
console.log(`${pad('group',24)} ${pad('mkt',4)} ${pad('served kw',10)} ${pad('spend',11)} ${pad('sales',11)} ${pad('orders',7)} ${pad('ACoS',6)} avg age`)
for (const c of cmp) {
  const cost = Math.round(Number(c.cost)/10000), sa = Number(c.sales)
  console.log(`${pad(c.grp,24)} ${pad(c.mkt,4)} ${pad(int(Number(c.n)),10)} ${pad(eur(cost),11)} ${pad(eur(sa),11)} ${pad(String(c.orders),7)} ${pad(sa>0?`${((cost/sa)*100).toFixed(0)}%`:'—',6)} ${c.medAge.toFixed(0)}d`)
}

// ── 6 · the backlog ───────────────────────────────────────────────────────────
console.log('\n\n═══ 6 · the local-only backlog ═══\n')
const back = await prisma.$queryRaw<Array<{ kind: string; n: bigint; ags: bigint }>>`
  SELECT CASE WHEN t."expressionValue" ~* '^b0[a-z0-9]{8}$' THEN 'ASIN-shaped (must NEVER be pushed)'
              ELSE 'real keyword text' END AS kind,
         COUNT(*)::bigint AS n, COUNT(DISTINCT t."adGroupId")::bigint AS ags
  FROM "AdTarget" t WHERE t."isNegative"=false AND t.kind='KEYWORD' AND t."externalTargetId" IS NULL
  GROUP BY 1`
for (const b of back) console.log(`  ${pad(b.kind,38)} ${pad(int(Number(b.n)),6)} across ${b.ags} ad groups`)
const dupes = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM (
    SELECT "adGroupId", LOWER("expressionValue"), "expressionType" FROM "AdTarget"
    WHERE "isNegative"=false AND kind='KEYWORD' GROUP BY 1,2,3 HAVING COUNT(*)>1) t`
console.log(`  duplicate keyword groups (same ad group · text · match type): ${dupes[0].n}`)
await prisma.$disconnect()
