#!/usr/bin/env node
// Verify W14.6 — queue-stats banner on /bulk-operations.
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

console.log('\nW14.6 — queue-stats banner\n')

const banner = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/QueueStatsBanner.tsx'),
  'utf8',
)
const page = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/page.tsx'),
  'utf8',
)

console.log('Case 1: banner shape')
check('declared as a client component',
  /^'use client'/.test(banner))
check('default export of QueueStatsBanner',
  /export default function QueueStatsBanner/.test(banner))
check('fetches /api/bulk-operations/queue-stats',
  /\/api\/bulk-operations\/queue-stats/.test(banner))
check('10s poll interval',
  /POLL_INTERVAL_MS = 10_000/.test(banner))
check('renders nothing on fetch failure',
  /if \(errored \|\| !stats\) return null/.test(banner))

console.log('\nCase 2: queue-disabled rendering')
check('disabled state shows promoteThreshold hint',
  /BullMQ not enabled — jobs run inline/.test(banner) &&
  /stats\.promoteThreshold\.toLocaleString\(\)/.test(banner))

console.log('\nCase 3: queue-enabled counters')
for (const counter of ['Waiting', 'Active', 'Completed', 'Failed', 'Delayed']) {
  check(`renders ${counter} counter`,
    new RegExp(`label="${counter}"`).test(banner))
}
check('Active gets blue tone when > 0',
  /tone=\{active > 0 \? 'blue' : 'slate'\}/.test(banner))
check('Failed gets red tone when > 0',
  /tone=\{failed > 0 \? 'red' : 'slate'\}/.test(banner))

console.log('\nCase 4: a11y semantics')
check('role=status + aria-live=polite',
  /role="status"[\s\S]{0,200}aria-live="polite"/.test(banner))
check('decorative icons aria-hidden',
  /aria-hidden="true"/.test(banner))

console.log('\nCase 5: hub page mounts the banner')
check('page imports QueueStatsBanner',
  /import QueueStatsBanner from '\.\/QueueStatsBanner'/.test(page))
check('rendered before ActiveJobsStrip',
  /<QueueStatsBanner \/>\s*\n\s*<ActiveJobsStrip \/>/.test(page))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
