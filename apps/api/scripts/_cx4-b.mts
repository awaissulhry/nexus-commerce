import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
console.error('=== per-channel totals ===')
for (const r of await q(`
  SELECT "channel", COUNT(*)::int AS rows, MAX("createdAt")::text AS newest, MIN("createdAt")::text AS oldest,
         SUM(CASE WHEN "isProcessed" THEN 0 ELSE 1 END)::int AS unproc,
         SUM(CASE WHEN "error" IS NOT NULL THEN 1 ELSE 0 END)::int AS err,
         SUM(CASE WHEN "signature" IS NOT NULL THEN 1 ELSE 0 END)::int AS signed,
         SUM(CASE WHEN "providerTimestamp" IS NOT NULL THEN 1 ELSE 0 END)::int AS hasprovts
  FROM "WebhookEvent" GROUP BY 1 ORDER BY 2 DESC`))
  console.error(`  ${String(r.channel).padEnd(10)} rows=${String(r.rows).padStart(6)} unproc=${String(r.unproc).padStart(5)} err=${String(r.err).padStart(4)} signed=${String(r.signed).padStart(6)} provTs=${String(r.hasprovts).padStart(6)} newest=${r.newest}`)
console.error('\n=== ANY_OFFER_CHANGED daily, last 14d (is it stale?) ===')
for (const r of await q(`
  SELECT DATE("createdAt")::text AS day, COUNT(*)::int AS rows FROM "WebhookEvent"
  WHERE "eventType"='ANY_OFFER_CHANGED' AND "createdAt" > NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1 DESC`))
  console.error(`  ${r.day}  ${r.rows}`)
console.error('\n=== unprocessed backlog: oldest 5 ===')
for (const r of await q(`
  SELECT "channel","eventType","createdAt"::text AS at, LEFT(COALESCE("error",''),90) AS err
  FROM "WebhookEvent" WHERE "isProcessed"=false ORDER BY "createdAt" ASC LIMIT 5`))
  console.error(`  ${r.at}  ${r.channel}/${r.eventType}  err=${r.err || '(none)'}`)
console.error('\n=== errors, grouped ===')
for (const r of await q(`
  SELECT LEFT("error",70) AS err, COUNT(*)::int AS rows, MAX("createdAt")::text AS newest
  FROM "WebhookEvent" WHERE "error" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`))
  console.error(`  ${String(r.rows).padStart(5)}  ${r.newest}  ${r.err}`)
process.exit(0)
