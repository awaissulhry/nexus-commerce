import { describe, it, expect } from 'vitest'
import { v3BatchResult } from './ads-api-client.js'

// A3 — the v3 batch-response parser must be CONSERVATIVE: flip to failure only on a recognized
// non-empty error[], and treat any unknown/!2xx-handled shape as ok (no false failures).
describe('v3BatchResult (A3 — 2xx-with-error-body detection)', () => {
  it('non-empty error[] → ok:false with a message', () => {
    const r = v3BatchResult({ keywords: { success: [], error: [{ index: 0, errors: [{ errorType: 'BID_TOO_LOW' }] }] } }, 'keywords')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/amazon_rejected/)
    expect(r.error).toMatch(/BID_TOO_LOW/)
  })
  it('success-only response → ok', () => {
    expect(v3BatchResult({ keywords: { success: [{ index: 0, keywordId: '123' }], error: [] } }, 'keywords')).toEqual({ ok: true, error: null })
  })
  it('empty error[] → ok', () => {
    expect(v3BatchResult({ adGroups: { error: [] } }, 'adGroups').ok).toBe(true)
  })
  it('unrecognized / missing block → ok (no false failure)', () => {
    expect(v3BatchResult({ somethingElse: true }, 'keywords').ok).toBe(true)
    expect(v3BatchResult(null, 'keywords').ok).toBe(true)
    expect(v3BatchResult({}, 'campaigns').ok).toBe(true)
    expect(v3BatchResult({ sandbox: true, patch: {} }, 'keywords').ok).toBe(true)
  })
  it('wrong resource key → ok (only inspects the named resource)', () => {
    expect(v3BatchResult({ keywords: { error: [{ x: 1 }] } }, 'adGroups').ok).toBe(true)
  })
})
