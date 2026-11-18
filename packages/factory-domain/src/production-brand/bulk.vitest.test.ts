import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { PARTNER_LIVE_EVENTS } from '../portal/notifications/live'
import { ORDER_REQUEST_KINDS } from '../sales/change-requests/rules'
import {
  askedUrgentWords,
  ASKED_WORDS,
  BATCH_ASK_KINDS,
  BULK_ASK_KINDS,
  BULK_ASK_MAX,
  bulkAskProblems,
  NONE_ASKED_WORDS,
  NOTHING_WITHDRAWN_WORDS,
  refusalCodeOf,
  WITHDRAW_OUTCOMES,
  WITHDRAW_WORDS,
  withdrawOutcomeOf,
  wordsOfMessage,
} from './bulk'
import { URGENCY_BATCH_MAX } from './urgency'

/**
 * B-PR-46a — a customer's bulk asks, the pure part (production plan §3 "Bulk asks"; R-50, R-51): the kinds (urgent is never asked
 * through Ask N), the fields checked once for every order, the codes of a refusal, Undo's outcomes, the batch event (office only),
 * and the customer's words in "voi" (fix-portal-1).
 */

const L1 = '01900000-0000-7000-8000-000000000001'
const L2 = '01900000-0000-7000-8000-000000000002'
const CANCEL_REASONS = new Map([
  ['LEAD_TIME', { needsNote: false }],
  ['OTHER', { needsNote: true }],
])

describe('B-PR-46a bulk asks: kinds and limits', () => {
  it('Ask N takes a pause, a resume or a cancel; a batch also holds "Urgent – asked" (Mark urgent); every kind is a request kind', () => {
    expect(BULK_ASK_KINDS).toEqual(['HOLD', 'RESUME', 'CANCEL'])
    expect(BULK_ASK_KINDS).not.toContain('RUSH')
    expect(BATCH_ASK_KINDS).toEqual(['RUSH', 'HOLD', 'RESUME', 'CANCEL'])
    for (const kind of BATCH_ASK_KINDS) expect(ORDER_REQUEST_KINDS as readonly string[]).toContain(kind)
    expect(BULK_ASK_MAX).toBe(50)
    expect(BULK_ASK_MAX).toBe(URGENCY_BATCH_MAX)
  })
})

describe('B-PR-46a bulkAskProblems: the fields once for every order', () => {
  it('a pause says why (no reason list is offered yet); a resume takes no code; a cancel picks a reason (and says why when it asks)', () => {
    expect(bulkAskProblems({ kind: 'HOLD', reason: 'Made-up: our shop moves.' }, CANCEL_REASONS)).toEqual([])
    expect(bulkAskProblems({ kind: 'HOLD' }, CANCEL_REASONS)).toEqual([{ path: 'body/reason', message: 'Say why you want to pause, in a few words.' }])
    expect(bulkAskProblems({ kind: 'HOLD', reasonCode: 'X', reason: 'Made-up.' }, CANCEL_REASONS)).toEqual([{ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' }])
    expect(bulkAskProblems({ kind: 'RESUME' }, CANCEL_REASONS)).toEqual([])
    expect(bulkAskProblems({ kind: 'RESUME', reasonCode: 'LEAD_TIME' }, CANCEL_REASONS)).toEqual([{ path: 'body/reasonCode', message: 'This ask takes no reason code: say it in your words.' }])
    expect(bulkAskProblems({ kind: 'CANCEL', reasonCode: 'LEAD_TIME' }, CANCEL_REASONS)).toEqual([])
    expect(bulkAskProblems({ kind: 'CANCEL' }, CANCEL_REASONS)).toEqual([{ path: 'body/reasonCode', message: 'Pick a reason.' }])
    expect(bulkAskProblems({ kind: 'CANCEL', reasonCode: '  ' }, CANCEL_REASONS)).toEqual([{ path: 'body/reasonCode', message: 'Pick a reason.' }])
    expect(bulkAskProblems({ kind: 'CANCEL', reasonCode: 'NOPE' }, CANCEL_REASONS)).toEqual([{ path: 'body/reasonCode', message: 'Pick one of the reasons offered.' }])
    expect(bulkAskProblems({ kind: 'CANCEL', reasonCode: 'OTHER' }, CANCEL_REASONS)).toEqual([{ path: 'body/reason', message: 'Say why in a few words.' }])
    expect(bulkAskProblems({ kind: 'CANCEL', reasonCode: 'OTHER', reason: 'Made-up: the event was called off.' }, CANCEL_REASONS)).toEqual([])
    expect(bulkAskProblems({ kind: 'RESUME', reason: 'x'.repeat(2001) }, CANCEL_REASONS)).toEqual([{ path: 'body/reason', message: 'At most 2000 characters.' }])
  })
})

describe('B-PR-46a the codes of a refusal and Undo', () => {
  it('a code at the end of a path; a field path names none', () => {
    expect(refusalCodeOf([{ path: 'body/WAITING', message: 'x' }])).toBe('WAITING')
    expect(refusalCodeOf([{ path: 'body/cells/0/LEATHER_CUT', message: 'x' }])).toBe('LEATHER_CUT')
    expect(refusalCodeOf([{ path: 'body/requestedDate', message: 'x' }])).toBeNull()
    expect(refusalCodeOf(undefined)).toBeNull()
    expect(wordsOfMessage('The order moved on.')).toEqual({ it: 'The order moved on.', en: 'The order moved on.' })
    expect(wordsOfMessage('  ').en).toBe('This could not be asked for this order.')
  })

  it("Undo withdraws only what waits for our answer; the rest stays, in words", () => {
    expect(WITHDRAW_OUTCOMES.map((outcome) => outcome)).toEqual(['WITHDRAWN', 'ANSWERED', 'ALREADY', 'COUNTERED'])
    expect(withdrawOutcomeOf('OPEN')).toBe('WITHDRAWN')
    expect(withdrawOutcomeOf('COUNTERED')).toBe('COUNTERED')
    expect(withdrawOutcomeOf('WITHDRAWN')).toBe('ALREADY')
    expect(withdrawOutcomeOf('ACCEPTED')).toBe('ANSWERED')
    expect(withdrawOutcomeOf('REFUSED')).toBe('ANSWERED')
  })
})

describe('B-PR-46a the customer’s words address it with "voi"', () => {
  it('"Urgent – asked" says why it was asked and that we answer; every portal word in voi, never tu', () => {
    expect(askedUrgentWords('CUT', 3)).toEqual({ it: 'Il taglio di questo ordine è iniziato: inviato a noi come «Urgente – richiesto»: vi rispondiamo noi.', en: 'Cutting has started on this order: sent to us as "Urgent – asked": we answer you.' })
    expect(askedUrgentWords('OVER_QUOTA', 3).en).toBe('You have used your 3 urgent marks: sent to us as "Urgent – asked": we answer you.')
    expect(askedUrgentWords('OVER_QUOTA', 1).it).toBe('Avete già usato la vostra urgenza: inviato a noi come «Urgente – richiesto»: vi rispondiamo noi.')
    expect(askedUrgentWords('OVER_QUOTA', 0).en).toBe('Urgent marks on your orders are asked of us: sent to us as "Urgent – asked": we answer you.')
    const portal = [askedUrgentWords('CUT', 3), askedUrgentWords('OVER_QUOTA', 0), askedUrgentWords('OVER_QUOTA', 1), askedUrgentWords('OVER_QUOTA', 4), ASKED_WORDS, NONE_ASKED_WORDS, NOTHING_WITHDRAWN_WORDS, ...Object.values(WITHDRAW_WORDS)]
    for (const words of portal) expect(words.it, words.it).not.toMatch(/\b(tu|tuo|tua|tuoi|tue|ti|hai|puoi|scrivici|chiedilo)\b/i)
  })
})

describe('B-PR-46a the batch event (office only) and the asked event naming its batch', () => {
  it('order_change_request.batch_asked: strict, the office live rule, no partner entry; asked takes its batch or none', () => {
    const batch = EVENT_CATALOGUE.find('order_change_request.batch_asked', 1)
    expect(batch?.live).toMatchObject({ permission: 'orders.view', fields: ['batchId', 'kind', 'count'] })
    expect(PARTNER_LIVE_EVENTS['order_change_request.batch_asked']).toBeUndefined()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.batch_asked', 1, { batchId: L1, partyId: L2, kind: 'HOLD', count: 2 })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.batch_asked', 1, { batchId: L1, partyId: L2, kind: 'SAMPLE_ROUND', count: 2 })).toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.batch_asked', 1, { batchId: L1, partyId: L2, kind: 'RUSH', count: 0 })).toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.batch_asked', 1, { batchId: L1, partyId: L2, kind: 'RUSH', count: 1, orderIds: [L1] })).toThrow()
    const asked = { requestId: L1, orderId: L2, partyId: L1, kind: 'HOLD', lines: 0, wholeOrder: false }
    expect(() => EVENT_CATALOGUE.parse('order_change_request.asked', 1, asked)).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.asked', 1, { ...asked, batchId: L2 })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.asked', 1, { ...asked, batchId: 'not-a-batch' })).toThrow()
  })
})
