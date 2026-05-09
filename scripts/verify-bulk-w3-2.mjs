#!/usr/bin/env node
// Verify W3.2 — FindReplaceBar component + Cmd+F wiring.
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

console.log('\nW3.2 — FindReplaceBar + Cmd+F wiring\n')

const bar = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/components/FindReplaceBar.tsx'),
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

console.log('Case 1: FindReplaceBar component exists with required exports')
check('component file exists', bar.length > 0)
check('exports FindReplaceBar named export', /export function FindReplaceBar/.test(bar))
check('exports FindReplaceBarProps', /export interface FindReplaceBarProps/.test(bar))

console.log('\nCase 2: bar imports the W3.1 search helpers')
check(
  'imports buildSearchRegex / findMatches / applyScope / replaceInString',
  /from\s+'\.\.\/lib\/find-replace'/.test(bar) &&
    /buildSearchRegex/.test(bar) &&
    /findMatches/.test(bar) &&
    /applyScope/.test(bar) &&
    /replaceInString/.test(bar),
)

console.log('\nCase 3: required UI elements')
check('Find input present', /placeholder="Find…"/.test(bar))
check('Aa case-sensitive toggle', /\bAa\b/.test(bar))
check('Ab| whole-word toggle', /\bAb\|/.test(bar))
check('.* regex toggle', /\.\*\s*\n/.test(bar))
check('scope select (all / selection / column)',
  /value="all"/.test(bar) && /value="selection"/.test(bar) && /value="column"/.test(bar))
check('Replace toggle', /Replace[\s\S]{0,50}<\/button>/.test(bar))
check('Match counter element', /\$\{safeCursor \+ 1\} of \$\{matches\.length\}/.test(bar))
check('Invalid-regex hint', /'invalid'/.test(bar))

console.log('\nCase 4: keyboard semantics')
check('Esc closes', /e\.key === 'Escape'/.test(bar))
check('Enter = next, Shift+Enter = prev',
  /e\.shiftKey\) goPrev\(\)[\s\S]*?else goNext\(\)/.test(bar))

console.log('\nCase 5: BulkOperationsClient wires Cmd+F')
check('imports FindReplaceBar', /import\s+\{\s*FindReplaceBar\s*\}/.test(client))
check('declares findReplaceOpen state',
  /const \[findReplaceOpen, setFindReplaceOpen\]/.test(client))
check('declares findMatchKeys state',
  /const \[findMatchKeys, setFindMatchKeys\]/.test(client))
check("Cmd/Ctrl+F handler",
  /e\.key\.toLowerCase\(\) === 'f'/.test(client) &&
    /setFindReplaceOpen\(true\)/.test(client))
check("Bypasses Cmd+F when an editable input is focused",
  /key\.toLowerCase\(\) === 'f'[\s\S]{0,500}ae\.tagName === 'INPUT'/.test(client))

console.log('\nCase 6: renders FindReplaceBar with the right props')
check('renders <FindReplaceBar', /<FindReplaceBar/.test(client))
check('passes cells / rangeBounds / visibleColumns / onActivate',
  /cells={findCells}/.test(client) &&
    /rangeBounds={rangeBounds}/.test(client) &&
    /visibleColumns={visibleColumnsList}/.test(client) &&
    /onActivate={handleFindActivate}/.test(client))

console.log('\nCase 7: editCtxRef carries findMatchKeys')
check("EditCtx.findMatchKeys field added",
  /findMatchKeys: Set<string>/.test(refs))
check("editCtxRef.current includes findMatchKeys",
  /findMatchKeys,\s*\}/.test(client))

console.log('\nCase 8: cells memo gated by findReplaceOpen')
check('findCells memo guarded by findReplaceOpen',
  /useMemo\(\(\) => \{[\s\S]*?if \(!findReplaceOpen\) return \[\]/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
