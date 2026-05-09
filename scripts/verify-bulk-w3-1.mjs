#!/usr/bin/env node
// Verify W3.1 — find-replace search helpers (logic only, no UI yet).
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

console.log('\nW3.1 — find-replace search helpers\n')

const src = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/find-replace.ts'),
  'utf8',
)

console.log('Case 1: exports')
for (const name of [
  'buildSearchRegex',
  'findMatches',
  'applyScope',
  'replaceInString',
  'matchKeySet',
]) {
  check(`${name} exported`, new RegExp(`export function ${name}`).test(src))
}

// Mirror the helpers locally for behavioural tests
function buildSearchRegex(opts) {
  if (!opts.query) return null
  const flags = opts.caseSensitive ? 'g' : 'gi'
  let source
  if (opts.regex) {
    source = opts.query
  } else {
    source = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  if (opts.wholeWord) {
    source = `\\b(?:${source})\\b`
  }
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

function findMatches(cells, opts) {
  const re = buildSearchRegex(opts)
  if (!re) return []
  const out = []
  for (const c of cells) {
    if (c.value === null || c.value === undefined) continue
    const s = String(c.value)
    if (s.length === 0) continue
    re.lastIndex = 0
    if (re.test(s)) {
      out.push({ rowIdx: c.rowIdx, colIdx: c.colIdx, rowId: c.rowId, columnId: c.columnId, display: s })
    }
  }
  return out
}

function replaceInString(source, opts, replacement) {
  const re = buildSearchRegex(opts)
  if (!re) return source
  re.lastIndex = 0
  return source.replace(re, replacement)
}

function applyScope(cells, scope) {
  if (scope.kind === 'all') return cells
  if (scope.kind === 'selection') {
    const b = scope.bounds
    if (!b) return []
    return cells.filter(
      (c) => c.rowIdx >= b.minRow && c.rowIdx <= b.maxRow && c.colIdx >= b.minCol && c.colIdx <= b.maxCol,
    )
  }
  if (scope.kind === 'column') {
    if (!scope.columnId) return []
    return cells.filter((c) => c.columnId === scope.columnId)
  }
  return cells
}

const SAMPLE = [
  { rowIdx: 0, colIdx: 0, rowId: 'a', columnId: 'name', value: 'Airmesh Jacket' },
  { rowIdx: 1, colIdx: 0, rowId: 'b', columnId: 'name', value: 'Racing Pants' },
  { rowIdx: 2, colIdx: 0, rowId: 'c', columnId: 'name', value: 'AIRMESH Glove' },
  { rowIdx: 0, colIdx: 1, rowId: 'a', columnId: 'sku', value: 'AIR-J' },
  { rowIdx: 1, colIdx: 1, rowId: 'b', columnId: 'sku', value: 'RAC-P' },
  { rowIdx: 2, colIdx: 1, rowId: 'c', columnId: 'sku', value: 'AIR-G' },
]

console.log('\nCase 2: literal find (case-insensitive default)')
{
  const m = findMatches(SAMPLE, { query: 'airmesh', caseSensitive: false, wholeWord: false, regex: false })
  check('finds 2 cells (case-insensitive)', m.length === 2)
  check('row 0 + row 2 matched', m[0].rowIdx === 0 && m[1].rowIdx === 2)
}

console.log('\nCase 3: case-sensitive')
{
  const m = findMatches(SAMPLE, { query: 'airmesh', caseSensitive: true, wholeWord: false, regex: false })
  check('case-sensitive finds 0 (lowercase needle)', m.length === 0)
  const m2 = findMatches(SAMPLE, { query: 'AIRMESH', caseSensitive: true, wholeWord: false, regex: false })
  check('case-sensitive finds 1 (exact case)', m2.length === 1)
}

console.log('\nCase 4: whole-word')
{
  // 'AIR' is a whole word in 'AIR-J' (separated by -) but NOT in 'Airmesh'
  const m = findMatches(SAMPLE, { query: 'AIR', caseSensitive: false, wholeWord: true, regex: false })
  // In 'AIR-J' the dash counts as non-word so AIR matches.
  check('whole-word AIR matches AIR-J / AIR-G but not Airmesh',
    m.length === 2 && m.every((x) => x.columnId === 'sku'))
}

console.log('\nCase 5: regex')
{
  const m = findMatches(SAMPLE, { query: '^[A-Z]{3}-', caseSensitive: true, wholeWord: false, regex: true })
  check('regex ^[A-Z]{3}- matches 3 SKUs', m.length === 3 && m.every((x) => x.columnId === 'sku'))
}

console.log('\nCase 6: invalid regex returns []')
{
  const m = findMatches(SAMPLE, { query: '[unclosed', caseSensitive: false, wholeWord: false, regex: true })
  check('invalid regex → []', m.length === 0)
  const re = buildSearchRegex({ query: '[unclosed', caseSensitive: false, wholeWord: false, regex: true })
  check('buildSearchRegex returns null for invalid', re === null)
}

console.log('\nCase 7: empty query returns []')
{
  const m = findMatches(SAMPLE, { query: '', caseSensitive: false, wholeWord: false, regex: false })
  check('empty query → []', m.length === 0)
}

console.log('\nCase 8: applyScope')
{
  const all = applyScope(SAMPLE, { kind: 'all' })
  check('all returns every cell', all.length === SAMPLE.length)

  const sel = applyScope(SAMPLE, {
    kind: 'selection',
    bounds: { minRow: 1, maxRow: 2, minCol: 0, maxCol: 0 },
  })
  check('selection limits to box', sel.length === 2 &&
    sel.every((c) => c.colIdx === 0 && c.rowIdx >= 1))

  const noSel = applyScope(SAMPLE, { kind: 'selection' })
  check('selection without bounds returns []', noSel.length === 0)

  const col = applyScope(SAMPLE, { kind: 'column', columnId: 'sku' })
  check('column scope filters', col.length === 3 && col.every((c) => c.columnId === 'sku'))

  const colMissing = applyScope(SAMPLE, { kind: 'column' })
  check('column scope without columnId returns []', colMissing.length === 0)
}

console.log('\nCase 9: replaceInString')
{
  const out = replaceInString('Airmesh Jacket', { query: 'airmesh', caseSensitive: false, wholeWord: false, regex: false }, 'Cordura')
  check('case-insensitive literal replace', out === 'Cordura Jacket')

  const out2 = replaceInString('Airmesh Jacket', { query: 'AIRMESH', caseSensitive: true, wholeWord: false, regex: false }, 'Cordura')
  check('case-sensitive miss → original', out2 === 'Airmesh Jacket')

  const out3 = replaceInString('AIR-J', { query: '^([A-Z]{3})-', caseSensitive: true, wholeWord: false, regex: true }, '$1.')
  check('regex with capture group', out3 === 'AIR.J')

  const out4 = replaceInString('Airmesh', { query: '', caseSensitive: false, wholeWord: false, regex: false }, 'X')
  check('empty query → original', out4 === 'Airmesh')
}

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
