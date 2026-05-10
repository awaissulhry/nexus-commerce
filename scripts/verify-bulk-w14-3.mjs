#!/usr/bin/env node
// Verify W14.3 — WCAG AA tab order + ARIA labels.
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

console.log('\nW14.3 — WCAG AA tab order + ARIA\n')

const strip = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/ActiveJobsStrip.tsx'),
  'utf8',
)
const exp = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/exports/ExportsClient.tsx'),
  'utf8',
)
const hist = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/history/HistoryClient.tsx'),
  'utf8',
)

console.log('Case 1: ActiveJobsStrip ARIA')
check('cancel button has aria-label',
  /aria-label=\{`Cancel \$\{job\.jobName\}`\}/.test(strip))
check('cancel icon has aria-hidden',
  /<Ban className="w-3 h-3" aria-hidden="true"/.test(strip))
check('progress bar has role + aria-valuenow',
  /role="progressbar"/.test(strip) &&
  /aria-valuenow=\{pct\}/.test(strip) &&
  /aria-valuemin=\{0\}/.test(strip) &&
  /aria-valuemax=\{100\}/.test(strip))
check('progress text marked aria-live=polite',
  /aria-live="polite"[\s\S]{0,80}aria-atomic="true"/.test(strip))

console.log('\nCase 2: ExportsClient ARIA')
check('Download anchor has aria-label',
  /aria-label=\{`Download export \$\{j\.jobName\}`\}/.test(exp))
check('Delete button has aria-label',
  /aria-label=\{`Delete export \$\{j\.jobName\}`\}/.test(exp))
check('Download icon marked aria-hidden',
  /<Download className="w-3 h-3" aria-hidden="true"/.test(exp))
check('Trash2 icon marked aria-hidden',
  /<Trash2 className="w-3 h-3" aria-hidden="true"/.test(exp))

console.log('\nCase 3: HistoryClient drawer trigger ARIA')
check('View button has aria-label with SKU',
  /aria-label=\{`View full payload for \$\{it\.sku \?\? 'deleted item'\}`\}/.test(hist))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
