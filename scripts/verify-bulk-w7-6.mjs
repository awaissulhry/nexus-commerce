#!/usr/bin/env node
// Verify W7.6 — dry-run preview panel.
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

console.log('\nW7.6 — dry-run preview\n')

const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/automation/AutomationClient.tsx'),
  'utf8',
)

console.log('Case 1: state for saved-rule dry-run')
check('contextJson state with JSON sample seed',
  /const \[contextJson, setContextJson\][\s\S]{0,200}"failureRate"/.test(client))
check('contextError state',
  /const \[contextError, setContextError\]/.test(client))
check('dryRunResult state',
  /const \[dryRunResult, setDryRunResult\]/.test(client))
check('dryRunBusy state',
  /const \[dryRunBusy, setDryRunBusy\]/.test(client))

console.log('\nCase 2: parse safety + endpoint wiring')
check('JSON.parse with try/catch + setContextError',
  /JSON\.parse\(contextJson\)[\s\S]{0,200}setContextError/.test(client))
check('hits POST /:id/dry-run',
  /\/api\/bulk-automation-rules\/\$\{editingId\}\/dry-run/.test(client))
check('result mapped from j.result',
  /j\.result\?\.matched \?\? false/.test(client) &&
    /j\.result\?\.status \?\? 'UNKNOWN'/.test(client) &&
    /j\.result\?\.actionResults \?\? \[\]/.test(client))

console.log('\nCase 3: panel only renders when rule is saved')
check('panel guarded by editingId',
  /\{editingId && \([\s\S]{0,400}5\. Dry-run preview/.test(client))

console.log('\nCase 4: per-action result display')
check('action results map renders type + ok dot',
  /dryRunResult\.actionResults\.map\(\(a, i\) =>/.test(client))
check('emerald / red tinting based on a.ok',
  /a\.ok\s*\?\s*'border-emerald-200/.test(client) &&
    /'border-red-200/.test(client))
check('output JSON-pretty-printed',
  /JSON\.stringify\(a\.output, null, 2\)/.test(client))
check('action error rendered when ok=false',
  /a\.error &&[\s\S]{0,200}\{a\.error\}/.test(client))

console.log('\nCase 5: result summary')
check("matched summary 'matched (status) · N actions'",
  /matched \(\$\{dryRunResult\.status\}\)/.test(client))
check("no-match summary 'no match (status)'",
  /no match \(\$\{dryRunResult\.status\}\)/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
