/**
 * Ads wave 4c (F3), AM-28, CM-32 — the console's market list comes from the connections, one market choice is shared
 * across the ads pages, and money reads in each market's own currency.
 *
 * The fixture is today's account plus one more market: IT, DE, FR and ES live with writes on, and UK switched on for
 * reading only. UK's data must show; UK's write controls must be off with the reason; the four must read exactly as
 * before.
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_MARKETS, READING_ONLY, currencyOf, formatMoney, marketsFromWire, orderMarketCodes, pageMarket, preferredMarket,
  readMarketsOf, readingOnlyDetail, writeAccessOf, writeBlockFor, writeMarketsOf, type WireMarket,
} from './adsMarkets'
import { fmtChangeValue } from '../_shared/changeValue'

const live = (code: string): WireMarket => ({ code, read: true, write: true, mode: 'production', writesEnabled: true, limitsKnown: true, currency: 'EUR', whyNoWrite: null })
const UK: WireMarket = {
  code: 'UK', read: true, write: false, mode: 'sandbox', writesEnabled: false, limitsKnown: false, currency: 'GBP',
  whyNoWrite: `${READING_ONLY}: the UK account is in sandbox mode.`,
}
// The API's order (the Owner's): the live four as the console always listed them, then reading-only markets.
const WIRE = { markets: [live('IT'), live('DE'), live('ES'), live('FR'), UK] }
const never = () => { throw new Error('the API list is used, not the fallback') }

describe('4c — the list is the connections, not a fixed four', () => {
  const markets = marketsFromWire(WIRE, [], never)

  it('🔴 UK reading only is read (its data shows) but not written; the four are read and written', () => {
    expect(readMarketsOf(markets)).toEqual(['IT', 'DE', 'ES', 'FR', 'UK'])
    expect(writeMarketsOf(markets)).toEqual(['IT', 'DE', 'ES', 'FR'])
  })

  it('🔴 a write control on UK is off and says why; IT is writable as before', () => {
    expect(writeAccessOf(markets, 'UK')).toEqual({ canWrite: false, reason: `${READING_ONLY}: the UK account is in sandbox mode.` })
    expect(writeAccessOf(markets, 'IT')).toEqual({ canWrite: true, reason: null })
    expect(markets.find((m) => m.code === 'UK')?.whyNotShort).toBe('reading only')
    expect(readingOnlyDetail(writeAccessOf(markets, 'UK').reason)).toBe('The UK account is in sandbox mode.')
  })

  it('a market with no account is refused with a reason; an unloaded list claims nothing', () => {
    expect(writeAccessOf(markets, 'PL')).toEqual({ canWrite: false, reason: 'Nexus has no Amazon Ads account for PL, so it changes nothing there.' })
    expect(writeAccessOf([], 'PL')).toEqual({ canWrite: true, reason: null })
  })

  it('an older API without `markets`: the rows, readable when the account is read (any mode), in the Owner\'s order', () => {
    const rows = ['UK', 'FR', 'ES', 'DE', 'IT', 'BE'].map((m) => ({ marketplace: m, isActive: true, mode: ['UK', 'BE'].includes(m) ? 'sandbox' : 'production', writesEnabledAt: '2026-01-01' }))
    const list = marketsFromWire(undefined, rows, (c) => ({ code: c.code, label: '', mode: c.mode ?? 'sandbox', writesEnabled: !!c.writesEnabledAt, launchable: c.mode === 'production', readable: !!c.isActive }))
    expect(readMarketsOf(list)).toEqual(['IT', 'DE', 'ES', 'FR', 'BE', 'UK'])
    expect(writeMarketsOf(list)).toEqual(['IT', 'DE', 'ES', 'FR'])
  })

  it('🔴 order: a page that merges the read list with the markets its rows name keeps IT, DE, ES, FR first', () => {
    // The campaigns grid, dashboard, health, portfolios and budget manager merge both lists; they used to sort A–Z.
    expect(orderMarketCodes(['UK', 'DE', 'IT', 'FR', 'ES', 'ZZ', 'IT'], markets)).toEqual(['IT', 'DE', 'ES', 'FR', 'UK', 'ZZ'])
  })

  it('🔴 a write touching a reading-only market is off with its reason; the live four are not', () => {
    expect(writeBlockFor(markets, ['IT', 'DE'])).toBeNull()
    expect(writeBlockFor(markets, ['IT', 'UK'])).toBe(`${READING_ONLY}: the UK account is in sandbox mode.`)
    expect(writeBlockFor([], ['UK'])).toBeNull()
  })
})

describe('AM-28 — one market choice across the ads pages', () => {
  const read = ['DE', 'ES', 'FR', 'IT', 'UK']

  it('🔴 an absent `?market=` opens on the viewer\'s shared choice (it was each page\'s own default)', () => {
    expect(pageMarket(null, { read, shared: 'DE', allowAll: true })).toBe('DE')
    expect(pageMarket(null, { read, shared: 'UK', allowAll: false })).toBe('UK')
    expect(pageMarket(null, { read, shared: ALL_MARKETS, allowAll: true })).toBe(ALL_MARKETS)
  })

  it('the URL wins over the shared choice, so a link opens on what it says', () => {
    expect(pageMarket('FR', { read, shared: 'DE', allowAll: true })).toBe('FR')
    expect(pageMarket(ALL_MARKETS, { read, shared: 'DE', allowAll: true })).toBe(ALL_MARKETS)
  })

  it('🔴 AM-27 — a one-market page never shows "all": the shared market if it is one, else the preferred read market', () => {
    expect(pageMarket(ALL_MARKETS, { read, shared: ALL_MARKETS, allowAll: false })).toBe('IT')
    expect(pageMarket(ALL_MARKETS, { read, shared: 'ES', allowAll: false })).toBe('ES')
    expect(pageMarket(null, { read: ['UK'], shared: ALL_MARKETS, allowAll: false })).toBe('UK')
  })

  it('a market Nexus does not read falls back; before the list loads, Amazon codes are trusted', () => {
    expect(pageMarket('PL', { read, shared: ALL_MARKETS, allowAll: true })).toBe(ALL_MARKETS)
    expect(pageMarket('PL', { read: [], shared: ALL_MARKETS, allowAll: true })).toBe('PL')
    expect(pageMarket('ZZ', { read: [], shared: ALL_MARKETS, allowAll: true })).toBe(ALL_MARKETS)
    expect(preferredMarket([])).toBe('IT')
  })
})

describe('CM-32 — each market in its own currency', () => {
  const markets = marketsFromWire(WIRE, [], never)

  it('🔴 UK is pounds, IT is euros — before the list loads, the euro markets are still euros', () => {
    expect(currencyOf(markets, 'UK')).toBe('GBP')
    expect(currencyOf(markets, 'IT')).toBe('EUR')
    expect(currencyOf([], 'DE')).toBe('EUR')
    expect(currencyOf([], 'SE')).toBeNull()
  })

  it('the change log prints a UK bid in pounds and an IT one exactly as before', () => {
    expect(fmtChangeValue('35', 'bid')).toBe('€0.35')
    expect(fmtChangeValue('35', 'bid', 'EUR')).toBe('€0.35')
    expect(fmtChangeValue('12.5', 'dailyBudget', 'GBP')).toBe('£12.50')
    expect(fmtChangeValue('35', 'bid', null)).toBe('0.35')
  })

  it('money with an unknown currency is the number alone, never a made-up euro sign', () => {
    expect(formatMoney(12.5, null)).toBe('12.50')
    expect(formatMoney(12.5, 'GBP')).toBe('£12.50')
  })
})
