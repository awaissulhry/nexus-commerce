#!/usr/bin/env node
// Verify W13.2 — auto-promote large jobs to BullMQ.
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

console.log('\nW13.2 — auto-promote large jobs\n')

const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-operations.routes.ts'),
  'utf8',
)

console.log('Case 1: promotion decision')
check('reads NEXUS_BULK_PROMOTE_THRESHOLD env (default 200)',
  /NEXUS_BULK_PROMOTE_THRESHOLD \?\? 200/.test(routes))
check('checks ENABLE_QUEUE_WORKERS=1 before promoting',
  /ENABLE_QUEUE_WORKERS === '1'/.test(routes))
check('promotes only when totalItems > threshold',
  /job\.totalItems > promoteThreshold/.test(routes))
check('lazy-imports bulkJobQueue',
  /await import\('\.\.\/lib\/queue\.js'\)/.test(routes))

console.log('\nCase 2: enqueue shape')
check("adds 'process' named job to bulk-job queue",
  /bulkJobQueue\.add\(\s*\n?\s*'process'/.test(routes))
check('passes jobId in data',
  /\{ jobId: id \}/.test(routes))
check('dedupe key uses bulk-<id>',
  /jobId: `bulk-\$\{id\}`/.test(routes))

console.log('\nCase 3: graceful fallback')
check('try/catch around enqueue',
  /catch \(err\)[\s\S]{0,400}BullMQ promotion failed/.test(routes))
check('falls back to in-process inline path',
  /if \(promotedTo === 'inline'\)/.test(routes))
check('still preserves the original fire-and-forget catch',
  /async processJob failed/.test(routes))

console.log('\nCase 4: response payload')
check("response includes promotedTo: 'bullmq' | 'inline'",
  /promotedTo,\s*\n\s*totalItems: job\.totalItems,/.test(routes))
check('still 200 IN_PROGRESS',
  /status: 'IN_PROGRESS',\s*\n\s*message: 'Job processing started'/.test(routes))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
