#!/usr/bin/env node
// Verify W2.6 — multiSelect cell type.
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

console.log('\nW2.6 — multiSelect cell type\n')

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

console.log("Case 1: 'multiSelect' in FieldType union")
check("'multiSelect' in union", /\|\s*'multiSelect'/.test(ec))

console.log('\nCase 2: coerceMultiSelect exported + behaviour')
check('coerceMultiSelect exported', /export function coerceMultiSelect/.test(ec))

function coerceMultiSelect(v) {
  if (v === null || v === undefined || v === '') return []
  if (Array.isArray(v)) {
    return Array.from(
      new Set(v.map((x) => String(x).trim()).filter((x) => x.length > 0)),
    )
  }
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return coerceMultiSelect(parsed)
    } catch {}
  }
  const parts = s.split(/[,;|]/).map((x) => x.trim()).filter((x) => x.length > 0)
  return Array.from(new Set(parts))
}

const cases = [
  [['a', 'b', 'c'], ['a', 'b', 'c']],
  [['a', 'a', 'b'], ['a', 'b']],
  ['a, b, c', ['a', 'b', 'c']],
  ['a; b; c', ['a', 'b', 'c']],
  ['a | b | c', ['a', 'b', 'c']],
  ['["a","b"]', ['a', 'b']],
  ['', []],
  [null, []],
  ['  a , , b , ', ['a', 'b']],
]
for (const [input, expected] of cases) {
  const got = coerceMultiSelect(input)
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  check(
    `coerceMultiSelect(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`,
    ok,
  )
}

console.log('\nCase 3: render branches')
check(
  'edit branch with options (popover checkbox list)',
  /meta\.options\.map\(\(opt\) => \{/.test(ec) &&
    /type="checkbox"/.test(ec),
)
check(
  'edit branch without options (free-form text)',
  /placeholder="tag, tag, tag"/.test(ec),
)
check(
  'display branch (chips + overflow counter)',
  /tags\.slice\(0, VISIBLE\)/.test(ec) &&
    /\+\{overflow\}/.test(ec),
)

console.log('\nCase 4: fieldToMeta routing')
check(
  "field.type 'multiSelect' OR 'string_array' routed",
  /field\.type === 'multiSelect'/.test(gc) &&
    /field\.type === 'string_array'/.test(gc),
)

console.log('\nCase 5: paste coercion')
check(
  'paste branch present',
  /multiSelect[\s\S]*JSON\.parse\(trimmed\)/.test(tsv) &&
    /Unknown values:/.test(tsv),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
