import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL?.replace('-pooler','') }); await c.connect()
const q = async (l,s)=>{ try{return (await c.query(s)).rows}catch(e){console.log(`[${l}] ${e.message}`);return[]} }
console.log('=== ChannelPublishAttempt for GALE-JACKET-BLACK-MEN-4XL (last 30m) ===')
;(await q('cpa',`SELECT to_char("attemptedAt",'HH24:MI:SS') ts, marketplace mkt, mode, outcome, "errorCode" FROM "ChannelPublishAttempt" WHERE sku='GALE-JACKET-BLACK-MEN-4XL' AND "attemptedAt" > now() - interval '30 minutes' ORDER BY "attemptedAt" DESC LIMIT 8`)).forEach(r=>console.log(`  ${r.ts} [${r.mkt}] ${r.mode}/${r.outcome} ${r.errorCode??''}`))
console.log('\n=== OutboundApiCallLog AMAZON listings/patch ops (last 30m) ===')
;(await q('log',`SELECT to_char("createdAt",'HH24:MI:SS') ts, operation, success, "errorCode" FROM "OutboundApiCallLog" WHERE channel='AMAZON' AND "createdAt" > now() - interval '30 minutes' AND (operation ILIKE '%listing%' OR operation ILIKE '%patch%' OR operation ILIKE '%feed%') ORDER BY "createdAt" DESC LIMIT 8`)).forEach(r=>console.log(`  ${r.ts} ${r.operation} ok=${r.success} ${r.errorCode??''}`))
await c.end()
