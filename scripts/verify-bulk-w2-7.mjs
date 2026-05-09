#!/usr/bin/env node
// Verify W2.7 — image cell type.
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

console.log('\nW2.7 — image cell type\n')

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

console.log("Case 1: 'image' in FieldType union")
check("'image' in union", /\|\s*'image'/.test(ec))

console.log('\nCase 2: render branches')
check(
  'edit branch (URL input)',
  /placeholder="https:\/\/cdn\.xavia\.it\/\.\.\."/.test(ec),
)
check(
  'display branch uses ImageCellThumb',
  /<ImageCellThumb url=\{url\} \/>/.test(ec),
)
check(
  'ImageCellThumb has broken-image fallback',
  /aria-label="Broken image"/.test(ec) &&
    /onError=\{\(\) => setFailed\(true\)\}/.test(ec),
)
check(
  'ImageCellThumb resets failed state on URL change',
  /useEffect\(\(\) => \{[\s\S]*?setFailed\(false\)[\s\S]*?\}, \[url\]\)/.test(ec),
)

console.log('\nCase 3: fieldToMeta routing')
check("field.type === 'image' routed", /fieldType: 'image'/.test(gc))

console.log('\nCase 4: paste coercion')
check(
  'paste accepts http/https URLs only',
  /Image URL must be http or https/.test(tsv) &&
    /Not a valid image URL/.test(tsv),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
