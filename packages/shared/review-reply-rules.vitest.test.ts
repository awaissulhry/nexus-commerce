import { describe, expect, it } from 'vitest'

import {
  EBAY_REPLY_LIMIT,
  REPLY_DUE_HOURS,
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
})
