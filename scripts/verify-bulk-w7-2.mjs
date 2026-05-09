#!/usr/bin/env node
// Verify W7.2 — trigger emission for bulk-ops domain.
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

console.log('\nW7.2 — trigger emission\n')

const triggers = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/automation/bulk-ops-triggers.ts'),
  'utf8',
)
const bulkSvc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)
const schedJob = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/scheduled-bulk-action.job.ts'),
  'utf8',
)
const tickJob = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/bulk-automation-tick.job.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)
const cronReg = fs.readFileSync(
  path.join(repo, 'apps/api/src/jobs/cron-registry.ts'),
  'utf8',
)

console.log('Case 1: triggers module exports')
for (const fn of ['emitBulkJobCompleted', 'emitScheduleFired', 'fireBulkCronTick']) {
  check(`${fn} exported`,
    new RegExp(`export (function|async function) ${fn}`).test(triggers))
}
check('all calls evaluate against domain=bulk-operations',
  /domain: DOMAIN/.test(triggers) && /const DOMAIN = 'bulk-operations'/.test(triggers))

console.log('\nCase 2: bulk-action.service emits bulk_job_completed')
check('processJob lazy-imports the trigger module',
  /import\(\s*'\.\/automation\/bulk-ops-triggers\.js'\s*\)/.test(bulkSvc))
check('emit called with the completed job snapshot',
  /emitBulkJobCompleted\(\{[\s\S]{0,400}jobId,[\s\S]{0,500}status: completedJob\.status/.test(bulkSvc))
check('emit failure logged but never thrown',
  /\[bulk-action\] emitBulkJobCompleted failed/.test(bulkSvc))

console.log('\nCase 3: scheduled-bulk-action.job emits schedule_fired')
check('schedule worker lazy-imports trigger module',
  /import\(\s*'\.\.\/services\/automation\/bulk-ops-triggers\.js'\s*\)/.test(schedJob))
check('emitScheduleFired called with schedule + new jobId',
  /emitScheduleFired\(\{[\s\S]{0,400}scheduleId: row\.id[\s\S]{0,200}jobId: job\.id/.test(schedJob))
check('emit failure path logs but does not break the tick',
  /\[scheduled-bulk-action\] emit schedule_fired failed/.test(schedJob))

console.log('\nCase 4: bulk-automation-tick (15-min cron)')
check('runBulkAutomationTickOnce exported',
  /export async function runBulkAutomationTickOnce/.test(tickJob))
check('startBulkAutomationTickCron exported',
  /export function startBulkAutomationTickCron/.test(tickJob))
check('15-min interval',
  /TICK_INTERVAL_MS = 15 \* 60 \* 1000/.test(tickJob))
check('boots WITHOUT firing immediately (no double-fire on restart)',
  !/void runBulkAutomationTickOnce\(\)\s*\n\s*tickTimer/.test(tickJob))

console.log('\nCase 5: index.ts wiring')
check('imports startBulkAutomationTickCron',
  /startBulkAutomationTickCron/.test(idx))
check('boots the tick',
  /startBulkAutomationTickCron\(\)/.test(idx))

console.log('\nCase 6: cron-registry')
check('bulk-automation-tick registered for manual triggers',
  /'bulk-automation-tick':\s*\(\)\s*=>\s*runBulkAutomationTickOnce\(\)/.test(cronReg))

console.log('\nCase 7: failure rate computed in context')
check('emitBulkJobCompleted derives failureRate',
  /failureRate = args\.failedItems \/ total/.test(triggers))
check('durationMs computed from startedAt + completedAt',
  /durationMs =\s*args\.startedAt && args\.completedAt/.test(triggers))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
