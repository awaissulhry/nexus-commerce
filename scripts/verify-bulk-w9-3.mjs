#!/usr/bin/env node
// Verify W9.3 — Export trigger + history page.
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

console.log('\nW9.3 — Export trigger + history page\n')

const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/exports/page.tsx'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/exports/ExportsClient.tsx'),
  'utf8',
)
const hub = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/page.tsx'),
  'utf8',
)

console.log('Case 1: /bulk-operations/exports page shell')
check('force-dynamic export',
  /export const dynamic = 'force-dynamic'/.test(page))
check('exports page mounts the tabs wrapper',
  /<ExportsTabs \/>|<ExportsClient \/>/.test(page))
check('breadcrumb back to /bulk-operations',
  /href: '\/bulk-operations'/.test(page) && /label: 'Exports'/.test(page))
check('PageHeader title set',
  /title="Export(?:s| wizard)"/.test(page))

console.log('\nCase 2: ExportsClient is a client component')
check("starts with 'use client'",
  /^'use client'/.test(client))
check('default-exports ExportsClient',
  /export default function ExportsClient/.test(client))

console.log('\nCase 3: builder + format options')
for (const fmt of ['csv', 'xlsx', 'json', 'pdf']) {
  check(`format option '${fmt}'`,
    new RegExp(`['\"]${fmt}['\"]`).test(client))
}
check('column picker tracks pickedColumns state',
  /pickedColumns,\s*setPickedColumns/.test(client))
check('toggleColumn flips membership',
  /prev\.includes\(id\) \? prev\.filter/.test(client))

console.log('\nCase 4: history table + actions')
check('history fetches GET /api/export-jobs',
  /\/api\/export-jobs\?limit=/.test(client))
check('download link points at :id/download',
  /\/api\/export-jobs\/\$\{j\.id\}\/download/.test(client))
check('delete uses DELETE /api/export-jobs/:id',
  /method: 'DELETE'/.test(client) &&
  /\/api\/export-jobs\/\$\{job\.id\}/.test(client))
check('confirms before delete',
  /useConfirm\(\)/.test(client) &&
  /tone: 'danger'/.test(client))
check('status badges for COMPLETED/FAILED/RUNNING/PENDING',
  /status === 'COMPLETED'/.test(client) &&
  /status === 'FAILED'/.test(client) &&
  /status === 'RUNNING'/.test(client) &&
  /status === 'PENDING'/.test(client))

console.log('\nCase 5: run-export wiring')
check('POST /api/export-jobs with format + columns',
  /\/api\/export-jobs`,\s*\{\s*method: 'POST'/.test(client) &&
  /JSON\.stringify\(\{[\s\S]{0,200}format,[\s\S]{0,200}columns/.test(client))
check('targetEntity defaults to product',
  /targetEntity: 'product'/.test(client))
check('auto-downloads after COMPLETED inline run',
  /j\.job\?\.status === 'COMPLETED'/.test(client) &&
  /window\.location\.href = `\$\{getBackendUrl\(\)\}\/api\/export-jobs/.test(client))

console.log('\nCase 6: Exports link in /bulk-operations hub')
check('imports Download icon',
  /Download[,\s]/.test(hub))
check('Link points at /bulk-operations/exports',
  /href="\/bulk-operations\/exports"/.test(hub))
check('label says Exports',
  /Exports\s*<\/Link>/.test(hub))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
