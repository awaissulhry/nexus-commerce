#!/usr/bin/env node
/**
 * S.6 verification — main stock workspace surfaces a cycle-count
 * entry point (the sub-route was previously discoverable only via
 * the sidebar or Cmd+K).
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx')
const src = fs.readFileSync(file, 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. ClipboardCheck icon imported
if (/ClipboardCheck/.test(src)) ok('ClipboardCheck icon imported')
else bad('ClipboardCheck icon imported')

// 2. cycleCountActive state defined
if (/setCycleCountActive/.test(src) && /cycleCountActive/.test(src)) ok('cycleCountActive state defined')
else bad('cycleCountActive state defined')

// 3. Sidecar fetches /api/fulfillment/cycle-counts
if (/api\/fulfillment\/cycle-counts/.test(src)) ok('sidecar fetches /api/fulfillment/cycle-counts')
else bad('sidecar fetches /api/fulfillment/cycle-counts')

// 4. The fetch result is filtered to DRAFT/IN_PROGRESS
if (/DRAFT['"]?\s*\|\|\s*[^=]*===\s*['"]IN_PROGRESS|status === ['"]DRAFT['"][^|]*\|\|[^=]*['"]IN_PROGRESS/.test(src)) {
  ok('active filter on DRAFT/IN_PROGRESS')
} else if (/c\.status === 'DRAFT'/.test(src) && /c\.status === 'IN_PROGRESS'/.test(src)) {
  ok('active filter on DRAFT/IN_PROGRESS')
} else {
  bad('active filter on DRAFT/IN_PROGRESS')
}

// 5. <Link> to /fulfillment/stock/cycle-count rendered in actions area
if (/href="\/fulfillment\/stock\/cycle-count"/.test(src)) ok('Link to /fulfillment/stock/cycle-count rendered')
else bad('Link to /fulfillment/stock/cycle-count rendered')

// 6. Badge fires when active > 0
if (/cycleCountActive\s*>\s*0/.test(src)) ok('badge gated on cycleCountActive > 0')
else bad('badge gated on cycleCountActive > 0')

// 7. The badge is accessibility-labeled
if (/aria-label=`?\$\{cycleCountActive\}|aria-label=\{?[^}]*cycleCountActive/.test(src)) {
  ok('badge has aria-label')
} else if (/aria-label=`\$\{cycleCountActive\}/.test(src)) {
  ok('badge has aria-label')
} else if (/aria-label=\{[^}]*cycleCountActive/.test(src)) {
  ok('badge has aria-label')
} else {
  bad('badge has aria-label')
}

console.log()
console.log(`[S.6 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
