/**
 * Reviews › Etsy and Shopify (PR I) — the pages' words: tiles, the reply window ("Day 2 of 100", "4 days left",
 * "Closed"), what a row's reply cell offers, the review app's state, the CSV export and the connect form's held reasons.
 */
import { describe, expect, it } from 'vitest'
import type { InboxRow } from '../inbox/inboxDatasource'
import {
  connectHeld, csvFileName, etsyReplyCell, etsySubtitle, etsyTileViews, isAnswered, isAppConnected, lastEditWords, mediaWords, reviewsCsv,
  shopDomainOf, shopifyReplyNote, shopifySubtitle, shopifyTileViews, waitHoursWords, windowWords,
  type EtsyRow, type ReviewAppView, type ShopifyRow,
} from './shopChannelModel'

const base: InboxRow = {
  id: 'r1', postedAt: '2026-10-20T10:00:00.000Z', channel: 'ETSY', market: null, kind: 'product', rating: 5, snippet: 'Lovely, fits well',
  english: null, language: 'en', buyer: 'A. Buyer', product: { id: 'p1', name: 'Racing gloves', sku: 'GLV-1', variant: 'M' },
  order: { id: 'o1', label: '3456789' }, mood: null, themes: [], status: 'NEW', assignee: null, dueAt: null, overdue: false, imported: false,
  responses: { sent: 0, draft: 0 }, photos: 1, aiTopics: null,
}
const etsy = (over: Partial<EtsyRow> = {}): EtsyRow => ({
  ...base, photoUrl: 'https://i.etsystatic.com/x.jpg', editedAt: '2026-10-25T10:00:00.000Z',
  window: { days: 100, day: 3, daysLeft: 98, closed: false, endsAt: '2027-02-02T10:00:00.000Z' }, ...over,
})
const shopify = (over: Partial<ShopifyRow> = {}): ShopifyRow => ({
  ...base, channel: 'SHOPIFY', photoItems: [{ url: 'https://img.judge.me/o.jpg', thumb: 'https://img.judge.me/c.jpg' }], hasVideo: true, app: 'JUDGEME', ...over,
})

describe('Etsy', () => {
  it('six tiles in the board’s order; open and closing link to the Inbox filtered to Etsy', () => {
    const views = etsyTileViews({ average: 4.8, reviews: 96, newReviews: 7, newDelta: 3, withPhoto: 22, notReplied: 5, closing: 1, closed: 3 })
    expect(views.map((v) => [v.label, v.value, v.hint])).toEqual([
      ['Average rating', '4.8', '96 reviews'],
      ['New reviews', '7', '+3 · last 30 days'],
      ['With a photo', '22', 'one per review'],
      ['Not replied yet', '5', 'window still open'],
      ['Window closing', '1', '10 days or less left'],
      ['Window closed', '3', 'no reply possible'],
    ])
    expect(views[3].href).toBe('/marketing/reviews/inbox?period=all&channel=ETSY&reply=needed')
  })

  it('the window in words', () => {
    expect(windowWords({ days: 100, day: 2, daysLeft: 99, closed: false, endsAt: '2027-01-01T00:00:00Z' })).toEqual({ label: 'Day 2 of 100', note: '99 days left', tone: 'neutral' })
    expect(windowWords({ days: 100, day: 97, daysLeft: 4, closed: false, endsAt: '2027-01-01T00:00:00Z' })).toMatchObject({ note: '4 days left', tone: 'danger' })
    expect(windowWords({ days: 100, day: 100, daysLeft: 0, closed: true, endsAt: '2026-10-01T00:00:00Z' })).toMatchObject({ label: 'Closed', note: 'closed 1 Oct' })
    expect(windowWords(null).label).toBe('No date')
  })

  it('the reply cell: write a reply (the Inbox pop-up), held when the window closed or without the permission; responded rows show the reply', () => {
    expect(etsyReplyCell(etsy(), true)).toEqual({ write: { href: '/marketing/reviews/inbox?channel=ETSY&review=r1', held: null }, note: 'Needs a reply' })
    expect(etsyReplyCell(etsy({ window: { days: 100, day: 100, daysLeft: 0, closed: true, endsAt: '2026-10-01T00:00:00Z' } }), true).write.held).toMatch(/^Etsy’s 100 days to reply ran out on 1 Oct/)
    expect(etsyReplyCell(etsy(), false).write.held).toMatch(/Manage reviews/)
    expect(etsyReplyCell(etsy({ status: 'RESPONDED' }), false)).toMatchObject({ note: 'Responded', write: { held: null } })
    expect(isAnswered(etsy({ responses: { sent: 1, draft: 0 } }))).toBe(true)
  })

  it('the last edit and the header line', () => {
    expect(lastEditWords(etsy())).toBe('last edit 25 Oct')
    expect(lastEditWords(etsy({ editedAt: null }))).toBe('last edit 20 Oct')
    expect(etsySubtitle(null, null)).toBe('reply on Etsy.com within 100 days of the buyer’s last edit')
  })
})

describe('Shopify', () => {
  const app = (state: ReviewAppView['state']): ReviewAppView => ({
    app: 'JUDGEME', name: 'Judge.me', what: '', state, stateWords: state === 'connected' ? 'Connected' : 'Not connected', tone: 'success', words: '',
    shopDomain: 'a-store.myshopify.com', connectedAt: null, lastReadAt: null, lastReadCount: null, canReply: true, connectable: true,
  })
  it('four tiles', () => {
    expect(shopifyTileViews({ average: 4.6, reviews: 318, newReviews: 24, newDelta: 6, withMedia: 64, videos: 9, needReply: 2, oldestWaitHours: 6 }).map((v) => `${v.label}: ${v.value} (${v.hint})`))
      .toEqual(['Average rating: 4.6 (318 reviews)', 'New reviews: 24 (+6 · last 30 days)', 'With photo or video: 64 (9 videos)', 'Needs a reply: 2 (oldest 6 h)'])
    expect(waitHoursWords(null)).toBe('nothing waits')
    expect(waitHoursWords(50)).toBe('oldest 2 days')
  })
  it('who posts the reply; the app’s state', () => {
    expect(shopifyReplyNote(shopify(), true)).toBe('Reply from Nexus')
    expect(shopifyReplyNote(shopify(), false)).toBe('Judge.me not connected')
    expect(shopifyReplyNote(shopify({ app: null }), true)).toBe('Copy and post in the app')
    expect(shopifyReplyNote(shopify({ status: 'RESPONDED' }), true)).toBe('Responded')
    expect(isAppConnected(app('waiting'))).toBe(true)
    expect(isAppConnected(app('needs_fix'))).toBe(false)
    expect(mediaWords(shopify())).toBe('1 photo · video in Judge.me')
    expect(shopifySubtitle(null)).toMatch(/Shopify keeps no reviews itself/)
  })
})

describe('export', () => {
  it('one CSV row per ticked review; a formula-looking cell stays text; quotes doubled', () => {
    const csv = reviewsCsv('ETSY', [etsy({ snippet: '=HYPERLINK("x")', buyer: 'B, "C"' })])
    const [head, line] = csv.trim().split('\r\n')
    expect(head).toBe('Posted,Last edit,Stars,Review,Buyer,Item,Order,Reply window,Status,Owner,Photo')
    expect(line).toBe('2026-10-20,2026-10-25,5,"\'=HYPERLINK(""x"")","B, ""C""",Racing gloves (M),3456789,Day 3 of 100 (98 days left),NEW,,https://i.etsystatic.com/x.jpg')
    expect(reviewsCsv('SHOPIFY', [shopify()]).split('\r\n')[1]).toContain('https://img.judge.me/o.jpg,yes,NEW')
    expect(csvFileName('SHOPIFY', new Date('2026-10-27T12:00:00Z'))).toBe('shopify-reviews-2026-10-27.csv')
  })
})

describe('connecting Judge.me', () => {
  it('the store address and the token, in order; the permission first', () => {
    const ok = { canManage: true, shopDomain: 'a-store.myshopify.com', apiToken: 'abcdefgh12345', busy: false }
    expect(connectHeld(ok)).toBeNull()
    expect(connectHeld({ ...ok, canManage: false })).toMatch(/Manage reviews/)
    expect(connectHeld({ ...ok, shopDomain: '' })).toMatch(/Shopify address first/)
    expect(connectHeld({ ...ok, shopDomain: 'mystore.com' })).toMatch(/\.myshopify\.com/)
    expect(connectHeld({ ...ok, apiToken: '' })).toMatch(/Paste the private API token/)
    expect(connectHeld({ ...ok, apiToken: 'a b' })).toMatch(/does not look like/)
    expect(shopDomainOf('https://A-Store.myshopify.com/admin')).toBe('a-store.myshopify.com')
  })
})
