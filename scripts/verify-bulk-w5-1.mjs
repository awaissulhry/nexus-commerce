#!/usr/bin/env node
// Verify W5.1 — BulkActionTemplate schema + service.
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

console.log('\nW5.1 — BulkActionTemplate schema + service\n')

console.log('Case 1: table exists with expected columns')
{
  const r = await c.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'BulkActionTemplate'
    ORDER BY ordinal_position
  `)
  const expected = [
    'id', 'name', 'description', 'actionType', 'channel',
    'actionPayload', 'defaultFilters', 'parameters',
    'category', 'userId', 'isBuiltin',
    'usageCount', 'lastUsedAt',
    'createdBy', 'createdAt', 'updatedAt',
  ]
  for (const col of expected) {
    check(`column ${col}`, r.rows.some((row) => row.column_name === col))
  }
  check('actionPayload is jsonb', r.rows.find((row) => row.column_name === 'actionPayload')?.data_type === 'jsonb')
  check('parameters is jsonb', r.rows.find((row) => row.column_name === 'parameters')?.data_type === 'jsonb')
  check('isBuiltin NOT NULL', r.rows.find((row) => row.column_name === 'isBuiltin')?.is_nullable === 'NO')
}

console.log('\nCase 2: indexes')
{
  const r = await c.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'BulkActionTemplate'
  `)
  check('userId index',
    r.rows.some((row) => row.indexname === 'BulkActionTemplate_userId_idx'))
  check('category index',
    r.rows.some((row) => row.indexname === 'BulkActionTemplate_category_idx'))
  check('actionType index',
    r.rows.some((row) => row.indexname === 'BulkActionTemplate_actionType_idx'))
  check('usageCount DESC index',
    r.rows.some((row) => row.indexname === 'BulkActionTemplate_usageCount_idx'))
}

console.log('\nCase 3: round-trip insert + read')
{
  const id = `verify-w5-1-${Date.now()}`
  await c.query(
    `INSERT INTO "BulkActionTemplate" (
       id, name, "actionType", "actionPayload",
       parameters, category, "isBuiltin",
       "usageCount", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, NOW(), NOW()
     )`,
    [
      id,
      'Spring sale 5%',
      'PRICING_UPDATE',
      JSON.stringify({ adjustmentType: 'PERCENT', value: '${pct}' }),
      JSON.stringify([
        { name: 'pct', label: 'Discount %', type: 'number', defaultValue: 5 },
      ]),
      'pricing',
      false,
      0,
    ],
  )
  const r = await c.query(
    `SELECT name, "actionType", "actionPayload", parameters, category
       FROM "BulkActionTemplate" WHERE id = $1`,
    [id],
  )
  check('insert + read works', r.rows.length === 1)
  check('actionPayload roundtrips JSON',
    r.rows[0].actionPayload?.value === '${pct}')
  check('parameters roundtrip',
    Array.isArray(r.rows[0].parameters) && r.rows[0].parameters[0]?.name === 'pct')
  await c.query(`DELETE FROM "BulkActionTemplate" WHERE id = $1`, [id])
}

console.log('\nCase 4: substituteDeep behaviour (mirrored)')
function substituteDeep(value, params) {
  if (typeof value === 'string') {
    const fullMatch = value.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/)
    if (fullMatch) {
      const name = fullMatch[1]
      return name in params ? params[name] : value
    }
    return value.replace(
      /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
      (_, name) =>
        name in params
          ? params[name] === null || params[name] === undefined
            ? ''
            : String(params[name])
          : `\${${name}}`,
    )
  }
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, params))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, params)
    return out
  }
  return value
}

{
  const result = substituteDeep({ value: '${pct}', label: 'Up ${pct}%' }, { pct: 5 })
  check("full-match preserves number type", result.value === 5)
  check("embedded match string-splices", result.label === 'Up 5%')

  const arr = substituteDeep([{ a: '${x}' }], { x: 'hello' })
  check('arrays + objects recurse', arr[0].a === 'hello')

  const missing = substituteDeep('${unknown}', { other: 1 })
  check("unknown ${name} stays as literal", missing === '${unknown}')
}

console.log('\nCase 5: source-level service exports')
const svcSrc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action-template.service.ts'),
  'utf8',
)
for (const sym of [
  'class BulkActionTemplateService',
  'listTemplates',
  'getTemplate',
  'createTemplate',
  'updateTemplate',
  'deleteTemplate',
  'duplicateTemplate',
  'applyParameters',
  'recordUsage',
]) {
  check(`exposes ${sym}`, svcSrc.includes(sym))
}
check('rejects updates to builtin templates',
  /Cannot update a built-in template directly/.test(svcSrc))
check('rejects unknown actionType in createTemplate',
  /not in KNOWN_BULK_ACTION_TYPES/.test(svcSrc))

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
