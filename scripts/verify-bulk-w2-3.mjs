#!/usr/bin/env node
// Verify W2.3 — date + datetime cell types.

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

console.log('\nW2.3 — date + datetime cell types\n')

const ec = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/EditableCell.tsx'),
  'utf8',
)
const gc = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/grid-columns.tsx'),
  'utf8',
)
const tsv = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/tsv-helpers.ts'),
  'utf8',
)

console.log("Case 1: FieldType union extends with 'date' + 'datetime'")
check("'date' in union", /\|\s*'date'/.test(ec))
check("'datetime' in union", /\|\s*'datetime'/.test(ec))

console.log('\nCase 2: helpers exported')
check('coerceDate exported', /export function coerceDate/.test(ec))
check('coerceDateTime exported', /export function coerceDateTime/.test(ec))
check('formatDate exported', /export function formatDate/.test(ec))
check('formatDateTime exported', /export function formatDateTime/.test(ec))

// Mirror coerceDate for behavioural test (post local-time fix)
function coerceDate(v) {
  if (v === null || v === undefined || v === '') return null
  const pad = (n) => String(n).padStart(2, '0')
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  }
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
    const eu = trimmed.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
    if (eu) {
      const [, dd, mm, yyyy] = eu
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) {
      const d = new Date(parsed)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
  }
  return null
}

console.log('\nCase 3: coerceDate handles operator habits')
check("'2026-05-09' stays canonical", coerceDate('2026-05-09') === '2026-05-09')
check("'09/05/2026' (Italian dd/mm/yyyy) → 2026-05-09", coerceDate('09/05/2026') === '2026-05-09')
check("'09.05.2026' (German) → 2026-05-09", coerceDate('09.05.2026') === '2026-05-09')
check("Date instance → 2026-05-09", coerceDate(new Date('2026-05-09T00:00:00')) === '2026-05-09')
check("''  → null", coerceDate('') === null)
check("null → null", coerceDate(null) === null)
check("'not a date' → null", coerceDate('not a date') === null)

console.log('\nCase 4: render branches present')
check(
  'date edit branch (input type=date)',
  /type="date"/.test(ec) &&
    /coerceDate\(draftValue\)/.test(ec),
)
check(
  'datetime edit branch (input type=datetime-local)',
  /type="datetime-local"/.test(ec) &&
    /coerceDateTime\(draftValue\)/.test(ec),
)
check(
  'date display branch uses formatDate',
  /formatDate\(draftValue, meta\.locale\)/.test(ec),
)
check(
  'datetime display branch uses formatDateTime',
  /formatDateTime\(draftValue, meta\.locale\)/.test(ec),
)

console.log('\nCase 5: fieldToMeta maps date + datetime')
check(
  "field.type === 'date' → fieldType: 'date'",
  /field\.type === 'date'/.test(gc) &&
    /fieldType:\s*'date'/.test(gc),
)
check(
  "field.type === 'datetime' → fieldType: 'datetime'",
  /field\.type === 'datetime'/.test(gc) &&
    /fieldType:\s*'datetime'/.test(gc),
)

console.log('\nCase 6: paste coercion')
check(
  'paste branch for date',
  /field\.type === 'date'/.test(tsv) &&
    /Use yyyy-mm-dd or dd\/mm\/yyyy/.test(tsv),
)
check(
  'paste branch for datetime',
  /field\.type === 'datetime'/.test(tsv) &&
    /Use yyyy-mm-ddTHH:MM/.test(tsv),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
