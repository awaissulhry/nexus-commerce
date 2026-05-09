#!/usr/bin/env node
// Verify W3.3 — match highlight overlay + scroll-into-view on Next/Prev.
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

console.log('\nW3.3 — match highlight overlay + scroll-to-match\n')

const gridRow = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/components/GridRow.tsx'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationsClient.tsx'),
  'utf8',
)
const refs = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/refs.ts'),
  'utf8',
)

console.log('Case 1: TableRow accepts findMatchSig prop')
check(
  'findMatchSig destructured',
  /findMatchSig,\s*\}: \{/.test(gridRow),
)
check(
  'findMatchSig typed as optional string',
  /findMatchSig\?: string/.test(gridRow),
)

console.log('\nCase 2: TableRow memo busts on findMatchSig change')
check(
  'memo comparator includes findMatchSig',
  /prev\.findMatchSig === next\.findMatchSig/.test(gridRow),
)

console.log('\nCase 3: per-cell highlight reads from matchCols (parsed sig)')
check(
  'matchCols memoised inside the row',
  /useMemo\(\(\) => \{[\s\S]{0,300}findMatchSig\.split\(','\)/.test(gridRow),
)
check(
  'isFindMatch derived from matchCols.has(colIdx)',
  /matchCols\?\.has\(colIdx\)/.test(gridRow),
)
check(
  'highlight class applied in cell wrapper',
  /'ring-1 ring-inset ring-amber-400 bg-amber-50\/60'/.test(gridRow),
)

console.log('\nCase 4: BulkOperationsClient builds per-row signature')
check(
  'findMatchSigByRow useMemo present',
  /findMatchSigByRow = useMemo\(\(\) => \{/.test(client),
)
check(
  'buckets keyed by rowIdx',
  /buckets\.set\(r, arr\)/.test(client),
)
check(
  'sorted colIdx joined with commas',
  /arr\.sort\(\(a, b\) => a - b\)[\s\S]*?arr\.join\(','\)/.test(client),
)

console.log('\nCase 5: TableRow render passes findMatchSig')
check(
  'findMatchSig prop wired',
  /findMatchSig=\{findMatchSigByRow\.get\(vRow\.index\)\}/.test(client),
)

console.log('\nCase 6: handleFindActivate scrolls into view')
check(
  'rowVirtualizer.scrollToIndex with align center',
  /rowVirtualizer\.scrollToIndex\(m\.rowIdx, \{ align: 'center' \}\)/.test(
    client,
  ),
)

console.log('\nCase 7: dead editCtxRef.findMatchKeys field removed')
check(
  'EditCtx no longer carries findMatchKeys',
  !/findMatchKeys: Set<string>/.test(refs),
)
check(
  "editCtxRef.current no longer assigns findMatchKeys",
  !/findMatchKeys,\s*\}\s*allFieldsRef/.test(client),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
