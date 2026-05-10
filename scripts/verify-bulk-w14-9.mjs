#!/usr/bin/env node
// Verify W14.9 — scheduled imports tab on /bulk-operations/imports.
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

console.log('\nW14.9 — scheduled imports tab\n')

const panel = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/imports/ScheduledImportsPanel.tsx'),
  'utf8',
)
const tabs = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/imports/ImportsTabs.tsx'),
  'utf8',
)
const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/imports/page.tsx'),
  'utf8',
)

console.log('Case 1: panel CRUD wired to /api/scheduled-imports')
check('GET list', /\/api\/scheduled-imports\?limit=200/.test(panel))
check('POST create', /method: 'POST'[\s\S]{0,800}\/api\/scheduled-imports/.test(panel))
check('PATCH /:id/enabled toggle',
  /\/api\/scheduled-imports\/\$\{row\.id\}\/enabled/.test(panel) &&
  /method: 'PATCH'/.test(panel))
check('DELETE /:id',
  /\/api\/scheduled-imports\/\$\{row\.id\}/.test(panel) &&
  /method: 'DELETE'/.test(panel))
check('POST /tick manual fire',
  /\/api\/scheduled-imports\/tick/.test(panel))

console.log('\nCase 2: form fields + validation')
check('cron field defaults daily 06:00', /'0 6 \* \* \*'/.test(panel))
check('targetEntity options product/channelListing/inventory',
  /TARGET_ENTITIES = \['product', 'channelListing', 'inventory'\]/.test(panel))
check('column mapping JSON-validates client-side',
  /JSON\.parse\(columnMapping\)/.test(panel))
check('rejects empty name + sourceUrl',
  /Name and source URL are required/.test(panel))

console.log('\nCase 3: row actions + a11y')
check('Pause/Resume button has aria-label',
  /aria-label=\{[\s\S]{0,200}r\.enabled[\s\S]{0,200}Pause \$\{r\.name\}[\s\S]{0,200}Resume \$\{r\.name\}/.test(panel))
check('Delete button has aria-label',
  /aria-label=\{`Delete \$\{r\.name\}`\}/.test(panel))
check('confirm dialog before delete',
  /useConfirm\(\)/.test(panel) && /tone: 'danger'/.test(panel))
check('decorative icons aria-hidden',
  /aria-hidden="true"/.test(panel))

console.log('\nCase 4: status badge variants')
for (const status of ['COMPLETED', 'FAILED']) {
  check(`renders ${status} badge`,
    new RegExp(`r\\.lastStatus === '${status}'`).test(panel))
}

console.log('\nCase 5: tabs wrapper')
check('TabButton declared',
  /function TabButton/.test(tabs))
check("two tabs: 'recent' + 'scheduled'",
  /tab === 'recent'[\s\S]{0,200}<ImportsClient \/>/.test(tabs) &&
  /<ScheduledImportsPanel \/>/.test(tabs))
check('?tab=scheduled deep-link survives reload',
  /params\.get\('tab'\) === 'scheduled'/.test(tabs))
check('URL synced via router.replace',
  /router\.replace/.test(tabs))
check('aria-selected on the active tab',
  /aria-selected=\{active\}/.test(tabs))
check('role=tablist on the strip',
  /role="tablist"/.test(tabs))

console.log('\nCase 6: page renders ImportsTabs')
check('imports page mounts ImportsTabs (not ImportsClient direct)',
  /<ImportsTabs \/>/.test(page) &&
  !/<ImportsClient \/>/.test(page))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
