#!/usr/bin/env node
/**
 * S.4 verification — StockDrawer adopts the U.1 focus-trap pattern.
 *
 * Pure file-content check (no API, no DOM). Confirms StockWorkspace.tsx
 * has the U.1 pattern applied correctly:
 *   1. FOCUSABLE_SELECTOR constant present
 *   2. containerRef + previouslyFocused refs declared in StockDrawer
 *   3. focus-trap useEffect with the four U.1 behaviors:
 *      - capture trigger on mount
 *      - defer initial focus 10ms
 *      - Tab/Shift-Tab cycle inside the panel
 *      - Escape closes
 *      - return focus on unmount with body-contains guard
 *   4. role="dialog" / aria-modal="true" / aria-label on the outer div
 *   5. ref={containerRef} on the panel <aside>
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

// 1. Selector constant present
if (/FOCUSABLE_SELECTOR\s*=\s*['"`]a\[href\]/.test(src)) ok('FOCUSABLE_SELECTOR constant present')
else bad('FOCUSABLE_SELECTOR constant present')

// 2. Refs declared
{
  const drawerStart = src.indexOf('function StockDrawer')
  const drawerEnd = src.indexOf('function Section(', drawerStart)
  const drawerBody = src.slice(drawerStart, drawerEnd)
  if (/const containerRef = useRef<HTMLElement \| null>\(null\)/.test(drawerBody)) ok('containerRef ref declared')
  else bad('containerRef ref declared')
  if (/const previouslyFocused = useRef<HTMLElement \| null>\(null\)/.test(drawerBody)) ok('previouslyFocused ref declared')
  else bad('previouslyFocused ref declared')

  // 3. The four U.1 behaviors
  if (/previouslyFocused\.current\s*=\s*\(?document\.activeElement/.test(drawerBody)) ok('captures trigger on open')
  else bad('captures trigger on open')

  if (/setTimeout\(\(\)\s*=>/.test(drawerBody) && /first\?\.focus\(\)/.test(drawerBody)) ok('defers initial focus')
  else bad('defers initial focus')

  if (/if \(e\.key === 'Escape'\)\s*\{\s*onClose\(\)/.test(drawerBody)) ok('Escape closes drawer')
  else bad('Escape closes drawer')

  if (/if \(e\.shiftKey\)/.test(drawerBody) && /last\.focus\(\)/.test(drawerBody) && /first\.focus\(\)/.test(drawerBody)) {
    ok('Tab and Shift+Tab cycle')
  } else {
    bad('Tab and Shift+Tab cycle')
  }

  if (/document\.body\.contains\(trigger\)/.test(drawerBody)) ok('body-contains guard on focus restore')
  else bad('body-contains guard on focus restore')

  // Cleanup clears timer + listener
  if (/clearTimeout\(initialFocusTimer\)/.test(drawerBody) &&
      /removeEventListener\('keydown', onKey\)/.test(drawerBody)) {
    ok('cleanup clears timer + keydown listener')
  } else {
    bad('cleanup clears timer + keydown listener')
  }

  // 4. ARIA dialog markup
  if (/role="dialog"/.test(drawerBody)) ok('role="dialog" on outer div')
  else bad('role="dialog" on outer div')

  if (/aria-modal="true"/.test(drawerBody)) ok('aria-modal="true"')
  else bad('aria-modal="true"')

  if (/aria-label="[^"]*[Ss]tock/.test(drawerBody)) ok('aria-label set')
  else bad('aria-label set')

  // 5. ref on the panel
  if (/ref=\{containerRef\}/.test(drawerBody)) ok('ref={containerRef} on the panel')
  else bad('ref={containerRef} on the panel')
}

// 6. useRef imported from react
if (/from 'react'\s*$/m.test(src)
    && /(\buseRef\b)/.test(src.split('from \'react\'')[0])) {
  ok('useRef imported')
} else if (/import\s*\{[^}]*\buseRef\b[^}]*\}\s*from\s*['"]react['"]/.test(src)) {
  ok('useRef imported')
} else {
  bad('useRef imported')
}

console.log()
console.log(`[S.4 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
