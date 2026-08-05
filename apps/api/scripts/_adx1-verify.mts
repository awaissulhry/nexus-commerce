/** ADX.1 verification — waits for the first post-deploy evaluator tick, then reports the status mix. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const n = (v: unknown) => Number(v ?? 0)
const MARK = process.argv[2]  // ISO timestamp: only count work after this

for (let i = 0; i < 60; i++) {
  const runs = await q(`SELECT COUNT(*) AS c FROM "CronRun"
    WHERE "jobName"='advertising-rule-evaluator' AND "startedAt" > '${MARK}'::timestamp`)
  if (n(runs[0]?.c) > 0) {
    const mix = await q(`SELECT status, COUNT(*) AS c FROM "AutomationRuleExecution"
      WHERE "startedAt" > '${MARK}'::timestamp GROUP BY 1 ORDER BY 2 DESC`)
    const cap = await q(`SELECT COUNT(*) AS c FROM "AutomationRuleExecution"
      WHERE "startedAt" > '${MARK}'::timestamp AND "errorMessage"='DAILY_CAP_EXCEEDED'`)
    const summary = await q(`SELECT "outputSummary" FROM "CronRun"
      WHERE "jobName"='advertising-rule-evaluator' AND "startedAt" > '${MARK}'::timestamp
      ORDER BY "startedAt" DESC LIMIT 1`)
    console.log(`ADX.1 VERIFY · ticks=${n(runs[0]?.c)} · statusMix=${JSON.stringify(mix.map(r=>`${r.status}:${n(r.c)}`))} · newCapRows=${n(cap[0]?.c)} (must be 0)`)
    console.log(`cron summary: ${summary[0]?.outputSummary ?? '(none)'}`)
    await p.$disconnect(); process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 30_000))
}
console.log('ADX.1 VERIFY: timed out waiting for an evaluator tick')
await p.$disconnect()
