#!/usr/bin/env node
// Verify W12.3 — eBay parallel-batch wrapper.
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

console.log('\nW12.3 — eBay parallel batch\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/channel-batch/ebay-parallel-batch.service.ts'),
  'utf8',
)

console.log('Case 1: API surface')
check('submitEbayParallelBatch exported',
  /export async function submitEbayParallelBatch/.test(svc))
check('rejects missing connectionId',
  /connectionId required/.test(svc))
check('rejects empty operations',
  /operations must be non-empty/.test(svc))
check('default concurrency = 8',
  /DEFAULT_CONCURRENCY = 8/.test(svc))
check('default maxRetries = 3',
  /DEFAULT_MAX_RETRIES = 3/.test(svc))
check('clamps concurrency to [1, 32]',
  /Math\.max\(1, Math\.min\(input\.concurrency \?\? DEFAULT_CONCURRENCY, 32\)\)/.test(svc))

console.log('\nCase 2: HTTP call shape')
check('price op → PUT /sell/inventory/v1/offer/:offerId',
  /method: 'PUT'/.test(svc) &&
  /\/sell\/inventory\/v1\/offer\/\$\{encodeURIComponent\(op\.offerId\)\}/.test(svc))
check('stock op → PUT /sell/inventory/v1/inventory_item/:sku',
  /\/sell\/inventory\/v1\/inventory_item\/\$\{encodeURIComponent\(op\.sku\)\}/.test(svc))
check('withdraw op → POST .../offer/:offerId/withdraw',
  /\/sell\/inventory\/v1\/offer\/\$\{encodeURIComponent\(op\.offerId\)\}\/withdraw/.test(svc))
check('Authorization header bearer token',
  /Authorization: `Bearer \$\{accessToken\}`/.test(svc))

console.log('\nCase 3: retry semantics')
check('429 → exponential backoff (1s, 2s, 4s)',
  /res\.status === 429[\s\S]{0,200}1000 \* Math\.pow\(2, attempt - 1\)/.test(svc))
check('5xx → backoff retry too',
  /res\.status >= 500[\s\S]{0,200}500 \* Math\.pow\(2, attempt - 1\)/.test(svc))
check('non-retryable 4xx breaks fast',
  /break/.test(svc))
check('result distinguishes ok / retried / failed',
  /status: attempt === 1 \? 'ok' : 'retried'/.test(svc) &&
  /status: 'failed'/.test(svc))
check('records attempts count + last httpStatus',
  /attempts: attempt[\s\S]{0,200}httpStatus: lastStatus/.test(svc))
check('one bad SKU never throws out of runOne',
  /catch \(err\)[\s\S]{0,200}lastErr =/.test(svc) &&
  /return \{[\s\S]{0,300}status: 'failed'/.test(svc))

console.log('\nCase 4: concurrency control')
check('runWithConcurrency uses pump-style worker pool',
  /async function pump\(\)/.test(svc))
check('worker count clamped by items.length',
  /Math\.min\(concurrency, items\.length\)/.test(svc))
check('pump exits when queue empty',
  /if \(i >= items\.length\) return/.test(svc))

console.log('\nCase 5: dry-run path')
check('NEXUS_EBAY_BATCH_DRYRUN gates submission',
  /NEXUS_EBAY_BATCH_DRYRUN/.test(svc))
check('dry-run returns ok=N, failed=0',
  /dryRun: true/.test(svc) &&
  /succeeded: results\.length/.test(svc))

console.log('\nCase 6: token resolution')
check('uses EbayAuthService.getValidToken',
  /new EbayAuthService\(\)/.test(svc) &&
  /auth\.getValidToken\(input\.connectionId\)/.test(svc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
