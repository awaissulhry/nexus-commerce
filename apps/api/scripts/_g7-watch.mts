import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const RULE='cmpuhjzot0003pk01xe1qxrkf'
const MARK=new Date().toISOString()
for (let i=0;i<45;i++){
  const r = await q(`SELECT status, "dryRun", COUNT(*) AS n, MAX("startedAt")::text AS last
    FROM "AutomationRuleExecution" WHERE "ruleId"='${RULE}' AND "startedAt" > '${MARK}'::timestamptz
    GROUP BY 1,2`)
  if (r.length) {
    const w = await q(`SELECT COUNT(*) AS n FROM "AdvertisingActionLog"
      WHERE "userId" LIKE '%retail-guard%' AND "createdAt" > '${MARK}'::timestamptz`)
    console.log(`G7 LIVE-RUN · ${JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v)} · guardWrites=${JSON.stringify(w,(_k,v)=>typeof v==='bigint'?Number(v):v)}`)
    await p.$disconnect(); process.exit(0)
  }
  await new Promise((r)=>setTimeout(r,30_000))
}
console.log('G7 TIMEOUT — no execution in ~22 min')
await p.$disconnect()
