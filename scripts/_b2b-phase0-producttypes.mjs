import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here=path.dirname(fileURLToPath(import.meta.url)); dotenv.config({path:path.join(here,'..','.env')})
const c=new pg.Client({connectionString:process.env.DATABASE_URL?.replace('-pooler','')}); await c.connect()
const r=await c.query(`SELECT COALESCE(NULLIF(cl."platformAttributes"->>'productType',''), p."productType", '(none)') pt, count(*) n
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId" WHERE cl.channel='AMAZON' GROUP BY 1 ORDER BY n DESC`)
console.log('Amazon listing productTypes:'); r.rows.forEach(x=>console.log(`  ${x.pt}: ${x.n}`))
const s=await c.query(`SELECT "productType", marketplace, "channel" FROM "CategorySchema" WHERE "channel"='AMAZON' ORDER BY "productType", marketplace`)
console.log(`\nCached CategorySchema rows (${s.rows.length}):`); s.rows.slice(0,40).forEach(x=>console.log(`  ${x.productType} [${x.marketplace}]`))
await c.end()
