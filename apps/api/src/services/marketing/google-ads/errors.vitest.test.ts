/**
 * Google Ads step 1a — a failed call, read: retry or not, the day's allowance used up, the sign-in lost, an expired
 * page token, a test-only Cloud project, Google's request id, and a sentence a person can act on.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { failureFromGatewayRefusal, failureFromNoAnswer, GoogleAdsReadError, parseGoogleAdsFailure } from './errors.js'

type ErrorFixture = { httpStatus: number; body: unknown }
const errors = JSON.parse(readFileSync(new URL('../../../test-support/google-ads/errors.json', import.meta.url), 'utf8')) as Record<string, ErrorFixture>
const parse = (name: string) => parseGoogleAdsFailure(errors[name].httpStatus, JSON.stringify(errors[name].body))

describe('Google Ads failures', () => {
  it('400 a refused query: not retried, Google\'s words kept, the request id found', () => {
    const f = parse('queryError')
    expect(f).toMatchObject({
      origin: 'google', httpStatus: 400, status: 'INVALID_ARGUMENT', code: 'UNRECOGNIZED_FIELD', requestId: 'test-request-0001',
      retryable: false, retryKind: null, quotaExhausted: false, authLost: false, permissionDenied: false,
    })
    expect(f.errors).toEqual([{ group: 'queryError', code: 'UNRECOGNIZED_FIELD', message: "Unrecognized field in the query: 'campaign.start_date'." }])
    expect(f.sentence).toBe("Google Ads refused the request: Unrecognized field in the query: 'campaign.start_date'.")
  })

  it('401 a revoked sign-in: reconnect, no retry', () => {
    expect(parse('authRevoked')).toMatchObject({ authLost: true, retryable: false, code: 'OAUTH_TOKEN_REVOKED' })
    expect(parse('authRevoked').sentence).toContain('Reconnect Google')
    expect(parseGoogleAdsFailure(401, '')).toMatchObject({ authLost: true })
  })

  it('403 no access, and a Cloud project approved for test accounts only', () => {
    expect(parse('permissionDenied')).toMatchObject({ permissionDenied: true, authLost: false, retryable: false, code: 'USER_PERMISSION_DENIED' })
    expect(parse('permissionDenied').sentence).toContain('no access to this Google Ads account')
    expect(parse('notApprovedForProduction')).toMatchObject({ notApprovedForProduction: true, permissionDenied: false, retryable: false })
    expect(parse('notApprovedForProduction').sentence).toContain('test accounts only')
  })

  it('429 RESOURCE_EXHAUSTED: the day\'s allowance is used up — never retried', () => {
    const f = parse('quotaExhausted')
    expect(f).toMatchObject({ quotaExhausted: true, retryable: false, retryKind: null, retryAfterMs: 43_200_000, requestId: 'test-request-0005' })
    expect(f.sentence).toContain('used up today\'s Google Ads API allowance')
  })

  it('429 RESOURCE_TEMPORARILY_EXHAUSTED: slow down, one retry after at least 30 s (or Google\'s longer delay)', () => {
    expect(parse('temporarilyExhausted')).toMatchObject({ quotaExhausted: false, retryable: true, retryKind: 'slow_down', retryAfterMs: 45_000 })
    expect(parseGoogleAdsFailure(429, '')).toMatchObject({ retryKind: 'slow_down', retryAfterMs: 30_000 })
  })

  it('500 / 503 and Google\'s transient codes: retried', () => {
    expect(parse('internal')).toMatchObject({ retryKind: 'transient', retryable: true, code: 'INTERNAL_ERROR' })
    expect(parse('transient')).toMatchObject({ retryKind: 'transient', retryable: true, code: 'TRANSIENT_ERROR' })
    expect(parse('transient').sentence).toBe('Google Ads had a temporary problem. Nexus tries again.')
    // An answer that is not JSON at all still reads: the request id comes from the header.
    const bare = parseGoogleAdsFailure(502, '<html>Bad Gateway</html>', new Headers({ 'request-id': 'test-header-request' }))
    expect(bare).toMatchObject({ retryKind: 'transient', requestId: 'test-header-request', errors: [] })
  })

  it('an expired page token', () => {
    expect(parse('expiredPageToken')).toMatchObject({ pageTokenExpired: true, retryable: false })
  })

  it('a body without the "error" wrapper (as Google\'s own examples print it) is read the same', () => {
    const unwrapped = (errors.permissionDenied.body as { error: unknown }).error
    expect(parseGoogleAdsFailure(403, JSON.stringify(unwrapped))).toMatchObject({ permissionDenied: true, requestId: 'test-request-0003' })
    expect(parseGoogleAdsFailure(418, '')).toMatchObject({ retryable: false, sentence: 'Google Ads answered with an error (HTTP 418).' })
  })

  it('the gateway sent nothing: a lost sign-in, a local rate limit', () => {
    expect(failureFromGatewayRefusal({ code: 'ACCOUNT_NEEDS_SIGNIN', message: 'Held, nothing sent: reconnect.', statusCode: 409, retryAfterMs: null }))
      .toMatchObject({ origin: 'gateway', authLost: true, retryable: false, sentence: 'Held, nothing sent: reconnect.' })
    expect(failureFromGatewayRefusal({ code: 'RATE_LIMITED_LOCAL', message: 'Not sent yet.', statusCode: 429, retryAfterMs: 12_000 }))
      .toMatchObject({ retryKind: 'slow_down', retryAfterMs: 12_000 })
    expect(failureFromGatewayRefusal({ code: 'GOOGLE_READ_ONLY', message: 'Nothing was sent to Google.', statusCode: 403, retryAfterMs: null }))
      .toMatchObject({ retryable: false, authLost: false })
    expect(failureFromNoAnswer({ errorClass: 'timeout' })).toMatchObject({ origin: 'network', retryKind: 'transient', code: 'TIMEOUT' })
  })

  it('the error carries the failure and its sentence as its message', () => {
    const error = new GoogleAdsReadError(parse('authRevoked'), 'ads.search', 1)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('GoogleAdsReadError')
    expect(error.message).toBe(error.failure.sentence)
    expect(error.opsSpent).toBe(1)
  })
})
