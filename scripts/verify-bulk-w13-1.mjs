#!/usr/bin/env node
// Verify W13.1 — bulk-job BullMQ queue + worker.
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

console.log('\nW13.1 — bulk-job queue + worker\n')

const queue = fs.readFileSync(
  path.join(repo, 'apps/api/src/lib/queue.ts'),
  'utf8',
)
const worker = fs.readFileSync(
  path.join(repo, 'apps/api/src/workers/bulk-job.worker.ts'),
  'utf8',
)
const idx = fs.readFileSync(
  path.join(repo, 'apps/api/src/index.ts'),
  'utf8',
)

console.log("Case 1: bulk-job queue exported")
check("queue.ts exports bulkJobQueue",
  /export const bulkJobQueue: Queue = new Queue\('bulk-job'/.test(queue))
check('attempts: 1 (retries are application-level)',
  /attempts: 1/.test(queue))
check('removeOnFail age 7 days',
  /removeOnFail: \{ age: 7 \* 86400 \}/.test(queue))

console.log('\nCase 2: worker module shape')
check('initializeBulkJobWorker exported',
  /export function initializeBulkJobWorker/.test(worker))
check("Worker bound to 'bulk-job' queue",
  /new Worker<BulkJobData, BulkJobResult>\(\s*\n?\s*'bulk-job'/.test(worker))
check('lazy-imports BulkActionService inside the processor',
  /await import\(\s*\n?\s*'\.\.\/services\/bulk-action\.service\.js'/.test(worker))
check('calls processJob(jobId) and returns result',
  /svc\.processJob\(jobId\)/.test(worker))
check('concurrency cap of 2',
  /concurrency: 2/.test(worker))
check('idempotent re-init (returns existing instance)',
  /Bulk-job worker already initialized/.test(worker))
check('attaches completed/failed/error listeners',
  /\.on\('completed'/.test(worker) &&
  /\.on\('failed'/.test(worker) &&
  /\.on\('error'/.test(worker))

console.log('\nCase 3: index.ts wires the worker into tryStartQueueWorkers')
check('imports initializeBulkJobWorker',
  /import \{ initializeBulkJobWorker \} from "\.\/workers\/bulk-job\.worker\.js"/.test(idx))
check('boots the worker behind ENABLE_QUEUE_WORKERS=1',
  /initializeBulkJobWorker\(\);/.test(idx) &&
  /ENABLE_QUEUE_WORKERS/.test(idx))
check('startup log mentions bulk-job',
  /BullMQ outbound-sync \+ channel-sync \+ bulk-list \+ bulk-job/.test(idx))

console.log('\nCase 4: result shape')
check('BulkJobResult tracks status + counts + duration',
  /processedItems: number/.test(worker) &&
  /failedItems: number/.test(worker) &&
  /skippedItems: number/.test(worker) &&
  /durationMs: number/.test(worker))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
