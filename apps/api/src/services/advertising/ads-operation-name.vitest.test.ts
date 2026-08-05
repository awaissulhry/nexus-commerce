/**
 * ACR.0.6 — the operation name that keeps OutboundApiCallLog queryable.
 *
 * Every ads call now writes a log row, so `operation` is the column an operator groups by to
 * ask "which endpoint is failing". If ids leak into it, each report or export becomes its own
 * operation and the grouping is worthless. Prod proved that within minutes of the first
 * deploy: six rows, six distinct operations, all of them the same call.
 *
 * The over-correction is equally real and is why these tests exist — a character class
 * containing `/` swallowed whole paths and turned "/reporting/reports" into "/:id".
 */
import { describe, it, expect } from 'vitest'
import { adsOperationName } from './ads-api-client.js'

describe('adsOperationName', () => {
  it('collapses a report UUID', () => {
    expect(adsOperationName('GET', '/reporting/reports/90a5aead-2e55-4325-bc04-518345b98e65'))
      .toBe('ads GET /reporting/reports/:id')
  })

  it('collapses a base64-ish export id — the case prod actually hit', () => {
    expect(adsOperationName('GET', '/exports/MjM3ZjhmNzItMmZhZC00ZTE0LTg1M2YtMmYxZWU0ZTg3MzI1LEE'))
      .toBe('ads GET /exports/:id')
  })

  it('collapses a numeric campaign id', () => {
    expect(adsOperationName('PUT', '/sp/campaigns/123456789')).toBe('ads PUT /sp/campaigns/:id')
  })

  it('leaves real path words alone, including long ones', () => {
    // "/reporting/reports" is 18 characters — the naive rule ate it.
    expect(adsOperationName('POST', '/reporting/reports')).toBe('ads POST /reporting/reports')
    expect(adsOperationName('GET', '/sp/targets')).toBe('ads GET /sp/targets')
    expect(adsOperationName('POST', '/sp/campaigns/list')).toBe('ads POST /sp/campaigns/list')
    expect(adsOperationName('GET', '/v2/profiles')).toBe('ads GET /v2/profiles')
  })

  it('drops the query string — it carries filters, not identity', () => {
    expect(adsOperationName('GET', '/sp/targets?count=50&next=abc')).toBe('ads GET /sp/targets')
  })
})
