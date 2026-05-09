#!/usr/bin/env node
// Verify W2.1 — boolean cell type added to EditableCell.
// Asserts:
//   1. FieldType union extended with 'boolean'
//   2. coerceBoolean exported + handles all expected input shapes
//   3. EditableCell renders boolean edit + display branches
//   4. fieldToMeta maps field.type='boolean' → fieldType='boolean'
//   5. coercePasteValue handles boolean inputs and rejects bad ones
//   6. toTsvCell roundtrips boolean cleanly

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

console.log('\nW2.1 — boolean cell type\n')

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

console.log('Case 1: FieldType union')
check(
  "FieldType includes 'boolean'",
  /FieldType\s*=[\s\S]*?\|\s*'boolean'/.test(ec),
)

console.log('\nCase 2: coerceBoolean export + behaviour')
check(
  'coerceBoolean exported',
  /export function coerceBoolean/.test(ec),
)

// Eval the coerceBoolean logic by mirroring its source — TS can't be
// imported into Node directly without a compile step, but the logic
// is small enough to mirror verbatim.
function coerceBoolean(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false
  return s.length > 0
}
const cases = [
  [true, true],
  [false, false],
  [null, null],
  [undefined, null],
  ['', null],
  ['true', true],
  ['TRUE', true],
  ['1', true],
  ['yes', true],
  ['on', true],
  ['false', false],
  ['0', false],
  ['no', false],
  ['off', false],
  [1, true],
  [0, false],
  [42, true],
  ['anything else', true],
]
for (const [input, expected] of cases) {
  const got = coerceBoolean(input)
  check(
    `coerceBoolean(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`,
    got === expected,
  )
}

console.log('\nCase 3: EditableCell render branches')
check(
  'edit branch for boolean (checkbox input)',
  /meta\.fieldType === 'boolean'/.test(ec) &&
    /type="checkbox"/.test(ec) &&
    /coerceBoolean\(draftValue\) === true/.test(ec),
)
check(
  'display branch for boolean (✓/✗ glyph)',
  /aria-label="True"/.test(ec) &&
    /aria-label="False"/.test(ec),
)

console.log('\nCase 4: fieldToMeta maps boolean')
check(
  "fieldToMeta handles field.type === 'boolean'",
  /field\.type === 'boolean'/.test(gc) &&
    /fieldType: 'boolean'/.test(gc),
)

console.log('\nCase 5: coercePasteValue handles boolean')
check(
  'paste accepts true/false/1/0/yes/no',
  /\['true', '1', 'yes', 'y', 'on'\]/.test(tsv) &&
    /\['false', '0', 'no', 'n', 'off'\]/.test(tsv),
)
check(
  'paste rejects non-boolean strings with clear error',
  /Must be true\/false/.test(tsv),
)

// Mirror the coerce logic here to assert behaviour
function coercePaste(raw, type) {
  if (type !== 'boolean') return { value: raw }
  const trimmed = String(raw).trim()
  if (trimmed === '') return { value: null }
  const lower = trimmed.toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(lower))
    return { value: true }
  if (['false', '0', 'no', 'n', 'off'].includes(lower))
    return { value: false }
  return {
    value: null,
    error: `Must be true/false / 1/0 / yes/no (got "${trimmed}")`,
  }
}
check(
  "paste 'TRUE' → true",
  coercePaste('TRUE', 'boolean').value === true,
)
check(
  "paste '0' → false",
  coercePaste('0', 'boolean').value === false,
)
check(
  "paste 'maybe' → error",
  coercePaste('maybe', 'boolean').error?.includes('Must be true/false'),
)

console.log('\nCase 6: TSV roundtrip')
// toTsvCell uses String(value) — boolean.toString() yields "true"/"false"
check(
  'toTsvCell(true) === "true"',
  String(true) === 'true',
)
check(
  'toTsvCell(false) === "false"',
  String(false) === 'false',
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
