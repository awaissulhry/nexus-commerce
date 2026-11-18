import { describe, expect, it } from 'vitest'
import { APPROVAL_KINDS, APPROVAL_DECISIONS } from '../approvals-out/kinds'
import { DECIDED_MESSAGE_KEYS, kindOf } from '../notifications/preferences/preferences'
import { MESSAGE_TEMPLATES, sentenceOf, type MessageKey } from '../notifications/rules'
import { ORDER_REQUEST_KINDS } from '../sales/change-requests/rules'
import { BATCH_ASK_KINDS } from './bulk'
import { URGENCY_CHANGES } from './events'
import {
  APPROVAL_OFFICE_KEYS,
  approvalOfficeNotice,
  ASK_CANCEL_LINES_KEY,
  ASK_OFFICE_KEYS,
  askOfficeNotice,
  BATCH_ASK_OFFICE_KEYS,
  batchAskOfficeNotice,
  COUNTER_OFFICE_KEYS,
  counterOfficeNotice,
  CUSTOMER_APPROVAL_RECORDS,
  mayTellApproval,
  OFFICE_DECIDED_KEYS,
  REFUSED_NEW_DATE_KEY,
  REFUSED_TOP_KEY,
  URGENCY_OFFICE_KEYS,
  urgencyOfficeNotice,
  WITHDRAWN_OFFICE_KEYS,
  withdrawnOfficeNotice, // fix-pr-4: the test used it without its import
} from './office-notices'

/**
 * B-PR-32 — which customer act makes which office notice, and its words (production plan §1 "Full control", §3; L15, R-43, R-51,
 * R-60; Appendix C "a TOP refusal tells the office"). Pure: the API's fan-out rule (platform/notifications/rules/brand-production.ts)
 * reads the records and decides who is told; brand-notices.pg.vitest.test.ts there runs it on the local stack.
 */

const mark = { by: 'BRAND', change: 'MARK', urgency: 'URGENT', undo: false, asked: false } as const

/** Every office notice key of this step (its words and placeholders are checked once for all). */
const ALL_KEYS: readonly MessageKey[] = [
  ...Object.values(URGENCY_OFFICE_KEYS).flatMap((entry): MessageKey[] => (typeof entry === 'string' ? [entry] : [entry.one, entry.many])),
  ...Object.values(ASK_OFFICE_KEYS),
  ASK_CANCEL_LINES_KEY,
  ...Object.values(BATCH_ASK_OFFICE_KEYS),
  WITHDRAWN_OFFICE_KEYS.one,
  WITHDRAWN_OFFICE_KEYS.many,
  ...Object.values(COUNTER_OFFICE_KEYS),
  ...Object.values(APPROVAL_OFFICE_KEYS).flatMap((answers): MessageKey[] => [answers.APPROVED, answers.APPROVED_WITH_CHANGES, answers.REFUSED]),
  REFUSED_TOP_KEY,
  REFUSED_NEW_DATE_KEY,
]

describe('B-PR-32 which customer act the factory is told of', () => {
  it('urgency: only the customer’s own acts — a mark (urgent, regular), a new order of its urgent list, an undo; never ours, never our yes to its ask', () => {
    expect(urgencyOfficeNotice(mark, 1)).toEqual({ key: 'notifications.production.customerUrgent', category: 'FOLLOWING' })
    expect(urgencyOfficeNotice(mark, 3)).toEqual({ key: 'notifications.production.customerUrgentMany', category: 'FOLLOWING' })
    expect(urgencyOfficeNotice({ ...mark, urgency: 'REGULAR' }, 1)?.key).toBe('notifications.production.customerRegular')
    expect(urgencyOfficeNotice({ ...mark, urgency: 'REGULAR' }, 2)?.key).toBe('notifications.production.customerRegularMany')
    expect(urgencyOfficeNotice({ ...mark, change: 'ORDER' }, 4)?.key).toBe('notifications.production.customerReordered')
    expect(urgencyOfficeNotice({ ...mark, undo: true }, 1)?.key).toBe('notifications.production.customerUndid')
    expect(urgencyOfficeNotice({ ...mark, undo: true, urgency: 'REGULAR' }, 2)?.key).toBe('notifications.production.customerUndidMany')
    // Ours: set back, locked, unlocked, our mark — and our yes to its "Urgent – asked" (its answer tells the customer, not this).
    for (const change of URGENCY_CHANGES) expect(urgencyOfficeNotice({ ...mark, by: 'FACTORY', change }, 1), change).toBeNull()
    expect(urgencyOfficeNotice({ ...mark, asked: true }, 1)).toBeNull()
    // A customer never sets back, locks or unlocks; nothing to tell of no order.
    for (const change of ['SET_BACK', 'LOCK', 'UNLOCK'] as const) expect(urgencyOfficeNotice({ ...mark, change }, 1)).toBeNull()
    expect(urgencyOfficeNotice(mark, 0)).toBeNull()
  })

  it('an ask of one order: every kind its own words (a cancel of some lines too), waiting for our answer (APPROVAL)', () => {
    expect(Object.keys(ASK_OFFICE_KEYS).sort()).toEqual([...ORDER_REQUEST_KINDS].sort())
    for (const kind of ORDER_REQUEST_KINDS) expect(askOfficeNotice(kind, true)).toEqual({ key: ASK_OFFICE_KEYS[kind], category: 'APPROVAL' })
    expect(askOfficeNotice('CANCEL', false).key).toBe(ASK_CANCEL_LINES_KEY)
    expect(askOfficeNotice('HOLD', false).key).toBe(ASK_OFFICE_KEYS.HOLD)
    expect(kindOf({ category: 'APPROVAL', messageKey: ASK_OFFICE_KEYS.RUSH })).toBe('APPROVAL_WAITING')
  })

  it('a bulk ask: ONE notice per batch, "asks to pause 12 orders"; a batch of one reads as an ask of one order; none: nothing', () => {
    expect(Object.keys(BATCH_ASK_OFFICE_KEYS).sort()).toEqual([...BATCH_ASK_KINDS].sort())
    for (const kind of BATCH_ASK_KINDS) {
      expect(batchAskOfficeNotice(kind, 12)).toEqual({ key: BATCH_ASK_OFFICE_KEYS[kind], category: 'APPROVAL' })
      expect(batchAskOfficeNotice(kind, 1)).toEqual({ key: ASK_OFFICE_KEYS[kind], category: 'APPROVAL' })
      expect(batchAskOfficeNotice(kind, 0)).toBeNull()
    }
  })

  it('withdrawn (one, or a batch’s Undo once) and our counter-offer answered: decisions — except its yes, which waits for our accept', () => {
    expect(withdrawnOfficeNotice(1)).toEqual({ key: WITHDRAWN_OFFICE_KEYS.one, category: 'APPROVAL' })
    expect(withdrawnOfficeNotice(5)).toEqual({ key: WITHDRAWN_OFFICE_KEYS.many, category: 'APPROVAL' })
    expect(withdrawnOfficeNotice(0)).toBeNull()
    expect(counterOfficeNotice('ACCEPTED').key).toBe('notifications.production.customerCounterAccepted')
    expect(counterOfficeNotice('REFUSED').key).toBe('notifications.production.customerCounterRefused')
    expect(kindOf({ category: 'APPROVAL', messageKey: WITHDRAWN_OFFICE_KEYS.many })).toBe('APPROVAL_DECIDED')
    expect(kindOf({ category: 'APPROVAL', messageKey: COUNTER_OFFICE_KEYS.REFUSED })).toBe('APPROVAL_DECIDED')
    expect(kindOf({ category: 'APPROVAL', messageKey: COUNTER_OFFICE_KEYS.ACCEPTED })).toBe('APPROVAL_WAITING')
  })

  it('an answered approval: the customer’s production approvals (PP, size set, top of production, fabric, trims), a refused TOP, a refused new date — nothing else', () => {
    const round = (sampleKind: string, status: (typeof APPROVAL_DECISIONS)[number]) => approvalOfficeNotice({ kind: 'SAMPLE', recordType: 'SampleRound', sampleKind, status })
    expect(round('PRE_PRODUCTION', 'APPROVED')?.key).toBe(APPROVAL_OFFICE_KEYS.SAMPLE.APPROVED)
    expect(round('SIZE_SET', 'APPROVED_WITH_CHANGES')?.key).toBe(APPROVAL_OFFICE_KEYS.SAMPLE.APPROVED_WITH_CHANGES)
    expect(round('PRE_PRODUCTION', 'REFUSED')?.key).toBe(APPROVAL_OFFICE_KEYS.SAMPLE.REFUSED)
    expect(round('TOP_OF_PRODUCTION', 'APPROVED')?.key).toBe(APPROVAL_OFFICE_KEYS.SAMPLE.APPROVED)
    // Appendix C: TOP gates nothing; its refusal tells the office (quality decides).
    expect(round('TOP_OF_PRODUCTION', 'REFUSED')).toEqual({ key: REFUSED_TOP_KEY, category: 'APPROVAL' })
    // Development samples are not production approvals.
    for (const kind of ['PROTO', 'FIT', 'SALESMAN', 'CERTIFICATION', 'BRAND']) expect(round(kind, 'REFUSED'), kind).toBeNull()
    for (const status of APPROVAL_DECISIONS) {
      expect(approvalOfficeNotice({ kind: 'FABRIC', recordType: 'SampleSwatch', sampleKind: null, status })?.key).toBe(APPROVAL_OFFICE_KEYS.FABRIC[status])
      expect(approvalOfficeNotice({ kind: 'TRIM', recordType: 'Style', sampleKind: null, status })?.key).toBe(APPROVAL_OFFICE_KEYS.TRIM[status])
      // A supplier's lab dip or a workshop's sample is never a customer's approval.
      expect(approvalOfficeNotice({ kind: 'FABRIC', recordType: 'PurchaseOrder', sampleKind: null, status })).toBeNull()
      expect(approvalOfficeNotice({ kind: 'TRIM', recordType: 'SubcontractOrder', sampleKind: null, status })).toBeNull()
      // A counter-offer's answer is order_change_request.counter_answered's.
      expect(approvalOfficeNotice({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', sampleKind: null, status })).toBeNull()
    }
    // A new date: only its refusal (the date stands; the office acts).
    expect(approvalOfficeNotice({ kind: 'REPROMISE', recordType: 'SalesOrder', sampleKind: null, status: 'REFUSED' })).toEqual({ key: REFUSED_NEW_DATE_KEY, category: 'APPROVAL' })
    expect(approvalOfficeNotice({ kind: 'REPROMISE', recordType: 'SalesOrder', sampleKind: null, status: 'APPROVED' })).toBeNull()
    // Every other kind never tells here (artwork, proofs, colours, leathers, concessions, revised orders, signatures).
    for (const kind of APPROVAL_KINDS.filter((entry) => !['SAMPLE', 'FABRIC', 'TRIM', 'REPROMISE'].includes(entry))) {
      for (const recordType of [...CUSTOMER_APPROVAL_RECORDS, 'NcrConcession', 'SalesOrderAmendment', 'SalesOrderLine', 'RiskAssessmentVersion']) {
        for (const status of APPROVAL_DECISIONS) expect(approvalOfficeNotice({ kind, recordType, sampleKind: 'PRE_PRODUCTION', status }), `${kind} ${recordType}`).toBeNull()
      }
    }
    // The cheap check before the round is read.
    expect(mayTellApproval({ kind: 'SAMPLE', recordType: 'SampleRound', status: 'REFUSED' })).toBe(true)
    expect(mayTellApproval({ kind: 'SAMPLE', recordType: 'Style', status: 'REFUSED' })).toBe(false)
    expect(mayTellApproval({ kind: 'ARTWORK', recordType: 'SalesOrder', status: 'REFUSED' })).toBe(false)
    expect(mayTellApproval({ kind: 'REPROMISE', recordType: 'SalesOrder', status: 'APPROVED' })).toBe(false)
  })
})

describe('B-PR-32 the words', () => {
  it('every sentence in English and Italian with the same placeholders; it names the customer, never a person ({actor})', () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length)
    for (const key of ALL_KEYS) {
      const words = MESSAGE_TEMPLATES[key]
      expect(words.en, key).toContain('{customer}')
      expect(words.en, key).toContain('{record}')
      expect(words.en, key).not.toContain('{actor}')
      expect(words.en.match(/\{\w+\}/g)?.sort(), key).toEqual(words.it.match(/\{\w+\}/g)?.sort())
      // Office words: "Customer"; the Italian never "Responsabile di produzione" (the production manager's role).
      expect(words.it, key).not.toMatch(/Responsabile di produzione/)
    }
  })

  it('the decisions are the matrix’s "approval decided"; the asks "approval waiting"', () => {
    for (const key of OFFICE_DECIDED_KEYS) expect(DECIDED_MESSAGE_KEYS.has(key), key).toBe(true)
    for (const key of [...Object.values(ASK_OFFICE_KEYS), ASK_CANCEL_LINES_KEY, ...Object.values(BATCH_ASK_OFFICE_KEYS), COUNTER_OFFICE_KEYS.ACCEPTED]) expect(DECIDED_MESSAGE_KEYS.has(key), key).toBe(false)
  })

  it('reads as the office reads it: the customer, our number, how many', () => {
    const base = { recordLabel: 'SO-0042', actorId: null }
    const names = new Map<string, string>()
    expect(sentenceOf({ ...base, messageKey: 'notifications.production.customerUrgentMany', params: { customer: 'Brand Alpha', count: 3 } }, names, 'en')).toBe('Brand Alpha marked 3 orders urgent, among them SO-0042')
    expect(sentenceOf({ ...base, messageKey: 'notifications.production.customerAskedHoldMany', params: { customer: 'Brand Alpha', count: 12 } }, names, 'it')).toBe('Brand Alpha chiede di mettere in pausa 12 ordini, tra cui SO-0042: rispondi in Approvazioni')
    expect(sentenceOf({ ...base, recordLabel: 'SMP-0007', messageKey: REFUSED_TOP_KEY, params: { customer: 'Brand Alpha' } }, names, 'en')).toBe('Brand Alpha refused the top-of-production sample SMP-0007: it holds nothing back, quality decides what happens next')
    expect(sentenceOf({ ...base, messageKey: REFUSED_NEW_DATE_KEY, params: { customer: 'Brand Alpha' } }, names, 'it')).toBe('Brand Alpha ha rifiutato la nuova data dell’ordine SO-0042: la data resta, ora tocca a noi')
  })
})
