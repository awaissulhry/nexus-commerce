#!/usr/bin/env node
/**
 * S.7 verification — CycleCountSessionClient adopts barcode-ready
 * scan input. Pure file-content check.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(
  here,
  '..',
  'apps/web/src/app/fulfillment/stock/cycle-count/[id]/CycleCountSessionClient.tsx',
)
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

// 1. BarcodeScanInput imported from primitive
if (/import\s*\{[^}]*\bBarcodeScanInput\b[^}]*\}\s*from\s*['"]@\/components\/ui\/BarcodeScanInput['"]/.test(src)) {
  ok('BarcodeScanInput imported')
} else {
  bad('BarcodeScanInput imported')
}

// 2. handleScan callback defined
if (/const handleScan = useCallback/.test(src)) ok('handleScan callback defined')
else bad('handleScan callback defined')

// 3. <BarcodeScanInput /> rendered, gated on isInProgress
if (/isInProgress &&[\s\S]*?<BarcodeScanInput/.test(src)) ok('<BarcodeScanInput> rendered behind isInProgress')
else bad('<BarcodeScanInput> rendered behind isInProgress')

// 4. onScan prop wired to handleScan
if (/<BarcodeScanInput[\s\S]*?onScan=\{handleScan\}/.test(src)) ok('onScan={handleScan}')
else bad('onScan={handleScan}')

// 5. data-cycle-count-input attribute on the count input
if (/data-cycle-count-input=\{it\.id\}/.test(src)) ok('data-cycle-count-input attribute on count input')
else bad('data-cycle-count-input attribute on count input')

// 6. handleScan resolves the input via the data attribute
if (/querySelector[^(]*\([^)]*data-cycle-count-input=/.test(src)) ok('handleScan resolves input via data-cycle-count-input')
else bad('handleScan resolves input via data-cycle-count-input')

// 7. handleScan calls scrollIntoView + focus
if (/scrollIntoView/.test(src) && /el\.focus\(\)/.test(src)) ok('handleScan scrolls + focuses the matched row')
else bad('handleScan scrolls + focuses the matched row')

// 8. Toast on miss / already-resolved status. After S.11 i18n, the
// strings live behind translation keys (cycleCount.session.scan*) —
// match either the i18n key path or the legacy English literals.
if (
  /not in this count/.test(src) ||
  /SKU.*not in/.test(src) ||
  /cycleCount\.session\.scanNotInCount/.test(src)
) ok('handleScan toasts on SKU miss')
else bad('handleScan toasts on SKU miss')
if (
  /already \$\{item\.status\.toLowerCase/.test(src) ||
  /already.*reconciled.*ignored/i.test(src) ||
  /cycleCount\.session\.scanAlreadyResolved/.test(src)
) {
  ok('handleScan toasts on already-resolved')
} else {
  bad('handleScan toasts on already-resolved')
}

console.log()
console.log(`[S.7 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
