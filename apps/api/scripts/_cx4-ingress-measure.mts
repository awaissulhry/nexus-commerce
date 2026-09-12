import prisma from '../src/db.js'
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)

console.error('=== WebhookEvent: volume + freshness per channel ===')
for (const r of await q(`
  SELECT "channel", COUNT(*)::int AS rows,
         MAX("createdAt")::text AS newest,
         MIN("createdAt")::text AS oldest,
         SUM(CASE WHEN "isProcessed" THEN 0 ELSE 1 END)::int AS unprocessed,
         SUM(CASE WHEN "error" IS NOT NULL THEN 1 ELSE 0 END)::int AS errored,
         SUM(CASE WHEN "signature" IS NOT NULL THEN 1 ELSE 0 END)::int AS signed
  FROM "WebhookEvent" GROUP BY 1 ORDER BY 2 DESC`))
  console.error(`  ${String(r.channel).padEnd(12)} rows=${String(r.rows).padStart(6)} unproc=${String(r.unprocessed).padStart(5)} err=${String(r.errored).padStart(4)} signed=${String(r.signed).padStart(6)}  newest=${r.newest}  oldest=${r.oldest}`)

console.error('\n=== eventType mix, last 90 days ===')
for (const r of await q(`
  SELECT "channel","eventType", COUNT(*)::int AS rows, MAX("createdAt")::text AS newest
  FROM "WebhookEvent" WHERE "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 25`))
  console.error(`  ${String(r.channel).padEnd(10)} ${String(r.eventType).padEnd(34)} ${String(r.rows).padStart(6)}  newest=${r.newest}`)

console.error('\n=== daily arrivals, last 45 days ===')
for (const r of await q(`
  SELECT DATE("createdAt")::text AS day, "channel", COUNT(*)::int AS rows
  FROM "WebhookEvent" WHERE "createdAt" > NOW() - INTERVAL '45 days'
  GROUP BY 1,2 ORDER BY 1 DESC LIMIT 30`))
  console.error(`  ${r.day}  ${String(r.channel).padEnd(10)} ${r.rows}`)

console.error('\n=== the 2026-07-29 claim: arrivals either side ===')
for (const r of await q(`
  SELECT DATE("createdAt")::text AS day, "channel", COUNT(*)::int AS rows
  FROM "WebhookEvent" WHERE "createdAt" BETWEEN '2026-07-20' AND '2026-08-10'
  GROUP BY 1,2 ORDER BY 1`))
  console.error(`  ${r.day}  ${String(r.channel).padEnd(10)} ${r.rows}`)
process.exit(0)
