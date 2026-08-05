import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const MARK=new Date().toISOString()
for (let i=0;i<50;i++){
  const ex = await q(`SELECT status, COUNT(*) AS n FROM "AutomationRuleExecution"
    WHERE "startedAt" > '${MARK}'::timestamptz GROUP BY 1 ORDER BY 2 DESC`)
  if (ex.length) {
    const w = await q(`SELECT COUNT(*) AS mutations FROM "AdMutation"
      WHERE "createdAt" > '${MARK}'::timestamptz AND actor NOT LIKE '%rank-defend%'`)
    const f = await q(`SELECT left(COALESCE("errorMessage",'-'),60) AS err, COUNT(*) AS n
      FROM "AutomationRuleExecution" WHERE "startedAt" > '${MARK}'::timestamptz AND status='FAILED'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 3`)
    console.log(`N5 FIRST-RUN · exec=${JSON.stringify(ex,(_k,v)=>typeof v==='bigint'?Number(v):v)} · nonRankMutations=${JSON.stringify(w,(_k,v)=>typeof v==='bigint'?Number(v):v)} · failures=${JSON.stringify(f,(_k,v)=>typeof v==='bigint'?Number(v):v)}`)
    await p.$disconnect(); process.exit(0)
  }
  await new Promise((r)=>setTimeout(r,30_000))
}
console.log('N5 TIMEOUT — no executions in ~25 min')
await p.$disconnect()
