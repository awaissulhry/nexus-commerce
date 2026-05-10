#!/usr/bin/env node
// Verify W13.4 — bulk-operations queue-stats endpoint. Closes Wave 13.
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

console.log('\nW13.4 — queue-stats endpoint\n')

const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-operations.routes.ts'),
  'utf8',
)

console.log('Case 1: route registered')
check("registers GET '/bulk-operations/queue-stats'",
  /'\/bulk-operations\/queue-stats'/.test(routes))

console.log('\nCase 2: queue-disabled path')
check('checks ENABLE_QUEUE_WORKERS=1 first',
  /queueEnabled = process\.env\.ENABLE_QUEUE_WORKERS === '1'/.test(routes))
check('returns queueEnabled: false when disabled',
  /queueEnabled: false[\s\S]{0,400}counts: \{[\s\S]{0,400}waiting: 0/.test(routes))

console.log('\nCase 3: queue-enabled path')
check('lazy-imports bulkJobQueue',
  /await import\('\.\.\/lib\/queue\.js'\)/.test(routes))
check('reads waiting/active/completed/failed/delayed via getJobCounts',
  /bulkJobQueue\.getJobCounts\([\s\S]{0,200}'waiting'[\s\S]{0,80}'active'[\s\S]{0,80}'completed'[\s\S]{0,80}'failed'[\s\S]{0,80}'delayed'/.test(routes))

console.log('\nCase 4: response shape')
check('exposes promoteThreshold from env',
  /promoteThreshold: Number\(\s*\n?\s*process\.env\.NEXUS_BULK_PROMOTE_THRESHOLD \?\? 200/.test(routes))
check('counts default to 0 when missing',
  /waiting: counts\.waiting \?\? 0/.test(routes))

console.log('\nCase 5: error handling')
check('500 on counter fetch failure',
  /queue-stats fetch failed[\s\S]{0,200}code\(500\)/.test(routes))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 13 complete)')
