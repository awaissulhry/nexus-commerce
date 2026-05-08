#!/usr/bin/env node
/**
 * S.8 verification — interactive elements in the stock surface have
 * a mobile tap area ≥44×44 px (WCAG AA). The convention applied:
 *   h-N px-* → h-11 sm:h-N px-*
 *   h-N w-N inline-flex → h-11 w-11 sm:h-N sm:w-N inline-flex
 *   small inline-flex padding-only buttons → +min-h-[44px] sm:min-h-0
 *
 * Pure file-content check. Fails if any bare h-7/h-8 button pattern
 * remains in interactive contexts.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))

const files = [
  'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx',
  'apps/web/src/app/fulfillment/stock/cycle-count/[id]/CycleCountSessionClient.tsx',
]

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const rel of files) {
  const full = path.join(here, '..', rel)
  const src = fs.readFileSync(full, 'utf8')
  const tag = path.basename(rel)

  // 1. No bare `h-7 px-N` or `h-8 px-N` (must be sm-prefixed now)
  const barePxRe = /(?:^|[^:0-9-])h-(?:7|8) px-/g
  const bareHits = (src.match(barePxRe) ?? []).length
  if (bareHits === 0) ok(`${tag}: no bare h-7/h-8 px-* patterns`)
  else bad(`${tag}: no bare h-7/h-8 px-* patterns`, `${bareHits} bare matches`)

  // 2. No bare `h-7 w-7 inline-flex` or `h-8 w-8 inline-flex`
  const bareIconRe = /(?:^|[^:0-9-])h-(?:7|8) w-(?:7|8) inline-flex/g
  const bareIconHits = (src.match(bareIconRe) ?? []).length
  if (bareIconHits === 0) ok(`${tag}: no bare h-N w-N inline-flex icon-button patterns`)
  else bad(`${tag}: no bare h-N w-N inline-flex icon-button patterns`, `${bareIconHits} bare matches`)

  // 3. Mobile-bumped patterns are present (proves the transformation
  //    happened on at least one element in the file).
  if (/h-11 sm:h-/.test(src)) ok(`${tag}: contains h-11 sm:h-N pattern`)
  else bad(`${tag}: contains h-11 sm:h-N pattern`)

  // 4. (StockWorkspace only) icon-button patterns also bumped
  if (rel.includes('StockWorkspace')) {
    if (/h-11 w-11 sm:h-(?:7|8) sm:w-(?:7|8) inline-flex/.test(src)) {
      ok(`${tag}: icon-button bump pattern present (h-11 w-11 sm:h-N sm:w-N)`)
    } else {
      bad(`${tag}: icon-button bump pattern present`)
    }
  }

  // 5. (CycleCountSessionClient) min-h-[44px] applied to small
  //    padding-only buttons
  if (rel.includes('CycleCountSessionClient')) {
    if (/min-h-\[44px\] sm:min-h-0 px-/.test(src)) {
      ok(`${tag}: min-h-[44px] sm:min-h-0 applied to padding-only buttons`)
    } else {
      bad(`${tag}: min-h-[44px] sm:min-h-0 applied to padding-only buttons`)
    }
  }
}

console.log()
console.log(`[S.8 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
