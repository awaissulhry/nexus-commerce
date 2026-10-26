import { describe, expect, it } from 'vitest'
import { reviewReplyRules } from '@nexus/shared/review-reply-rules'
import {
  MANAGE_DRAFT, MANAGE_REPLY, buyerFacts, composerView, detailSubtitle, detailTabs, detailTitle, draftResponseId, historySteps,
  initialReplyText, navIds, navPlace, nextHeld, nextId, orderFacts, replyDoneWords, replyTargetWords, returnOpen, sameThemeLink,
  textView, themeChoices, type InboxDetail,
} from './reviewDetailModel'
import { detailPosition } from '@/design-system/patterns/detailModalModel'

const NOW = new Date('2026-10-26T12:00:00Z')

function detail(over: Partial<InboxDetail> = {}, review: Partial<InboxDetail['review']> = {}): InboxDetail {
  const base: InboxDetail = {
    review: {
      id: 'r1', channel: 'EBAY', market: 'DE', kind: 'seller', rating: 3, title: null, body: 'Fällt sehr klein aus', buyer: 'buyer-one',
      postedAt: '2026-10-26T08:12:00Z', ingestedAt: '2026-10-26T08:30:00Z', imported: false, verifiedPurchase: true, status: 'NEW',
      assignee: null, tags: [], note: null, triageUpdatedAt: null, externalReviewId: 'F1', sku: 'OT-XL', asin: null, ...review,
    },
    english: 'Runs very small', language: 'de', languageWords: 'German',
    product: { id: 'p1', name: 'Over-trousers', sku: 'OT' }, variant: { id: 'p2', name: 'Over-trousers XL', sku: 'OT-XL', words: 'XL' },
    order: { id: 'o1', label: '12-34567', channel: 'EBAY', market: 'DE', placedAt: '2026-10-18T10:00:00Z', deliveredAt: '2026-10-21T10:00:00Z', total: '89.9', currency: 'EUR', status: 'DELIVERED' },
    return: { id: 'ret1', status: 'REQUESTED', reasonWords: 'too small', requestedAt: '2026-10-25T10:00:00Z' },
    listingHref: null,
    buyerHistory: [{ id: 'old', postedAt: '2026-03-01T10:00:00Z', rating: 5, snippet: 'Great' }],
    sentiment: { label: 'NEUTRAL', categories: ['FIT_SIZING', 'QUALITY'], edited: false, editedAt: null },
    responses: [],
    timeline: [
      { at: '2026-10-18T10:00:00Z', words: 'Order placed on eBay Germany' },
      { at: '2026-10-25T10:00:00Z', words: 'Return requested — too small' },
      { at: '2026-10-26T08:40:00Z', words: 'AI read it: mood Neutral · Fit & sizing' },
    ],
    reply: reviewReplyRules('EBAY', { kind: 'seller', marketplace: 'DE', postedAt: '2026-10-26T08:12:00Z' }, NOW),
  }
  return { ...base, ...over }
}

describe('review pop-up header and tabs', () => {
  it('names the product and size, who, where, what and when', () => {
    const d = detail()
    expect(detailTitle(d)).toBe('Over-trousers — XL')
    expect(detailSubtitle(d, 'UTC')).toBe('buyer-one · eBay Germany · seller feedback · 26 Oct 2026, 08:12')
    expect(detailTitle(detail({ product: null, variant: null }))).toBe('Seller feedback')
    expect(returnOpen(d)).toBe(true)
    expect(returnOpen(detail({ return: { id: 'x', status: 'REFUNDED', reasonWords: null, requestedAt: '2026-10-01T00:00:00Z' } }))).toBe(false)
    expect(detailTabs(d).map((t) => [t.label, t.count ?? null])).toEqual([['Review', null], ['Order', null], ['Buyer', null], ['History', 3]])
  })

  it('Prev / Next walk the rows on screen; Next is held on the last with a reason', () => {
    const ids = navIds([{ id: 'a' }, { id: 'b' }])
    expect(nextId(ids, 'a')).toBe('b')
    expect(nextId(ids, 'b')).toBeNull()
    expect(nextHeld(ids, 'a')).toBeNull()
    expect(nextHeld(ids, 'b')).toMatch(/last review on this page/)
    expect(nextHeld(ids, 'zzz')).toMatch(/not in the list/)
    // The whole list is 56 rows: page 1's last row has a next page; the list's last row says so.
    expect(nextHeld(ids, 'b', { offset: 0, total: 56 })).toMatch(/last review on this page/)
    expect(nextHeld(ids, 'b', { offset: 54, total: 56 })).toBe('This is the last review in the list.')
  })

  it('the counter counts the whole filtered list: the grid page’s offset, or the cards from the first row', () => {
    expect(navPlace({ narrow: false, page: 2, pageSize: 50, total: 56 })).toEqual({ offset: 50, total: 56 })
    expect(navPlace({ narrow: false, page: 1, pageSize: 50, total: 56 })).toEqual({ offset: 0, total: 56 })
    expect(navPlace({ narrow: true, page: 3, pageSize: 50, total: 56 })).toEqual({ offset: 0, total: 56 })
    expect(navPlace({ narrow: false, page: 1, pageSize: 50, total: undefined })).toEqual({ offset: 0, total: null })
    // With the DetailModal's counter: the 3rd row of page 2 reads "53 of 56", not "3 of 50".
    const page2 = Array.from({ length: 6 }, (_, i) => `p2-${i}`)
    expect(detailPosition(page2, 'p2-2', navPlace({ narrow: false, page: 2, pageSize: 50, total: 56 })).words).toBe('53 of 56')
    expect(detailPosition(page2.slice(0, 3), 'p2-2', navPlace({ narrow: true, page: 1, pageSize: 50, total: 56 })).words).toBe('3 of 56')
  })
})

describe('the reply box from the channel rules', () => {
  it('eBay feedback read from eBay: Nexus sends, 500 characters, held without the permission', () => {
    const view = composerView(detail(), { canManage: true })
    expect(view).toMatchObject({ limit: 500, copy: false, open: null, primary: { label: 'Send reply to eBay', held: null, mode: 'send' }, sent: null, draftHeld: null })
    expect(composerView(detail(), { canManage: false }).primary.held).toBe(MANAGE_REPLY)
    expect(composerView(detail(), { canManage: false }).draftHeld).toBe(MANAGE_DRAFT)
  })

  it('Amazon seller feedback: copy, Open Feedback Manager, Mark as responded; no removal action', () => {
    const d = detail({ reply: reviewReplyRules('AMAZON', { kind: 'seller', marketplace: 'IT' }, NOW) }, { channel: 'AMAZON', market: 'IT' })
    const view = composerView(d, { canManage: true })
    expect(view.copy).toBe(true)
    expect(view.open).toEqual({ label: 'Open Feedback Manager', href: 'https://sellercentral.amazon.it/feedback-manager/index.html' })
    expect(view.primary).toEqual({ label: 'Mark as responded', held: null, mode: 'mark' })
    expect(JSON.stringify(view)).not.toMatch(/remov/i)
  })

  it('a sent reply is read-only; a second one is held by the rules; the latest draft fills the box', () => {
    const sent = detail({
      responses: [{ id: 's1', status: 'SENT', body: 'Danke!', locale: 'de', isAiDrafted: false, createdAt: '2026-10-26T10:00:00Z', sentAt: '2026-10-26T10:42:00Z', createdBy: 'u', failedWords: null }],
      reply: reviewReplyRules('EBAY', { kind: 'seller', marketplace: 'DE', replied: true }, NOW),
    })
    const view = composerView(sent, { canManage: true }, 'UTC')
    expect(view.sent).toEqual({ at: 'Sent 26 Oct 2026, 10:42', text: 'Danke!', note: '· public on eBay · cannot be undone or edited' })
    expect(view.primary.held).toMatch(/already has a reply/)
    expect(initialReplyText(sent)).toBe('')
    const drafted = detail({ responses: [{ id: 'd1', status: 'DRAFT', body: 'Hallo', locale: 'de', isAiDrafted: true, createdAt: '2026-10-26T09:00:00Z', sentAt: null, createdBy: 'u', failedWords: null }] })
    expect(initialReplyText(drafted)).toBe('Hallo')
    expect(draftResponseId(drafted)).toBe('d1')
    expect(replyDoneWords('send', 'EBAY')).toBe('Reply sent to eBay. The review is Responded.')
  })

  it('a refusal newer than any sent reply shows in words', () => {
    const d = detail({ responses: [{ id: 'f', status: 'FAILED', body: 'x', locale: null, isAiDrafted: false, createdAt: '2026-10-26T11:00:00Z', sentAt: null, createdBy: 'u', failedWords: 'eBay refused the reply. Nothing was sent.' }] })
    expect(composerView(d, { canManage: true }).refused).toBe('eBay refused the reply. Nothing was sent.')
  })
})

describe('the review tab, order, buyer and history', () => {
  it('shows the original text and its English; offers Translate only when needed', () => {
    expect(textView(detail())).toMatchObject({ heading: 'What buyer-one wrote · German', english: { from: 'Translated from German', text: 'Runs very small' }, canTranslate: false })
    expect(textView(detail({ english: null })).canTranslate).toBe(true)
    expect(textView(detail({ english: null, language: 'en', languageWords: 'English' })).canTranslate).toBe(false)
    expect(sameThemeLink(detail())).toEqual({ label: 'Other “Fit & sizing” reviews', href: '/marketing/reviews/inbox?period=all&theme=FIT_SIZING' })
    const themed = (categories: string[]) => sameThemeLink(detail({ sentiment: { label: 'NEUTRAL', categories, edited: false, editedAt: null } }))
    // Other alone never reads `Other “Other” reviews`; a named theme after Other wins.
    expect(themed(['OTHER'])).toEqual({ label: 'Other reviews with no theme', href: '/marketing/reviews/inbox?period=all&theme=OTHER' })
    expect(themed(['OTHER', 'SHIPPING'])).toEqual({ label: 'Other “Shipping” reviews', href: '/marketing/reviews/inbox?period=all&theme=SHIPPING' })
    expect(themed([])).toBeNull()
    expect(themeChoices(['FIT_SIZING'])).not.toContainEqual({ value: 'FIT_SIZING', label: 'Fit & sizing' })
  })

  it('order and buyer facts; no e-mail or address anywhere', () => {
    const d = detail()
    expect(orderFacts(d, 'UTC').map((f) => `${f.label}: ${f.value}`)).toEqual([
      'Order: 12-34567', 'Where: eBay Germany', 'Placed: 18 Oct 2026', 'Delivered: 21 Oct 2026', 'Paid: €89.90', 'Return: Requested 25 Oct 2026',
    ])
    expect(orderFacts(detail({ order: null }))).toEqual([])
    const buyer = buyerFacts(d)
    expect(buyer.find((f) => f.label === 'Contact')?.value).toBe('Through eBay messages only')
    expect(JSON.stringify(buyer)).not.toMatch(/@/)
  })

  it('history in order with tones; "Replied" waits while the review is open; the reply target', () => {
    const steps = historySteps(detail())
    expect(steps.map((s) => [s.label, s.tone])).toEqual([
      ['Order placed on eBay Germany', 'neutral'], ['Return requested — too small', 'warning'], ['AI read it: mood Neutral · Fit & sizing', 'info'], ['Replied', 'neutral'],
    ])
    expect(steps[3].at).toBeNull()
    expect(historySteps(detail({}, { status: 'RESOLVED' }))).toHaveLength(3)
    expect(replyTargetWords(detail(), NOW.getTime(), 'UTC')).toBe('Reply target: 28 Oct')
    expect(replyTargetWords(detail({}, { postedAt: '2026-10-20T08:00:00Z' }), NOW.getTime(), 'UTC')).toBe('Overdue since 22 Oct')
  })
})
