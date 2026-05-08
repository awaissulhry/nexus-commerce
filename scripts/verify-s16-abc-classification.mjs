#!/usr/bin/env node
/**
 * S.16 verification — ABC classification.
 *
 * Pure file-content + schema-state checks (no live DB queries — the
 * migration applies via prisma migrate deploy on Railway).
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const schema = fs.readFileSync(path.join(here, '..', 'packages/database/prisma/schema.prisma'), 'utf8')
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const apiIndex = fs.readFileSync(path.join(here, '..', 'apps/api/src/index.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8')
const analyticsClient = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/analytics/AnalyticsClient.tsx'), 'utf8')
const service = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/abc-classification.service.ts'), 'utf8')
const job = fs.readFileSync(path.join(here, '..', 'apps/api/src/jobs/abc-classification.job.ts'), 'utf8')
const migrationDir = path.join(here, '..', 'packages/database/prisma/migrations/20260508_s16_abc_classification')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Migration exists
if (fs.existsSync(path.join(migrationDir, 'migration.sql'))) ok('migration SQL exists')
else bad('migration SQL exists')
if (fs.existsSync(path.join(migrationDir, 'rollback.sql'))) ok('migration rollback exists')
else bad('migration rollback exists')
const migrationSql = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8')
if (/ADD COLUMN IF NOT EXISTS "abcClass" TEXT/.test(migrationSql)) ok('migration adds abcClass column')
else bad('migration adds abcClass column')
if (/CREATE INDEX IF NOT EXISTS "Product_abcClass_idx"/.test(migrationSql)) ok('migration creates abcClass index')
else bad('migration creates abcClass index')

// 2. Prisma schema updated
if (/abcClass\s+String\?/.test(schema)) ok('schema.prisma declares abcClass')
else bad('schema.prisma declares abcClass')
if (/abcClassUpdatedAt\s+DateTime\?/.test(schema)) ok('schema.prisma declares abcClassUpdatedAt')
else bad('schema.prisma declares abcClassUpdatedAt')
if (/@@index\(\[abcClass\]\)/.test(schema)) ok('schema.prisma has abcClass index')
else bad('schema.prisma has abcClass index')

// 3. Service exports recompute + getSnapshot
if (/export async function recompute/.test(service)) ok('service exports recompute()')
else bad('service exports recompute()')
if (/export async function getSnapshot/.test(service)) ok('service exports getSnapshot()')
else bad('service exports getSnapshot()')

// 4. Service uses 80/15/5 default bands
if (/bandA = args\.bandA \?\? 0\.80/.test(service)) ok('service defaults bandA=0.80')
else bad('service defaults bandA=0.80')
if (/bandB = args\.bandB \?\? 0\.15/.test(service)) ok('service defaults bandB=0.15')
else bad('service defaults bandB=0.15')

// 5. Service classifies zero-sales as D
if (/r\.metricValue === 0/.test(service) && /class:\s*'D'/.test(service)) {
  ok('service classifies zero-sales as D')
} else {
  bad('service classifies zero-sales as D')
}

// 6. Service supports revenue/units/margin metrics
if (/AbcMetric = 'revenue' \| 'units' \| 'margin'/.test(service)) {
  ok('service AbcMetric union (revenue/units/margin)')
} else {
  bad('service AbcMetric union (revenue/units/margin)')
}

// 7. Cron job
if (/abc-classification cron: scheduled/.test(job)) ok('cron job declares scheduled state')
else bad('cron job declares scheduled state')
if (/0 4 \* \* 1/.test(job)) ok('cron schedule = Monday 04:00 UTC')
else bad('cron schedule = Monday 04:00 UTC')
if (/NEXUS_ENABLE_ABC_CRON/.test(job)) ok('cron has NEXUS_ENABLE_ABC_CRON opt-out')
else bad('cron has NEXUS_ENABLE_ABC_CRON opt-out')

// 8. Cron registered in index.ts
if (/import \{ startAbcClassificationCron \}/.test(apiIndex)) ok('apiIndex imports cron')
else bad('apiIndex imports cron')
if (/startAbcClassificationCron\(\)/.test(apiIndex)) ok('apiIndex starts cron')
else bad('apiIndex starts cron')

// 9. Routes
if (/fastify\.get\('\/stock\/analytics\/abc'/.test(stockRoutes)) ok('GET /api/stock/analytics/abc registered')
else bad('GET /api/stock/analytics/abc registered')
if (/fastify\.post\('\/stock\/analytics\/abc\/recompute'/.test(stockRoutes)) {
  ok('POST /api/stock/analytics/abc/recompute registered')
} else {
  bad('POST /api/stock/analytics/abc/recompute registered')
}

// 10. /api/stock list selects abcClass
const stockListBlock = stockRoutes.match(/fastify\.get\('\/stock'[\s\S]*?reorderThreshold:[\s\S]*?\)\s*\n/)
if (stockListBlock && /abcClass:\s*true/.test(stockListBlock[0])) {
  ok('/api/stock list selects abcClass on Product')
} else {
  bad('/api/stock list selects abcClass on Product')
}

// 11. Frontend
if (/AbcBadge/.test(stockWorkspace)) ok('StockWorkspace defines AbcBadge')
else bad('StockWorkspace defines AbcBadge')
if (/it\.product\.abcClass/.test(stockWorkspace)) ok('StockWorkspace renders abcClass on row')
else bad('StockWorkspace renders abcClass on row')

if (/api\/stock\/analytics\/abc/.test(analyticsClient)) ok('AnalyticsClient fetches /api/stock/analytics/abc')
else bad('AnalyticsClient fetches /api/stock/analytics/abc')
if (/AbcResponse/.test(analyticsClient)) ok('AnalyticsClient AbcResponse type defined')
else bad('AnalyticsClient AbcResponse type defined')

// 12. Catalog keys
const newKeys = [
  'stock.abc.title', 'stock.abc.snapshotAt', 'stock.abc.notRun',
  'stock.abc.empty', 'stock.abc.totalClassified',
  'stock.abc.band.A.label', 'stock.abc.band.A.description',
  'stock.abc.band.B.label', 'stock.abc.band.B.description',
  'stock.abc.band.C.label', 'stock.abc.band.C.description',
  'stock.abc.band.D.label', 'stock.abc.band.D.description',
]
const ACRONYMS = new Set(['COGS', 'FBA', 'SKU', 'API'])
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && !ACRONYMS.has(en[k]) && en[k] !== `Class ${k.split('.').pop()?.charAt(0)}`) {
    bad(`${k} translated`)
  }
}

console.log()
console.log(`[S.16 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
