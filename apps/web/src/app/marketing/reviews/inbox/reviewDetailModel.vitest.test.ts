import { describe, expect, it } from 'vitest'
import { reviewReplyRules } from '@nexus/shared/review-reply-rules'
import {
  MANAGE_DRAFT, MANAGE_REPLY, buyerFacts, composerView, detailSubtitle, detailTabs, detailTitle, draftResponseId, historySteps,
  initialReplyText, lightboxHead, navIds, navPlace, nextHeld, nextId, orderFacts, photosView, replyDoneWords, replyTargetWords, replyTitle,
  returnOpen, reviewPhotos, revisionLine, sameThemeLink, textView, themeChoices, topicChips, type InboxDetail,
} from './reviewDetailModel'
import { lightboxCounter, lightboxHeld, lightboxStep } from '@/design-system/patterns/lightboxModel'
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
    // PR I: a Shopify review read from Judge.me or Okendo is answered through that app (the rules' `via`).
    expect(replyDoneWords('send', 'SHOPIFY', 'Judge.me')).toBe('Reply sent to Judge.me. The review is Responded.')
    expect(replyTitle({ channel: 'SHOPIFY', mode: 'send', via: 'Okendo' })).toBe('Reply on Okendo')
    expect(replyDoneWords('send', 'SHOPIFY', 'Okendo')).toBe('Reply sent to Okendo. The review is Responded.')
    expect(replyTitle({ channel: 'EBAY', mode: 'send' })).toBe('Reply on eBay')
    expect(replyTitle({ channel: 'ETSY', mode: 'copy' })).toBe('Reply')
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
    // No delivery date in Nexus is "not recorded", never "not yet" next to "Order delivered on time" (live audit B12).
    const noDate = detail({ order: { ...d.order!, deliveredAt: null } })
    expect(orderFacts(noDate, 'UTC').find((f) => f.label === 'Delivered')).toEqual({ label: 'Delivered', value: 'Not recorded', hint: 'Nexus has no delivery date for this order' })
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

  it('never "Overdue" or "Replied — not yet" where nobody can answer, or for an imported review (the badges\' one rule)', () => {
    const amazonProduct = detail({ reply: reviewReplyRules('AMAZON', { kind: 'product', marketplace: 'IT' }, NOW) }, { channel: 'AMAZON', market: 'IT', kind: 'product', postedAt: '2026-10-20T08:00:00Z' })
    expect(replyTargetWords(amazonProduct, NOW.getTime(), 'UTC')).toBe('No reply target: nobody can answer it')
    expect(historySteps(amazonProduct).map((st) => st.label)).not.toContain('Replied')
    const imported = detail({}, { imported: true, postedAt: '2026-10-20T08:00:00Z' })
    expect(replyTargetWords(imported, NOW.getTime(), 'UTC')).toBe('Imported from a file: no reply target')
    expect(historySteps(imported).map((st) => st.label)).not.toContain('Replied')
    // eBay feedback read by Nexus still waits for its reply.
    expect(historySteps(detail()).map((st) => st.label)).toContain('Replied')
  })

  it("positive and eBay's automatic feedback have no reply target — the badges leave them out (Owner 2026-10-27)", () => {
    const positive = detail({ noReply: 'positive' }, { rating: 5, postedAt: '2026-10-20T08:00:00Z' })
    expect(replyTargetWords(positive, NOW.getTime(), 'UTC')).toBe('No reply needed: positive — reply only if you want to')
    expect(historySteps(positive).map((st) => st.label)).not.toContain('Replied')
    const automatic = detail({ noReply: 'automatic' }, { rating: 5, body: 'Order delivered on time with no issues' })
    expect(replyTargetWords(automatic, NOW.getTime(), 'UTC')).toBe('No reply needed: eBay left this feedback by itself')
    // The API says it needs a reply: the target, with the year when it is not this year's (live audit D04).
    expect(replyTargetWords(detail({ noReply: null }, { postedAt: '2025-02-14T08:00:00Z' }), NOW.getTime(), 'UTC')).toBe('Overdue since 16 Feb 2025')
  })
})

describe('the buyer’s photos and the Lightbox (PR G)', () => {
  const media = [
    { url: 'https://i.ebayimg.example/2.jpg', type: 'image', width: null, height: null, position: 1 },
    { url: 'https://i.ebayimg.example/1.jpg', type: 'image', width: null, height: null, position: 0 },
    { url: 'javascript:alert(1)', type: 'image', width: null, height: null, position: 2 },
  ]

  it('opens the photos in order, each named for the buyer; a link that is not a web address is left out', () => {
    expect(reviewPhotos(detail({ media }))).toEqual([
      { url: 'https://i.ebayimg.example/1.jpg', alt: 'Photo 1 of 2 from buyer-one', type: 'IMAGE' },
      { url: 'https://i.ebayimg.example/2.jpg', alt: 'Photo 2 of 2 from buyer-one', type: 'IMAGE' },
    ])
    expect(photosView(detail({ media }))).toMatchObject({ kind: 'photos', count: '2 photos', hint: 'Press a photo to see it large. eBay keeps the photos; Nexus shows them from eBay.' })
  })

  it('Etsy’s one photo and Judge.me’s photos open the same way (PR I); a Judge.me video is said, never hidden', () => {
    const one = [{ url: 'https://i.etsystatic.com/review/abc_fullxfull.jpg', type: 'image', width: null, height: null, position: 0 }]
    const etsy = detail({ media: one }, { channel: 'ETSY', kind: 'product' })
    expect(photosView(etsy)).toMatchObject({ kind: 'photos', count: '1 photo', hint: 'Press a photo to see it large. Etsy keeps the photos; Nexus shows them from Etsy.' })
    expect(reviewPhotos(etsy)).toEqual([{ url: one[0].url, alt: 'Photo 1 of 1 from buyer-one', type: 'IMAGE' }])
    expect(photosView(detail({ media: [] }, { channel: 'ETSY', kind: 'product' }))).toEqual({ kind: 'none', words: 'No photo with this review. Etsy buyers can add one.' })
    const jm = [{ url: 'https://img.judge.me/o.jpg', type: 'image', width: null, height: null, position: 0 }]
    expect(photosView(detail({ media: jm, videoIn: 'Judge.me', app: 'Judge.me' }, { channel: 'SHOPIFY', kind: 'product' }))).toMatchObject({
      kind: 'photos',
      hint: 'Press a photo to see it large. Judge.me keeps the photos; Nexus shows them from Judge.me. The buyer also added a video: watch it in Judge.me (Nexus shows the photos only).',
    })
    expect(photosView(detail({ media: [], videoIn: 'Judge.me' }, { channel: 'SHOPIFY', kind: 'product' }))).toEqual({
      kind: 'none', words: 'No photos with this review. The buyer added a video: watch it in Judge.me (Nexus shows the photos only).',
    })
    expect(photosView(detail({ media: [] }, { channel: 'SHOPIFY', kind: 'product', imported: true }))).toEqual({ kind: 'none', words: 'This review came from a file: its photos are not in Nexus.' })
    // Okendo, Yotpo and Loox: the photos are the app's (the detail names the app).
    expect(photosView(detail({ media: jm, videoIn: null, app: 'Loox' }, { channel: 'SHOPIFY', kind: 'product' }))).toMatchObject({ hint: 'Press a photo to see it large. Loox keeps the photos; Nexus shows them from Loox.' })
  })

  it('Prev is held on the first photo, Next on the last; the counter reads "2 of 2"', () => {
    const items = reviewPhotos(detail({ media }))
    expect(lightboxHeld(0, items.length, -1)).toBe('This is the first photo.')
    expect(lightboxStep(0, items.length, 1)).toBe(1)
    expect(lightboxHeld(1, items.length, 1)).toBe('This is the last photo.')
    expect(lightboxCounter(1, items.length)).toBe('2 of 2')
  })

  it('says when there are none (eBay)', () => {
    expect(photosView(detail({ media: [] }))).toEqual({ kind: 'none', words: 'No photos with this feedback. eBay buyers can add up to 5.' })
    expect(photosView(detail({ media: [] }, { imported: true }))).toEqual({ kind: 'none', words: 'This feedback came from a file: its photos are not in Nexus.' })
  })

  it('every channel has a true state: never a sample, never "Coming later"', () => {
    const channels = ['EBAY', 'ETSY', 'SHOPIFY', 'AMAZON', 'WALMART']
    for (const channel of channels) {
      for (const kind of ['product', 'seller'] as const) {
        for (const imported of [false, true]) {
          const view = photosView(detail({ media: [] }, { channel, kind, imported, asin: 'B0TEST0001', market: 'IT' }))
          expect(['none', 'elsewhere']).toContain(view.kind)
          expect(JSON.stringify(view)).not.toMatch(/sample|coming later/i)
        }
      }
    }
  })

  it('an Amazon product review: Amazon gives sellers no photos; the product page on Amazon, linked when Nexus knows the ASIN and market', () => {
    const words = 'Amazon gives sellers no review photos. Buyers’ photos show on the product page on Amazon.'
    const href = 'https://www.amazon.it/dp/B0TEST0001'
    expect(photosView(detail({ media: [], listingHref: href }, { channel: 'AMAZON', kind: 'product', asin: 'B0TEST0001', market: 'IT' }))).toEqual({
      kind: 'elsewhere', words, link: { label: 'Open the product page on Amazon Italy', href },
    })
    // A file import: Amazon still gives no photos; the same words and link.
    expect(photosView(detail({ listingHref: href }, { channel: 'AMAZON', kind: 'product', asin: 'B0TEST0001', market: 'IT', imported: true }))).toMatchObject({ kind: 'elsewhere', words, link: { href } })
    expect(photosView(detail({ listingHref: null }, { channel: 'AMAZON', kind: 'product', asin: null, market: 'IT' }))).toEqual({
      kind: 'elsewhere', words: `${words} Nexus does not know the product’s ASIN of this review, so it cannot link the page.`, link: null,
    })
    // No market: the API would fall back to amazon.com, so no link (it could be the wrong country's page).
    expect(photosView(detail({ listingHref: 'https://www.amazon.com/dp/B0TEST0001' }, { channel: 'AMAZON', kind: 'product', asin: 'B0TEST0001', market: null }))).toEqual({
      kind: 'elsewhere', words: `${words} Nexus does not know the market of this review, so it cannot link the page.`, link: null,
    })
    expect(photosView(detail({ listingHref: null }, { channel: 'AMAZON', kind: 'product', asin: 'B0TEST0001', market: 'DE' }))).toEqual({ kind: 'elsewhere', words, link: null })
  })

  it('Amazon seller feedback has no photos at all', () => {
    expect(photosView(detail({ listingHref: 'https://www.amazon.de/dp/B0TEST0001' }, { channel: 'AMAZON', kind: 'seller', asin: 'B0TEST0001', market: 'DE' }))).toEqual({
      kind: 'elsewhere', words: 'Amazon seller feedback has no photos: buyers leave stars and words only.', link: null,
    })
  })

  it('a channel Nexus reads no photos from says so', () => {
    expect(photosView(detail({ media: [] }, { channel: 'WALMART', kind: 'product' }))).toEqual({
      kind: 'elsewhere', words: 'Nexus reads no photos from Walmart: any the buyer added stay on Walmart.', link: null,
    })
  })

  it('the Lightbox head: who, where, when, and the listing on eBay', () => {
    expect(lightboxHead(detail({ listingHref: 'https://www.ebay.de/itm/110012345678' }), 'UTC')).toEqual({
      meta: 'buyer-one · eBay Germany · 26 Oct 2026', external: { label: 'Open on eBay', href: 'https://www.ebay.de/itm/110012345678' },
    })
    expect(lightboxHead(detail(), 'UTC').external).toBeNull()
  })
})

describe('eBay’s topics and revision state (PR G)', () => {
  it('topics as chips toned by eBay’s mood; revision words with when Nexus saw them', () => {
    expect(topicChips(detail({ aiTopics: [{ topic: 'fit', label: 'Fit & sizing', sentiment: 'NEGATIVE', texts: ['Zu klein'] }, { topic: 'shipping', label: 'Shipping', sentiment: 'POSITIVE', texts: [] }] }))).toEqual([
      { key: 'fit', label: 'Fit & sizing', tone: 'danger', texts: ['Zu klein'] },
      { key: 'shipping', label: 'Shipping', tone: 'success', texts: [] },
    ])
    expect(topicChips(detail({ aiTopics: null }))).toEqual([])
    expect(revisionLine(detail({ revision: { state: 'REVISION_OPEN', words: 'Waiting for the buyer', tone: 'info', since: '2026-10-24T09:00:00Z', eligible: false } }), 'UTC')).toEqual({ words: 'Waiting for the buyer', tone: 'info', since: 'seen 24 Oct 2026' })
    expect(revisionLine(detail())).toBeNull()
  })
})
