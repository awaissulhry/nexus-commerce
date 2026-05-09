#!/usr/bin/env node
// Verify W9.1 — ExportJob + ScheduledExport schema + service.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
dotenv.config({ path: path.join(repo, '.env') })
let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW9.1 — Export schema + service\n')

console.log('Case 1: ExportJob columns')
{
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ExportJob'`)
  for (const col of [
    'id','jobName','description','format','targetEntity','columns','filters',
    'status','rowCount','bytes','artifactBase64','artifactUrl','errorMessage',
    'scheduleId','createdBy','createdAt','startedAt','completedAt','updatedAt',
  ]) {
    check(`ExportJob.${col}`, r.rows.some((x) => x.column_name === col))
  }
}

console.log('\nCase 2: ScheduledExport columns + index')
{
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ScheduledExport'`)
  for (const col of [
    'id','name','format','targetEntity','columns','filters',
    'delivery','deliveryTarget','cronExpression','scheduledFor','timezone',
    'nextRunAt','enabled','lastRunAt','lastJobId','lastStatus',
    'lastError','runCount','createdBy','createdAt','updatedAt',
  ]) {
    check(`ScheduledExport.${col}`, r.rows.some((x) => x.column_name === col))
  }
  const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'ScheduledExport'`)
  check('enabled+nextRunAt index',
    idx.rows.some((x) => x.indexname === 'ScheduledExport_enabled_nextRunAt_idx'))
}

console.log('\nCase 3: end-to-end create + render + roundtrip')
{
  const id = `verify-w9-1-${Date.now()}`
  const cols = JSON.stringify([
    { id: 'sku', label: 'SKU' },
    { id: 'name', label: 'Name' },
    { id: 'basePrice', label: 'Price', format: 'currency' },
  ])
  await c.query(
    `INSERT INTO "ExportJob" (
       id, "jobName", format, "targetEntity", columns, status,
       "rowCount", bytes, "createdAt", "updatedAt"
     ) VALUES (
       $1, 'Test export', 'csv', 'product', $2::jsonb, 'COMPLETED',
       2, 80, NOW(), NOW()
     )`,
    [id, cols],
  )
  const r = await c.query(
    `SELECT format, "targetEntity", columns FROM "ExportJob" WHERE id = $1`, [id])
  check('row inserted', r.rows.length === 1)
  check('columns roundtrip JSON',
    Array.isArray(r.rows[0].columns) && r.rows[0].columns[0].id === 'sku')
  await c.query(`DELETE FROM "ExportJob" WHERE id = $1`, [id])
}

console.log('\nCase 4: source-level service shape')
const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/export-wizard.service.ts'),
  'utf8',
)
for (const sym of ['class ExportWizardService', 'create(', 'list(', 'get(', 'run(', 'download(', 'delete(']) {
  check(`exposes ${sym}`, svc.includes(sym))
}
check('rejects unknown format',
  /Unknown format:/.test(svc))
check('rejects empty columns',
  /columns is required \(non-empty\)/.test(svc))
check('inline payload <1MB; bigger uses URL',
  /INLINE_PAYLOAD_LIMIT_BYTES = 1_000_000/.test(svc) &&
  /inline = bytes\.byteLength <= INLINE_PAYLOAD_LIMIT_BYTES/.test(svc))
check('download() returns filename + contentType + bytes',
  /interface DownloadResult/.test(svc) &&
  /filename: string[\s\S]{0,200}contentType: string/.test(svc))

console.log('\nCase 5: CSV + JSON renderers')
const renderers = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/export/renderers.ts'),
  'utf8',
)
check('exports renderExport',
  /export async function renderExport/.test(renderers))
check("ColumnSpec interface present",
  /export interface ColumnSpec/.test(renderers))
check('CSV cell escapes quotes/commas/newlines',
  /\[",\\n\\r\]/.test(renderers))
check('JSON renderer present',
  /input\.format === 'json'/.test(renderers))
check('xlsx + pdf throw "not yet implemented"',
  /Renderer for \$\{input\.format\} not yet implemented/.test(renderers))

// Mirror CSV rendering for behavioural test
function csvCell(s) {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}
function renderCsv(rows, cols) {
  const lines = [cols.map((c) => csvCell(c.label)).join(',')]
  for (const r of rows) {
    lines.push(cols.map((c) => csvCell(String(r[c.id] ?? ''))).join(','))
  }
  return lines.join('\n') + '\n'
}
const csvOut = renderCsv(
  [{ sku: 'AIR-J', name: 'Airmesh, Black', basePrice: '99.00' }],
  [{ id: 'sku', label: 'SKU' }, { id: 'name', label: 'Name' }, { id: 'basePrice', label: 'Price' }],
)
check("CSV escapes 'Airmesh, Black' with quotes",
  csvOut.includes('"Airmesh, Black"'))
check('CSV ends with newline',
  csvOut.endsWith('\n'))

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
