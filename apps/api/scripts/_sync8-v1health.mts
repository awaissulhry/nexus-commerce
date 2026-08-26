/** SYNC.8 — the 46 state updates, and whether the v1 export (only SD/SB source) delivers. */
import prisma from '../src/db.js'

console.log('=== all AD_ENTITY_STATE_UPDATE rows ===')
const st = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_ENTITY_STATE_UPDATE' }, orderBy: { createdAt: 'asc' },
  select: { createdAt: true, entityType: true, payloadBefore: true, payloadAfter: true, userId: true, amazonResponseStatus: true },
})
for (const l of st) {
  const b: any = l.payloadBefore, a: any = l.payloadAfter
  console.log(`  ${l.createdAt.toISOString().slice(0,16)} ${String(l.entityType).padEnd(9)} ${String(b?.name ?? '').slice(0,30).padEnd(30)} ${b?.status ?? b?.state} -> ${a?.status ?? a?.state}  amz=${l.amazonResponseStatus ?? '-'} by=${l.userId ?? '-'}`)
}

console.log('\n=== AmazonAdsExportJob — last 24h ===')
const ex = await prisma.$queryRawUnsafe<any[]>(`
  SELECT resource::text AS r, status::text AS s, COUNT(*)::int AS n, SUM("rowsIngested")::int AS rows, MAX("createdAt") AS newest
  FROM "AmazonAdsExportJob" WHERE "createdAt" > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 1,2`)
if (!ex.length) console.log('  (none)')
for (const x of ex) console.log(`  ${String(x.r).padEnd(16)} ${String(x.s).padEnd(12)} n=${String(x.n).padStart(4)} rows=${String(x.rows).padStart(7)} newest=${x.newest?.toISOString?.().slice(0,16)}`)

console.log('\n=== AmazonAdsExportJob — all time by status ===')
const ex2 = await prisma.$queryRawUnsafe<any[]>(`
  SELECT status::text AS s, COUNT(*)::int AS n, SUM("rowsIngested")::int AS rows, MAX("createdAt") AS newest
  FROM "AmazonAdsExportJob" GROUP BY 1 ORDER BY 2 DESC`)
for (const x of ex2) console.log(`  ${String(x.s).padEnd(12)} n=${String(x.n).padStart(5)} rows=${String(x.rows).padStart(7)} newest=${x.newest?.toISOString?.().slice(0,16)}`)

console.log('\n=== last 15 campaigns-resource export jobs ===')
const last = await prisma.$queryRawUnsafe<any[]>(`
  SELECT resource::text AS r, status::text AS s, "rowsIngested", "createdAt", LEFT(COALESCE("errorMessage",''),100) AS err
  FROM "AmazonAdsExportJob" WHERE resource::text ILIKE '%ampaign%' ORDER BY "createdAt" DESC LIMIT 15`)
if (!last.length) console.log('  (no campaign-resource export jobs at all)')
for (const x of last) console.log(`  ${String(x.r).padEnd(14)} ${String(x.s).padEnd(11)} rows=${String(x.rowsIngested).padStart(5)} ${x.createdAt?.toISOString?.().slice(0,16)} err=${x.err || '-'}`)

console.log('\n=== SD/SB campaigns: when was each row last written at all? ===')
const sdsb = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "adProduct", name, status, marketplace, "lastSyncedAt", "updatedAt", "settingsSyncedAt"
  FROM "Campaign" WHERE "adProduct" <> 'SPONSORED_PRODUCTS' AND "externalCampaignId" IS NOT NULL
  ORDER BY "lastSyncedAt" DESC NULLS LAST`)
for (const c of sdsb) console.log(`  ${String(c.adProduct).padEnd(18)} ${String(c.name).slice(0,32).padEnd(32)} ${c.status} lastSynced=${c.lastSyncedAt?.toISOString?.().slice(0,16) ?? 'NEVER'} settingsSynced=${c.settingsSyncedAt?.toISOString?.().slice(0,16) ?? 'NEVER'}`)

await prisma.$disconnect()
