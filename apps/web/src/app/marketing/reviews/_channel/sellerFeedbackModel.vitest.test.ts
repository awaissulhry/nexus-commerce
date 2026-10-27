/**
 * Reviews › Amazon seller feedback (PR H) — the card line, why "Fetch now" is held (permission first), failed markets in
 * words, the tile, and one feedback as the card lists it. Pure.
 */
import { describe, expect, it } from 'vitest'
import {
  failedFetchWords, feedbackCardLine, feedbackRowView, fetchHeldWords, MANAGE_FETCH, REMOVAL_RULES, sellerFeedbackTile,
  type AmazonSellerFeedback, type AmazonSellerFeedbackRow, type SellerFeedbackState,
} from './sellerFeedbackModel'
import { removalView, type InboxDetail } from '../inbox/reviewDetailModel'

const state = (over: Partial<SellerFeedbackState> = {}): SellerFeedbackState => ({
  on: true, every: 'Daily 06:00 UTC', markets: [], canFetch: true, held: null, fixHref: null, fetching: false, lastFetchAt: null, lastOkAt: null, ...over,
})

const check = { verdict: 'may_qualify' as const, label: 'May qualify', tone: 'info' as const, why: 'Entirely about the product, not your service', words: 'w', reasons: ['product_only'], ageDays: 2, daysLeft: 88 }

const row = (over: Partial<AmazonSellerFeedbackRow> = {}): AmazonSellerFeedbackRow => ({
  id: 'f1', rating: 2, postedAt: '2026-10-25T00:00:00Z', text: 'Cucitura aperta sul pollice.', english: 'Open seam on the thumb.', language: 'it',
  amazonOrderId: '028-1111111-1111111', orderId: null, fulfilmentWords: 'you shipped it', status: 'NEW', replied: false, check, ...over,
})

describe('"Fetch now"', () => {
  it('is held without the permission first, then for the API’s reason; free when it can run', () => {
    expect(fetchHeldWords(state(), false)).toBe(MANAGE_FETCH)
    expect(fetchHeldWords(state({ canFetch: false, held: 'Nexus does not fetch Amazon seller feedback in this setup yet.' }), true))
      .toBe('Nexus does not fetch Amazon seller feedback in this setup yet.')
    expect(fetchHeldWords(null, true)).toMatch(/could not check/)
    expect(fetchHeldWords(state(), true)).toBeNull()
  })

  it('names each market whose fetch failed', () => {
    expect(failedFetchWords(state())).toBeNull()
    const s = state({ markets: [
      { market: 'IT', state: 'ok', lastFetchAt: null, lastOkAt: null, rows: 3, words: 'Fetched' },
      { market: 'ES', state: 'failed', lastFetchAt: null, lastOkAt: null, rows: null, words: 'Amazon refused.' },
    ] })
    expect(failedFetchWords(s)).toBe('Spain: Amazon refused.')
  })
})

describe('the card', () => {
  it('says what the report is, the last fetch and how many in 90 days', () => {
    const f: AmazonSellerFeedback = { fetch: state({ lastFetchAt: '2026-10-25T09:12:00Z' }), total90: 7, rows: [], rules: [...REMOVAL_RULES] }
    expect(feedbackCardLine(f)).toMatch(/^Amazon’s report holds only 1–3 star feedback and is fetched on request \(it can’t be scheduled\) · last fetch 25 Oct, \d\d:12 · 7 in the last 90 days$/)
    expect(feedbackCardLine({ ...f, fetch: state({ on: false }) })).toMatch(/not fetched in this setup yet · 7 in the last 90 days$/)
    expect(feedbackCardLine({ ...f, fetch: state({ fetching: true }) })).toMatch(/fetching now/)
  })

  it('one feedback: the buyer’s words, the English when it differs, who shipped, the check', () => {
    const v = feedbackRowView(row())
    expect(v).toMatchObject({ stars: 2, day: '25 Oct', text: 'Cucitura aperta sul pollice.', english: 'Open seam on the thumb.' })
    expect(v.who).toBe('A buyer · order 028-1111111-1111111 · you shipped it')
    expect(v.check.label).toBe('May qualify')
    expect(feedbackRowView(row({ english: 'Cucitura aperta sul pollice.', replied: true, fulfilmentWords: null, amazonOrderId: null })))
      .toMatchObject({ english: null, who: 'A buyer · you replied' })
    expect(feedbackRowView(row({ text: '  ' })).text).toBe('No comment')
  })

  it('the tile: 90 days against the 90 before; no number when this setup does not fetch and nothing is held', () => {
    expect(sellerFeedbackTile({ sellerFeedback90: 7, sellerFeedbackPrev90: 9, sellerFeedbackOn: true })).toEqual({ value: '7', hint: 'last 90 days · −2 on the 90 days before' })
    expect(sellerFeedbackTile({ sellerFeedback90: 3, sellerFeedbackPrev90: 3, sellerFeedbackOn: false })).toEqual({ value: '3', hint: 'last 90 days · same as the 90 days before' })
    expect(sellerFeedbackTile({ sellerFeedback90: 0, sellerFeedbackPrev90: 0, sellerFeedbackOn: false })).toEqual({ value: '—', hint: 'Not fetched in this setup yet' })
  })

  it('the rules never offer to ask Amazon from Nexus', () => {
    expect(REMOVAL_RULES.join(' ')).toMatch(/You ask in Feedback Manager, and Amazon decides\./)
    expect(REMOVAL_RULES.join(' ')).not.toMatch(/from Nexus/)
  })
})

describe('the review pop-up', () => {
  const detail = (over: Partial<InboxDetail['review']>, removal: InboxDetail['removal']) =>
    ({ review: { channel: 'AMAZON', kind: 'seller', ...over } as InboxDetail['review'], removal })

  it('shows the removal check for Amazon seller feedback only', () => {
    const removal = { ...check, rules: [...REMOVAL_RULES] }
    expect(removalView(detail({}, removal))).toMatchObject({ label: 'May qualify', tone: 'info', rules: REMOVAL_RULES })
    expect(removalView(detail({ kind: 'product' }, removal))).toBeNull()
    expect(removalView(detail({ channel: 'EBAY' }, removal))).toBeNull()
    expect(removalView(detail({}, null))).toBeNull()
    expect(removalView(detail({}, undefined))).toBeNull()
  })
})
