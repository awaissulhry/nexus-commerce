#!/usr/bin/env node
/**
 * S.27 — Dark mode pass verification.
 *
 * Asserts every Stock surface client has a non-trivial number of
 * `dark:` Tailwind classes (so visual regressions in dark mode get
 * caught early), and asserts no duplicate `dark:X dark:Y` pairs leaked
 * into the source from the bulk substitution.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const FILES = [
  'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx',
  'apps/web/src/app/fulfillment/stock/analytics/AnalyticsClient.tsx',
  'apps/web/src/app/fulfillment/stock/transfers/TransfersClient.tsx',
  'apps/web/src/app/fulfillment/stock/reservations/ReservationsClient.tsx',
  'apps/web/src/app/fulfillment/stock/shopify-locations/ShopifyLocationsClient.tsx',
  'apps/web/src/app/fulfillment/stock/cycle-count/CycleCountListClient.tsx',
  'apps/web/src/app/fulfillment/stock/cycle-count/[id]/CycleCountSessionClient.tsx',
  'apps/web/src/app/fulfillment/stock/fba-pan-eu/FbaPanEuClient.tsx',
  'apps/web/src/app/fulfillment/stock/import/ImportClient.tsx',
  'apps/web/src/app/fulfillment/stock/mcf/MCFClient.tsx',
]

const DUPLICATE_PATTERNS = [
  /dark:text-slate-\d+\s+dark:text-slate-\d+/g,
  /dark:bg-slate-\d+\s+dark:bg-slate-\d+/g,
  /dark:border-slate-\d+\s+dark:border-slate-\d+/g,
  /dark:hover:bg-slate-\d+\s+dark:hover:bg-slate-\d+/g,
  /dark:hover:border-slate-\d+\s+dark:hover:border-slate-\d+/g,
]

const MIN_DARK_CLASSES = 15
const failures = []

for (const rel of FILES) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    failures.push(`MISSING file: ${rel}`)
    continue
  }
  const src = fs.readFileSync(abs, 'utf8')
  const darkCount = (src.match(/\bdark:/g) ?? []).length
  if (darkCount < MIN_DARK_CLASSES) {
    failures.push(`${rel}: only ${darkCount} dark: classes (expected ≥ ${MIN_DARK_CLASSES})`)
  }
  for (const re of DUPLICATE_PATTERNS) {
    const dup = src.match(re)
    if (dup && dup.length > 0) {
      failures.push(`${rel}: duplicate dark: pair leaked → ${dup[0]}`)
    }
  }
}

if (failures.length === 0) {
  console.log(`✅ S.27 dark-mode pass clean across ${FILES.length} stock files`)
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const n = (src.match(/\bdark:/g) ?? []).length
    console.log(`   ${rel}: ${n} dark: classes`)
  }
  process.exit(0)
}

console.error('❌ S.27 verification failed')
for (const f of failures) console.error(`   - ${f}`)
process.exit(1)
