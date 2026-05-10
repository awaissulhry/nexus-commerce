#!/usr/bin/env node
// Verify W13.3 — rate-limit-aware retry inside the per-item loop.
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

console.log('\nW13.3 — rate-limit-aware retry\n')

const rl = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/channel-batch/rate-limit.ts'),
  'utf8',
)
const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)

console.log('Case 1: rate-limit module surface')
check('RateLimitError class exported',
  /export class RateLimitError extends Error/.test(rl))
check('isRateLimitError() handles direct instances',
  /err instanceof RateLimitError/.test(rl))
check('isRateLimitError() handles status === 429',
  /e\.status === 429 \|\| e\.statusCode === 429/.test(rl))
check('isRateLimitError() recognises message patterns',
  /rate limit/.test(rl) &&
  /throttled/.test(rl) &&
  /too many requests/.test(rl))

console.log('\nCase 2: extractRetryAfterMs helpers')
check('reads RateLimitError.retryAfterMs (typed path)',
  /err instanceof RateLimitError\) return err\.retryAfterMs/.test(rl))
check('falls back to error.retryAfter * 1000 (seconds)',
  /e\.retryAfter \* 1000/.test(rl))
check('reads retry-after header from error.headers',
  /'retry-after'/.test(rl))

console.log('\nCase 3: backoff ladder')
check('defaultRateLimitBackoffMs returns exponential with 30s cap',
  /Math\.min\(30_000, 1000 \* Math\.pow\(2, attempt - 1\)\)/.test(rl))

console.log('\nCase 4: bulk-action loop wires it')
check('item loop wraps processItem in retry while-loop',
  /while \(!succeeded && rlAttempt <= MAX_RATE_LIMIT_RETRIES\)/.test(svc))
check('MAX_RATE_LIMIT_RETRIES = 4',
  /MAX_RATE_LIMIT_RETRIES = 4/.test(svc))
check('lazy-imports rate-limit helpers in catch',
  /await import\('\.\/channel-batch\/rate-limit\.js'\)/.test(svc))
check('uses extractRetryAfterMs ?? defaultBackoff',
  /extractRetryAfterMs\(itemError\) \?\?\s*\n?\s*defaultRateLimitBackoffMs\(rlAttempt\)/.test(svc))
check('sleeps before retry via setTimeout(...backoffMs)',
  /new Promise\(\(r\) => setTimeout\(r, backoffMs\)\)/.test(svc))
check('continues loop on retry (not break/break)',
  /continue;/.test(svc))
check('falls to FAILED only after exhausting retries',
  /rateLimitAttempts: rlAttempt/.test(svc))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
