#!/usr/bin/env node
// Verify W6.3 — schedule picker in BulkOperationModal.
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

console.log('\nW6.3 — schedule picker in BulkOperationModal\n')

const modal = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationModal.tsx'),
  'utf8',
)

console.log('Case 1: schedule state declared')
for (const sig of [
  /const \[scheduleMode, setScheduleMode\] = useState<'now' \| 'schedule'>/,
  /const \[scheduleAt, setScheduleAt\] = useState/,
  /const \[scheduleCron, setScheduleCron\] = useState/,
  /const \[scheduleName, setScheduleName\] = useState/,
  /const \[scheduling, setScheduling\] = useState\(false\)/,
  /const \[scheduleResult, setScheduleResult\]/,
]) {
  check(`state ${sig.source.slice(0, 40)}…`, sig.test(modal))
}

console.log('\nCase 2: toggle button + CalendarClock icon')
check('CalendarClock imported', /CalendarClock,/.test(modal))
check('toggle flips mode', /setScheduleMode\(\(m\) => \(m === 'now' \? 'schedule' : 'now'\)\)/.test(modal))
check("button label switches 'Schedule…' / 'Run now'",
  /scheduleMode === 'schedule' \? 'Run now' : 'Schedule…'/.test(modal))

console.log('\nCase 3: primary button branches on mode')
check("'now' mode shows handleExecute button",
  /scheduleMode === 'now' && \(\s*<Button[\s\S]{0,200}onClick=\{handleExecute\}/.test(modal))
check("'schedule' mode shows POST /api/scheduled-bulk-actions",
  /scheduleMode === 'schedule' && \(/.test(modal) &&
    /\/api\/scheduled-bulk-actions['`]/.test(modal))

console.log('\nCase 4: schedule fields rendered when in schedule mode')
check('datetime-local input',
  /type="datetime-local"[\s\S]{0,300}value=\{scheduleAt\}/.test(modal))
check('cron input with placeholder',
  /placeholder="m h dom mon dow"/.test(modal))
check('schedule name input',
  /value=\{scheduleName\}[\s\S]{0,200}placeholder=\{op\?\.label/.test(modal))
check('Europe/Rome tz hint shown',
  /Europe\/Rome/.test(modal))

console.log('\nCase 5: validation + result')
check('button disabled until at OR cron set',
  /\(!scheduleAt && !scheduleCron\)/.test(modal))
check("scheduleResult shows 'Schedule saved.'",
  /Schedule saved\./.test(modal))
check('next-run datetime rendered when present',
  /Next run:[\s\S]{0,80}toLocaleString/.test(modal))

console.log('\nCase 6: POST body shape')
check('body includes actionType + actionPayload + filters + targetProductIds',
  /actionType: opType[\s\S]{0,300}actionPayload: payload[\s\S]{0,300}scopePayload\.targetProductIds/.test(modal))
check('scheduledFor sent as ISO',
  /scheduleAt[\s\S]{0,80}new Date\(scheduleAt\)\.toISOString\(\)/.test(modal))
check('cronExpression null when blank',
  /scheduleCron\.trim\(\) \|\| null/.test(modal))
check('timezone Europe/Rome',
  /timezone: 'Europe\/Rome'/.test(modal))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
