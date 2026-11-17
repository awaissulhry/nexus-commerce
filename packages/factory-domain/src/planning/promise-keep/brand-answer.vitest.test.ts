import { describe, expect, it } from 'vitest'
import { KIND_RULES } from '../../approvals-out/kinds'
import { answerProblems } from '../../approvals-out/rules'
import { customerAnswerOf, DATE_STANDS_WORDS, refusalTaskOf, repromiseFactsOf, repromiseHeld, repromiseQuestion, type RepromiseFacts } from './brand-answer'

/**
 * B-PR-28 — the customer answers a new promise date, pure (production plan §3 "accept or refuse a new date", "A brand's 'no' to a
 * new date does not undo the date"; 08-backend §4.3; wall test PW-P05, pure part). The database half (the ask with the accept,
 * the portal answer, the follow-up and waiting on us, another customer's 404) is
 * apps/factory-api modules/planning/promise-keep/repromise-brand.pg.vitest.test.ts.
 */

const FACTS: RepromiseFacts = {
  orderNumber: 'SO-2026-0042',
  customerRef: 'PO-ALPHA-7',
  lineSeq: 10,
  style: { code: 'JKT-01', name: 'Made-up jacket' },
  colourway: { code: 'BLK', name: 'Black' },
  sizes: [
    { size: '50', from: '2026-12-04', to: '2026-12-11' },
    { size: '52', from: null, to: '2026-12-18' },
  ],
  reasonCode: 'MATERIAL_LATE',
}

describe('B-PR-28 the question of a new date', () => {
  it('names the order, its reference, the line, each size from → to, the reason in its words and that the date stands', () => {
    const en = repromiseQuestion(FACTS, 'en')
    expect(en).toContain('New date for order SO-2026-0042 (your reference PO-ALPHA-7), line 10 – JKT-01 Made-up jacket BLK')
    expect(en).toContain('Size 50: 4 December 2026 → 11 December 2026; Size 52: 18 December 2026.')
    expect(en).toMatch(/Reason: .+\./)
    expect(en.endsWith(DATE_STANDS_WORDS.en)).toBe(true)
    const it_ = repromiseQuestion(FACTS, 'it')
    expect(it_).toContain("Nuova data per l'ordine SO-2026-0042 (vostro riferimento PO-ALPHA-7), riga 10")
    expect(it_).toContain('Taglia 50: 4 dicembre 2026 → 11 dicembre 2026')
    expect(it_.endsWith(DATE_STANDS_WORDS.it)).toBe(true)
    // An unknown reason code reads as planning's, never as the code.
    expect(repromiseQuestion({ ...FACTS, reasonCode: 'NOT-A-CODE' }, 'en')).not.toContain('NOT-A-CODE')
  })

  it('wall (PW-P05, pure): the page shows the order’s own dates only — no load, no lane, no other order or customer', () => {
    const facts = repromiseFactsOf(FACTS, 'en')
    expect(facts.map((fact) => fact.label)).toEqual(['Order', 'Line', 'Size 50', 'Size 52', 'Reason', 'Please note'])
    expect(JSON.stringify(facts)).not.toMatch(/minutes|\blane|\bload\b|capacity|SO-2026-0043/i)
    expect(repromiseFactsOf({ ...FACTS, colourway: null, customerRef: null }, 'it')[0]).toEqual({ label: 'Ordine', value: 'SO-2026-0042' })
  })

  it('is accepted as it stands or refused with words (never "with changes"); the kind asks on a sales order', () => {
    expect(KIND_RULES.REPROMISE).toMatchObject({ recordTypes: ['SalesOrder'], withChanges: false, task: 'APPROVE' })
    expect(answerProblems({ kind: 'REPROMISE', decision: 'REFUSED', answer: '', typedName: 'Anna Rossi' }).map((issue) => issue.path)).toEqual(['body/answer'])
    expect(answerProblems({ kind: 'REPROMISE', decision: 'APPROVED', answer: null, typedName: 'Anna Rossi' })).toEqual([])
  })
})

describe('B-PR-28 the answer', () => {
  it('reads as the office’s proposal shows it', () => {
    expect(customerAnswerOf('OPEN')).toBe('WAITING')
    expect(customerAnswerOf('APPROVED')).toBe('ACCEPTED')
    expect(customerAnswerOf('APPROVED_WITH_CHANGES')).toBe('ACCEPTED')
    expect(customerAnswerOf('REFUSED')).toBe('REFUSED')
    expect(customerAnswerOf('WITHDRAWN')).toBe('WITHDRAWN')
    expect(customerAnswerOf('EXPIRED')).toBe('EXPIRED')
  })

  it('an open question is held once the order no longer waits or the date moved again, in the reader’s words', () => {
    expect(repromiseHeld({ orderOpen: true, movedSince: false }, 'en')).toBeNull()
    expect(repromiseHeld({ orderOpen: true, movedSince: true }, 'en')).toBe('The date changed again: we ask you about the newest one.')
    expect(repromiseHeld({ orderOpen: false, movedSince: true }, 'it')).toBe('Questo ordine non attende più la vostra risposta.')
  })

  it('a refusal leaves the date standing and opens a task for us with their words', () => {
    const task = refusalTaskOf({ orderNumber: 'SO-2026-0042', lineSeq: 10, sizes: FACTS.sizes, answer: '  Too late for our shop opening.  ' })
    expect(task.title).toBe('The customer did not accept the new date: SO-2026-0042 line 10')
    expect(task.description).toContain('50: 2026-12-11; 52: 2026-12-18')
    expect(task.description).toContain('Their words: “Too late for our shop opening.”')
    expect(task.description).toContain('The date stands.')
    expect(refusalTaskOf({ orderNumber: 'SO-1', lineSeq: 20, sizes: [{ size: null, from: null, to: '2026-12-01' }], answer: null }).description).not.toContain('Their words')
  })
})
