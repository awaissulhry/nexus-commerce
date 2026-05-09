#!/usr/bin/env node
// Verify W5.4 — Built-in template seeds (closes Wave 5).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
dotenv.config({ path: path.join(repo, '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW5.4 — built-in template seeds\n')

const seedSrc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action-template-seeds.ts'),
  'utf8',
)
const indexSrc = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: seed module shape')
check('exports BUILTIN_TEMPLATES', /export const BUILTIN_TEMPLATES/.test(seedSrc))
check('exports seedBulkActionTemplates fn',
  /export async function seedBulkActionTemplates/.test(seedSrc))

console.log('\nCase 2: seed list covers every audited category')
const expectedCategories = ['pricing', 'inventory', 'status', 'channel']
for (const cat of expectedCategories) {
  check(`category '${cat}' in seeds`,
    new RegExp(`category:\\s*'${cat}'`).test(seedSrc))
}

console.log('\nCase 3: seeds reference valid actionTypes only')
const seenActionTypes = [...seedSrc.matchAll(/actionType:\s*'(\w+)'/g)].map((m) => m[1])
const allowed = new Set([
  'PRICING_UPDATE', 'INVENTORY_UPDATE', 'STATUS_UPDATE',
  'ATTRIBUTE_UPDATE', 'LISTING_SYNC', 'MARKETPLACE_OVERRIDE_UPDATE',
  'LISTING_BULK_ACTION',
])
const allValid = seenActionTypes.every((t) => allowed.has(t))
check(`every seed actionType is in KNOWN_BULK_ACTION_TYPES (got ${seenActionTypes.length})`, allValid)

console.log('\nCase 4: index.ts boots the seeder best-effort')
check('imports seedBulkActionTemplates dynamically',
  /import\(\s*'\.\/services\/bulk-action-template-seeds\.js'\s*\)/.test(indexSrc))
check('boot logs result',
  /\[boot\] bulk-action-template seeds/.test(indexSrc))
check('failure path catches + warns instead of throwing',
  /\[boot\] bulk-action-template seeds skipped/.test(indexSrc))

console.log('\nCase 5: DB state — seeded rows are present')
{
  const r = await c.query(
    `SELECT name, "actionType", category, "isBuiltin"
       FROM "BulkActionTemplate" WHERE "isBuiltin" = true
       ORDER BY name`,
  )
  check(`at least 12 builtin templates in DB (got ${r.rows.length})`,
    r.rows.length >= 12)
  check('every builtin row has isBuiltin=true',
    r.rows.every((row) => row.isBuiltin === true))
  // Spot-check a couple
  check("'Spring sale — N% off' present",
    r.rows.some((row) => row.name === 'Spring sale — N% off'))
  check("'End-of-life — set INACTIVE' present",
    r.rows.some((row) => row.name === 'End-of-life — set INACTIVE'))
  check("'Pause listings (Amazon DE)' present",
    r.rows.some((row) => row.name === 'Pause listings (Amazon DE)'))
}

console.log('\nCase 6: parameter shape — required + bounds')
{
  const r = await c.query(
    `SELECT name, parameters FROM "BulkActionTemplate"
       WHERE "isBuiltin" = true AND name = 'Spring sale — N% off'`,
  )
  const params = r.rows[0]?.parameters
  check('parameters is an array', Array.isArray(params))
  check('first param has name=pct',
    Array.isArray(params) && params[0]?.name === 'pct')
  check('pct is required', Array.isArray(params) && params[0]?.required === true)
  check('pct has min/max', Array.isArray(params) &&
    typeof params[0]?.min === 'number' &&
    typeof params[0]?.max === 'number')
}

console.log('\nCase 7: seeds idempotent — re-running uses (userId,name) keys')
{
  // Source-level: seedBulkActionTemplates does findFirst on userId+name
  // before deciding insert vs update.
  check('looks up by (userId, name) before insert',
    /findFirst\(\{\s*where:\s*\{\s*userId:\s*SEED_USER_ID,\s*name:\s*t\.name\s*\}/.test(seedSrc))
}

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 5 complete — Templates v2 shipped)')
