#!/usr/bin/env node
// Verify W10.4 — cancel mid-flight (confirm + cadence). Closes Wave 10.
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

console.log('\nW10.4 — cancel mid-flight\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)

console.log('Case 1: cancel cadence optimised')
check('CANCEL_POLL_EVERY constant defined',
  /const CANCEL_POLL_EVERY = 10/.test(svc))
check('CANCEL_POLL_MAX_MS constant defined',
  /const CANCEL_POLL_MAX_MS = 2000/.test(svc))
check('checks first item + every Nth item + or by wall-clock',
  /itemIdx === 0[\s\S]{0,80}dueByCount[\s\S]{0,80}dueByTime/.test(svc))
check('records lastCancelCheck after each poll',
  /lastCancelCheck = Date\.now\(\)/.test(svc))
check('still observes CANCELLING / CANCELLED transitions',
  /liveStatus\?\.status === 'CANCELLING'[\s\S]{0,200}CANCELLED/.test(svc))
check('exits the loop with cancelled=true',
  /cancelled = true;\s*\n\s*break;/.test(svc))

console.log('\nCase 2: post-loop finalization')
check('finalStatus = CANCELLED when cancelled flag set',
  /if \(cancelled\)[\s\S]{0,50}finalStatus = 'CANCELLED'/.test(svc))
check('writes completedAt on cancel',
  /finalStatus,\s*\n\s*completedAt: new Date\(\)/.test(svc))

console.log('\nCase 3: cancelJob route + transitions')
check('PENDING/QUEUED → CANCELLED immediately',
  /cancellableNow[\s\S]{0,300}status: 'CANCELLED',\s*\n\s*completedAt: new Date\(\)/.test(svc))
check('IN_PROGRESS → CANCELLING (cooperative)',
  /Cancelling job \(cooperative\)[\s\S]{0,200}status: 'CANCELLING'/.test(svc))
check('rejects other statuses',
  /Cannot cancel job with status:/.test(svc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 10 complete)')
