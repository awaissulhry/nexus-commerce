#!/usr/bin/env node
/**
 * S.23 verification — Shopify Locations UI + bidirectional sync.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8')
const shopifyWebhooks = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/shopify-webhooks.ts'), 'utf8')
const pagePath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/shopify-locations/page.tsx')
const clientPath = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/shopify-locations/ShopifyLocationsClient.tsx')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. UI page exists
if (fs.existsSync(pagePath)) ok('shopify-locations/page.tsx exists')
else bad('shopify-locations/page.tsx exists')
if (fs.existsSync(clientPath)) ok('shopify-locations/ShopifyLocationsClient.tsx exists')
else bad('shopify-locations/ShopifyLocationsClient.tsx exists')

const client = fs.readFileSync(clientPath, 'utf8')

// 2. Client wires the 3 endpoints
if (/api\/stock\/shopify-locations(?!\/discover|\/:)/.test(client) || /\/api\/stock\/shopify-locations`/.test(client)) {
  ok('client GETs /api/stock/shopify-locations')
} else {
  bad('client GETs /api/stock/shopify-locations')
}
if (/\/api\/stock\/shopify-locations\/discover/.test(client)) ok('client POSTs /discover')
else bad('client POSTs /discover')
if (/PATCH[\s\S]{0,80}\/api\/stock\/shopify-locations/.test(client) || /method:\s*'PATCH'[\s\S]*?api\/stock\/shopify-locations\/\$\{loc\.id\}/.test(client)) {
  ok('client PATCHes /:id (active toggle)')
} else {
  bad('client PATCHes /:id (active toggle)')
}

// 3. Discover triggers refetch
if (/runDiscover[\s\S]*?await fetchData\(\)/.test(client)) ok('discover refetches the list')
else bad('discover refetches the list')

// 4. Toggle handler + busy state
if (/togglingId/.test(client) && /toggleActive/.test(client)) ok('toggle active handler')
else bad('toggle active handler')

// 5. Empty state with discover CTA
if (/EmptyState[\s\S]*?stock\.shopifyLocations\.discover/.test(client)) {
  ok('EmptyState renders Discover CTA')
} else {
  bad('EmptyState renders Discover CTA')
}

// 6. Workspace links to /shopify-locations
if (/href="\/fulfillment\/stock\/shopify-locations"/.test(stockWorkspace)) {
  ok('workspace links to /shopify-locations')
} else {
  bad('workspace links to /shopify-locations')
}

// 7. Inbound webhook now uses resolveByShopifyId + applyStockMovement
if (/import \{ resolveByShopifyId \} from "\.\.\/services\/shopify-locations\.service\.js"/.test(shopifyWebhooks)) {
  ok('shopify-webhooks imports resolveByShopifyId')
} else {
  bad('shopify-webhooks imports resolveByShopifyId')
}
if (/await resolveByShopifyId\(shopifyLocationId\)/.test(shopifyWebhooks)) {
  ok('handleInventoryUpdate resolves Shopify location → Nexus')
} else {
  bad('handleInventoryUpdate resolves Shopify location → Nexus')
}
if (/await applyStockMovement\(\{[\s\S]*?reason:\s*'SYNC_RECONCILIATION',[\s\S]*?actor:\s*'shopify-webhook:inventory'/.test(shopifyWebhooks)) {
  ok('handleInventoryUpdate emits SYNC_RECONCILIATION movement')
} else {
  bad('handleInventoryUpdate emits SYNC_RECONCILIATION movement')
}
if (/unmapped Shopify location/.test(shopifyWebhooks)) {
  ok('handleInventoryUpdate logs + skips unmapped locations')
} else {
  bad('handleInventoryUpdate logs + skips unmapped locations')
}

// 8. Catalog parity
const newKeys = [
  'stock.shopifyLocations.title', 'stock.shopifyLocations.description',
  'stock.shopifyLocations.discover',
  'stock.shopifyLocations.empty.title', 'stock.shopifyLocations.empty.description',
  'stock.shopifyLocations.col.code', 'stock.shopifyLocations.col.name',
  'stock.shopifyLocations.col.shopifyId', 'stock.shopifyLocations.col.skus',
  'stock.shopifyLocations.col.units', 'stock.shopifyLocations.col.status',
  'stock.shopifyLocations.active', 'stock.shopifyLocations.inactive',
  'stock.shopifyLocations.enable', 'stock.shopifyLocations.disable',
  'stock.shopifyLocations.toast.discovered', 'stock.shopifyLocations.toast.discoverFailed',
]
const ACRONYMS = new Set(['SKU', 'API', 'CSV', 'COGS'])
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && !ACRONYMS.has(en[k]) && en[k].length > 4) {
    bad(`${k} translated`)
  }
}

console.log()
console.log(`[S.23 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
