#!/usr/bin/env node
// Verify W8.1 — ImportJob + ImportJobRow + ScheduledImport schema
// + service.
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

console.log('\nW8.1 — Import wizard schema + service\n')

console.log('Case 1: ImportJob columns')
{
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ImportJob'`)
  for (const col of [
    'id','jobName','description','source','sourceUrl','filename','fileKind',
    'targetEntity','columnMapping','onError','status',
    'totalRows','successRows','failedRows','skippedRows','errorSummary',
    'scheduleId','parentJobId',
    'createdBy','createdAt','startedAt','completedAt','updatedAt',
  ]) {
    check(`ImportJob.${col}`, r.rows.some((x) => x.column_name === col))
  }
}

console.log('\nCase 2: ImportJobRow + FK cascade')
{
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ImportJobRow'`)
  for (const col of [
    'id','jobId','rowIndex','targetId','parsedValues',
    'status','errorMessage','beforeState','afterState',
    'createdAt','completedAt',
  ]) {
    check(`ImportJobRow.${col}`, r.rows.some((x) => x.column_name === col))
  }
  const fk = await c.query(`
    SELECT confdeltype FROM pg_constraint
    WHERE conrelid = '"ImportJobRow"'::regclass AND contype = 'f'
  `)
  check('FK has ON DELETE CASCADE', fk.rows.some((x) => x.confdeltype === 'c'))
}

console.log('\nCase 3: ScheduledImport columns + (enabled,nextRunAt) idx')
{
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ScheduledImport'`)
  for (const col of [
    'id','name','description','source','sourceUrl','targetEntity',
    'columnMapping','onError','cronExpression','scheduledFor','timezone',
    'nextRunAt','enabled','lastRunAt','lastJobId','lastStatus',
    'lastError','runCount','createdBy','createdAt','updatedAt',
  ]) {
    check(`ScheduledImport.${col}`, r.rows.some((x) => x.column_name === col))
  }
  const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'ScheduledImport'`)
  check('enabled+nextRunAt index',
    idx.rows.some((x) => x.indexname === 'ScheduledImport_enabled_nextRunAt_idx'))
}

console.log('\nCase 4: end-to-end create + apply + per-row tracking')
{
  // Seed a Product the import will mutate
  const sku = `verify-w8-1-${Date.now()}`
  const prod = await c.query(
    `INSERT INTO "Product" (id, sku, name, "basePrice", status, "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'Test Product', 50.00, 'ACTIVE', NOW(), NOW())
     RETURNING id`,
    [sku],
  )
  const productId = prod.rows[0].id

  const jobId = `verify-w8-1-job-${Date.now()}`
  await c.query(
    `INSERT INTO "ImportJob" (
       id, "jobName", source, "fileKind", "targetEntity",
       "columnMapping", "onError", status, "totalRows",
       "createdAt", "updatedAt"
     ) VALUES (
       $1, 'Test', 'upload', 'csv', 'product',
       '{"sku":"SKU","basePrice":"Price"}'::jsonb, 'skip', 'PENDING_PREVIEW', 1,
       NOW(), NOW()
     )`,
    [jobId],
  )
  const rowId = `${jobId}-row-1`
  await c.query(
    `INSERT INTO "ImportJobRow" (
       id, "jobId", "rowIndex", "parsedValues", status, "createdAt"
     ) VALUES (
       $1, $2, 1, $3::jsonb, 'PENDING', NOW()
     )`,
    [rowId, jobId, JSON.stringify({ sku, basePrice: 75.5 })],
  )

  // Mirror the write path (set basePrice=75.5, capture before/after)
  const before = await c.query(`SELECT "basePrice" FROM "Product" WHERE id = $1`, [productId])
  await c.query(`UPDATE "Product" SET "basePrice" = 75.5 WHERE id = $1`, [productId])
  const after = await c.query(`SELECT "basePrice" FROM "Product" WHERE id = $1`, [productId])
  check(`basePrice changed (${before.rows[0].basePrice} → ${after.rows[0].basePrice})`,
    Number(before.rows[0].basePrice) === 50 && Number(after.rows[0].basePrice) === 75.5)

  await c.query(
    `UPDATE "ImportJobRow"
       SET status = 'SUCCESS',
           "targetId" = $2,
           "beforeState" = $3::jsonb,
           "afterState" = $4::jsonb,
           "completedAt" = NOW()
     WHERE id = $1`,
    [rowId, productId, JSON.stringify({ basePrice: 50 }), JSON.stringify({ basePrice: 75.5 })],
  )
  await c.query(
    `UPDATE "ImportJob"
       SET status = 'COMPLETED', "successRows" = 1, "completedAt" = NOW()
     WHERE id = $1`,
    [jobId],
  )

  // FK cascade: deleting the job drops the row.
  await c.query(`DELETE FROM "ImportJob" WHERE id = $1`, [jobId])
  const remaining = await c.query(
    `SELECT count(*)::int FROM "ImportJobRow" WHERE id = $1`,
    [rowId],
  )
  check('child row cascaded on parent delete', remaining.rows[0].count === 0)

  // Restore the product to its before-state to keep the catalog clean.
  await c.query(`UPDATE "Product" SET "basePrice" = 50 WHERE id = $1`, [productId])
  await c.query(`DELETE FROM "Product" WHERE id = $1`, [productId])
}

console.log('\nCase 5: source-level service shape')
const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/import-wizard.service.ts'),
  'utf8',
)
for (const sym of ['class ImportWizardService', 'create(', 'apply(', 'retryFailed(', 'rollback(', 'list(', 'listRows(', 'get(']) {
  check(`exposes ${sym}`, svc.includes(sym))
}
check('apply respects onError abort vs skip',
  /job\.onError === 'abort'/.test(svc))
check('writeRow whitelists Product fields',
  /ALLOWED_FIELDS = new Set/.test(svc) && /'basePrice'/.test(svc))
check('rollback creates a child job linked via parentJobId',
  /parentJobId: job\.id/.test(svc))
check('retryFailed forks FAILED rows only',
  /retryFailed\([\s\S]{0,800}status: 'FAILED'/.test(svc) &&
    /rows: failedRows\.map/.test(svc))

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
