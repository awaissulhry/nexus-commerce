#!/usr/bin/env node
// Verify W12.4 — CHANNEL_BATCH bulk-action wiring. Closes Wave 12.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW12.4 — CHANNEL_BATCH wiring\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)

console.log('Case 1: enum + ACTION_ENTITY')
check("CHANNEL_BATCH in BulkActionType union",
  /\| 'CHANNEL_BATCH'/.test(svc))
check('CHANNEL_BATCH in KNOWN_BULK_ACTION_TYPES',
  /'CHANNEL_BATCH',\s*\n\]\);/.test(svc))
check("ACTION_ENTITY maps CHANNEL_BATCH to 'product'",
  /CHANNEL_BATCH: 'product'/.test(svc))

console.log('\nCase 2: dispatcher')
check('processItem dispatches CHANNEL_BATCH',
  /case 'CHANNEL_BATCH':\s*\n\s*return await this\.processChannelBatch/.test(svc))
check('handler receives jobChannel',
  /processChannelBatch\(item as Product, payload, job\.channel\)/.test(svc))

console.log('\nCase 3: payload validation')
check('rejects unknown channel',
  /payload\.channel must be AMAZON \| EBAY \| SHOPIFY/.test(svc))
check('rejects unknown operation',
  /payload\.operation must be 'price' \| 'stock'/.test(svc))

console.log('\nCase 4: per-channel routing')
check("AMAZON branch lazy-imports amazon-batch-feed",
  /channel === 'AMAZON'[\s\S]{0,400}submitAmazonListingsBatch/.test(svc))
check('AMAZON requires AMAZON_SELLER_ID',
  /CHANNEL_BATCH AMAZON: AMAZON_SELLER_ID env required/.test(svc))
check('AMAZON marketplaceIds derived from payload.marketplace',
  /marketplaceIds = marketplace \? \[marketplace\] : \[\]/.test(svc))
check('AMAZON price → operations [{type:price, sku, currency, value}]',
  /\{ type: 'price', sku, currency, value \}/.test(svc))
check('AMAZON stock → operations [{type:stock, sku, quantity}]',
  /\{ type: 'stock', sku, quantity: qty \}/.test(svc))

check("EBAY branch lazy-imports ebay-parallel-batch",
  /channel === 'EBAY'[\s\S]{0,400}submitEbayParallelBatch/.test(svc))
check('EBAY resolves active ChannelConnection',
  /channelType: 'EBAY', isActive: true/.test(svc))
check('EBAY requires offerId for price ops',
  /if \(!offerId\) return \{ status: 'skipped' \}/.test(svc))

check("SHOPIFY branch lazy-imports shopify-bulk-mutation",
  /submitShopifyBulkMutation/.test(svc))
check('SHOPIFY price uses productVariantUpdate',
  /productVariantUpdate\(input: \$input\)/.test(svc))
check('SHOPIFY stock requires env-set inventoryItemId + locationId',
  /SHOPIFY_DEFAULT_INVENTORY_ITEM_GID \+ SHOPIFY_DEFAULT_LOCATION_GID/.test(svc))
check('SHOPIFY stock uses inventorySetQuantities',
  /inventorySetQuantities\(input: \$input\)/.test(svc))

console.log('\nCase 5: state extractors')
check('extractItemState handles CHANNEL_BATCH',
  /case 'CHANNEL_BATCH':[\s\S]{0,800}masterPrice:/.test(svc))
check('refetchAfterState reads back ChannelListing',
  /case 'CHANNEL_BATCH': \{[\s\S]{0,800}channelListing\.findFirst/.test(svc))

console.log('\nCase 6: skips')
check('skips when no ChannelListing for the channel/marketplace',
  /if \(!listing\) return \{ status: 'skipped' \}/.test(svc))
check('skips Amazon when computed price <= 0',
  /!Number\.isFinite\(value\) \|\| value <= 0/.test(svc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 12 complete)')
