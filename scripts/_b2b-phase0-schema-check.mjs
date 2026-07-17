// READ-ONLY Phase-0 gate check: does each in-use productType's cached Amazon
// schema allow purchasable_offer.audience = "B2B" + quantity_discount_plan?
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL?.replace('-pooler', '') }); await c.connect()

const PTS = ['OUTERWEAR', 'SUIT', 'AUTO_ACCESSORY', 'PANTS', 'GLOVES']

// recursively collect every value stored under a given key name
function collect(obj, key, out = []) {
  if (obj == null || typeof obj !== 'object') return out
  if (Array.isArray(obj)) { for (const v of obj) collect(v, key, out); return out }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v)
    collect(v, key, out)
  }
  return out
}

for (const pt of PTS) {
  const rows = (await c.query(
    `SELECT marketplace, "schemaDefinition", "fetchedAt" FROM "CategorySchema"
     WHERE "channel"='AMAZON' AND "productType"=$1 ORDER BY marketplace, "fetchedAt" DESC`, [pt],
  )).rows
  if (rows.length === 0) { console.log(`\n${pt}: (no cached schema)`); continue }
  console.log(`\n=== ${pt} ===`)
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.marketplace)) continue // latest per market
    seen.add(r.marketplace)
    const def = r.schemaDefinition ?? {}
    const po = def?.properties?.purchasable_offer
    if (!po) { console.log(`  [${r.marketplace}] purchasable_offer: ABSENT`); continue }
    const poStr = JSON.stringify(po)
    const hasB2B = poStr.includes('"B2B"')
    const hasQty = poStr.includes('quantity_discount_plan')
    // pull the audience enum(s) if present
    const audDefs = collect(po, 'audience')
    const enums = [...new Set(collect(audDefs, 'enum').flat())]
    console.log(`  [${r.marketplace}] B2B:${hasB2B ? '✓' : '✗'}  quantity_discount_plan:${hasQty ? '✓' : '✗'}  audience-enum:[${enums.slice(0, 12).join(', ')}${enums.length > 12 ? ', …' : ''}]`)
  }
}
await c.end()
