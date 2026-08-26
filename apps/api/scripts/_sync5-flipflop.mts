/** SYNC.5 — the 36 campaign-status drift rows: who put the WRONG value there? */
import prisma from '../src/db.js'

console.log('=== every CAMPAIGN status drift row ever, in time order ===')
const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "entityName", "ourValue", "amazonValue", classification, occurrences,
         "firstDetectedAt", "lastDetectedAt", "resolvedAt", marketplace
  FROM "AdDrift" WHERE "entityType"='CAMPAIGN' AND field='status'
  ORDER BY "firstDetectedAt" ASC`)
for (const r of rows) {
  const mins = ((r.resolvedAt ?? new Date()).getTime() - r.firstDetectedAt.getTime()) / 60000
  console.log(`  ${r.firstDetectedAt.toISOString().slice(0,16)} ${String(r.marketplace).padEnd(3)} ${String(r.entityName).slice(0,38).padEnd(38)} ours=${String(r.ourValue).padEnd(8)} amazon=${String(r.amazonValue).padEnd(8)} ${String(r.classification).padEnd(15)} x${String(r.occurrences).padStart(3)} open=${mins.toFixed(0)}m`)
}

console.log('\n=== the OTHER campaign writer: v1 export ingest cron runs ===')
for (const job of ['ads-v1-export-ingest', 'ads-v1-ingest', 'ads-v1-export-create', 'ads-v1-export-poll']) {
  const runs = await prisma.cronRun.findMany({ where: { jobName: job }, orderBy: { startedAt: 'desc' }, take: 4, select: { startedAt: true, status: true, outputSummary: true } })
  if (!runs.length) continue
  console.log(`  -- ${job}`)
  for (const r of runs) console.log(`     ${r.startedAt.toISOString().slice(0,16)} ${String(r.status).padEnd(8)} ${r.outputSummary ?? ''}`)
}

console.log('\n=== all cron jobs that ran in the last 24h (which ones touch campaigns?) ===')
const jobs = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "jobName", COUNT(*)::int AS runs, MAX("startedAt") AS last_run
  FROM "CronRun" WHERE "startedAt" > now() - interval '24 hours'
  GROUP BY 1 ORDER BY 1`)
for (const j of jobs) console.log(`  ${String(j.jobName).padEnd(36)} runs=${String(j.runs).padStart(4)} last=${j.last_run?.toISOString?.().slice(0,16)}`)

console.log('\n=== V1 export jobs: how stale is the data they ingest? ===')
try {
  const ex = await prisma.$queryRawUnsafe<any[]>(`
    SELECT resource, status, "rowsIngested", "createdAt", "updatedAt"
    FROM "AdsV1ExportJob" ORDER BY "createdAt" DESC LIMIT 10`)
  for (const e of ex) console.log(`  ${String(e.resource).padEnd(14)} ${String(e.status).padEnd(11)} rows=${String(e.rowsIngested).padStart(5)} created=${e.createdAt?.toISOString?.().slice(0,16)} updated=${e.updatedAt?.toISOString?.().slice(0,16)}`)
} catch (e) { console.log('  (table name differs):', (e as Error).message.slice(0, 120)) }

await prisma.$disconnect()
