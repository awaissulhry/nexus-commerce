/** SYNC.7 — who set 36 campaigns ENABLED on 2026-08-21, and is the v1 export pipeline alive? */
import prisma from '../src/db.js'

console.log('=== AdvertisingActionLog 2026-08-21 17:00-21:00 ===')
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: new Date('2026-08-21T17:00:00Z'), lte: new Date('2026-08-21T21:00:00Z') } },
  orderBy: { createdAt: 'asc' }, take: 40,
  select: { createdAt: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, userId: true, amazonResponseStatus: true },
})
if (!logs.length) console.log('  (no action-log rows in that window)')
for (const l of logs) console.log(`  ${l.createdAt.toISOString().slice(0,16)} ${String(l.actionType).padEnd(20)} ${String(l.entityType).padEnd(9)} before=${JSON.stringify(l.payloadBefore).slice(0,50)} after=${JSON.stringify(l.payloadAfter).slice(0,50)} user=${l.userId ?? '-'}`)

console.log('\n=== every status-ish actionType ever ===')
const kinds = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "actionType", COUNT(*)::int AS n, MAX("createdAt") AS last FROM "AdvertisingActionLog"
  GROUP BY 1 ORDER BY 2 DESC LIMIT 25`)
for (const r of kinds) console.log(`  ${String(r.actionType).padEnd(28)} n=${String(r.n).padStart(6)} last=${r.last?.toISOString?.().slice(0,16)}`)

console.log('\n=== AmazonAdsExportJob: is the v1 pipeline delivering? (last 24h) ===')
const ex = await prisma.$queryRawUnsafe<any[]>(`
  SELECT resource::text AS resource, status::text AS status, COUNT(*)::int AS n,
         SUM("rowsIngested")::int AS rows, MAX("createdAt") AS newest
  FROM "AmazonAdsExportJob" WHERE "createdAt" > now() - interval '24 hours'
  GROUP BY 1,2 ORDER BY 1,2`)
if (!ex.length) console.log('  (no export jobs in 24h)')
for (const x of ex) console.log(`  ${String(x.resource).padEnd(16)} ${String(x.status).padEnd(12)} n=${String(x.n).padStart(4)} rowsIngested=${String(x.rows).padStart(6)} newest=${x.newest?.toISOString?.().slice(0,16)}`)

console.log('\n=== AmazonAdsExportJob all-time by status ===')
const ex2 = await prisma.$queryRawUnsafe<any[]>(`
  SELECT status::text AS status, COUNT(*)::int AS n, SUM("rowsIngested")::int AS rows,
         MIN("createdAt") AS oldest, MAX("createdAt") AS newest
  FROM "AmazonAdsExportJob" GROUP BY 1 ORDER BY 2 DESC`)
for (const x of ex2) console.log(`  ${String(x.status).padEnd(12)} n=${String(x.n).padStart(5)} rowsIngested=${String(x.rows).padStart(7)} oldest=${x.oldest?.toISOString?.().slice(0,16)} newest=${x.newest?.toISOString?.().slice(0,16)}`)

console.log('\n=== last successful campaigns-resource ingest (the ONLY SD/SB state source) ===')
const last = await prisma.$queryRawUnsafe<any[]>(`
  SELECT resource::text AS resource, status::text AS status, "rowsIngested", "createdAt", "updatedAt", LEFT(COALESCE("errorMessage",''),120) AS err
  FROM "AmazonAdsExportJob" WHERE resource::text ILIKE '%campaign%'
  ORDER BY "createdAt" DESC LIMIT 12`)
for (const x of last) console.log(`  ${String(x.resource).padEnd(14)} ${String(x.status).padEnd(11)} rows=${String(x.rowsIngested).padStart(5)} created=${x.createdAt?.toISOString?.().slice(0,16)} err=${x.err || '-'}`)

await prisma.$disconnect()
