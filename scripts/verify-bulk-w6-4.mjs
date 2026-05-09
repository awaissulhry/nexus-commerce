#!/usr/bin/env node
// Verify W6.4 — /bulk-operations/schedules page (closes Wave 6).
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

console.log('\nW6.4 — /bulk-operations/schedules page\n')

const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/schedules/page.tsx'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/schedules/SchedulesClient.tsx'),
  'utf8',
)
const root = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/page.tsx'),
  'utf8',
)

console.log('Case 1: page shell')
check("page declares dynamic = 'force-dynamic'",
  /export const dynamic = 'force-dynamic'/.test(page))
check('renders SchedulesClient', /<SchedulesClient \/>/.test(page))
check('breadcrumb back to /bulk-operations',
  /href: '\/bulk-operations'/.test(page))

console.log('\nCase 2: SchedulesClient API surface')
check('GET /api/scheduled-bulk-actions',
  /\/api\/scheduled-bulk-actions\?limit=200/.test(client))
check('PATCH /:id/enabled (pause/resume)',
  /\/api\/scheduled-bulk-actions\/\$\{[^}]+\}\/enabled[\s\S]{0,200}method:\s*'PATCH'/.test(client))
check('DELETE /:id',
  /\/api\/scheduled-bulk-actions\/\$\{[^}]+\}[\s\S]{0,80}method:\s*'DELETE'/.test(client))
check('POST /tick (manual fire)',
  /\/api\/scheduled-bulk-actions\/tick[\s\S]{0,80}method:\s*'POST'/.test(client))

console.log('\nCase 3: status grouping')
check('groups due / upcoming / paused / exhausted',
  /due: Schedule\[\][\s\S]{0,200}upcoming: Schedule\[\][\s\S]{0,200}paused: Schedule\[\][\s\S]{0,200}exhausted: Schedule\[\]/.test(client))
check('summary chip shows counts',
  /grouped\.due\.length[\s\S]{0,200}grouped\.upcoming\.length[\s\S]{0,200}grouped\.paused\.length[\s\S]{0,200}grouped\.exhausted\.length/.test(client))

console.log('\nCase 4: row affordances')
check('pause / play toggle',
  /<Pause /.test(client) && /<Play /.test(client) &&
    /setEnabled\(s\.id, !s\.enabled\)/.test(client))
check('delete button + confirm dialog',
  /<Trash2 /.test(client) && /useConfirm/.test(client))
check('"Run tick now" button when due > 0',
  /Run tick now/.test(client) && /grouped\.due\.length === 0/.test(client))
check('lastJobId links into Job History',
  /\/bulk-operations\/history\?jobId=\$\{s\.lastJobId\}/.test(client))

console.log('\nCase 5: cadence display')
check('cron expression rendered as monospace',
  /font-mono[\s\S]{0,100}s\.cronExpression/.test(client))
check('one-time formatted with "once @ <datetime>"',
  /once @\s*\{formatDateTime\(s\.scheduledFor\)\}/.test(client))
check('timezone shown under cadence',
  /tz:\s*\{s\.timezone\}/.test(client))

console.log('\nCase 6: status badges')
check("'Paused' badge when !enabled",
  /Paused</.test(client) && /!s\.enabled/.test(client))
check("'Exhausted' badge when nextRunAt null",
  /Exhausted</.test(client))
check("'Recurring' / 'One-time' badges",
  /Recurring</.test(client) && /One-time</.test(client))

console.log('\nCase 7: relative-time formatter')
check('relative() handles future + past',
  /diff > 0 \? `in \$\{min\}m` : `\$\{min\}m ago`/.test(client))

console.log('\nCase 8: bulk-operations root page links to schedules')
check('Schedules link added to actions',
  /href="\/bulk-operations\/schedules"/.test(root))
check('CalendarClock icon imported',
  /CalendarClock/.test(root))

console.log('\nCase 9: 30s auto-refresh')
check('setInterval(30_000)',
  /setInterval\(fetchSchedules, 30_000\)/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 6 complete — Scheduling shipped)')
