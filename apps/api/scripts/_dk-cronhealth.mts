import prisma from '../src/db.js'
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "jobName", "status", MAX("startedAt")::text AS last_run, COUNT(*)::int AS runs_24h
  FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '24 hours'
    AND ("jobName" ILIKE '%amazon%' OR "jobName" ILIKE '%ads%' OR "jobName" ILIKE '%kiosk%')
  GROUP BY 1,2 ORDER BY 1, 2`)
console.table(r)
await prisma.$disconnect()
