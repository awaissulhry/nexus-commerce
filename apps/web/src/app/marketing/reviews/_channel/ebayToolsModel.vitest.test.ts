/**
 * Reviews › eBay (PR G) — eBay's AI topics as tags, the revision requests in words, and "Leave feedback for buyers":
 * which picked sales a send asks for, why the button is held (permission, nothing picked, none can go, the 500-character
 * text), the button's label and the result in the server's numbers.
 */
import { describe, expect, it } from 'vitest'
import {
  MANAGE_BUYER_FEEDBACK, buyerResultWords, buyerRowHeld, buyerRowView, buyerSendHeld, buyerSendLabel, buyerSendNote, buyerSendReach,
  ebayWhere, feedbackCount, revisionSummary, revisionView, topicTags, type BuyerFeedbackRow, type EbayRevisions,
} from './ebayToolsModel'

const TZ = 'UTC'

const row = (id: string, over: Partial<BuyerFeedbackRow> = {}): BuyerFeedbackRow => ({
  id, orderLineItemId: `11${id}-22${id}`, title: 'Test gloves', price: '49.90', currency: 'EUR', buyer: 'A buyer', order: { id: `o-${id}`, label: `11${id}-22${id}` },
  market: 'IT', soldAt: '2026-10-15T10:00:00Z', daysLeft: 78, state: 'AWAITING', held: null, approval: null, left: null, lastWords: null,
  firstSeenAt: '2026-10-16T10:00:00Z', ...over,
})

describe('eBay’s AI topics', () => {
  it('shows each topic with its count, toned by what buyers mostly said', () => {
    expect(topicTags({
      read: 120, words: null,
      topics: [
        { topic: 'shipping', label: 'Shipping', count: 96, positive: 90, negative: 0, neutral: 6 },
        { topic: 'fit', label: 'Fit & sizing', count: 22, positive: 4, negative: 15, neutral: 3 },
        { topic: 'quality', label: 'Quality', count: 1, positive: 1, negative: 1, neutral: 0 },
      ],
    })).toEqual([
      { key: 'shipping', text: 'Shipping · 96', tone: 'success', title: '96 feedback mention it: 90 positive, 0 negative, 6 neutral' },
      { key: 'fit', text: 'Fit & sizing · 22', tone: 'danger', title: '22 feedback mention it: 4 positive, 15 negative, 3 neutral' },
      { key: 'quality', text: 'Quality · 1', tone: 'neutral', title: '1 feedback mentions it: 1 positive, 1 negative, 0 neutral' },
    ])
    expect(topicTags(null)).toEqual([])
  })
})

describe('revision requests', () => {
  it('says who, where, what, and what happens next', () => {
    const waiting = revisionView({ id: 'r1', buyer: 'A buyer', market: 'IT', type: 'negative', postedAt: '2026-10-20T10:00:00Z', state: 'REVISION_OPEN', words: 'Waiting for the buyer', tone: 'info', stateSince: '2026-10-24T09:00:00Z', daysLeft: null, canAsk: false }, TZ)
    expect(waiting).toEqual({
      key: 'r1', who: 'A buyer', what: 'eBay Italy · negative · left 20 Oct', pill: { words: 'Waiting for the buyer', tone: 'info' },
      note: 'The buyer has 10 days to answer (Nexus saw the request on 24 Oct). eBay changes nothing unless the buyer agrees.', canAsk: false,
    })
    const ask = revisionView({ id: 'r2', buyer: null, market: null, type: 'neutral', postedAt: '2026-10-25T10:00:00Z', state: 'ENTERED', words: 'Can be asked in Seller Hub', tone: 'warning', stateSince: null, daysLeft: 28, canAsk: true }, TZ)
    expect(ask).toMatchObject({ who: 'Buyer not named', what: 'eBay (whole account) · neutral · left 25 Oct', note: '28 days left to ask (eBay: feedback under 30 days old, once per feedback).', canAsk: true })
  })

  it('sums up the card', () => {
    const r = { counts: { waiting: 1, revised: 2, declined: 0, canAsk: 3 } } as EbayRevisions
    expect(revisionSummary(r)).toBe('1 waiting for the buyer · 3 can be asked · 2 revised')
    expect(revisionSummary({ counts: { waiting: 0, revised: 0, declined: 0, canAsk: 0 } } as EbayRevisions)).toBe('No revision requests')
  })
})

describe('leave feedback for buyers', () => {
  it('a sale in words: buyer and market from the Nexus order, else said so', () => {
    expect(buyerRowView(row('1'), TZ)).toEqual({ who: 'A buyer', where: 'eBay Italy', item: 'Test gloves', order: '111-221', when: 'Sold 15 Oct · 78 days left', status: { words: 'Ready', tone: 'neutral' } })
    expect(buyerRowView(row('2', { buyer: null, market: null, soldAt: null, daysLeft: null, order: null }), TZ)).toMatchObject({
      who: 'Buyer not in Nexus', where: 'eBay (whole account)', order: '112-222', when: 'Sale date not in Nexus (eBay still lists it)',
    })
    expect(buyerRowView(row('3', { approval: { id: 'a', words: 'Waits' } }), TZ).status).toEqual({ words: 'Waits for approval', tone: 'info' })
    expect(buyerRowView(row('4', { held: 'This order has an open return or case: leave feedback once it is closed.' }), TZ).status).toEqual({ words: 'Held', tone: 'warning' })
    expect(buyerRowView(row('5', { state: 'LEFT', left: { at: '2026-10-26T08:00:00Z', by: 'x', text: 'Great' } }), TZ).status).toEqual({ words: 'Left 26 Oct', tone: 'success' })
    expect(ebayWhere('DE')).toBe('eBay Germany')
  })

  it('a send asks only for the sales that may get feedback, and says why the others are left out', () => {
    const old = row('o', { held: 'Sold on 1 Jul 2026: eBay allows feedback for a buyer only within 90 days of the sale.' })
    expect(buyerSendReach([row('1'), old, row('2')])).toEqual({ apply: [row('1'), row('2')], skipped: [{ id: 'o', reason: old.held }] })
    expect(buyerSendNote([row('1'), old, row('2')])).toBe('One change plan with 2 sales waits on the Approvals page; eBay gets nothing until a person approves it. 1 picked sale is left out: Sold on 1 Jul 2026: eBay allows feedback for a buyer only within 90 days of the sale.')
    expect(buyerSendNote([row('1')])).toBe('One approval request waits on the Approvals page; eBay gets nothing until a person approves it.')
    expect(buyerSendLabel(1)).toBe('Send for approval')
    expect(buyerSendLabel(3)).toBe('Send 3 for approval')
  })

  it('holds the send: permission, nothing picked, none can go, then the 500-character text', () => {
    const text = 'Great buyer!'
    expect(buyerSendHeld({ canManage: false, rows: [row('1')], text })).toBe(MANAGE_BUYER_FEEDBACK)
    expect(buyerSendHeld({ canManage: true, rows: [], text })).toBe('Pick at least one sale first.')
    const waiting = row('w', { held: 'Already sent for approval: it waits on the Approvals page.' })
    expect(buyerSendHeld({ canManage: true, rows: [waiting], text })).toBe('Already sent for approval: it waits on the Approvals page.')
    expect(buyerSendHeld({ canManage: true, rows: [waiting, waiting], text })).toBe('None of the 2 picked sales can get feedback now: Already sent for approval: it waits on the Approvals page.')
    expect(buyerSendHeld({ canManage: true, rows: [row('1')], text: 'x'.repeat(501) })).toBe('Cut 1 character (eBay allows 500).')
    expect(buyerSendHeld({ canManage: true, rows: [row('1')], text: '' })).toBe('Write the feedback first.')
    expect(buyerSendHeld({ canManage: true, rows: [row('1')], text })).toBeNull()
    expect(buyerRowHeld(row('1'), false)).toBe(MANAGE_BUYER_FEEDBACK)
    expect(buyerRowHeld(waiting, true)).toBe(waiting.held)
    expect(feedbackCount('  Great buyer!  ')).toBe('12 / 500')
  })

  it('the result in the server’s numbers', () => {
    expect(buyerResultWords({ changed: 3, held: [], sent: { approvalId: 'a', kind: 'plan', lines: 3, expiresAt: null } })).toEqual({
      words: 'Sent for approval: one change plan with 3 sales. A person approves it on the Approvals page.', tone: 'success',
    })
    expect(buyerResultWords({ changed: 1, held: [{ id: 'x', words: 'This order has an open return or case: leave feedback once it is closed.' }], sent: { approvalId: 'a', kind: 'request', lines: 1, expiresAt: null } })).toEqual({
      words: 'Sent for approval. A person approves it on the Approvals page. 1 sale was not sent: This order has an open return or case: leave feedback once it is closed.', tone: 'warning',
    })
    expect(buyerResultWords({ changed: 0, held: [{ id: 'x', words: 'Already sent for approval: it waits on the Approvals page.' }], sent: null })).toEqual({ words: 'Already sent for approval: it waits on the Approvals page.', tone: 'warning' })
  })
})
