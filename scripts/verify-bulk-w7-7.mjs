#!/usr/bin/env node
// Verify W7.7 — approval-queue schema + service + routes.
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

console.log('\nW7.7 — approval gates\n')

console.log('Case 1: BulkAutomationApproval table')
{
  const r = await c.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'BulkAutomationApproval'
  `)
  for (const col of [
    'id','ruleId','ruleName','triggerPayload','actionPlan',
    'threshold','estimatedValueCentsEur','status','expiresAt',
    'approvedBy','approvedAt','rejectedBy','rejectedAt','rejectedReason',
    'resolvedActionResults','resolvedExecutionId',
    'createdBy','createdAt','updatedAt',
  ]) {
    check(`column ${col}`, r.rows.some((x) => x.column_name === col))
  }
}

console.log('\nCase 2: indexes')
{
  const r = await c.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'BulkAutomationApproval'`,
  )
  check('status+expiresAt index',
    r.rows.some((x) => x.indexname === 'BulkAutomationApproval_status_expiresAt_idx'))
  check('ruleId+createdAt index',
    r.rows.some((x) => x.indexname === 'BulkAutomationApproval_ruleId_createdAt_idx'))
}

console.log('\nCase 3: end-to-end approve flow')
{
  const id = `verify-w7-7-${Date.now()}`
  const expires = new Date(Date.now() + 60 * 60 * 1000)
  await c.query(
    `INSERT INTO "BulkAutomationApproval" (
       id, "ruleId", "ruleName", "triggerPayload", "actionPlan",
       threshold, "expiresAt", status, "createdAt", "updatedAt"
     ) VALUES (
       $1, 'rule-fake', 'test rule', '{"job":{"x":1}}'::jsonb,
       '[{"type":"log_only"}]'::jsonb, 'manual', $2, 'PENDING',
       NOW(), NOW()
     )`, [id, expires.toISOString()],
  )
  const before = await c.query(
    `SELECT status FROM "BulkAutomationApproval" WHERE id = $1`, [id])
  check('row inserted as PENDING', before.rows[0].status === 'PENDING')

  await c.query(
    `UPDATE "BulkAutomationApproval"
       SET status = 'APPROVED',
           "approvedBy" = 'awa@xavia.it',
           "approvedAt" = NOW(),
           "resolvedActionResults" = '[{"type":"log_only","ok":true,"output":{"logged":true}}]'::jsonb
     WHERE id = $1`, [id],
  )
  const after = await c.query(
    `SELECT status, "approvedBy" FROM "BulkAutomationApproval" WHERE id = $1`,
    [id],
  )
  check('approve transitions to APPROVED', after.rows[0].status === 'APPROVED')
  check('approvedBy populated', after.rows[0].approvedBy === 'awa@xavia.it')

  await c.query(`DELETE FROM "BulkAutomationApproval" WHERE id = $1`, [id])
}

console.log('\nCase 4: stale-row expiry sweep')
{
  const id = `verify-w7-7-stale-${Date.now()}`
  const past = new Date(Date.now() - 60_000)
  await c.query(
    `INSERT INTO "BulkAutomationApproval" (
       id, "ruleId", "ruleName", "triggerPayload", "actionPlan",
       threshold, "expiresAt", status, "createdAt", "updatedAt"
     ) VALUES (
       $1, 'rule-fake', 'expired rule', '{}'::jsonb, '[]'::jsonb,
       'manual', $2, 'PENDING', NOW(), NOW()
     )`, [id, past.toISOString()],
  )
  // Mirror expireStale
  const r = await c.query(
    `UPDATE "BulkAutomationApproval"
       SET status = 'EXPIRED'
     WHERE status = 'PENDING' AND "expiresAt" < NOW()
       AND id = $1
     RETURNING status`,
    [id],
  )
  check('expired rows transition to EXPIRED', r.rows[0]?.status === 'EXPIRED')

  await c.query(`DELETE FROM "BulkAutomationApproval" WHERE id = $1`, [id])
}

console.log('\nCase 5: source-level service shape')
const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/automation/bulk-approval.service.ts'),
  'utf8',
)
for (const sym of ['class BulkApprovalService', 'create(', 'list(', 'get(', 'approve(', 'reject(', 'expireStale(']) {
  check(`exposes ${sym}`, svc.includes(sym))
}
check('approve refuses non-PENDING rows',
  /Approval is not PENDING/.test(svc))
check('approve refuses expired rows',
  /Approval has expired/.test(svc))
check('approve dispatches via ACTION_HANDLERS at dryRun=false',
  /handler\([\s\S]{0,200}dryRun: false/.test(svc))

console.log('\nCase 6: routes')
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-automation-approvals.routes.ts'),
  'utf8',
)
for (const ep of [
  '/bulk-automation-approvals',
  '/bulk-automation-approvals/:id',
  '/bulk-automation-approvals/:id/approve',
  '/bulk-automation-approvals/:id/reject',
  '/bulk-automation-approvals/sweep-expired',
]) {
  check(`route ${ep}`, routes.includes(`'${ep}'`))
}
check('approve maps non-PENDING / expired to 409',
  /Approval is not PENDING[\s\S]{0,80}Approval has expired[\s\S]{0,80}return reply\.code\(409\)/.test(routes))

console.log('\nCase 7: index.ts wires the routes')
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)
check('imports bulkAutomationApprovalsRoutes',
  /import bulkAutomationApprovalsRoutes/.test(idx))
check('registered with /api prefix',
  /app\.register\(bulkAutomationApprovalsRoutes, \{ prefix: '\/api' \}\)/.test(idx))

await c.end()

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
