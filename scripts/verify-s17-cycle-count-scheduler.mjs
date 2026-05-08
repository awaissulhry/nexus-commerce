#!/usr/bin/env node
/**
 * S.17 verification — ABC-driven cycle-count scheduler.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const service = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/cycle-count-scheduler.service.ts'), 'utf8')
const job = fs.readFileSync(path.join(here, '..', 'apps/api/src/jobs/cycle-count-scheduler.job.ts'), 'utf8')
const apiIndex = fs.readFileSync(path.join(here, '..', 'apps/api/src/index.ts'), 'utf8')
const fulfillmentRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/fulfillment.routes.ts'), 'utf8')
const listClient = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/cycle-count/CycleCountListClient.tsx'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Service exports
if (/export async function scheduleAutoCount/.test(service)) ok('service exports scheduleAutoCount')
else bad('service exports scheduleAutoCount')
if (/export async function findDueForCount/.test(service)) ok('service exports findDueForCount')
else bad('service exports findDueForCount')
if (/export function getCadenceConfig/.test(service)) ok('service exports getCadenceConfig')
else bad('service exports getCadenceConfig')

// 2. Default cadence A=7, B=30, C=90, D=180
if (/A:\s*7,/.test(service) && /B:\s*30,/.test(service) && /C:\s*90,/.test(service) && /D:\s*180,/.test(service)) {
  ok('service defaults A=7, B=30, C=90, D=180 days')
} else {
  bad('service defaults A=7, B=30, C=90, D=180 days')
}

// 3. Operator override via env
if (/NEXUS_ABC_CADENCE_DAYS/.test(service)) ok('service supports NEXUS_ABC_CADENCE_DAYS override')
else bad('service supports NEXUS_ABC_CADENCE_DAYS override')

// 4. Idempotency: skip if existing DRAFT/IN_PROGRESS auto-scheduled session
if (/status:\s*\{\s*in:\s*\['DRAFT',\s*'IN_PROGRESS'\][\s\S]*?notes:\s*\{\s*startsWith:\s*'auto-scheduled'/.test(service)) {
  ok('service is idempotent against existing auto-scheduled DRAFT/IN_PROGRESS')
} else {
  bad('service is idempotent against existing auto-scheduled DRAFT/IN_PROGRESS')
}

// 5. Sort priority: A first, then never-counted, then oldest count
if (/order =\s*\{\s*A:\s*0,\s*B:\s*1,\s*C:\s*2,\s*D:\s*3/.test(service)) {
  ok('due list sorted A>B>C>D priority')
} else {
  bad('due list sorted A>B>C>D priority')
}

// 6. Cron job — 02:30 UTC daily, opt-out env, registered in apiIndex
if (/30 2 \* \* \*/.test(job)) ok('cron schedule = daily 02:30 UTC')
else bad('cron schedule = daily 02:30 UTC')
if (/NEXUS_ENABLE_CYCLE_COUNT_SCHEDULER/.test(job)) ok('cron has opt-out env')
else bad('cron has opt-out env')
if (/import \{ startCycleCountSchedulerCron \}/.test(apiIndex)) ok('apiIndex imports cron')
else bad('apiIndex imports cron')
if (/startCycleCountSchedulerCron\(\)/.test(apiIndex)) ok('apiIndex starts cron')
else bad('apiIndex starts cron')

// 7. Endpoints
if (/'\/fulfillment\/cycle-counts\/due'/.test(fulfillmentRoutes)) ok('GET /api/fulfillment/cycle-counts/due registered')
else bad('GET /api/fulfillment/cycle-counts/due registered')
if (/'\/fulfillment\/cycle-counts\/auto-schedule'/.test(fulfillmentRoutes)) ok('POST /api/fulfillment/cycle-counts/auto-schedule registered')
else bad('POST /api/fulfillment/cycle-counts/auto-schedule registered')

// 8. Frontend manual-trigger button
if (/handleAutoSchedule/.test(listClient)) ok('list client wires handleAutoSchedule')
else bad('list client wires handleAutoSchedule')
if (/api\/fulfillment\/cycle-counts\/auto-schedule/.test(listClient)) {
  ok('list client posts to auto-schedule endpoint')
} else {
  bad('list client posts to auto-schedule endpoint')
}
if (/cycleCount\.list\.actionAutoSchedule/.test(listClient)) ok('list client renders Auto-schedule button')
else bad('list client renders Auto-schedule button')

// 9. Catalog parity
const newKeys = [
  'cycleCount.list.actionAutoSchedule', 'cycleCount.list.actionAutoScheduleTitle',
  'cycleCount.list.toast.autoScheduled', 'cycleCount.list.toast.autoScheduleNoneDue',
  'cycleCount.list.toast.autoScheduleFailed',
]
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k]) bad(`${k} translated`)
}

console.log()
console.log(`[S.17 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
