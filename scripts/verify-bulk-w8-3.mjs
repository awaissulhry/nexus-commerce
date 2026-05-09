#!/usr/bin/env node
// Verify W8.3 — import wizard UI.
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

console.log('\nW8.3 — import wizard UI\n')

const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/imports/page.tsx'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/imports/ImportsClient.tsx'),
  'utf8',
)
const root = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/page.tsx'),
  'utf8',
)

console.log('Case 1: page shell + breadcrumb')
check("page is force-dynamic", /export const dynamic = 'force-dynamic'/.test(page))
check('renders ImportsClient', /<ImportsClient \/>/.test(page))
check('breadcrumb back to /bulk-operations',
  /href: '\/bulk-operations'/.test(page))

console.log('\nCase 2: file picker accepts csv / xlsx / xls / json')
check("accept attr lists every kind",
  /accept="\.csv,\.xlsx,\.xls,\.json"/.test(client))

console.log('\nCase 3: client → server flow')
check('POST /api/import-jobs/preview',
  /\/api\/import-jobs\/preview/.test(client))
check('POST /api/import-jobs/:id/apply',
  /\/import-jobs\/\$\{[^}]*\}\/apply/.test(client))
check('POST /api/import-jobs/:id/retry-failed',
  /\/import-jobs\/\$\{[^}]*\}\/retry-failed/.test(client))
check('POST /api/import-jobs/:id/rollback',
  /\/import-jobs\/\$\{[^}]*\}\/rollback/.test(client))
check('GET /api/import-jobs (history)',
  /\/api\/import-jobs\?limit=100/.test(client))

console.log('\nCase 4: XLSX path uses ArrayBuffer + base64')
check('arrayBufferToBase64 helper',
  /function arrayBufferToBase64\(buffer: ArrayBuffer\)/.test(client))
check('xlsx branch sends bytesBase64',
  /kind === 'xlsx'[\s\S]{0,200}body\.bytesBase64 = arrayBufferToBase64/.test(client))
check('csv / json branch sends text',
  /body\.text = await file\.text\(\)/.test(client))

console.log('\nCase 5: mapping confirmation surface')
check('PRODUCT_FIELDS list',
  /const PRODUCT_FIELDS =/.test(client))
check('SKU marked required',
  /id: 'sku'[\s\S]{0,80}required: true/.test(client))
check('per-field <select> wires mapping change',
  /setMapping\(\{ \.\.\.mapping, \[f\.id\]: e\.target\.value \}\)/.test(client))
check('unmapped columns surfaced',
  /Unmapped columns/.test(client))
check("On error: skip / abort selector",
  /value="skip"[\s\S]{0,100}On error: skip failed/.test(client) &&
    /value="abort"[\s\S]{0,100}On error: abort apply/.test(client))

console.log('\nCase 6: stats + status badges')
check('total / success / failed / skipped tiles',
  /preview\.job\.totalRows[\s\S]{0,400}preview\.job\.successRows[\s\S]{0,400}preview\.job\.failedRows[\s\S]{0,400}preview\.job\.skippedRows/.test(client))
for (const s of ['COMPLETED','FAILED','PARTIAL','APPLYING','PENDING_PREVIEW','CANCELLED']) {
  check(`statusBadge handles '${s}'`,
    new RegExp(`status === '${s}'`).test(client))
}

console.log('\nCase 7: history table actions')
check('Retry-failed button only when failedRows > 0',
  /j\.failedRows > 0 && j\.status !== 'PENDING_PREVIEW'/.test(client))
check('Rollback button gated on success + status',
  /j\.successRows > 0 &&[\s\S]{0,200}j\.status !== 'APPLYING'/.test(client))
check('Rollback prompts confirmation',
  /useConfirm/.test(client) && /Rollback "[^"]+"/.test(client))

console.log('\nCase 8: drill-in panel')
check('drill modal renders rows',
  /drillRows\.map\(\(r\)/.test(client))
check("filter chips for all / SUCCESS / FAILED / SKIPPED",
  /\['all', 'SUCCESS', 'FAILED', 'SKIPPED'\] as const/.test(client))
check('errorMessage rendered when present',
  /r\.errorMessage \?\? ''/.test(client))

console.log('\nCase 9: bulk-operations root page links to /imports')
check('Upload icon imported',
  /Upload[\s\S]{0,200}from 'lucide-react'/.test(root))
check('"Imports" link present', /href="\/bulk-operations\/imports"/.test(root))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
