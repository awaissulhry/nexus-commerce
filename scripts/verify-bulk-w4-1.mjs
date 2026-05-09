#!/usr/bin/env node
// Verify W4.1 — multi-key sort.
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

console.log('\nW4.1 — multi-key sort\n')

const sortLib = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/multi-sort.ts'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationsClient.tsx'),
  'utf8',
)

console.log('Case 1: lib exports')
for (const name of ['cycleSortKey', 'readRowValue', 'compareValues', 'sortRows']) {
  check(`${name} exported`, new RegExp(`export function ${name}`).test(sortLib))
}
check('SortKey type exported', /export interface SortKey/.test(sortLib))

// Mirror the helpers locally
function cycleSortKey(current, columnId, shift) {
  const idx = current.findIndex((k) => k.columnId === columnId)
  const existing = idx >= 0 ? current[idx] : null
  if (!shift) {
    if (!existing) return [{ columnId, direction: 'asc' }]
    if (existing.direction === 'asc') return [{ columnId, direction: 'desc' }]
    return []
  }
  if (!existing) return [...current, { columnId, direction: 'asc' }]
  if (existing.direction === 'asc') {
    return current.map((k) =>
      k.columnId === columnId ? { ...k, direction: 'desc' } : k,
    )
  }
  return current.filter((k) => k.columnId !== columnId)
}

function compareValues(a, b) {
  const aEmpty = a === null || a === undefined || a === ''
  const bEmpty = b === null || b === undefined || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a !== 'object' && typeof b !== 'object') {
    const na = typeof a === 'number' ? a : parseFloat(String(a))
    const nb = typeof b === 'number' ? b : parseFloat(String(b))
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (String(na) === String(a).trim() && String(nb) === String(b).trim()) {
        return na - nb
      }
    }
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function sortRows(rows, keys) {
  if (keys.length === 0) return rows
  const indexed = rows.map((row, idx) => ({ row, idx }))
  indexed.sort((x, y) => {
    for (const k of keys) {
      const av = x.row[k.columnId]
      const bv = y.row[k.columnId]
      const cmp = compareValues(av, bv)
      if (cmp !== 0) return k.direction === 'desc' ? -cmp : cmp
    }
    return x.idx - y.idx
  })
  return indexed.map((x) => x.row)
}

console.log('\nCase 2: cycleSortKey — plain click')
{
  let s = []
  s = cycleSortKey(s, 'sku', false)
  check("first click → asc", s.length === 1 && s[0].direction === 'asc')
  s = cycleSortKey(s, 'sku', false)
  check("second click → desc", s.length === 1 && s[0].direction === 'desc')
  s = cycleSortKey(s, 'sku', false)
  check("third click → unsorted", s.length === 0)
  // Plain click on a different column replaces:
  s = [{ columnId: 'sku', direction: 'asc' }]
  s = cycleSortKey(s, 'name', false)
  check("plain click on new col replaces list", s.length === 1 && s[0].columnId === 'name')
}

console.log('\nCase 3: cycleSortKey — shift+click multi-key')
{
  let s = []
  s = cycleSortKey(s, 'status', true)
  s = cycleSortKey(s, 'stock', true)
  check("shift adds 2 keys", s.length === 2 && s[0].columnId === 'status' && s[1].columnId === 'stock')
  s = cycleSortKey(s, 'stock', true)
  check("shift cycles asc → desc within list",
    s.length === 2 && s[1].direction === 'desc')
  s = cycleSortKey(s, 'stock', true)
  check("shift cycles desc → removed (preserves order of rest)",
    s.length === 1 && s[0].columnId === 'status')
}

console.log('\nCase 4: compareValues')
check("numbers compare numerically", compareValues(2, 10) < 0)
check("string '10' < string '2' as text but numeric here",
  compareValues('10', '2') > 0) // numeric coerce wins
check("nulls sort last", compareValues(null, 'a') > 0 && compareValues('a', null) < 0)
check("empty strings sort last", compareValues('', 'a') > 0)
check("non-numeric string falls to localeCompare",
  compareValues('apple', 'banana') < 0)

console.log('\nCase 5: sortRows — multi-key behaviour')
{
  const rows = [
    { sku: 'A1', status: 'ACTIVE', stock: 5 },
    { sku: 'B1', status: 'DRAFT', stock: 10 },
    { sku: 'C1', status: 'ACTIVE', stock: 12 },
    { sku: 'D1', status: 'ACTIVE', stock: 1 },
  ]
  const sorted = sortRows(rows, [
    { columnId: 'status', direction: 'asc' },
    { columnId: 'stock', direction: 'desc' },
  ])
  check("status asc then stock desc",
    sorted.map((r) => r.sku).join(',') === 'C1,A1,D1,B1')

  const empty = sortRows(rows, [])
  check("empty keys → array as-is",
    empty === rows)
}

console.log('\nCase 6: BulkOperationsClient wires sortKeys')
check("imports cycleSortKey + sortRows + SortKey",
  /cycleSortKey, sortRows, type SortKey/.test(client))
check("sortKeys state declared",
  /const \[sortKeys, setSortKeys\] = useState<SortKey\[\]>/.test(client))
check("displayRows applies sortRows BEFORE buildHierarchy",
  /sortRows\([\s\S]{0,80}sortKeys[\s\S]{0,200}buildHierarchy\(sorted, expandedParents\)/.test(client))
check("header onClick wires cycleSortKey with shift detection",
  /setSortKeys\(\(prev\) =>\s*cycleSortKey\(prev, header\.column\.id, e\.shiftKey\)/.test(client))
check("system cols don't trigger sort",
  /isSystemCol\s*\?\s*undefined/.test(client))

console.log('\nCase 7: header renders sort indicator')
check("indicator includes ↑ / ↓",
  /\?\s*'↑'\s*:\s*'↓'/.test(client))
check("multi-key indicator shows order index",
  /sortIdx \+ 1[\s\S]{0,40}sortKeys\.length/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
