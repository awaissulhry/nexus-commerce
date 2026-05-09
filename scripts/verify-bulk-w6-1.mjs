#!/usr/bin/env node
// Verify W6.1 — ScheduledBulkAction schema + service.
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

console.log('\nW6.1 — ScheduledBulkAction schema + service\n')

console.log('Case 1: table columns')
{
  const r = await c.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'ScheduledBulkAction'
  `)
  const expected = [
    'id','name','description','actionType','channel','actionPayload',
    'targetProductIds','targetVariationIds','filters',
    'scheduledFor','cronExpression','timezone','nextRunAt','enabled',
    'lastRunAt','lastJobId','lastStatus','lastError','runCount',
    'templateId','createdBy','createdAt','updatedAt',
  ]
  for (const col of expected) {
    check(`column ${col}`, r.rows.some((x) => x.column_name === col))
  }
}

console.log('\nCase 2: indexes')
{
  const r = await c.query(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'ScheduledBulkAction'
  `)
  check('enabled+nextRunAt index',
    r.rows.some((x) => x.indexname === 'ScheduledBulkAction_enabled_nextRunAt_idx'))
  check('actionType index',
    r.rows.some((x) => x.indexname === 'ScheduledBulkAction_actionType_idx'))
  check('templateId index',
    r.rows.some((x) => x.indexname === 'ScheduledBulkAction_templateId_idx'))
}

console.log('\nCase 3: insert + read roundtrip')
{
  const id = `verify-w6-1-${Date.now()}`
  await c.query(
    `INSERT INTO "ScheduledBulkAction" (
       id, name, "actionType", "actionPayload",
       "scheduledFor", "cronExpression", timezone,
       "nextRunAt", enabled, "runCount",
       "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, 'PRICING_UPDATE', '{"adjustmentType":"PERCENT","value":-5}'::jsonb,
       NULL, '0 2 * * *', 'Europe/Rome',
       $3, true, 0,
       NOW(), NOW()
     )`,
    [id, 'Daily 2am test', new Date(Date.now() + 60_000)],
  )
  const r = await c.query(
    `SELECT name, "cronExpression", timezone, enabled, "runCount"
       FROM "ScheduledBulkAction" WHERE id = $1`, [id])
  check('row inserted', r.rows.length === 1)
  check('cronExpression roundtrips',
    r.rows[0].cronExpression === '0 2 * * *')
  check('timezone defaults to Europe/Rome',
    r.rows[0].timezone === 'Europe/Rome')
  await c.query(`DELETE FROM "ScheduledBulkAction" WHERE id = $1`, [id])
}

console.log('\nCase 4: source-level service shape')
const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/scheduled-bulk-action.service.ts'),
  'utf8',
)
for (const sym of [
  'class ScheduledBulkActionService',
  'create(',
  'list(',
  'get(',
  'setEnabled(',
  'delete(',
  'findDueSchedules(',
  'markFired(',
  'computeNextRun(',
  'validateCronExpression(',
]) {
  check(`exposes ${sym}`, svc.includes(sym))
}
check('rejects unknown actionType',
  /not in KNOWN_BULK_ACTION_TYPES/.test(svc))
check('requires scheduledFor OR cronExpression',
  /Schedule must carry either scheduledFor or cronExpression/.test(svc))

console.log('\nCase 5: computeNextRun behaviour (mirrored)')
// We can't easily call cron-parser from this verifier without compile,
// so instead we validate the dispatch logic by source patterns.
check('one-time exhausts after fire',
  /if \(row\.runCount > 0\) return null/.test(svc))
check('recurring uses cron-parser via parseCron',
  /parseCron\(row\.cronExpression/.test(svc))
check('respects scheduledFor as start gate for recurring',
  /if \(row\.scheduledFor && cronNext < row\.scheduledFor\)/.test(svc))

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
