/**
 * eBay error classification — the fix for "Internal Server Error" on
 * POST /ebay-ads/builder/launch (2026-07-28).
 */
import { describe, it, expect } from 'vitest'
import { classifyEbayError, parseEbayErrors, EbayApiError } from './ebay-error.js'

// Verbatim from a live prod response, 2026-07-28.
const REAL_35077 = '{"errors":[{"errorId":35077,"domain":"API_MARKETING","category":"BUSINESS","message":"To use promoted listings, you need to improve your seller level to Top Rated or Above Standard and have enough recent sales."}]}'

describe('parseEbayErrors', () => {
  it('extracts the errors[] array', () => {
    const errs = parseEbayErrors(REAL_35077)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.errorId).toBe(35077)
  })
  it('tolerates junk, HTML and empty bodies without throwing', () => {
    expect(parseEbayErrors('')).toEqual([])
    expect(parseEbayErrors('<html>502 Bad Gateway</html>')).toEqual([])
    expect(parseEbayErrors('{"nope":1}')).toEqual([])
  })
})

describe('classifyEbayError', () => {
  it('35077 → ACCOUNT_BLOCKED 409, terminal, names the real cause', () => {
    const info = classifyEbayError(409, parseEbayErrors(REAL_35077))
    expect(info.kind).toBe('ACCOUNT_BLOCKED')
    expect(info.httpStatus).toBe(409)
    expect(info.terminal).toBe(true)
    expect(info.operatorMessage).toMatch(/Top Rated or Above Standard/)
    expect(info.operatorMessage).toMatch(/not a Nexus problem/)
  })

  it('35036 "ad already exists" is idempotent, not a failure', () => {
    const info = classifyEbayError(409, [{ errorId: 35036, message: 'ad already exists' }])
    expect(info.kind).toBe('IDEMPOTENT')
    expect(info.terminal).toBe(false)
  })

  it('listing-eligibility codes map to 422 and say which listing problem it is', () => {
    expect(classifyEbayError(400, [{ errorId: 35048 }]).operatorMessage).toMatch(/ended/)
    expect(classifyEbayError(400, [{ errorId: 35058 }]).operatorMessage).toMatch(/fixed-price/)
    expect(classifyEbayError(400, [{ errorId: 35054 }]).operatorMessage).toMatch(/different eBay marketplace/)
    for (const id of [35048, 35058, 35052, 35075, 35054]) {
      const i = classifyEbayError(400, [{ errorId: id }])
      expect(i.kind).toBe('LISTING_INELIGIBLE')
      expect(i.httpStatus).toBe(422)
    }
  })

  it('DYNAMIC rate strategy blocks bid writes (35010/35113) → 409', () => {
    for (const id of [35010, 35113]) {
      const i = classifyEbayError(400, [{ errorId: id }])
      expect(i.kind).toBe('CONFLICT')
      expect(i.operatorMessage).toMatch(/FIXED/)
    }
  })

  it('35071 is retryable, not terminal', () => {
    const i = classifyEbayError(429, [{ errorId: 35071 }])
    expect(i.kind).toBe('RATE_LIMITED')
    expect(i.terminal).toBe(false)
  })

  it('an UNRECOGNISED code is surfaced verbatim, never flattened to a 500', () => {
    const i = classifyEbayError(400, [{ errorId: 99999, message: 'some new eBay rule' }])
    expect(i.kind).toBe('UNKNOWN')
    expect(i.httpStatus).toBe(400) // keeps eBay's 4xx — not our fault
    expect(i.operatorMessage).toMatch(/error 99999/)
    expect(i.operatorMessage).toMatch(/some new eBay rule/)
  })

  it('prefers longMessage when eBay supplies both', () => {
    const i = classifyEbayError(400, [{ errorId: 1, message: 'short', longMessage: 'the long explanation' }])
    expect(i.operatorMessage).toMatch(/the long explanation/)
  })

  it('a 5xx from eBay becomes 502 — their outage is not our bug report', () => {
    expect(classifyEbayError(503, [{ errorId: 1, message: 'unavailable' }]).httpStatus).toBe(502)
    expect(classifyEbayError(503, []).httpStatus).toBe(502)
  })

  it('an empty body still yields an actionable status, never a bare 500', () => {
    const i = classifyEbayError(409, [])
    expect(i.httpStatus).toBe(409)
    expect(i.operatorMessage).toMatch(/HTTP 409/)
  })
})

describe('EbayApiError', () => {
  it('carries status, ids and kind for the route handler', () => {
    const err = new EbayApiError('createCampaign', 409, parseEbayErrors(REAL_35077), REAL_35077)
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('ACCOUNT_BLOCKED')
    expect(err.httpStatus).toBe(409)
    expect(err.ebayStatus).toBe(409)
    expect(err.errorIds).toEqual([35077])
    expect(err.terminal).toBe(true)
    expect(err.message).toMatch(/^createCampaign: /)
    expect(err.message).toMatch(/Top Rated or Above Standard/)
  })

  it('falls back to the raw body when eBay sends no errors[] (e.g. an HTML 502)', () => {
    const err = new EbayApiError('getReportTask', 502, [], '<html>Bad Gateway</html>')
    expect(err.message).toMatch(/eBay HTTP 502/)
    expect(err.message).toMatch(/Bad Gateway/)
  })

  it('never produces the string operators used to see', () => {
    const err = new EbayApiError('createCampaign', 409, parseEbayErrors(REAL_35077))
    expect(err.message).not.toBe('Internal Server Error')
    expect(err.message).not.toMatch(/^Internal Server Error$/)
  })
})
