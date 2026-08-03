import { describe, it, expect } from 'vitest'
import { v3BatchResult, updateTarget } from './ads-api-client.js'

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

// ── DL.1 — a target's bid/state update must reach the endpoint that owns its id ──────────────
//
// updateTarget used to PUT /sp/keywords for EVERY AdTarget. A product or auto target's external id
// is a `targetId` under /sp/targets, so Amazon rejected those writes with entityNotFoundError at
// "$.keywords[0].keywordId" — permanently, and silently, while the engine reported success.
// Measured live: 413 keyword writes APPLIED, all 27 product/auto targets FAILED with zero successes.
//
// Sandbox short-circuits before any HTTP, and reports the route it WOULD have taken, so routing is
// assertable without touching Amazon.
describe('DL.1 updateTarget routing by target kind', () => {
  const ctx = { profileId: 'p1', region: 'EU' as const }
  const route = async (kind: string | null | undefined) => {
    const r = await updateTarget(ctx, 'ext-1', { bid: 0.42 }, kind)
    return (r.rawResponse as { route?: string }).route
  }

  it('sends PRODUCT targets to /sp/targets', async () => {
    expect(await route('PRODUCT')).toBe('targets')
  })
  it('sends AUTO targets to /sp/targets', async () => {
    expect(await route('AUTO')).toBe('targets')
  })
  it('sends KEYWORD targets to /sp/keywords, exactly as before', async () => {
    expect(await route('KEYWORD')).toBe('keywords')
  })
  it('is case-insensitive about the kind', async () => {
    expect(await route('product')).toBe('targets')
    expect(await route('auto')).toBe('targets')
  })
  // The fallback matters: an absent kind must behave the way it always did, so this change can
  // never introduce a NEW failure for a shape we did not anticipate.
  it('falls back to the keyword path when the kind is unknown, null or omitted', async () => {
    expect(await route(null)).toBe('keywords')
    expect(await route(undefined)).toBe('keywords')
    expect(await route('SOMETHING_NEW')).toBe('keywords')
    expect(await route('')).toBe('keywords')
  })
})
