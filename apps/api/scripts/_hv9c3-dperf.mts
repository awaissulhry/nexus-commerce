/** HV.9c.3 D-A — what actually bound performance to id-less targets? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')

console.log('\n═══ 1 · perf rows whose localEntityId points at an id-less AdTarget — ACCOUNT-WIDE ═══')
const bad = await prisma.$queryRaw<Array<{n:bigint;targets:bigint;first:Date;last:Date;created:Date}>>`
  SELECT COUNT(*)::bigint AS n, COUNT(DISTINCT p."localEntityId")::bigint AS targets,
         MIN(p.date) AS first, MAX(p.date) AS last, MAX(p."reportedAt") AS created
  FROM "AmazonAdsDailyPerformance" p JOIN "AdTarget" t ON t.id = p."localEntityId"
  WHERE p."entityType"='AD_TARGET' AND t."externalTargetId" IS NULL`
const b=bad[0]
console.log(`  ${int(b.n)} rows across ${int(b.targets)} id-less targets · dates ${b.first?.toISOString().slice(0,10)} → ${b.last?.toISOString().slice(0,10)} · newest reportedAt ${b.created?.toISOString().slice(0,16)}`)

console.log('\n═══ 2 · 🔴 does the perf row\'s OWN entityId match a DIFFERENT local row? ═══')
const mism = await prisma.$queryRaw<Array<{ext:string;n:bigint;owner:string|null;bound:string}>>`
  SELECT p."entityId" AS ext, COUNT(*)::bigint AS n,
         (SELECT o.id FROM "AdTarget" o WHERE o."externalTargetId" = p."entityId" LIMIT 1) AS owner,
         p."localEntityId" AS bound
  FROM "AmazonAdsDailyPerformance" p JOIN "AdTarget" t ON t.id = p."localEntityId"
  WHERE p."entityType"='AD_TARGET' AND t."externalTargetId" IS NULL
  GROUP BY 1,4 ORDER BY 2 DESC`
for (const m of mism) console.log(`  ext=${m.ext} rows=${int(m.n)} boundTo=${String(m.bound).slice(0,12)}… trueOwner=${m.owner?String(m.owner).slice(0,12)+'…':'🔴 none'} ${m.owner===m.bound?'MATCH':'🔴 MISBOUND'}`)

console.log('\n═══ 3 · when were those rows written? (reportedAt) ═══')
const when = await prisma.$queryRaw<Array<{d:string;n:bigint}>>`
  SELECT TO_CHAR(p."reportedAt",'YYYY-MM-DD') AS d, COUNT(*)::bigint AS n
  FROM "AmazonAdsDailyPerformance" p JOIN "AdTarget" t ON t.id = p."localEntityId"
  WHERE p."entityType"='AD_TARGET' AND t."externalTargetId" IS NULL GROUP BY 1 ORDER BY 1`
for (const r of when) console.log(`  reportedAt ${r.d}: ${int(r.n)} rows`)

console.log('\n═══ 4 · the resolver joins on externalTargetId — so how many local rows share one id NOW? ═══')
const dupes = await prisma.$queryRaw<Array<{n:bigint}>>`
  SELECT COUNT(*)::bigint AS n FROM (SELECT "externalTargetId" FROM "AdTarget"
    WHERE "externalTargetId" IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1) x`
console.log(`  external ids held by more than one AdTarget: ${int(dupes[0].n)}`)
console.log(`  → findFirst({where:{externalTargetId}}) is only ambiguous when that number is > 0.`)
await prisma.$disconnect()
