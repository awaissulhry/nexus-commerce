#!/usr/bin/env node
/**
 * S.22 verification — Shopify Locations multi-location binding
 * (schema + service + routes; no UI yet — that's S.23).
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const schema = fs.readFileSync(path.join(here, '..', 'packages/database/prisma/schema.prisma'), 'utf8')
const service = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/shopify-locations.service.ts'), 'utf8')
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const shopifyService = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/marketplaces/shopify.service.ts'), 'utf8')
const migrationDir = path.join(here, '..', 'packages/database/prisma/migrations/20260508_s22_shopify_locations')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Migration files
if (fs.existsSync(path.join(migrationDir, 'migration.sql'))) ok('migration.sql exists')
else bad('migration.sql exists')
if (fs.existsSync(path.join(migrationDir, 'rollback.sql'))) ok('rollback.sql exists')
else bad('rollback.sql exists')
const migrationSql = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8')
if (/ADD COLUMN IF NOT EXISTS "externalLocationId" TEXT/.test(migrationSql)) ok('migration adds externalLocationId')
else bad('migration adds externalLocationId')
if (/ADD COLUMN IF NOT EXISTS "externalChannel" TEXT/.test(migrationSql)) ok('migration adds externalChannel')
else bad('migration adds externalChannel')
if (/CREATE UNIQUE INDEX[\s\S]*?WHERE "externalChannel" IS NOT NULL AND "externalLocationId" IS NOT NULL/.test(migrationSql)) {
  ok('migration creates unique partial index on (channel, externalId)')
} else {
  bad('migration creates unique partial index on (channel, externalId)')
}

// 2. Schema declarations
if (/externalLocationId\s+String\?/.test(schema)) ok('schema declares externalLocationId')
else bad('schema declares externalLocationId')
if (/externalChannel\s+String\?/.test(schema)) ok('schema declares externalChannel')
else bad('schema declares externalChannel')
if (/@@index\(\[externalChannel, externalLocationId\]\)/.test(schema)) ok('schema indexes (externalChannel, externalLocationId)')
else bad('schema indexes (externalChannel, externalLocationId)')

// 3. Service exports
const exportsExpected = [
  'export async function discoverShopifyLocations',
  'export async function upsertShopifyLocation',
  'export async function resolveByShopifyId',
  'export async function listShopifyLocationsWithStock',
  'export async function setShopifyLocationActive',
]
for (const e of exportsExpected) {
  if (service.includes(e)) ok(`service has ${e.replace('export async function ', '')}`)
  else bad(`service has ${e.replace('export async function ', '')}`)
}

// 4. Service maps SHOPIFY_LOCATION + externalChannel='SHOPIFY' on upsert
if (/type:\s*'SHOPIFY_LOCATION'/.test(service)) ok('upsert sets type=SHOPIFY_LOCATION')
else bad('upsert sets type=SHOPIFY_LOCATION')
if (/externalChannel:\s*'SHOPIFY'/.test(service)) ok('upsert sets externalChannel=SHOPIFY')
else bad('upsert sets externalChannel=SHOPIFY')

// 5. Idempotency: lookup by (channel, externalId) OR by code
if (/OR:\s*\[[\s\S]*?externalChannel:\s*'SHOPIFY',\s*externalLocationId[\s\S]*?\{\s*code\s*\}/.test(service)) {
  ok('upsert lookup uses (channel, externalId) OR code')
} else {
  bad('upsert lookup uses (channel, externalId) OR code')
}

// 6. ShopifyService exposes makeRequestPublic
if (/async makeRequestPublic\(/.test(shopifyService)) ok('ShopifyService exposes makeRequestPublic')
else bad('ShopifyService exposes makeRequestPublic')

// 7. Routes registered
if (/'\/stock\/shopify-locations'/.test(stockRoutes)) ok('GET /api/stock/shopify-locations registered')
else bad('GET /api/stock/shopify-locations registered')
if (/'\/stock\/shopify-locations\/discover'/.test(stockRoutes)) ok('POST /api/stock/shopify-locations/discover registered')
else bad('POST /api/stock/shopify-locations/discover registered')
if (/'\/stock\/shopify-locations\/:id'/.test(stockRoutes)) ok('PATCH /api/stock/shopify-locations/:id registered')
else bad('PATCH /api/stock/shopify-locations/:id registered')

// 8. Discover route handles missing-config gracefully
if (/Shopify not configured/.test(stockRoutes)) ok('discover route warns + handles missing config')
else bad('discover route warns + handles missing config')

console.log()
console.log(`[S.22 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
