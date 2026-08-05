import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<any[]>(s)
const n=(v:any)=>typeof v==='bigint'?Number(v):v
const show=(r:any[])=>r.length?r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${n(v)}`).join('  '))):console.log('  (none)')
console.log('— IS THE NEW CODE RUNNING? ads rows in OutboundApiCallLog only exist post-ACR.0.6 —')
show(await q(`SELECT operation, COUNT(*)::int AS n, MAX("createdAt")::text AS last
  FROM "OutboundApiCallLog" WHERE operation LIKE 'ads %' GROUP BY operation ORDER BY n DESC LIMIT 8`))
console.log('\n— any OutboundApiCallLog rows at all in the last 15 min —')
show(await q(`SELECT operation, COUNT(*)::int AS n FROM "OutboundApiCallLog"
  WHERE "createdAt" > now() - interval '15 minutes' GROUP BY operation ORDER BY n DESC LIMIT 8`))
await p.$disconnect(); process.exit(0)
