// Read-only verifier for the eBay shared-SKU round-trip.
// Usage: node scripts/_shared-verify.mjs <CHILD_SKU>
// Prints: the child Product(s), its SharedListingMembership rows (per-listing
// price + productId link), and any pending inventory fan-out for those ItemIDs.
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', '')
const sku = process.argv[2]
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
if (!sku) { console.error('usage: node scripts/_shared-verify.mjs <CHILD_SKU>'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()
const line = '─'.repeat(60)
try {
  console.log(line)
  console.log(`CHILD SKU: ${sku}`)
  console.log(line)

  // 1) Exactly ONE Product per SKU (create-on-save must not duplicate)
  const prod = await c.query(
    `SELECT id, sku, status, "isParent", "parentId", "importSource", "totalStock"
       FROM "Product" WHERE sku=$1 AND "deletedAt" IS NULL`, [sku])
  console.log(`\n[1] Product rows for SKU (expect exactly 1): ${prod.rowCount}`)
  for (const p of prod.rows) console.log('   ', JSON.stringify(p))

  // 2) Memberships — one per shared parent, each with per-listing price + non-null productId
  const mem = await c.query(
    `SELECT marketplace, "parentSku", "itemId", price, "productId", status, "lastQtyPushed", "lastError"
       FROM "SharedListingMembership" WHERE sku=$1 ORDER BY "parentSku", marketplace`, [sku])
  console.log(`\n[2] SharedListingMembership rows (expect >=2: one per shared parent): ${mem.rowCount}`)
  for (const m of mem.rows) console.log('   ', JSON.stringify(m))
  const distinctParents = new Set(mem.rows.map(m => m.parentSku))
  const nullPid = mem.rows.filter(m => m.productId == null).length
  console.log(`    → distinct parents: ${distinctParents.size} | rows with NULL productId (want 0): ${nullPid}`)
  console.log(`    → distinct ItemIDs: ${new Set(mem.rows.map(m => m.itemId)).size} (each parent should have its own eBay ItemID)`)
  console.log(`    → prices: ${mem.rows.map(m => `${m.parentSku}=${m.price}`).join(', ')} (should differ per your test)`)

  // 3) Inventory fan-out queued for those ItemIDs (after a stock change)
  const itemIds = [...new Set(mem.rows.map(m => m.itemId).filter(Boolean))]
  if (itemIds.length) {
    const q = await c.query(
      `SELECT "externalListingId", "syncType", "syncStatus", (payload->>'quantity') AS qty, "createdAt"
         FROM "OutboundSyncQueue"
        WHERE "externalListingId" = ANY($1) AND "syncType"='QUANTITY_UPDATE'
        ORDER BY "createdAt" DESC LIMIT 10`, [itemIds]).catch(e => ({ rows: [], err: e.message }))
    console.log(`\n[3] Fan-out QUANTITY_UPDATE queue for ItemIDs [${itemIds.join(', ')}] (after a stock change, expect one per ItemID):`)
    if (q.err) console.log('    (queue query skipped:', q.err, ')')
    for (const r of q.rows) console.log('   ', JSON.stringify(r))
    if (!q.rows?.length && !q.err) console.log('    (none yet — expected until you change stock)')
  }
  console.log('\n' + line)
} finally {
  await c.end()
}
