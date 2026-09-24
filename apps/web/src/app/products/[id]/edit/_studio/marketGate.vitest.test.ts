import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { marketGate, marketGateReason, MARKETS_UNREAD_REASON, NO_MARKET_REASON, setUpMarkets } from './marketGate'

/** A-53 — the studio's "no market" decision, the set-up call, and the three tabs that used to wait forever. */
describe('marketGate', () => {
  it('is ready only when a market AND a language resolved', () => {
    expect(marketGate({ market: 'IT', locale: 'it', marketCount: 12, discoveryFailed: false })).toBe('ready')
    expect(marketGate({ market: null, locale: 'it', marketCount: 12, discoveryFailed: false })).not.toBe('ready')
    expect(marketGate({ market: 'IT', locale: null, marketCount: 12, discoveryFailed: false })).not.toBe('ready')
  })

  it('says the read FAILED when the frame could not read the markets', () => {
    expect(marketGate({ market: null, locale: null, marketCount: 0, discoveryFailed: true })).toBe('failed')
  })

  it('says there are NONE when the read succeeded and the business has no markets (Motovento, 2026-09-24)', () => {
    expect(marketGate({ market: null, locale: 'it', marketCount: 0, discoveryFailed: false })).toBe('none')
  })

  it('offers a re-read, not a wait, when markets exist but none resolved', () => {
    expect(marketGate({ market: null, locale: 'it', marketCount: 3, discoveryFailed: false })).toBe('failed')
  })

  it('gives the readiness chip the matching sentence', () => {
    expect(marketGateReason('none')).toBe(NO_MARKET_REASON)
    expect(marketGateReason('failed')).toBe(MARKETS_UNREAD_REASON)
    expect(marketGateReason('ready')).toBeNull()
  })
})

describe('setUpMarkets', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('re-reads the frame once after the server added the markets', async () => {
    const retry = vi.fn(async () => {})
    expect(await setUpMarkets(async () => json(200, { success: true, created: 20, total: 20 }), retry)).toEqual({ ok: true })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('returns a sentence and does NOT re-read when the server refuses', async () => {
    const retry = vi.fn(async () => {})
    expect(await setUpMarkets(async () => json(403, { error: 'forbidden' }), retry)).toEqual({ ok: false, message: 'You do not have permission to set up markets for this business.' })
    expect(await setUpMarkets(async () => json(500, { error: 'relation does not exist' }), retry)).toEqual({ ok: false, message: 'Nexus could not set up the markets. Try again in a moment.' })
    expect(await setUpMarkets(async () => json(401, {}), retry)).toEqual({ ok: false, message: 'Your session has expired. Sign in again to continue.' })
    expect(await setUpMarkets(async () => { throw new TypeError('fetch failed') }, retry)).toEqual({ ok: false, message: 'Nexus could not be reached. Check your connection and try again.' })
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('the three tabs no longer wait forever', () => {
  const WAIT = /Waiting for the market/
  const files = ['sheet/ProductSheetTab.tsx', 'matrix/MatrixTab.tsx', 'variants/family/FamilyVariants.tsx']
  const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

  it('the detector finds the old line (positive control)', () => {
    expect(WAIT.test(`  if (!market || !locale) return <div className="nds-cell-muted">Waiting for the market…</div>`)).toBe(true)
  })

  it.each(files)('%s renders NoMarketState and never the waiting line', (file) => {
    const text = read(file)
    expect(text.length).toBeGreaterThan(200)
    expect(text).not.toMatch(WAIT)
    expect(text).toMatch(/if \(!market \|\| !locale\) return <NoMarketState \/>/)
  })
})
