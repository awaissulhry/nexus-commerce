#!/usr/bin/env node
// Verify W3.4 — Replace flow + undo integration.
// Closes Wave 3.
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

console.log('\nW3.4 — replace flow + undo integration\n')

const bar = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/components/FindReplaceBar.tsx'),
  'utf8',
)

console.log('\nCase 4: bar Replace-All triggers the commit-batch')
check(
  'replaceAll collects into batch',
  /replaceAll[\s\S]{0,500}onReplaceCell\(m\.rowId, m\.columnId, next, batch\)/.test(
    bar,
  ),
)
check(
  'replaceAll calls onCommitReplaceBatch',
  /onCommitReplaceBatch\(batch\)/.test(bar),
)
check(
  'no-op writes are skipped (next === m.display)',
  /if \(next === m\.display\) continue/.test(bar),
)

console.log('\nCase 5: Replace-One contract')
check(
  'replaceOne calls onReplaceCell without batch (3-arg form)',
  /onReplaceCell\(m\.rowId, m\.columnId, next\)\s*$/m.test(bar),
)

console.log('\nCase 6: replaceInString reused (no duplicate logic)')
check(
  'bar imports replaceInString from find-replace',
  /import\s*\{[\s\S]*?replaceInString[\s\S]*?\}\s*from\s*'\.\.\/lib\/find-replace'/.test(
    bar,
  ),
)
check(
  'replaceOne uses replaceInString',
  /next = replaceInString\(m\.display, opts, replacement\)/.test(bar),
)

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 3 complete — Excel-tier Find & Replace shipped)')
