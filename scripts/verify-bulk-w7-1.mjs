#!/usr/bin/env node
// Verify W7.1 — bulk-ops action handlers registered into the
// AutomationRule engine.
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

console.log('\nW7.1 — bulk-ops action handlers\n')

const src = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/automation/bulk-ops-actions.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log('Case 1: trigger + action constants')
check('exports BULK_OPS_TRIGGERS',
  /export const BULK_OPS_TRIGGERS/.test(src))
check('lists 4 expected triggers',
  /'bulk_job_completed'/.test(src) &&
    /'bulk_job_failed_burst'/.test(src) &&
    /'schedule_fired'/.test(src) &&
    /'bulk_cron_tick'/.test(src))
check('exports BULK_OPS_ACTION_TYPES',
  /export const BULK_OPS_ACTION_TYPES/.test(src))
check('lists 3 expected action types',
  /'apply_bulk_template'/.test(src) &&
    /'create_bulk_job'/.test(src) &&
    /'pause_schedules_matching'/.test(src))

console.log('\nCase 2: handlers')
check('apply_bulk_template handler defined',
  /const apply_bulk_template: ActionHandler/.test(src))
check('create_bulk_job handler defined',
  /const create_bulk_job: ActionHandler/.test(src))
check('pause_schedules_matching handler defined',
  /const pause_schedules_matching: ActionHandler/.test(src))

console.log('\nCase 3: dryRun semantics')
check('apply_bulk_template returns substitutedPayload preview when dryRun',
  /if \(meta\.dryRun\) \{[\s\S]{0,300}substitutedPayload/.test(src))
check('create_bulk_job dry-run returns payload + filter shape',
  /if \(meta\.dryRun\) \{[\s\S]{0,400}targetCount: targetProductIds\?\.length \?\? null/.test(src))
check('pause_schedules_matching dry-run returns wouldPause count',
  /if \(meta\.dryRun\) \{[\s\S]{0,200}wouldPause: count/.test(src))

console.log('\nCase 4: safety guards')
check('apply_bulk_template requires templateId',
  /apply_bulk_template requires action\.templateId/.test(src))
check('create_bulk_job requires actionType',
  /create_bulk_job requires action\.actionType/.test(src))
check('pause_schedules_matching refuses pause-all without confirmAll',
  /pause_schedules_matching requires either actionType filter or confirmAll=true/.test(src))

console.log('\nCase 5: register() is idempotent')
check('register guarded by `registered` flag',
  /let registered = false/.test(src) &&
    /if \(registered\) return/.test(src))
check('mutates ACTION_HANDLERS in place',
  /ACTION_HANDLERS\['apply_bulk_template'\]/.test(src) &&
    /ACTION_HANDLERS\['create_bulk_job'\]/.test(src) &&
    /ACTION_HANDLERS\['pause_schedules_matching'\]/.test(src))
check('exports registerBulkOpsActions',
  /export function registerBulkOpsActions/.test(src))

console.log('\nCase 6: index.ts wires the registration at boot')
check('boot block calls registerBulkOpsActions',
  /registerBulkOpsActions\(\)/.test(idx))
check('lazy import (so a missing module never blocks boot)',
  /import\(\s*'\.\/services\/automation\/bulk-ops-actions\.js'\s*\)/.test(idx))
check('failure path catches + warns',
  /\[boot\] bulk-ops automation actions skipped/.test(idx))

console.log('\nCase 7: telemetry hook on apply_bulk_template')
check('records template usage on success',
  /templateService\.recordUsage\(templateId\)/.test(src))

console.log('\nCase 8: createdBy attribution traceable to rule')
check('jobs created carry createdBy=automation:<ruleId>',
  /createdBy:\s*`automation:\$\{meta\.ruleId\}`/.test(src))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
