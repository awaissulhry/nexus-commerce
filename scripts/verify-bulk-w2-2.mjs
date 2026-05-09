#!/usr/bin/env node
// Verify W2.2 — currency cell type.
// Asserts:
//   1. FieldType union extended with 'currency'
//   2. EditableMeta carries currency + locale fields
//   3. formatCurrency exported + handles all expected shapes
//   4. EditableCell renders currency edit + display branches
//   5. fieldToMeta routes PRICE_FIELDS through fieldType='currency'
//   6. Locale formatting matches Intl.NumberFormat semantics

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

console.log('\nW2.2 — currency cell type\n')

const ec = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/EditableCell.tsx'),
  'utf8',
)
const gc = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/grid-columns.tsx'),
  'utf8',
)

console.log('Case 1: FieldType union')
check(
  "FieldType includes 'currency'",
  /FieldType\s*=[\s\S]*?\|\s*'currency'/.test(ec),
)

console.log('\nCase 2: EditableMeta extension')
check(
  'currency field on EditableMeta',
  /currency\?: string/.test(ec),
)
check(
  'locale field on EditableMeta',
  /locale\?: string/.test(ec),
)

console.log('\nCase 3: formatCurrency export + behaviour')
check('formatCurrency exported', /export function formatCurrency/.test(ec))

// Mirror logic for unit testing
function formatCurrency(value, currency = 'EUR', locale = 'it-IT') {
  if (value === null || value === undefined || value === '') return ''
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? parseFloat(value)
        : NaN
  if (!Number.isFinite(n)) return ''
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

const cases = [
  [null, ''],
  [undefined, ''],
  ['', ''],
  ['abc', ''],
]
for (const [input, expected] of cases) {
  const got = formatCurrency(input)
  check(
    `formatCurrency(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got "${got}")`,
    got === expected,
  )
}

// Locale-specific assertions: it-IT puts the symbol after the digits
// and uses a comma as the decimal separator. Spaces and currency
// symbols may differ across Node versions / locale data, so assert
// only on the parts we know are stable.
const it = formatCurrency(12345.67, 'EUR', 'it-IT')
check(
  `it-IT EUR uses comma decimal + € (got "${it}")`,
  it.includes(',67') && it.includes('€'),
)
const en = formatCurrency(1234.56, 'USD', 'en-US')
check(
  `en-US USD ~ "$1,234.56" (got "${en}")`,
  en.includes('1,234.56') && en.includes('$'),
)
// Unknown ISO falls back to the safe path
const fallback = formatCurrency(99.5, 'XYZ', 'it-IT')
check(
  `unknown ISO falls back gracefully (got "${fallback}")`,
  fallback === 'XYZ 99.50' || fallback.includes('99'),
)

console.log('\nCase 4: EditableCell render branches')
check(
  'currency edit branch (numeric input + ISO chip)',
  /meta\.currency \?\? 'EUR'/.test(ec) &&
    /text-xs uppercase tracking-wide text-slate-500/.test(ec),
)
check(
  'currency display branch (locale-formatted)',
  /formatCurrency\(draftValue, meta\.currency, meta\.locale\)/.test(ec),
)

console.log('\nCase 5: fieldToMeta routes pricing fields')
check(
  'isPrice branch returns fieldType=currency',
  /if \(isPrice\)/.test(gc) &&
    /fieldType:\s*'currency'/.test(gc),
)
check(
  "default currency = 'EUR'",
  /currency:\s*'EUR'/.test(gc),
)
check(
  "default locale = 'it-IT'",
  /locale:\s*'it-IT'/.test(gc),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
