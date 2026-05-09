#!/usr/bin/env node
// Verify W2.8 — link / formula / lookup. Closes Wave 2 cell-type parity
// (16 of 16 Airtable types implemented in EditableCell).
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

console.log('\nW2.8 — link / formula / lookup\n')

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

console.log('Case 1: FieldType union — all 3 added')
for (const t of ['link', 'formula', 'lookup']) {
  check(`'${t}' in union`, new RegExp(`\\|\\s*'${t}'`).test(ec))
}

console.log('\nCase 2: enterEdit short-circuits read-only types')
check(
  'enterEdit ignores formula / lookup / link',
  /meta\.fieldType === 'formula'[\s\S]{0,80}meta\.fieldType === 'lookup'[\s\S]{0,80}meta\.fieldType === 'link'/.test(
    ec,
  ),
)

console.log('\nCase 3: link display branch')
check(
  'meta.linkResolve callback hook',
  /linkResolve\?: \(id: unknown\) => string \| null/.test(ec),
)
check(
  'link display renders → label',
  /→ \{label\}/.test(ec) &&
    /Linked record not found/.test(ec),
)

console.log('\nCase 4: formula / lookup display branches')
check(
  'fx icon for formula',
  /'formula' \? 'fx'/.test(ec),
)
check(
  '↗ icon for lookup',
  /'fx' : '↗'/.test(ec),
)
check(
  'computed types use cursor-default (no edit affordance)',
  /cursor-default/.test(ec),
)
check(
  'tooltip explains read-only computed',
  /Computed[\s\S]*?Lookup from related record[\s\S]*?\(read-only\)/.test(ec),
)

console.log('\nCase 5: fieldToMeta routing for all 3')
check(
  'link routed',
  /field\.type === 'link'.*?fieldType: 'link'/s.test(gc),
)
check(
  'formula routed',
  /field\.type === 'formula'.*?fieldType: 'formula'/s.test(gc),
)
check(
  'lookup routed',
  /field\.type === 'lookup'.*?fieldType: 'lookup'/s.test(gc),
)

console.log('\nCase 6: paste coercion for read-only types')
check(
  'formula / lookup paste → "Read-only — computed"',
  /Read-only — computed/.test(tsv),
)
check(
  'link paste accepts raw id',
  /field\.type === 'link'[\s\S]*?return \{ value: trimmed \}/.test(tsv),
)

console.log('\nCase 7: 16-type Airtable parity check (closes Wave 2)')
const expected = [
  'text', 'number', 'select', 'boolean', 'currency',
  'date', 'datetime', 'url', 'email', 'phone',
  'color', 'multiSelect', 'image', 'link', 'formula', 'lookup',
]
for (const t of expected) {
  check(
    `FieldType union includes '${t}'`,
    new RegExp(`\\|\\s*'${t}'`).test(ec) ||
      // text / number / select are the original 3 — no leading pipe
      new RegExp(`FieldType\\s*=[\\s\\S]*?'${t}'`).test(ec),
  )
}

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (16/16 Airtable cell types — Wave 2 complete)')
