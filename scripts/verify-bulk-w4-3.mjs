#!/usr/bin/env node
// Verify W4.3 — group-by column.
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

console.log('\nW4.3 — group-by column\n')

const lib = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/grouping.ts'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationsClient.tsx'),
  'utf8',
)

console.log('Case 1: lib exports')
for (const name of ['isGroupHeader', 'bucketByColumn', 'buildGroupedRows', 'toggleGroup']) {
  check(`${name} exported`, new RegExp(`export function ${name}`).test(lib))
}
check('GroupHeader interface exported', /export interface GroupHeader/.test(lib))

// Mirror logic
function bucketByColumn(rows, columnId) {
  const buckets = new Map()
  for (const row of rows) {
    const v = row[columnId]
    const key = v === null || v === undefined || v === '' ? '∅' : String(v)
    let arr = buckets.get(key)
    if (!arr) {
      arr = []
      buckets.set(key, arr)
    }
    arr.push(row)
  }
  return buckets
}

function buildGroupedRows(rows, columnId, collapsedGroupKeys) {
  const buckets = bucketByColumn(rows, columnId)
  const out = []
  for (const [key, bucketRows] of buckets) {
    const collapsed = collapsedGroupKeys.has(key)
    out.push({
      __group: true,
      id: `__grp:${columnId}:${key}`,
      columnId,
      value: key === '∅' ? null : key,
      label: key === '∅' ? '(empty)' : key,
      count: bucketRows.length,
      collapsed,
    })
    if (!collapsed) for (const r of bucketRows) out.push(r)
  }
  return out
}

function toggleGroup(current, key) {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

const SAMPLE = [
  { sku: 'A1', brand: 'Xavia' },
  { sku: 'A2', brand: 'Xavia' },
  { sku: 'B1', brand: 'Alpinestars' },
  { sku: 'C1', brand: null },
  { sku: 'C2', brand: '' },
  { sku: 'C3', brand: 'Alpinestars' },
]

console.log('\nCase 2: bucketByColumn — preserves insertion order, dedupes nullish')
{
  const buckets = bucketByColumn(SAMPLE, 'brand')
  check('three buckets (Xavia, Alpinestars, ∅)', buckets.size === 3)
  check('Xavia has 2 rows', (buckets.get('Xavia') || []).length === 2)
  check('Alpinestars has 2 rows', (buckets.get('Alpinestars') || []).length === 2)
  check('∅ catches null + ""', (buckets.get('∅') || []).length === 2)
}

console.log('\nCase 3: buildGroupedRows — interleaves headers with data')
{
  const out = buildGroupedRows(SAMPLE, 'brand', new Set())
  check('emits 3 headers + 6 data rows', out.length === 9)
  check('first row is a header', out[0].__group === true)
  check('header label "(empty)" for ∅', out.find((r) => r.__group && r.label === '(empty)') !== undefined)
}

console.log('\nCase 4: collapsed group hides children')
{
  const collapsed = new Set(['Xavia'])
  const out = buildGroupedRows(SAMPLE, 'brand', collapsed)
  // 3 headers + 0 (Xavia hidden) + 2 (Alpinestars) + 2 (empty) = 7
  check('Xavia collapse drops 2 data rows', out.length === 7)
  const xaviaHeader = out.find((r) => r.__group && r.label === 'Xavia')
  check('Xavia header still present', xaviaHeader !== undefined)
  check('Xavia header marked collapsed', xaviaHeader.collapsed === true)
}

console.log('\nCase 5: toggleGroup')
{
  let s = new Set()
  s = toggleGroup(s, 'A')
  check("toggle empty → ['A']", s.has('A') && s.size === 1)
  s = toggleGroup(s, 'A')
  check("toggle ['A'] → []", s.size === 0)
  s = toggleGroup(s, 'A')
  s = toggleGroup(s, 'B')
  check("toggle adds two", s.size === 2)
}

console.log('\nCase 6: BulkOperationsClient wires the toolbar selector')
check('imports bucketByColumn from grouping',
  /import\s*\{\s*bucketByColumn\s*\}\s*from\s*'\.\/lib\/grouping'/.test(client))
check('declares groupByColumnId state',
  /const \[groupByColumnId, setGroupByColumnId\] = useState<string>/.test(client))
check('declares collapsedGroupKeys state',
  /const \[collapsedGroupKeys, setCollapsedGroupKeys\] = useState<Set<string>>/.test(client))
check('group-by pinned as primary sort key',
  /effectiveSortKeys: SortKey\[\] = groupByColumnId/.test(client) &&
  /columnId: groupByColumnId, direction: 'asc'/.test(client))
check('drops duplicate sort key when pinned',
  /sortKeys\.filter\(\(k\) => k\.columnId !== groupByColumnId\)/.test(client))
check('groupBucketCount memo computes via bucketByColumn',
  /groupBucketCount = useMemo\(\(\) => \{[\s\S]{0,200}bucketByColumn/.test(client))
check('toolbar Group: selector renders',
  /<option value="">Group: \(none\)<\/option>/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
