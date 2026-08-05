import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('rules that have NEVER matched — what do they trigger on?', await q(`
  SELECT trigger, COUNT(*) AS rules, string_agg(left(name,34), ' | ') AS names
  FROM "AutomationRule"
  WHERE domain='advertising' AND enabled AND "matchCount"=0
  GROUP BY 1 ORDER BY 2 DESC`))
show('rules that DO match — their triggers', await q(`
  SELECT trigger, COUNT(*) AS rules, SUM("matchCount") AS matches
  FROM "AutomationRule"
  WHERE domain='advertising' AND enabled AND "matchCount">0
  GROUP BY 1 ORDER BY 3 DESC`))
show('search-term grain — is THAT ingested?', await q(`
  SELECT COUNT(*) AS rows, SUM(clicks) AS clicks,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS spend_eur,
         COUNT(*) FILTER (WHERE "costMicros">0 AND COALESCE("orders7d",0)=0) AS zero_sale_rows,
         ROUND((SUM("costMicros") FILTER (WHERE "costMicros">0 AND COALESCE("orders7d",0)=0)/1000000.0)::numeric,2) AS zero_sale_eur
  FROM "AmazonAdsSearchTerm"`))
await p.$disconnect()
