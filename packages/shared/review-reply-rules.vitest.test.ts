import { describe, expect, it } from 'vitest'

import {
  EBAY_BUYER_FEEDBACK_DAYS,
  EBAY_BUYER_FEEDBACK_LIMIT,
  EBAY_REPLY_LIMIT,
  REPLY_DUE_HOURS,
  buyerFeedbackDaysLeft,
  buyerFeedbackLineHeld,
  buyerFeedbackTextHeld,
  revisionWords,
  channelSiteDomain,
  isReviewOpen,
  isReviewOverdue,
  replyLength,
  replyRefusal,
  reviewDueAt,
  reviewReplyRules,
} from './review-reply-rules'

const NOW = new Date('2026-10-26T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

describe('reviewReplyRules — one reply rule per channel (Reviews Inbox, 2026-10-26)', () => {
  it('eBay: Nexus sends, one reply, 500 characters (RespondToFeedback ResponseText max length), no edit', () => {
    const r = reviewReplyRules('EBAY', { kind: 'seller', marketplace: 'DE' }, NOW)
    expect(EBAY_REPLY_LIMIT).toBe(500)
    expect(r).toMatchObject({ mode: 'send', limit: 500, oneReply: true, canEdit: false, sendLabel: 'Send reply to eBay', markAsResponded: false, held: null })
    expect(r.ruleLine).toBe('One reply per feedback, up to 500 characters, can’t be edited or removed.')
  })

  it('eBay, imported from a file: copied and posted by hand, the same limit', () => {
    const r = reviewReplyRules('EBAY', { imported: true, marketplace: 'IT' }, NOW)
    expect(r).toMatchObject({ mode: 'copy', limit: 500, sendLabel: null, markAsResponded: true })
    expect(r.open?.href).toBe('https://www.ebay.it/sh/ovw')
  })

  it('eBay with a reply already: held with the reason, and the API refuses it', () => {
    const r = reviewReplyRules('ebay', { replied: true }, NOW)
    expect(r.heldCode).toBe('already_replied')
    expect(r.held).toBe('This feedback already has a reply. eBay allows one reply per feedback.')
    expect(replyRefusal(r, 'Thanks again')).toEqual({ code: 'already_replied', words: r.held })
  })

  it('Amazon: no reply API — copy, open Seller Central, mark as responded; never a send button', () => {
    const product = reviewReplyRules('AMAZON', { kind: 'product', marketplace: 'DE' }, NOW)
    expect(product).toMatchObject({ mode: 'copy', sendLabel: null, markAsResponded: true, limit: null })
    expect(product.open).toEqual({ label: 'Open in Seller Central', href: 'https://sellercentral.amazon.de/home' })
    const seller = reviewReplyRules('AMAZON', { kind: 'seller', marketplace: 'IT', replied: true }, NOW)
    expect(seller.open?.label).toBe('Open Feedback Manager')
    expect(seller.heldCode).toBe('already_replied')
  })

  it('Etsy: copy only, one reply within 100 days, counted from the posted time', () => {
    const open = reviewReplyRules('ETSY', { postedAt: daysAgo(11) }, NOW)
    expect(open).toMatchObject({ mode: 'copy', oneReply: true, canEdit: false, held: null })
    expect(open.window).toMatchObject({ days: 100, day: 12, daysLeft: 89, closed: false })
    expect(open.window?.words).toBe('Day 12 of 100 · 89 days left to reply on Etsy')
    const closed = reviewReplyRules('ETSY', { postedAt: daysAgo(101) }, NOW)
    expect(closed.heldCode).toBe('window_closed')
    expect(closed.held).toMatch(/^The reply window on Etsy closed on \d{1,2} \w{3} 2026\.$/)
    expect(replyRefusal(closed, 'Thank you')?.code).toBe('window_closed')
  })

  it('Shopify: copy and mark as responded until the review app is connected; a second reply is not held', () => {
    const r = reviewReplyRules('SHOPIFY', { replied: true }, NOW)
    expect(r).toMatchObject({ mode: 'copy', oneReply: false, held: null, open: null })
  })

  it('an unknown channel: copy and mark as responded', () => {
    expect(reviewReplyRules('OTHER', {}, NOW)).toMatchObject({ mode: 'copy', markAsResponded: true, held: null })
  })
})

describe('replyRefusal — what reply/send refuses', () => {
  const ebay = reviewReplyRules('EBAY', {}, NOW)
  it('empty text', () => {
    expect(replyRefusal(ebay, '   ')).toEqual({ code: 'empty_body', words: 'Write a reply first.' })
  })
  it('over the limit, in words; exactly the limit passes', () => {
    expect(replyRefusal(ebay, 'x'.repeat(500))).toBeNull()
    expect(replyRefusal(ebay, 'x'.repeat(501))).toEqual({ code: 'too_long', words: 'Cut 1 character to send it (the limit is 500).' })
    expect(replyRefusal(ebay, 'x'.repeat(538))?.words).toBe('Cut 38 characters to send it (the limit is 500).')
  })
  it('no limit: any length passes', () => {
    expect(replyRefusal(reviewReplyRules('AMAZON', {}, NOW), 'x'.repeat(5000))).toBeNull()
  })
  it('characters are counted as a person sees them', () => {
    expect(replyLength('Grazie 🙏🏽')).toBe(8)
    expect(replyLength('')).toBe(0)
  })
})

describe('due and overdue', () => {
  it(`an open review is overdue after ${REPLY_DUE_HOURS} hours`, () => {
    expect(reviewDueAt('2026-10-24T08:00:00Z').toISOString()).toBe('2026-10-26T08:00:00.000Z')
    expect(isReviewOverdue({ status: null, postedAt: daysAgo(3) }, NOW)).toBe(true)
    expect(isReviewOverdue({ status: 'IN_PROGRESS', postedAt: daysAgo(3) }, NOW)).toBe(true)
    expect(isReviewOverdue({ status: 'NEW', postedAt: daysAgo(1) }, NOW)).toBe(false)
  })
  it('a closed review is never overdue', () => {
    for (const status of ['RESPONDED', 'RESOLVED', 'IGNORED']) {
      expect(isReviewOpen(status)).toBe(false)
      expect(isReviewOverdue({ status, postedAt: daysAgo(30) }, NOW)).toBe(false)
    }
  })
})

describe('channelSiteDomain', () => {
  it('per market, with a .com fallback; none for channels without market sites', () => {
    expect(channelSiteDomain('EBAY', 'UK')).toBe('www.ebay.co.uk')
    expect(channelSiteDomain('AMAZON', 'it')).toBe('www.amazon.it')
    expect(channelSiteDomain('AMAZON', 'XX')).toBe('www.amazon.com')
    expect(channelSiteDomain('SHOPIFY', 'IT')).toBeNull()
  })

  it('eBay: a reply is held when the buyer’s eBay user ID is known to be missing, not when a caller leaves it out', () => {
    expect(reviewReplyRules('EBAY', { buyerId: '' })).toMatchObject({ heldCode: 'buyer_unknown', mode: 'send' })
    expect(reviewReplyRules('EBAY', { buyerId: null }).held).toMatch(/buyer’s eBay user ID/)
    expect(reviewReplyRules('EBAY', { buyerId: 'buyer_123' }).held).toBeNull()
    expect(reviewReplyRules('EBAY', {}).held).toBeNull()
    expect(reviewReplyRules('EBAY', { buyerId: '', replied: true }).heldCode).toBe('already_replied')
    expect(replyRefusal(reviewReplyRules('EBAY', { buyerId: '' }), 'Thanks!')).toMatchObject({ code: 'buyer_unknown' })
  })
})

describe('eBay feedback for buyers (PR G)', () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

  it('takes up to 500 characters, counted as a person sees them', () => {
    expect(EBAY_BUYER_FEEDBACK_LIMIT).toBe(500)
    expect(buyerFeedbackTextHeld('x'.repeat(500))).toBeNull()
    expect(buyerFeedbackTextHeld('x'.repeat(501))).toBe('Cut 1 character (eBay allows 500).')
    expect(buyerFeedbackTextHeld('x'.repeat(538))).toBe('Cut 38 characters (eBay allows 500).')
    expect(buyerFeedbackTextHeld('   ')).toBe('Write the feedback first.')
    expect(buyerFeedbackTextHeld(null)).toBe('Write the feedback first.')
  })

  it('holds a sale older than 90 days, and counts the days left', () => {
    expect(EBAY_BUYER_FEEDBACK_DAYS).toBe(90)
    expect(buyerFeedbackLineHeld({ state: 'AWAITING', soldAt: days(89) }, NOW)).toBeNull()
    expect(buyerFeedbackLineHeld({ state: 'AWAITING', soldAt: days(91) }, NOW)).toMatch(/^Sold on .*: eBay allows feedback for a buyer only within 90 days of the sale\.$/)
    expect(buyerFeedbackDaysLeft(days(10), NOW)).toBe(80)
    expect(buyerFeedbackDaysLeft(days(120), NOW)).toBe(0)
    expect(buyerFeedbackDaysLeft(null, NOW)).toBeNull()
    // eBay still lists a sale Nexus has no order for: its date is unknown, so eBay's own list decides.
    expect(buyerFeedbackLineHeld({ state: 'AWAITING', soldAt: null }, NOW)).toBeNull()
  })

  it('holds a line already left, gone, waiting for approval or with an open return — in that order', () => {
    expect(buyerFeedbackLineHeld({ state: 'LEFT', waiting: true }, NOW)).toMatch(/already left .*one feedback per sale/)
    expect(buyerFeedbackLineHeld({ state: 'GONE' }, NOW)).toMatch(/no longer lists this sale/)
    expect(buyerFeedbackLineHeld({ state: 'AWAITING', waiting: true, openReturn: true }, NOW)).toBe('Already sent for approval: it waits on the Approvals page.')
    expect(buyerFeedbackLineHeld({ state: 'AWAITING', openReturn: true, soldAt: days(5) }, NOW)).toBe('This order has an open return or case: leave feedback once it is closed.')
  })
})

describe('eBay revision requests (PR G)', () => {
  it('says each state of eBay in words', () => {
    expect(revisionWords('REVISION_OPEN', false)).toEqual({ words: 'Waiting for the buyer', tone: 'info' })
    expect(revisionWords('REVISED', false)).toEqual({ words: 'Revised by the buyer', tone: 'success' })
    expect(revisionWords('REVISION_DECLINED_OR_EXPIRED', false)?.words).toBe('Buyer said no, or 10 days passed')
    expect(revisionWords('ENTERED', true)).toEqual({ words: 'Can be asked in Seller Hub', tone: 'warning' })
    expect(revisionWords('ENTERED', false)).toBeNull()
    expect(revisionWords(null, null)).toBeNull()
  })
})
