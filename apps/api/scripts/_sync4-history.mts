/** SYNC.4 — the forensic record: how long has Amazon ever disagreed with us, historically? */
import prisma from '../src/db.js'

console.log('=== AdDrift status rows EVER recorded (incl. resolved) ===')
const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "entityType", field, COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE "resolvedAt" IS NULL)::int AS open,
         MIN("firstDetectedAt") AS first_seen,
         MAX(EXTRACT(EPOCH FROM (COALESCE("resolvedAt", now()) - "firstDetectedAt"))/60)::int AS max_open_minutes,
         AVG(EXTRACT(EPOCH FROM (COALESCE("resolvedAt", now()) - "firstDetectedAt"))/60)::int AS avg_open_minutes
  FROM "AdDrift" GROUP BY 1,2 ORDER BY 3 DESC`)
if (!rows.length) console.log('  (AdDrift is EMPTY)')
for (const r of rows) console.log(`  ${String(r.entityType).padEnd(10)} ${String(r.field).padEnd(16)} n=${String(r.n).padStart(4)} open=${String(r.open).padStart(4)} first=${r.first_seen?.toISOString?.().slice(0,16)} maxOpen=${r.max_open_minutes}min avgOpen=${r.avg_open_minutes}min`)

console.log('\n=== Which entity types does drift detection cover AT ALL? ===')
const types = await prisma.$queryRawUnsafe<any[]>(`SELECT "entityType", COUNT(*)::int AS n FROM "AdDrift" GROUP BY 1 ORDER BY 2 DESC`)
for (const r of types) console.log(`  ${String(r.entityType).padEnd(12)} n=${r.n}`)

console.log('\n=== Entity populations, for comparison ===')
for (const [label, n] of [
  ['Campaign', await prisma.campaign.count()],
  ['AdGroup', await prisma.adGroup.count()],
  ['AdTarget', await prisma.adTarget.count()],
  ['AdProductAd', await prisma.adProductAd.count()],
] as [string, number][]) console.log(`  ${label.padEnd(12)} ${n}`)

console.log('\n=== AdGroup / AdTarget / ProductAd state freshness (lastSyncedAt) ===')
for (const t of ['AdGroup', 'AdTarget', 'AdProductAd']) {
  try {
    const r = await prisma.$queryRawUnsafe<any[]>(`
      SELECT status, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE "lastSyncedAt" IS NULL)::int AS never_synced,
             COUNT(*) FILTER (WHERE "lastSyncedAt" < now() - interval '24 hours')::int AS older_24h
      FROM "${t}" GROUP BY 1 ORDER BY 2 DESC`)
    console.log(`  -- ${t}`)
    for (const x of r) console.log(`     ${String(x.status).padEnd(9)} n=${String(x.n).padStart(5)} neverSynced=${String(x.never_synced).padStart(5)} >24h=${String(x.older_24h).padStart(5)}`)
  } catch (e) { console.log(`  -- ${t}: ${(e as Error).message.slice(0, 90)}`) }
}

console.log('\n=== Campaign status: when did rows last actually CHANGE status? (settingsSyncedAt vs updatedAt) ===')
const cs = await prisma.$queryRawUnsafe<any[]>(`
  SELECT date_trunc('day', "updatedAt") AS day, COUNT(*)::int AS n
  FROM "Campaign" GROUP BY 1 ORDER BY 1 DESC LIMIT 5`)
for (const r of cs) console.log(`  ${r.day?.toISOString?.().slice(0,10)} rows touched=${r.n}`)

await prisma.$disconnect()
