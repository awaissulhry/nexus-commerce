// READ-ONLY: inspect the cached OUTERWEAR/IT schema closely — fetch age, the exact
// `audience` definition, and where "B2B" / "quantity_discount_plan" appear (if at all).
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL?.replace('-pooler', '') }); await c.connect()

const rows = (await c.query(
  `SELECT "productType", marketplace, "fetchedAt", "expiresAt", "schemaDefinition"
   FROM "CategorySchema" WHERE "channel"='AMAZON' AND "productType" IN ('OUTERWEAR','AUTO_ACCESSORY')
   ORDER BY "productType", marketplace, "fetchedAt" DESC`,
)).rows

const seen = new Set()
for (const r of rows) {
  const key = `${r.productType}/${r.marketplace}`
  if (seen.has(key)) continue
  seen.add(key)
  const def = r.schemaDefinition ?? {}
  const full = JSON.stringify(def)
  const po = def?.properties?.purchasable_offer
  console.log(`\n=== ${key} === fetched ${new Date(r.fetchedAt).toISOString().slice(0,10)} expires ${r.expiresAt ? new Date(r.expiresAt).toISOString().slice(0,10) : '?'}`)
  console.log(`  full-schema mentions: "B2B" ×${(full.match(/B2B/g)||[]).length}, "quantity_discount_plan" ×${(full.match(/quantity_discount_plan/g)||[]).length}, "audience" ×${(full.match(/audience/g)||[]).length}`)
  // find the audience definition inside purchasable_offer
  function find(obj, key, out=[]) { if(obj&&typeof obj==='object'){ if(Array.isArray(obj)){for(const v of obj)find(v,key,out)} else {for(const[k,v]of Object.entries(obj)){if(k===key)out.push(v);find(v,key,out)}}} return out }
  const aud = find(po, 'audience')
  console.log('  purchasable_offer.audience definition(s):')
  console.log('   ', JSON.stringify(aud).slice(0, 600))
}
await c.end()
