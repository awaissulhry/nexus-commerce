#!/usr/bin/env node
/**
 * S.5 verification — CycleCountSessionClient replaces window.prompt()
 * with the Modal primitive. Pure file-content check.
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

// 1. Active window.prompt() calls are gone (commentary mentioning the
//    name is allowed — strip /* ... */ and // lines before checking)
{
  const stripped = src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const promptHits = (stripped.match(/window\.prompt\s*\(/g) ?? []).length
  if (promptHits === 0) ok('no active window.prompt() calls')
  else bad('no active window.prompt() calls', `found ${promptHits}`)
  const confirmHits = (stripped.match(/window\.confirm\s*\(/g) ?? []).length
  if (confirmHits === 0) ok('no active window.confirm() calls')
  else bad('no active window.confirm() calls', `found ${confirmHits}`)
  const alertHits = (stripped.match(/(?<![\w.])alert\s*\(/g) ?? []).length
  if (alertHits === 0) ok('no active alert() calls')
  else bad('no active alert() calls', `found ${alertHits}`)
}

// 2. Modal primitive imported
if (/import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*['"]@\/components\/ui\/Modal['"]/.test(src)) {
  ok('Modal imported from primitive')
} else {
  bad('Modal imported from primitive')
}
if (/\bModalBody\b/.test(src) && /\bModalFooter\b/.test(src)) ok('ModalBody + ModalFooter used')
else bad('ModalBody + ModalFooter used')

// 3. State for the reason prompt
if (/\breasonPrompt\b/.test(src) && /setReasonPrompt/.test(src)) ok('reasonPrompt state')
else bad('reasonPrompt state')
if (/\breasonInput\b/.test(src)) ok('reasonInput state')
else bad('reasonInput state')
if (/\breasonSubmitting\b/.test(src)) ok('reasonSubmitting state')
else bad('reasonSubmitting state')

// 4. Both flows wired (cancel + ignore)
if (/kind:\s*['"]cancel['"]/.test(src)) ok('cancel kind set on reasonPrompt')
else bad('cancel kind set on reasonPrompt')
if (/kind:\s*['"]ignore['"]/.test(src)) ok('ignore kind set on reasonPrompt')
else bad('ignore kind set on reasonPrompt')

// 5. Modal renders with title + textarea + footer Buttons
if (/<Modal\s/.test(src) && /open=\{reasonPrompt\s*!==?\s*null\}/.test(src)) ok('<Modal> rendered with open prop')
else bad('<Modal> rendered with open prop')
if (/<textarea\b[\s\S]*?value=\{reasonInput\}/.test(src)) ok('textarea bound to reasonInput')
else bad('textarea bound to reasonInput')
if (/<Button\b[\s\S]*?onClick=\{submitReason\}/.test(src)) ok('submit Button wired')
else bad('submit Button wired')

// 6. submitReason routes to the correct perform helper
if (/submitReason\s*=\s*async/.test(src) && /performCancel\(reason\)/.test(src) && /performIgnore\(/.test(src)) {
  ok('submitReason routes to performCancel/performIgnore')
} else {
  bad('submitReason routes correctly')
}

console.log()
console.log(`[S.5 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
