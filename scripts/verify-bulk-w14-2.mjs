#!/usr/bin/env node
// Verify W14.2 — dark mode parity for the W9-W13 surfaces.
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

console.log('\nW14.2 — dark mode parity\n')

const files = [
  'apps/web/src/app/bulk-operations/ActiveJobsStrip.tsx',
  'apps/web/src/app/bulk-operations/exports/ExportsClient.tsx',
  'apps/web/src/app/bulk-operations/history/HistoryClient.tsx',
]

console.log('Case 1: ActiveJobsStrip header has dark variants')
const strip = fs.readFileSync(path.join(repo, files[0]), 'utf8')
check('"Active Jobs" label gets dark:text-blue-200',
  /text-blue-900 dark:text-blue-200/.test(strip))
check('"View all" link gets dark hover variant',
  /hover:text-blue-900 dark:hover:text-blue-100/.test(strip))
check('row hover has dark variant',
  /hover:bg-blue-100\/30 dark:hover:bg-blue-900\/30/.test(strip))
check('divide-y has dark variant',
  /divide-blue-100 dark:divide-blue-900\/60/.test(strip))

console.log('\nCase 2: every classname with a coloured token also carries a dark: variant')
const exp = fs.readFileSync(path.join(repo, files[1]), 'utf8')
// Real-world dark-mode pairing maps light tokens to lighter/darker
// shades (text-red-700 → dark:text-red-300), not verbatim. So check
// that any className using a coloured base token includes SOME dark:
// modifier — catches obvious "forgot dark mode entirely" misses
// without flagging legitimate shade variations.
const exportsViolations = (exp.match(/className="[^"]+"/g) ?? [])
  .filter((cls) => {
    const hasColoured = /(bg|text|border|divide)-(?:slate|blue|red|green|amber)-\d+/.test(cls)
    if (!hasColoured) return false
    return !cls.includes('dark:')
  })
check('every coloured className carries a dark: variant', exportsViolations.length === 0)
if (exportsViolations.length > 0) {
  console.log('    ↳ first miss:', exportsViolations[0].slice(0, 140))
}

console.log('\nCase 3: HistoryClient retry-notice green-800 paired')
const hist = fs.readFileSync(path.join(repo, files[2]), 'utf8')
check('retry notice text-green-800 has dark:text-green-200',
  /text-green-800 dark:text-green-200/.test(hist))

console.log('\nCase 4: dark variant counts')
for (const f of files) {
  const c = fs.readFileSync(path.join(repo, f), 'utf8')
  const darkCount = (c.match(/dark:/g) ?? []).length
  check(`${f.split('/').pop()} has >=10 dark: variants`, darkCount >= 10)
}

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
