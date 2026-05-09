#!/usr/bin/env node
// Verify W7.8 — execution history + approval queue UI (closes Wave 7).
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

console.log('\nW7.8 — execution history + approval queue\n')

const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-automation-rules.routes.ts'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/automation/AutomationClient.tsx'),
  'utf8',
)

console.log('Case 1: executions endpoint')
check('GET /:id/executions added',
  /'\/bulk-automation-rules\/:id\/executions'/.test(routes))
check('domain check on the rule',
  /rule\.domain !== DOMAIN/.test(routes))
check('orderBy startedAt desc',
  /orderBy: \{ startedAt: 'desc' \}/.test(routes))

console.log('\nCase 2: client fetches + renders execution history')
check('fetchExecutions calls the new endpoint',
  /\/api\/bulk-automation-rules\/\$\{ruleId\}\/executions/.test(client))
check('history panel only renders when editingId',
  /\{editingId && \(\s*<section[\s\S]{0,400}6\. Execution history/.test(client))
check('per-execution status colour coding',
  /e\.status === 'SUCCESS'[\s\S]{0,400}e\.status === 'FAILED'[\s\S]{0,400}e\.status === 'DRY_RUN'/.test(client))
check('Dry-run badge on dryRun rows',
  /e\.dryRun && \(\s*<Badge variant="warning"/.test(client))

console.log('\nCase 3: approval queue panel')
check('fetchApprovals hits /bulk-automation-approvals?status=PENDING',
  /\/bulk-automation-approvals\?status=PENDING/.test(client))
check('30s auto-refresh',
  /setInterval\(fetchApprovals, 30_000\)/.test(client))
check('Approve / Reject buttons wired to /:id/approve|/reject',
  /\/api\/bulk-automation-approvals\/\$\{id\}\/\$\{action\}/.test(client))
check('Approval card shows estimatedValueCentsEur in EUR',
  /\(a\.estimatedValueCentsEur \/ 100\)\.toFixed\(2\)/.test(client))
check('Approval card shows expiry datetime',
  /new Date\(a\.expiresAt\)\.toLocaleString\(\)/.test(client))

console.log('\nCase 4: status filtering surfaces')
check('status filter passed to /executions endpoint',
  /request\.query\.status[\s\S]{0,80}where\.status = request\.query\.status/.test(routes))

console.log('\nCase 5: empty-state guidance')
check("'No executions yet.' empty-state copy present",
  /No executions yet\./.test(client))

console.log('\nCase 6: refresh wiring after operator actions')
check("approve/reject triggers fetchApprovals + fetchExecutions",
  /decideApproval[\s\S]{0,1500}await fetchApprovals\(\)[\s\S]{0,300}fetchExecutions\(editingId\)/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 7 complete)')
