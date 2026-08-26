/** SYNC.6 — who set 36 campaigns ENABLED on 2026-08-21, and is the v1 pipeline alive? */
import prisma from '../src/db.js'

console.log('=== AdvertisingActionLog around 2026-08-21 18:00-20:00 ===')
try {
  const logs = await prisma.$queryRawUnsafe<any[]>(`
    SELECT "createdAt", "actionType", "entityType", "entityName", "oldValue", "newValue", source, "ruleName"
    FROM "AdvertisingActionLog"
    WHERE "createdAt" BETWEEN '2026-08-21 17:00' AND '2026-08-21 21:00'
    ORDER BY "createdAt" ASC LIMIT 40`)
  if (!logs.length) console.log('  (no action-log rows in that window)')
  for (const l of logs) console.log(`  ${l.createdAt.toISOString().slice(0,16)} ${String(l.actionType).padEnd(18)} ${String(l.entityType).padEnd(10)} ${String(l.entityName).slice(0,28).padEnd(28)} ${l.oldValue}->${l.newValue} src=${l.source ?? '-'} rule=${l.ruleName ?? '-'}`)
} catch (e) { console.log('  err:', (e as Error).message.slice(0, 160)) }

console.log('\n=== any status-changing action-log rows, ever, by source ===')
try {
  const s = await prisma.$queryRawUnsafe<any[]>(`
    SELECT "actionType", source, COUNT(*)::int AS n, MAX("createdAt") AS last
    FROM "AdvertisingActionLog" WHERE "actionType" ILIKE '%status%' OR "actionType" ILIKE '%state%' OR "actionType" ILIKE '%pause%' OR "actionType" ILIKE '%enable%'
    GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`)
  if (!s.length) console.log('  (none)')
  for (const r of s) console.log(`  ${String(r.actionType).padEnd(24)} src=${String(r.source).padEnd(14)} n=${String(r.n).padStart(5)} last=${r.last?.toISOString?.().slice(0,16)}`)
} catch (e) { console.log('  err:', (e as Error).message.slice(0, 160)) }

console.log('\n=== v1 export pipeline health: job rows by status ===')
const tbls = await prisma.$queryRawUnsafe<any[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%v1%'`)
console.log('  tables:', tbls.map((t) => t.table_name).join(', ') || '(none)')
for (const t of tbls) {
  try {
    const r = await prisma.$queryRawUnsafe<any[]>(`SELECT status, COUNT(*)::int AS n, MAX("createdAt") AS newest, SUM("rowsIngested")::int AS rows FROM "${t.table_name}" GROUP BY 1 ORDER BY 2 DESC`)
    console.log(`  -- ${t.table_name}`)
    for (const x of r) console.log(`     ${String(x.status).padEnd(12)} n=${String(x.n).padStart(5)} newest=${x.newest?.toISOString?.().slice(0,16)} rowsIngested=${x.rows}`)
  } catch (e) { console.log(`  -- ${t.table_name}: ${(e as Error).message.slice(0, 100)}`) }
}

console.log('\n=== v1 exports created in the last 24h and what became of them ===')
try {
  const r = await prisma.$queryRawUnsafe<any[]>(`
    SELECT resource, status, COUNT(*)::int AS n, MAX("createdAt") AS newest
    FROM "AdsV1ExportJob" WHERE "createdAt" > now() - interval '24 hours'
    GROUP BY 1,2 ORDER BY 1,2`)
  if (!r.length) console.log('  (none created in 24h)')
  for (const x of r) console.log(`  ${String(x.resource).padEnd(14)} ${String(x.status).padEnd(12)} n=${String(x.n).padStart(4)} newest=${x.newest?.toISOString?.().slice(0,16)}`)
} catch (e) { console.log('  err:', (e as Error).message.slice(0, 160)) }

await prisma.$disconnect()
