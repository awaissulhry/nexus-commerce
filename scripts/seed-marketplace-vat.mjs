#!/usr/bin/env node
// A.1 — Seed Marketplace.vatRate + taxInclusive on the live DB.
//
// The schema has both columns (Marketplace.vatRate Decimal? + Marketplace.taxInclusive Boolean)
// but seed-marketplaces.ts shipped without them. As a result every marketplace had
// vatRate=NULL + taxInclusive=false in production, which silently disabled the engine's
// VAT block (pricing-engine.service.ts:404-422) for Amazon EU + UK. Net effect: every
// EU listing was underpriced by 19-25% relative to what consumers should see.
//
// This script is idempotent — re-running just confirms the state. It only updates rows
// whose values actually differ from the target.
//
// Usage: node scripts/seed-marketplace-vat.mjs [--dry-run]
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const dryRun = process.argv.includes('--dry-run')

// Same source-of-truth as packages/database/scripts/seed-marketplaces.ts.
// Standard 2026 VAT rates. Amazon EU + UK + eBay EU + UK are tax-inclusive
// (consumer sees gross). Amazon US, Shopify, Woo, Etsy are tax-exclusive.
const TARGETS = [
  { channel: 'AMAZON', code: 'IT', vatRate: '22.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'DE', vatRate: '19.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'FR', vatRate: '20.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'ES', vatRate: '21.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'UK', vatRate: '20.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'NL', vatRate: '21.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'SE', vatRate: '25.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'PL', vatRate: '23.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'US', vatRate: null,    taxInclusive: false },
  { channel: 'EBAY',   code: 'IT', vatRate: '22.00', taxInclusive: true },
  { channel: 'EBAY',   code: 'DE', vatRate: '19.00', taxInclusive: true },
  { channel: 'EBAY',   code: 'FR', vatRate: '20.00', taxInclusive: true },
  { channel: 'EBAY',   code: 'ES', vatRate: '21.00', taxInclusive: true },
  { channel: 'EBAY',   code: 'UK', vatRate: '20.00', taxInclusive: true },
  { channel: 'SHOPIFY',     code: 'GLOBAL', vatRate: null, taxInclusive: false },
  { channel: 'WOOCOMMERCE', code: 'GLOBAL', vatRate: null, taxInclusive: false },
  { channel: 'ETSY',        code: 'GLOBAL', vatRate: null, taxInclusive: false },
]

const c = new pg.Client({ connectionString: url })
await c.connect()

console.log(dryRun ? '[DRY RUN] No writes' : '[LIVE] Writing to DB')
console.log()

const before = await c.query(`
  SELECT channel, code, "vatRate", "taxInclusive"
  FROM "Marketplace" ORDER BY channel, code`)
console.log('=== Before ===')
console.table(before.rows.map(r => ({
  channel: r.channel, code: r.code,
  vatRate: r.vatRate ?? '(null)',
  taxInclusive: r.taxInclusive,
})))

let updated = 0
let unchanged = 0
let missing = 0
for (const t of TARGETS) {
  const cur = before.rows.find(r => r.channel === t.channel && r.code === t.code)
  if (!cur) {
    console.log(`  MISSING row: ${t.channel}:${t.code} — run seed-marketplaces.ts first`)
    missing++
    continue
  }
  const curVat = cur.vatRate == null ? null : String(cur.vatRate)
  const targetVat = t.vatRate
  if (curVat === targetVat && cur.taxInclusive === t.taxInclusive) {
    unchanged++
    continue
  }
  if (!dryRun) {
    await c.query(
      `UPDATE "Marketplace" SET "vatRate" = $1, "taxInclusive" = $2, "updatedAt" = now()
       WHERE channel = $3 AND code = $4`,
      [t.vatRate, t.taxInclusive, t.channel, t.code],
    )
  }
  console.log(`  ${dryRun ? 'would update' : 'updated'}: ${t.channel}:${t.code} → vatRate=${t.vatRate ?? '(null)'} taxInclusive=${t.taxInclusive}`)
  updated++
}

console.log()
console.log(`Summary: updated=${updated} unchanged=${unchanged} missing=${missing}`)

if (!dryRun && updated > 0) {
  const after = await c.query(`
    SELECT channel, code, "vatRate", "taxInclusive"
    FROM "Marketplace" ORDER BY channel, code`)
  console.log()
  console.log('=== After ===')
  console.table(after.rows.map(r => ({
    channel: r.channel, code: r.code,
    vatRate: r.vatRate ?? '(null)',
    taxInclusive: r.taxInclusive,
  })))
}

await c.end()
