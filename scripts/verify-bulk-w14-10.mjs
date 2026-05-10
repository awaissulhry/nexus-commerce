#!/usr/bin/env node
// Verify W14.10 — scheduled exports tab on /bulk-operations/exports.
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

console.log('\nW14.10 — scheduled exports tab\n')

const panel = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/exports/ScheduledExportsPanel.tsx'),
  'utf8',
)
const tabs = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/exports/ExportsTabs.tsx'),
  'utf8',
)
const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/exports/page.tsx'),
  'utf8',
)

console.log('Case 1: panel CRUD wired to /api/scheduled-exports')
check('GET list', /\/api\/scheduled-exports\?limit=200/.test(panel))
check('POST create', /\/api\/scheduled-exports`,\s*\{\s*method: 'POST'/.test(panel))
check('PATCH /:id/enabled toggle',
  /\/api\/scheduled-exports\/\$\{row\.id\}\/enabled/.test(panel) &&
  /method: 'PATCH'/.test(panel))
check('DELETE /:id',
  /\/api\/scheduled-exports\/\$\{row\.id\}/.test(panel) &&
  /method: 'DELETE'/.test(panel))
check('POST /tick manual fire',
  /\/api\/scheduled-exports\/tick/.test(panel))

console.log('\nCase 2: form fields + delivery validation')
check('cron field defaults daily 07:00', /'0 7 \* \* \*'/.test(panel))
check('format options csv/xlsx/json/pdf',
  /FORMATS = \['csv', 'xlsx', 'json', 'pdf'\]/.test(panel))
check('delivery options email/webhook',
  /DELIVERIES = \['email', 'webhook'\]/.test(panel))
check('webhook delivery requires http(s) URL',
  /Webhook delivery requires an http\(s\) URL in deliveryTarget/.test(panel))
check('default columns use SKU + Name + Brand + price + stock',
  /DEFAULT_COLUMNS = \[[\s\S]{0,400}id: 'sku'[\s\S]{0,200}id: 'totalStock'/.test(panel))

console.log('\nCase 3: row actions + a11y')
check('Pause/Resume button has aria-label',
  /aria-label=\{[\s\S]{0,200}Pause \$\{r\.name\}[\s\S]{0,200}Resume \$\{r\.name\}/.test(panel))
check('Delete button has aria-label',
  /aria-label=\{`Delete \$\{r\.name\}`\}/.test(panel))
check('confirm dialog before delete',
  /useConfirm\(\)/.test(panel) && /tone: 'danger'/.test(panel))

console.log('\nCase 4: render delivery cell + status badges')
check('shows deliveryTarget when set',
  /r\.deliveryTarget && \(/.test(panel))
for (const status of ['COMPLETED', 'FAILED']) {
  check(`renders ${status} badge`,
    new RegExp(`r\\.lastStatus === '${status}'`).test(panel))
}

console.log('\nCase 5: tabs wrapper')
check("two tabs: 'recent' + 'scheduled'",
  /tab === 'recent'[\s\S]{0,200}<ExportsClient \/>/.test(tabs) &&
  /<ScheduledExportsPanel \/>/.test(tabs))
check('?tab=scheduled deep-link survives reload',
  /params\.get\('tab'\) === 'scheduled'/.test(tabs))
check('aria-selected on the active tab',
  /aria-selected=\{active\}/.test(tabs))
check('role=tablist on the strip',
  /role="tablist"/.test(tabs))

console.log('\nCase 6: page renders ExportsTabs')
check('exports page mounts ExportsTabs (not ExportsClient direct)',
  /<ExportsTabs \/>/.test(page) &&
  !/<ExportsClient \/>/.test(page))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
