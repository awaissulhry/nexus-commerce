import prisma from '../src/db.js'
const r = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "jobName","status", COUNT(*)::int AS runs, MAX("startedAt")::text AS last_run
  FROM "CronRun" WHERE "jobName" ILIKE '%ams%' AND "startedAt" > NOW() - INTERVAL '3 hours'
  GROUP BY 1,2 ORDER BY 4 DESC`)
console.error(r.length
  ? r.map((x) => `AMS| ${x.jobName} ${x.status} runs=${x.runs} last=${x.last_run}`).join('\n')
  : 'AMS| NO RUNS IN 3h')
const any = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "jobName", MAX("startedAt")::text AS last_run FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '20 minutes' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`)
console.error('RECENT| ' + any.map((x) => `${x.jobName}@${String(x.last_run).slice(11,19)}`).join(' '))
process.exit(0)
