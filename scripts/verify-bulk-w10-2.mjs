#!/usr/bin/env node
// Verify W10.2 — ETA + per-item duration tracking.
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

console.log('\nW10.2 — ETA + per-item duration\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)
const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-operations.routes.ts'),
  'utf8',
)
const strip = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/ActiveJobsStrip.tsx'),
  'utf8',
)
const schema = fs.readFileSync(
  path.join(repo, 'packages/database/prisma/schema.prisma'),
  'utf8',
)

console.log('Case 1: schema fields')
check('BulkActionJob.estimatedCompletionAt added',
  /estimatedCompletionAt DateTime\?/.test(schema))
check('BulkActionItem.durationMs added',
  /durationMs  Int\?/.test(schema))

console.log('\nCase 2: schema applied to DB')
{
  const j = await c.query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'BulkActionJob' AND column_name = 'estimatedCompletionAt'`,
  )
  check('BulkActionJob.estimatedCompletionAt exists', j.rows.length === 1)
  const i = await c.query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'BulkActionItem' AND column_name = 'durationMs'`,
  )
  check('BulkActionItem.durationMs exists', i.rows.length === 1)
}

console.log('\nCase 3: ETA computed inside updateProgress')
check('linear extrapolation from elapsed since startedAt',
  /elapsedMs = Date\.now\(\) - job\.startedAt\.getTime\(\)/.test(svc))
check('totalEstimatedMs = elapsed * total / processed',
  /totalEstimatedMs =[\s\S]{0,200}elapsedMs \/ totalProcessed[\s\S]{0,80}\* job\.totalItems/.test(svc))
check('skips estimation when processed=0 (no division by zero)',
  /totalProcessed > 0/.test(svc))
check('skips when job already complete',
  /totalProcessed < job\.totalItems/.test(svc))
check('writes estimatedCompletionAt to the job row',
  /estimatedCompletionAt,/.test(svc))

console.log('\nCase 4: per-item duration timer')
check('itemStartedAt = Date.now() before processItem',
  /const itemStartedAt = Date\.now\(\)/.test(svc))
check('SUCCEEDED/SKIPPED branch records durationMs',
  /status:\s*\n\s*result\.status === 'processed' \? 'SUCCEEDED' : 'SKIPPED',[\s\S]{0,400}durationMs: Date\.now\(\) - itemStartedAt/.test(svc))
check('FAILED branch records durationMs',
  /status: 'FAILED',[\s\S]{0,300}durationMs: Date\.now\(\) - itemStartedAt/.test(svc))

console.log('\nCase 5: SSE stream surfaces ETA')
check('sigFor includes estimatedCompletionAt',
  /estimatedCompletionAt[\s\S]{0,300}\.toISOString\(\)/.test(routes))
check('eta change triggers an update event',
  /'\|'.*eta|eta,\s*\]\.join/.test(routes))

console.log('\nCase 6: ActiveJobsStrip renders ETA')
check('ActiveJob type includes estimatedCompletionAt',
  /estimatedCompletionAt\?:\s*string \| null/.test(strip))
check('formatEta helper renders relative ms',
  /function formatEta\(/.test(strip))
check('shows ETA chip while IN_PROGRESS',
  /job\.status === 'IN_PROGRESS' && formatEta\(job\.estimatedCompletionAt\)/.test(strip))
check('tooltip shows projected finish time',
  /Projected finish:/.test(strip))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  await c.end()
  process.exit(1)
}
await c.end()
console.log('\n✓ all assertions passed')
