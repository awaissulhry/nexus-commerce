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
  reviewAppOf,
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

  it('Etsy: the 100 days count from the buyer’s last edit when Etsy gives it (PR I)', () => {
    // Posted 150 days ago, edited 11 days ago: the window is open, day 12 of 100.
    const edited = reviewReplyRules('ETSY', { postedAt: daysAgo(150), lastEditedAt: daysAgo(11) }, NOW)
    expect(edited).toMatchObject({ held: null, window: { day: 12, daysLeft: 89, closed: false } })
    // No edit time (a file import): the window counts from the posted time.
    expect(reviewReplyRules('ETSY', { postedAt: daysAgo(20), lastEditedAt: null }, NOW).window).toMatchObject({ day: 21, daysLeft: 80 })
    const late = reviewReplyRules('ETSY', { postedAt: daysAgo(300), lastEditedAt: daysAgo(104) }, NOW)
    expect(late.heldCode).toBe('window_closed')
    expect(late.window?.endsAt).toBe(new Date(daysAgo(104).getTime() + 100 * 24 * 60 * 60 * 1000).toISOString())
    // Already replied on Etsy: held, whatever the window.
    expect(reviewReplyRules('ETSY', { postedAt: daysAgo(2), replied: true }, NOW).heldCode).toBe('already_replied')
  })

  it('Shopify via Judge.me: Nexus sends one reply, held once replied; without the connection, or from a file, it is copied', () => {
    const r = reviewReplyRules('SHOPIFY', { app: 'JUDGEME' }, NOW)
    expect(r).toMatchObject({ mode: 'send', sendLabel: 'Send reply to Judge.me', markAsResponded: false, limit: null, oneReply: true, held: null })
    expect(r.ruleLine).toMatch(/public on the store’s review widget/)
    expect(reviewReplyRules('SHOPIFY', { app: 'JUDGEME', replied: true }, NOW)).toMatchObject({ heldCode: 'already_replied' })
    const off = reviewReplyRules('SHOPIFY', { app: 'JUDGEME', appConnected: false }, NOW)
    expect(off).toMatchObject({ mode: 'copy', markAsResponded: true, held: null })
    expect(off.ruleLine).toMatch(/^Judge\.me is not connected to Nexus now/)
    expect(replyRefusal(off, 'Thank you')).toBeNull()
    expect(reviewReplyRules('SHOPIFY', { app: 'JUDGEME', imported: true }, NOW)).toMatchObject({ mode: 'copy', held: null })
    expect(reviewReplyRules('SHOPIFY', { imported: true }, NOW).ruleLine).toMatch(/came from a file/)
  })

  it('Shopify via Okendo, Yotpo or Loox: copy, with each app’s own words', () => {
    expect(reviewReplyRules('SHOPIFY', { app: 'OKENDO' }, NOW).ruleLine).toMatch(/Enterprise plan only/)
    expect(reviewReplyRules('SHOPIFY', { app: 'YOTPO' }, NOW)).toMatchObject({ mode: 'copy', held: null })
    expect(reviewReplyRules('SHOPIFY', { app: 'LOOX' }, NOW).ruleLine).toMatch(/^Loox gives apps no way to reply/)
  })

  it('reviewAppOf: Judge.me reads only', () => {
    expect(reviewAppOf('JUDGEME_API')).toBe('JUDGEME')
    expect(reviewAppOf('IMPORT_CSV')).toBeNull()
    expect(reviewAppOf(null)).toBeNull()
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
