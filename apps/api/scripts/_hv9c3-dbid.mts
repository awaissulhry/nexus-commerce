/** HV.9c.3 D-B — bid writes against targets with no Amazon id. READ-ONLY, account-wide. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')

console.log('\n═══ 1 · AD_BID_UPDATE against id-less targets — ACCOUNT-WIDE, all time ═══')
const all = await prisma.$queryRaw<Array<{n:bigint;targets:bigint;oldest:Date;newest:Date}>>`
  SELECT COUNT(*)::bigint AS n, COUNT(DISTINCT l."entityId")::bigint AS targets,
         MIN(l."createdAt") AS oldest, MAX(l."createdAt") AS newest
  FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id = l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t."externalTargetId" IS NULL`
const a=all[0]
console.log(`  ${int(a.n)} bid writes across ${int(a.targets)} id-less targets · ${a.oldest?.toISOString().slice(0,10)} → ${a.newest?.toISOString().slice(0,16)}`)

console.log('\n═══ 2 · is the harvest cohort the whole story? ═══')
const split = await prisma.$queryRaw<Array<{inCohort:boolean;n:bigint;targets:bigint}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT (f."entityId" IS NOT NULL) AS "inCohort", COUNT(*)::bigint AS n, COUNT(DISTINCT l."entityId")::bigint AS targets
  FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id = l."entityId" LEFT JOIN f ON f."entityId"=t.id
  WHERE l."actionType"='AD_BID_UPDATE' AND t."externalTargetId" IS NULL GROUP BY 1`
for (const s of split) console.log(`  ${s.inCohort?'INSIDE the harvest cohort ':'🔴 OUTSIDE the cohort     '} ${String(int(s.n)).padStart(6)} writes across ${int(s.targets)} targets`)

console.log('\n═══ 3 · by actor ═══')
const actors = await prisma.$queryRaw<Array<{u:string|null;n:bigint;newest:Date}>>`
  SELECT l."userId" AS u, COUNT(*)::bigint AS n, MAX(l."createdAt") AS newest
  FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id = l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t."externalTargetId" IS NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`
for (const r of actors) console.log(`  ${String(r.u).slice(0,44).padEnd(46)} ${String(int(r.n)).padStart(6)} newest=${r.newest?.toISOString().slice(0,16)}`)

console.log('\n═══ 4 · still accruing? writes per day, last 7 days ═══')
const days = await prisma.$queryRaw<Array<{d:string;n:bigint}>>`
  SELECT TO_CHAR(l."createdAt",'YYYY-MM-DD') AS d, COUNT(*)::bigint AS n
  FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id = l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t."externalTargetId" IS NULL
    AND l."createdAt" >= NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY 1`
for (const r of days) console.log(`  ${r.d}  ${int(r.n)}`)

console.log('\n═══ 5 · what status do they report? ═══')
const st = await prisma.$queryRaw<Array<{s:string|null;n:bigint}>>`
  SELECT l."amazonResponseStatus" AS s, COUNT(*)::bigint AS n
  FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id = l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t."externalTargetId" IS NULL GROUP BY 1 ORDER BY 2 DESC`
for (const r of st) console.log(`  ${String(r.s ?? 'NULL').padEnd(12)} ${int(r.n)}`)
await prisma.$disconnect()
