/** AX-ZD.3 — is the settings sync still healthy after the hold-back change? */
import prisma from '../src/db.js'

const runs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "status", "outputSummary", "errorMessage", "startedAt"::text
  FROM "CronRun" WHERE "jobName" = 'ads-campaign-settings-sync'
  ORDER BY "startedAt" DESC LIMIT 4`)
for (const r of runs) console.log(JSON.stringify(r))
console.log('open drifts   :', await prisma.adDrift.count({ where: { resolvedAt: null } }))
console.log('AdMutation    :', await prisma.adMutation.count())
await prisma.$disconnect()
