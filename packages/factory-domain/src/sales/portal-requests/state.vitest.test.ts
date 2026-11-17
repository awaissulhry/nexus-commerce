import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '../customer-numbers'
import { partnerSentence } from '../../portal/notifications/messages'
import { requestProblems, requestTextOf, subjectOf } from './rules'
import { isOpenRequest, PORTAL_REQUEST_STATES, REQUEST_STATE_WORDS, requestStateOf } from './state'

/** B-TH-010/011/105: the customer's request, its state from the real states, its own numbers (pure). */

describe('the state the customer reads (B-TH-011, R-01)', () => {
  const state = (status: Parameters<typeof requestStateOf>[0]['status'], quoteStatus: string | null = null, orderStatus: string | null = null) => requestStateOf({ status, quoteStatus, orderStatus })

  it('follows the request, then its quote, then its order — never "Quote sent" for a draft', () => {
    expect(state('NEW')).toBe('SENT')
    expect(state('ASSIGNED')).toBe('BEING_REVIEWED')
    expect(state('NEED_INFO')).toBe('NEED_INFO')
    expect(state('DECLINED')).toBe('DECLINED')
    expect(state('LOST')).toBe('CLOSED')
    for (const draft of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED']) expect(state('QUOTED', draft)).toBe('QUOTE_BEING_PREPARED')
    expect(state('QUOTED', null)).toBe('QUOTE_BEING_PREPARED')
    expect(state('QUOTED', 'SENT')).toBe('QUOTE_SENT')
    expect(state('QUOTED', 'ACCEPTED')).toBe('QUOTE_ACCEPTED')
    for (const ended of ['DECLINED', 'EXPIRED', 'CANCELLED']) expect(state('QUOTED', ended)).toBe('CLOSED')
    expect(state('QUOTED', 'ACCEPTED', 'PENDING_APPROVAL')).toBe('ORDER_WAITING')
    for (const going of ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'CLOSED']) expect(state('QUOTED', 'ACCEPTED', going)).toBe('ORDER_CONFIRMED')
    expect(state('QUOTED', 'ACCEPTED', 'CANCELLED')).toBe('CLOSED')
  })

  it('reads “Not an order” as Closed, every other decline as Declined (B-TH-043)', () => {
    expect(requestStateOf({ status: 'DECLINED', quoteStatus: null, orderStatus: null, declineReason: 'NOT_AN_ORDER' })).toBe('CLOSED')
    for (const declineReason of ['PRICE', 'CAPACITY', 'OTHER', null]) expect(requestStateOf({ status: 'DECLINED', quoteStatus: null, orderStatus: null, declineReason })).toBe('DECLINED')
    expect(REQUEST_STATE_WORDS.CLOSED.en).toBe('Closed')
  })

  it('reads the order made straight from the request by its own state (B-TH-022)', () => {
    expect(state('ORDERED', null, 'PENDING_APPROVAL')).toBe('ORDER_WAITING')
    for (const going of ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'CLOSED']) expect(state('ORDERED', null, going)).toBe('ORDER_CONFIRMED')
    expect(state('ORDERED', null, 'CANCELLED')).toBe('CLOSED')
  })

  it('has words in both languages for every state; open up to an order waiting for its yes', () => {
    for (const code of PORTAL_REQUEST_STATES) expect(REQUEST_STATE_WORDS[code].en.length * REQUEST_STATE_WORDS[code].it.length, code).toBeGreaterThan(0)
    expect(PORTAL_REQUEST_STATES.filter(isOpenRequest)).toEqual(['SENT', 'BEING_REVIEWED', 'NEED_INFO', 'QUOTE_BEING_PREPARED', 'QUOTE_SENT', 'QUOTE_ACCEPTED', 'ORDER_WAITING'])
    expect(REQUEST_STATE_WORDS.NEED_INFO.en).toBe('We need something from you')
  })
})

describe('the words the customer sends (B-TH-010)', () => {
  it('takes the first line as the subject when none is typed, cut at 200 characters', () => {
    expect(subjectOf('  Team jackets  ', 'x')).toBe('Team jackets')
    expect(subjectOf(null, '\n\n  Ten rain covers\nmore')).toBe('Ten rain covers')
    expect(subjectOf('', 'a'.repeat(250))).toHaveLength(200)
    expect(subjectOf('', 'a'.repeat(250)).endsWith('…')).toBe(true)
  })

  it('keeps the message as written after its subject; no subject twice', () => {
    expect(requestTextOf('Team jackets', 'Thirty, black.')).toBe('Team jackets\n\nThirty, black.')
    expect(requestTextOf('Team jackets', 'Team jackets\nThirty.')).toBe('Team jackets\nThirty.')
    expect(requestTextOf(null, 'Thirty, black.  \n')).toBe('Thirty, black.')
  })

  it('refuses an empty message, a past day and words over 20 000 characters together', () => {
    expect(requestProblems({ message: ' ' }, '2026-11-17').map((issue) => issue.path)).toEqual(['body/message'])
    expect(requestProblems({ message: 'ok', wantedDate: '2026-11-16' }, '2026-11-17').map((issue) => issue.path)).toEqual(['body/wantedDate'])
    expect(requestProblems({ subject: 'S', message: 'x'.repeat(19_999) }, '2026-11-17').map((issue) => issue.path)).toEqual(['body/message'])
    expect(requestProblems({ message: 'ok', wantedDate: '2026-11-17' }, '2026-11-17')).toEqual([])
  })
})

describe("a request's news in the customer's language (B-TH-011)", () => {
  // th2-backend step 7 (threads plan §0.5, counts do not leak): the customer's own number only, never the office's series.
  it('names the customer’s own number only — never the office number, never an office person', () => {
    const notice = (messageKey: string, yourSeq: number | null) => ({ messageKey, recordLabel: yourSeq === null ? '—' : `#${yourSeq}`, params: { yourKind: 'REQUEST', yourSeq } }) as never
    expect(partnerSentence(notice('portal.request.received', 7), 'en', 'Seed A')).toBe('We received your request 7')
    expect(partnerSentence(notice('portal.request.need_info', 7), 'it', 'Seed A')).toBe('Ci serve qualcosa da voi per la vostra richiesta 7')
    expect(partnerSentence(notice('portal.request.declined', 7), 'it', 'Seed A')).toBe('La vostra richiesta 7 non è stata accettata')
    for (const key of ['portal.request.received', 'portal.request.need_info', 'portal.request.declined']) expect(partnerSentence(notice(key, 7), 'en', 'Seed A')).not.toMatch(/INQ-/)
  })
})

describe("each customer's own numbers (B-TH-105)", () => {
  it('says "Your request 7" in both languages, nothing without a number', () => {
    expect(customerNumberOf('REQUEST', 7)).toEqual({ seq: 7, words: { en: 'Your request 7', it: 'La vostra richiesta 7' } })
    expect(customerNumberOf('ORDER', 12)?.words.en).toBe('Your order 12')
    expect(customerNumberOf('QUOTE', 3)?.words.it).toBe('Il vostro preventivo 3')
    expect(customerNumberOf('REQUEST', null)).toBeNull()
    expect(customerNumberOf('REQUEST', 0)).toBeNull()
  })
})
