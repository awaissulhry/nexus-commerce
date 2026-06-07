import { describe, it, expect } from 'vitest'
import { isRetryableSyncError } from './ads-write-reconcile.service.js'

// AR — the auto-reconcile sweep re-pushes FAILED entities every rank tick. It MUST
// retry transient failures (so Amazon eventually catches up) but MUST NOT re-fire
// permanent/logic errors (which would never land and would loop forever). This
// classifier is the guard; lock its behaviour both ways.
describe('isRetryableSyncError (AR — loop-prevention classifier)', () => {
  it('retries transient failures (429 / 5xx / throttle / timeout / network / unknown)', () => {
    for (const e of [
      '429 Too Many Requests',
      'rate limit exceeded',
      'throttled by Amazon',
      '500 Internal Server Error',
      '502 Bad Gateway',
      '503 Service Unavailable',
      'request timeout',
      'ECONNRESET',
      'socket hang up',
      'amazon_rejected: TEMPORARY_ERROR',
    ]) {
      expect(isRetryableSyncError(e), e).toBe(true)
    }
  })

  it('treats null / undefined / empty as transient (benefit of the doubt)', () => {
    expect(isRetryableSyncError(null)).toBe(true)
    expect(isRetryableSyncError(undefined)).toBe(true)
    expect(isRetryableSyncError('')).toBe(true)
  })

  it('does NOT retry permanent / logic errors (4xx, not-found, invalid, duplicate, no external id)', () => {
    for (const e of [
      '400 Bad Request',
      '401 Unauthorized',
      '403 Forbidden',
      '404 Not Found',
      '409 Conflict',
      '422 Unprocessable Entity',
      'entity does not exist',
      'campaign not found',
      'INVALID_ARGUMENT: bid too low',
      'malformed request',
      'duplicate target',
      'no_external_id',
    ]) {
      expect(isRetryableSyncError(e), e).toBe(false)
    }
  })
})
