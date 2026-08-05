import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('brand field on products', await q(`
  SELECT brand, COUNT(*) AS n FROM "Product" WHERE brand IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`))
show('family tokens from advertised product names (2nd word after XAVIA)', await q(`
  SELECT DISTINCT split_part(upper(pr.name), ' ', 2) AS family, COUNT(*) AS products
  FROM "AdProductAd" pa
  JOIN "Product" pr ON pr.id = pa."productId"
  WHERE pr.name IS NOT NULL
  GROUP BY 1 HAVING COUNT(*) > 0 ORDER BY 2 DESC LIMIT 15`))
await p.$disconnect()
