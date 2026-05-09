#!/usr/bin/env node
// Verify W7.5 — visual builder UI shell.
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

console.log('\nW7.5 — visual automation builder\n')

const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/automation/page.tsx'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/automation/AutomationClient.tsx'),
  'utf8',
)
const root = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/page.tsx'),
  'utf8',
)

console.log('Case 1: page shell + breadcrumb')
check("page is force-dynamic", /export const dynamic = 'force-dynamic'/.test(page))
check('renders AutomationClient', /<AutomationClient \/>/.test(page))
check('breadcrumb back to /bulk-operations',
  /\{ label: 'Bulk Operations', href: '\/bulk-operations' \}/.test(page))

console.log('\nCase 2: trigger / action / op vocabularies')
for (const t of ['bulk_job_completed','bulk_job_failed_burst','schedule_fired','bulk_cron_tick']) {
  check(`trigger '${t}' available in builder`,
    new RegExp(`id: '${t}'`).test(client))
}
for (const a of ['apply_bulk_template','create_bulk_job','pause_schedules_matching','notify','log_only']) {
  check(`action '${a}' available in builder`,
    new RegExp(`id: '${a}'`).test(client))
}
for (const op of ['eq','ne','lt','lte','gt','gte','contains','exists']) {
  check(`condition op '${op}' available`,
    new RegExp(`'${op}'`).test(client))
}

console.log('\nCase 3: rule list + inline test + save')
check('GET /api/bulk-automation-rules',
  /\/api\/bulk-automation-rules\?limit=200/.test(client))
check('PATCH /api/bulk-automation-rules/:id',
  /\/bulk-automation-rules\/\$\{[^}]+\}[\s\S]{0,200}method:\s*['"]PATCH['"]/.test(client))
check('DELETE /api/bulk-automation-rules/:id',
  /method:\s*['"]DELETE['"]/.test(client))
check('POST /api/bulk-automation-rules (create)',
  /\/api\/bulk-automation-rules['`][\s\S]{0,200}method:\s*editingId \? 'PATCH' : 'POST'/.test(client))
check('Test button hits dry-run-inline',
  /\/bulk-automation-rules\/dry-run-inline/.test(client))

console.log('\nCase 4: builder panels in trigger → conditions → actions order')
check('1. Trigger panel',
  /1\. Trigger/.test(client))
check('2. Conditions panel',
  /2\. Conditions/.test(client))
check('3. Actions panel',
  /3\. Actions/.test(client))
check('4. Safety panel (dry-run + cap)',
  /4\. Safety/.test(client))

console.log('\nCase 5: defensive defaults in EMPTY_DRAFT')
check("draft starts dryRun=true",
  /dryRun: true/.test(client))
check('draft starts enabled=false',
  /enabled: false/.test(client))
check('draft starts maxExecutionsPerDay=100',
  /maxExecutionsPerDay: 100/.test(client))

console.log('\nCase 6: row affordances')
check('Pause / Activate toggle wired',
  /setEnabled\(r, !r\.enabled\)/.test(client))
check('Delete uses confirm dialog',
  /useConfirm/.test(client))
check('Delete clears editor when active rule removed',
  /editingId === r\.id\) startNew\(\)/.test(client))

console.log('\nCase 7: bulk-operations root page links to /automation')
check('Wand2 icon imported on root page',
  /Wand2/.test(root))
check('"Automation" link present', /Automation/.test(root))
check('href="/bulk-operations/automation"',
  /href="\/bulk-operations\/automation"/.test(root))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
