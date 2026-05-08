#!/usr/bin/env node
/**
 * S.9 verification — mobile bottom-nav on the stock workspace +
 * mobile card layout for cycle-count items. Pure file-content check.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const stock = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8')
const cycle = fs.readFileSync(
  path.join(here, '..', 'apps/web/src/app/fulfillment/stock/cycle-count/[id]/CycleCountSessionClient.tsx'),
  'utf8',
)

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── Stock workspace bottom-nav ──────────────────────────────────
if (/<nav[\s\S]*?aria-label="Stock navigation"/.test(stock)) ok('stock: <nav aria-label="Stock navigation">')
else bad('stock: <nav aria-label="Stock navigation">')

if (/sm:hidden fixed inset-x-0 bottom-0/.test(stock)) ok('stock: bottom-nav uses sm:hidden fixed inset-x-0 bottom-0')
else bad('stock: bottom-nav uses sm:hidden fixed inset-x-0 bottom-0')

if (/aria-current="page"/.test(stock)) ok('stock: bottom-nav marks current Stock as aria-current="page"')
else bad('stock: bottom-nav marks current Stock as aria-current="page"')

if (/href="\/fulfillment\/stock\/cycle-count"/.test(stock)) ok('stock: bottom-nav links to /fulfillment/stock/cycle-count')
else bad('stock: bottom-nav links to /fulfillment/stock/cycle-count')

// Bottom-nav badge gated on cycleCountActive > 0
const navBlockMatch = stock.match(/<nav[\s\S]*?<\/nav>/)
if (navBlockMatch && /cycleCountActive\s*>\s*0/.test(navBlockMatch[0])) {
  ok('stock: bottom-nav badge gated on cycleCountActive > 0')
} else {
  bad('stock: bottom-nav badge gated on cycleCountActive > 0')
}

// Hidden when bulk action bar is visible
if (/selected\.size === 0 &&/.test(stock) && /drawerProductId/.test(stock)) {
  ok('stock: bottom-nav hidden when bulk bar / drawer visible')
} else {
  bad('stock: bottom-nav hidden when bulk bar / drawer visible')
}

// ── Cycle-count session: mobile card view ───────────────────────
if (/sm:hidden space-y-2/.test(cycle)) ok('cycle-count: mobile card layout sm:hidden block present')
else bad('cycle-count: mobile card layout sm:hidden block present')

// After S.27 dark-mode pass, classes like `bg-white` may be followed
// by `dark:bg-slate-900` and `border-slate-200` by
// `dark:border-slate-700`, so match the structural classes loosely.
if (/hidden sm:block[^"]*bg-white[^"]*border[^"]*border-slate-200[^"]*rounded-lg/.test(cycle)) {
  ok('cycle-count: desktop table wrapped in hidden sm:block')
} else {
  bad('cycle-count: desktop table wrapped in hidden sm:block')
}

// Mobile card uses min-h-[44px] on its action buttons
const mobileBlockMatch = cycle.match(/sm:hidden space-y-2[\s\S]*?(?=\s*\{\/\*\s*Items table)/)
if (mobileBlockMatch && /min-h-\[44px\]/.test(mobileBlockMatch[0])) {
  ok('cycle-count: mobile card actions ≥44px tap target')
} else {
  bad('cycle-count: mobile card actions ≥44px tap target')
}

// Mobile card retains data-cycle-count-input for the S.7 scan flow
if (mobileBlockMatch && /data-cycle-count-input=\{it\.id\}/.test(mobileBlockMatch[0])) {
  ok('cycle-count: mobile card retains data-cycle-count-input (S.7 scan flow works)')
} else {
  bad('cycle-count: mobile card retains data-cycle-count-input')
}

console.log()
console.log(`[S.9 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
