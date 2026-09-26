/**
 * The Shopify orders shadow report card's pure half: the one GET it sends, how each answer reads,
 * and the sentences the card shows. Node-only, like the rest of this suite.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  fetchShopifyShadowReport,
  matchSentence,
  percent,
  readSentence,
  type ShopifyShadowReport,
} from './shopifyShadowReport'

function fakeFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

function report(over: { read?: Partial<ShopifyShadowReport['read']>; skus?: Partial<ShopifyShadowReport['skus']>; total?: number } = {}): ShopifyShadowReport {
  return {
    readOnly: true,
    accountId: 'conn_1',
    generatedAt: '2026-09-26T12:00:00.000Z',
    window: { days: 60, since: '2026-07-28T12:00:00.000Z', until: '2026-09-26T12:00:00.000Z', note: 'Shopify returns only the last 60 days.' },
    read: { pages: 2, stoppedBecause: 'complete', complete: true, throttleWaits: 0, waitedMs: 0, locationsReadable: true, ordersRead: 31, pageSize: 20, linesPerOrder: 20, ...over.read },
    orders: { total: over.total ?? 30, outsideWindow: 1, cancelled: 1, test: 2, pos: 0, perWeek: [], financialStatus: [], fulfillmentStatus: [], sources: [] },
    skus: {
      lines: 40, units: 45, linesWithoutSku: 1, matchedLines: 36, matchedUnits: 40, unmatchedLines: 3, unmatchedUnits: 4, nearMatchLines: 1,
      deletedProductLines: 0, ordersFullyMatched: 27, ordersPartlyMatched: 1, ordersUnmatched: 2, ordersWithUnreadLines: 0,
      orderMatchRate: 0.9, lineMatchRate: 0.9, unmatched: [], unmatchedShapes: [], ...over.skus,
    },
    locations: { used: [], fulfillmentsWithoutLocation: 0, ordersWithoutFulfillment: 3 },
  }
}

describe('fetchShopifyShadowReport — the one GET', () => {
  it('GETs the account’s report with the window, with credentials', async () => {
    const fetchImpl = fakeFetch({ ok: true, report: report() })
    const result = await fetchShopifyShadowReport('conn/1', 30, fetchImpl)
    expect(result.kind).toBe('ok')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/shopify\/shadow-report\/conn%2F1\?days=30$/)
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.credentials).toBe('include')
    expect(init.cache).toBe('no-store')
  })

  it('switched off → "off" with the server’s sentence, not an error', async () => {
    const result = await fetchShopifyShadowReport('conn_1', 60, fakeFetch({ ok: false, code: 'SHOPIFY_SHADOW_REPORT_OFF', error: 'The Shopify shadow report is switched off on this server (NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT).' }, 404))
    expect(result).toEqual({ kind: 'off', message: 'The Shopify shadow report is switched off on this server (NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT).' })
  })

  it('any other refusal → "error" with the code and the sentence', async () => {
    const result = await fetchShopifyShadowReport('conn_1', 60, fakeFetch({ ok: false, code: 'SHOPIFY_THROTTLED', error: 'Shopify is rate-limiting this account right now; nothing was read.' }, 429))
    expect(result).toEqual({ kind: 'error', message: 'Shopify is rate-limiting this account right now; nothing was read. (SHOPIFY_THROTTLED)' })
  })

  it('no body → "error" naming the HTTP status; a network failure → "error" with its message', async () => {
    const empty = vi.fn(async () => ({ ok: false, status: 403, json: async () => { throw new Error('not json') } })) as unknown as typeof fetch
    expect(await fetchShopifyShadowReport('conn_1', 60, empty)).toEqual({ kind: 'error', message: 'The report could not be loaded (HTTP 403).' })
    const down = vi.fn(async () => { throw new Error('Failed to fetch') }) as unknown as typeof fetch
    expect(await fetchShopifyShadowReport('conn_1', 60, down)).toEqual({ kind: 'error', message: 'Failed to fetch' })
  })
})

describe('the sentences', () => {
  it('percent: whole percent, "—" when there is nothing to divide', () => {
    expect(percent(0.9)).toBe('90%')
    expect(percent(5 / 9)).toBe('56%')
    expect(percent(1)).toBe('100%')
    expect(percent(0)).toBe('0%')
    expect(percent(null)).toBe('—')
  })

  it('readSentence: a complete read says so; an incomplete one says why and that the counts are partial', () => {
    expect(readSentence(report())).toBe('Complete: 31 orders read in 2 pages.')
    expect(readSentence(report({ read: { stoppedBecause: 'max_pages', complete: false, pages: 25, ordersRead: 500 } }))).toBe(
      'Incomplete: stopped at the 25-page limit after 500 orders. The counts cover only those orders.',
    )
    expect(readSentence(report({ read: { stoppedBecause: 'throttled', complete: false, pages: 3, ordersRead: 60 } }))).toBe(
      'Incomplete: Shopify’s rate limit ended the read after 60 orders. The counts cover only those orders.',
    )
  })

  it('matchSentence: what the order webhook would match today', () => {
    expect(matchSentence(report())).toBe('27 of 30 orders (90%) have every line matched to a Nexus SKU; 36 of 40 lines (90%).')
    expect(matchSentence(report({ total: 0, skus: { orderMatchRate: null, lineMatchRate: null, lines: 0, matchedLines: 0, ordersFullyMatched: 0 } }))).toBe('No orders in this window.')
  })
})
