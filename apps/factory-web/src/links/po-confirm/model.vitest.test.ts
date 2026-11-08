import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { lineDraftHasProblems, lineDraftProblems } from '@nexus/ui/patterns/LineResponseList/index'
import { ANSWER_OUTCOMES, DECLINE_REASONS, planAnswer, type LineAnswerKind } from '@nexus/factory-domain/purchasing/confirm/answer'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { lineBodyOf, parseQuantityIn } from '../../lib/po-answer/lines'
import { answeredKey, answerPreview, askedOf, confirmBody, dayIn, declineHeld, initialModel, pdfProblem, plainQuantity, PROBLEMS, quantityShown, reduce, sendHeld, type LineDraft, type PoConfirmViewModel } from './model'

const TODAY = '2026-10-30'
const base = designScreen.cases.find((item) => item.id === 'open')!.model
const page = base.page!
const [leather, lining, protectors] = page.lines as [(typeof page.lines)[number], (typeof page.lines)[number], (typeof page.lines)[number]]

const draft = (patch: Partial<LineDraft> & Pick<LineDraft, 'kind'>): LineDraft => ({
  quantity: '',
  date: '',
  deliveries: [
    { quantity: '', date: '' },
    { quantity: '', date: '' },
  ],
  reason: '',
  ...patch,
})

/** The API's own rule for one line (planAnswer's ValidationError or not): the link takes W1's four answers. */
const apiTakes = (line: typeof leather, answer: LineDraft) => {
  try {
    const body = lineBodyOf(line.id, answer, 'it')
    planAnswer([{ id: line.id, seq: line.seq, quantity: line.quantity, uom: line.uom, needDate: line.needDate }], { mode: 'BY_LINE', lines: [{ ...body, answer: body.answer as LineAnswerKind }] }, TODAY)
    return true
  } catch {
    return false
  }
}

describe('quantities as people type them', () => {
  it('reads Italian and English numbers into the API’s plain form', () => {
    expect(plainQuantity('1.200,5', 'it')).toBe('1200.5')
    expect(plainQuantity('1200,5', 'it')).toBe('1200.5')
    expect(plainQuantity('1.200', 'it')).toBe('1200')
    expect(plainQuantity('1,200.5', 'en')).toBe('1200.5')
    expect(plainQuantity(' 350 ', 'en')).toBe('350')
    expect(plainQuantity('abc', 'en')).toBeNull()
    expect(plainQuantity('', 'it')).toBeNull()
    expect(plainQuantity('-3', 'en')).toBeNull()
  })

  it('shows the API’s four places without trailing zeros, in the reader’s language', () => {
    // Italian groups from five digits (CLDR): 1200, 12.000.
    expect(quantityShown('1200.0000', 'it')).toBe('1200')
    expect(quantityShown('12000.0000', 'it')).toBe('12.000')
    expect(quantityShown('1200.5000', 'en')).toBe('1,200.5')
    expect(quantityShown('12.2500', 'it')).toBe('12,25')
  })

  it('counts the supplier’s today in Rome, as the API does', () => {
    expect(dayIn(new Date('2026-10-30T22:30:00Z'))).toBe('2026-10-30')
    expect(dayIn(new Date('2026-10-30T23:30:00Z'))).toBe('2026-10-31')
  })
})

describe('a line’s answer: the DS part’s checks are the API’s rule (B-W2b-179: the link answers with LineResponseList)', () => {
  const cases: [string, typeof leather, LineDraft][] = [
    ['other: a later date with a reason', leather, draft({ kind: 'OTHER', quantity: '1.200', date: '2026-11-28', reason: 'Concia' })],
    ['other: less, same date', lining, draft({ kind: 'OTHER', quantity: '300', date: '', reason: 'Stock' })],
    ['other: no reason', leather, draft({ kind: 'OTHER', quantity: '1200', date: '2026-11-28', reason: '' })],
    ['other: nothing given', leather, draft({ kind: 'OTHER', reason: 'x' })],
    ['other: what was asked', lining, draft({ kind: 'OTHER', quantity: '350', date: '2026-11-10', reason: 'x' })],
    ['other: a past date', leather, draft({ kind: 'OTHER', date: '2026-10-01', reason: 'x' })],
    ['other: too far', leather, draft({ kind: 'OTHER', date: '2029-01-01', reason: 'x' })],
    ['other: zero', leather, draft({ kind: 'OTHER', quantity: '0', reason: 'x' })],
    ['other: five decimals', leather, draft({ kind: 'OTHER', quantity: '1,12345', reason: 'x' })],
    ['split: two days', leather, draft({ kind: 'SPLIT', deliveries: [{ quantity: '700', date: '2026-11-14' }, { quantity: '500', date: '2026-11-28' }], reason: 'x' })],
    ['split: one day', leather, draft({ kind: 'SPLIT', deliveries: [{ quantity: '700', date: '2026-11-14' }, { quantity: '500', date: '2026-11-14' }], reason: 'x' })],
    ['split: a missing quantity', leather, draft({ kind: 'SPLIT', deliveries: [{ quantity: '700', date: '2026-11-14' }, { quantity: '', date: '2026-11-28' }], reason: 'x' })],
    ['cannot: with a reason', protectors, draft({ kind: 'CANNOT', reason: 'Fuori produzione' })],
    ['cannot: without', protectors, draft({ kind: 'CANNOT', reason: '  ' })],
    ['as asked', lining, draft({ kind: 'AS_ASKED' })],
  ]
  for (const [label, line, answer] of cases) {
    it(label, () => {
      const problems = lineDraftProblems(askedOf(line), answer, { today: TODAY, parseQuantity: parseQuantityIn('it') })
      // As asked is never answered "with problems"; every other draft: the part holds exactly what the API refuses.
      expect(answer.kind === 'AS_ASKED' ? false : lineDraftHasProblems(problems), JSON.stringify(problems)).toBe(answer.kind === 'AS_ASKED' ? false : !apiTakes(line, answer))
    })
  }
})

describe('the whole answer', () => {
  it('nothing changed: confirm all as asked', () => {
    const preview = answerPreview(page, {}, TODAY, 'it')!
    expect(preview).toMatchObject({ mode: 'ALL_AS_ASKED', outcome: 'CONFIRMED' })
    expect(preview.summary).toEqual([{ key: 'allAsAsked', count: 3 }])
    expect(confirmBody(base, preview)).toEqual({ version: 4, mode: 'ALL_AS_ASKED', supplierRef: null, note: null, typedName: null, confirmationFileId: null })
  })

  it('a later date is a proposal the buyer decides (P2), every line in the body', () => {
    const answers = { [leather.id]: draft({ kind: 'OTHER', quantity: '1200', date: '2026-11-28', reason: 'Concia' }) }
    const preview = answerPreview(page, answers, TODAY, 'it')!
    expect(preview).toMatchObject({ mode: 'BY_LINE', outcome: 'PROPOSED' })
    expect(preview.summary).toEqual([
      { key: 'asAsked', count: 2 },
      { key: 'later', count: 1 },
    ])
    const body = confirmBody({ ...base, answers, supplierRef: ' OC-1 ', upload: { state: 'done', id: 'f1', name: 'a.pdf', size: 10 } }, preview)
    expect(body.lines).toHaveLength(3)
    expect(body.lines![0]).toEqual({ lineId: leather.id, answer: 'OTHER', quantity: '1200', date: '2026-11-28', reason: 'Concia' })
    expect(body).toMatchObject({ supplierRef: 'OC-1', confirmationFileId: 'f1' })
  })

  it('every line one it cannot deliver declines the order', () => {
    const cannot = draft({ kind: 'CANNOT', reason: 'No' })
    expect(answerPreview(page, { [leather.id]: cannot, [lining.id]: cannot, [protectors.id]: cannot }, TODAY, 'it')?.outcome).toBe('DECLINED')
  })

  it('sending waits with its reason: busy, an upload, a file to choose again, a required name', () => {
    const preview = answerPreview(page, {}, TODAY, 'it')
    expect(sendHeld(base, preview)).toBeNull()
    expect(sendHeld({ ...base, send: 'busy' }, preview)).toBe('answer.held.busy')
    expect(sendHeld(base, null)).toBe('answer.held.incomplete')
    expect(sendHeld({ ...base, upload: { state: 'uploading', name: 'a.pdf', size: 1 } }, preview)).toBe('answer.held.uploading')
    expect(sendHeld({ ...base, upload: { state: 'quarantined', name: 'a.pdf' } }, preview)).toBe('answer.held.file')
    const named = { ...base, page: { ...page, answers: [{ action: 'confirm' as const, typedName: 'required' as const, email: false }] } }
    expect(sendHeld(named, preview)).toBe('answer.held.name')
    expect(sendHeld({ ...named, typedName: 'Marco' }, preview)).toBeNull()
  })

  it('a decline for another reason says why', () => {
    expect(declineHeld({ ...base, decline: { reason: 'OTHER', note: '', tried: false } })).toBe('decline.held.note')
    expect(declineHeld({ ...base, decline: { reason: 'OTHER', note: 'Chiusura', tried: false } })).toBeNull()
    expect(declineHeld({ ...base, decline: { reason: 'NO_CAPACITY', note: '', tried: false } })).toBeNull()
  })

  it('a PDF only, at most 20 MB, never empty', () => {
    expect(pdfProblem({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeNull()
    expect(pdfProblem({ name: 'a.PDF', type: '', size: 10 })).toBeNull()
    expect(pdfProblem({ name: 'a.docx', type: 'application/msword', size: 10 })).toBe('notPdf')
    expect(pdfProblem({ name: 'a.pdf', type: 'application/pdf', size: 21 * 1024 * 1024 })).toBe('tooBig')
    expect(pdfProblem({ name: 'a.pdf', type: 'application/pdf', size: 0 })).toBe('empty')
  })
})

describe('the page’s state', () => {
  it('a line’s saved answer is kept by line; as asked again (or all as asked) removes the change', () => {
    let state: PoConfirmViewModel = { ...initialModel(TODAY), link: 'valid', page }
    state = reduce(state, { type: 'answer', lineId: leather.id, draft: draft({ kind: 'OTHER', date: '2026-11-28', reason: 'Concia' }) })
    expect(state.answers[leather.id]?.date).toBe('2026-11-28')
    state = reduce(state, { type: 'answer', lineId: lining.id, draft: draft({ kind: 'CANNOT', reason: 'No' }) })
    state = reduce(state, { type: 'answer', lineId: leather.id, draft: null })
    expect(state.answers[leather.id]).toBeUndefined()
    expect(state.answers[lining.id]?.kind).toBe('CANNOT')
    expect(reduce(state, { type: 'allAsAsked' }).answers).toEqual({})
  })

  it('a substitute and a change go to the API as the portal’s answers (when the link offers them)', () => {
    expect(lineBodyOf(protectors.id, draft({ kind: 'SUBSTITUTE', substituteId: 'item-2', substitute: '', reason: '' }), 'it')).toEqual({ lineId: protectors.id, answer: 'SUBSTITUTE', quantity: null, date: null, substituteItemId: 'item-2', substituteNote: null, reason: null })
    expect(lineBodyOf(lining.id, draft({ kind: 'CHANGE', reason: 'Due bagni' }), 'it')).toEqual({ lineId: lining.id, answer: 'CHANGE', reason: 'Due bagni' })
    expect(lineBodyOf(leather.id, draft({ kind: 'CANNOT', reason: 'No' }), 'it')).toEqual({ lineId: leather.id, answer: 'CANNOT_DELIVER', reason: 'No' })
  })

  it('a newer read keeps what was typed; a dead link closes the dialogs; the expiry never hides an answer just sent', () => {
    let state: PoConfirmViewModel = { ...initialModel(TODAY), link: 'valid', page, answers: { [leather.id]: draft({ kind: 'CANNOT', reason: 'x' }) }, declineOpen: true }
    state = reduce(state, { type: 'read', page: { ...page, order: { ...page.order, version: 5 } } })
    expect(state.answers[leather.id]).toBeDefined()
    expect(reduce(state, { type: 'refused', problem: null, link: 'unavailable' })).toMatchObject({ link: 'unavailable', declineOpen: false })
    expect(reduce(state, { type: 'expired' }).link).toBe('expired')
    const done = reduce(state, { type: 'answered', page, done: { outcome: 'CONFIRMED', summary: null, fileName: null, supplierRef: null } })
    expect(reduce(done, { type: 'expired' }).link).toBe('valid')
  })

  it('an order that takes no answer names its state', () => {
    expect(answeredKey('CONFIRMED')).toBe('answered.CONFIRMED')
    expect(answeredKey('SENT')).toBe('answered.other')
  })
})

describe('words', () => {
  it('every code the page words has its words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['po-confirm-link'])['po-confirm-link']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      has('propose.hint', { buyer: 'Paola' })
      has('propose.hintAll', { buyer: 'Paola' })
      for (const outcome of ANSWER_OUTCOMES) {
        has(`answer.outcome.${outcome}`)
        has(`done.${outcome}.title`)
        has(`done.${outcome}.body`)
      }
      for (const reason of DECLINE_REASONS) has(`decline.reasons.${reason}`)
      for (const status of PURCHASE_ORDER_STATUSES) {
        has(`${answeredKey(status)}.title`)
        has(`${answeredKey(status)}.body`)
      }
      for (const problem of PROBLEMS) has(`problem.${problem}`)
      for (const uom of UOMS) has(`uom.${uom}`)
    }
  })
})

const LEFT_KEY = /\b(?:lines|answer|summary|file|sheet|decline|done|answered|problem|dead|error|order|answerBy|who|uom|links)\.[a-zA-Z_.]+\b/
// Words that look like keys but are not (none on these pages today).
const NOT_KEYS = /(?!)/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left and no price', () => {
  it(`SCR-100: ${designScreen.cases.length} cases × it, en`, () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(NOT_KEYS, '')
        expect(html.length, `SCR-100/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-100/${item.id} (${locale})`).toBeNull()
        // C2: no price, no amount, no currency on a supplier's page.
        expect(html, `SCR-100/${item.id} (${locale}): money on a supplier page`).not.toMatch(/€|EUR\b|\bprice\b|prezzo|unitPrice|netAmount/i)
      }
    }
  })
})
