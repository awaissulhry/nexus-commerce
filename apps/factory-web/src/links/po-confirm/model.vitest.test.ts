import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ANSWER_OUTCOMES, DECLINE_REASONS, LINE_ANSWERS, LINE_CHANGES, planAnswer } from '@nexus/factory-domain/purchasing/confirm/answer'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { designScreen } from './fixtures'
import {
  answeredKey,
  answerPreview,
  confirmBody,
  dayIn,
  declineHeld,
  draftOf,
  draftProblems,
  firstProblemKey,
  hasProblems,
  initialModel,
  lineBody,
  pdfProblem,
  plainQuantity,
  PROBLEMS,
  quantityShown,
  reduce,
  sendHeld,
  summaryParts,
  type LineDraft,
  type PoConfirmViewModel,
} from './model'

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

/** The API's own rule for one line (planAnswer's ValidationError or not). */
const apiTakes = (line: typeof leather, answer: LineDraft) => {
  try {
    planAnswer([{ id: line.id, seq: line.seq, quantity: line.quantity, uom: line.uom, needDate: line.needDate }], { mode: 'BY_LINE', lines: [lineBody(line, answer, 'it')] }, TODAY)
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

describe('a line’s answer: this page’s checks are the API’s rule', () => {
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
    ['cannot: with a reason', protectors, draft({ kind: 'CANNOT_DELIVER', reason: 'Fuori produzione' })],
    ['cannot: without', protectors, draft({ kind: 'CANNOT_DELIVER', reason: '  ' })],
    ['as asked', lining, draft({ kind: 'AS_ASKED' })],
  ]
  for (const [label, line, answer] of cases) {
    it(label, () => {
      const problems = draftProblems(line, answer, TODAY, 'it')
      expect(hasProblems(problems), JSON.stringify(problems)).toBe(!apiTakes(line, answer))
      if (hasProblems(problems)) expect(firstProblemKey(problems)).toMatch(/^sheet\.problem\./)
    })
  }

  it('a new sheet starts from what was asked (other) and keeps a draft of the same kind', () => {
    const fresh = draftOf(leather, 'OTHER', 'it')
    expect(fresh).toMatchObject({ kind: 'OTHER', quantity: '1200', date: '2026-11-14' })
    const typed = draft({ kind: 'SPLIT', reason: 'x' })
    expect(draftOf(leather, 'SPLIT', 'it', typed)).toBe(typed)
  })
})

describe('the whole answer', () => {
  it('nothing changed: confirm all as asked', () => {
    const preview = answerPreview(page, {}, TODAY, 'it')!
    expect(preview).toMatchObject({ mode: 'ALL_AS_ASKED', outcome: 'CONFIRMED' })
    expect(summaryParts(preview.counts)).toEqual([{ key: 'summary.allAsAsked', count: 3 }])
    expect(confirmBody(base, preview, 'it')).toEqual({ version: 4, mode: 'ALL_AS_ASKED', supplierRef: null, note: null, typedName: null, confirmationFileId: null })
  })

  it('a later date is a proposal the buyer decides (P2), every line in the body', () => {
    const answers = { [leather.id]: draft({ kind: 'OTHER', quantity: '1200', date: '2026-11-28', reason: 'Concia' }) }
    const preview = answerPreview(page, answers, TODAY, 'it')!
    expect(preview).toMatchObject({ mode: 'BY_LINE', outcome: 'PROPOSED' })
    expect(summaryParts(preview.counts)).toEqual([
      { key: 'summary.asAsked', count: 2 },
      { key: 'summary.later', count: 1 },
    ])
    const body = confirmBody({ ...base, answers, supplierRef: ' OC-1 ', upload: { state: 'done', id: 'f1', name: 'a.pdf', size: 10 } }, preview, 'it')
    expect(body.lines).toHaveLength(3)
    expect(body.lines![0]).toEqual({ lineId: leather.id, answer: 'OTHER', quantity: '1200', date: '2026-11-28', reason: 'Concia' })
    expect(body).toMatchObject({ supplierRef: 'OC-1', confirmationFileId: 'f1' })
  })

  it('every line one it cannot deliver declines the order', () => {
    const cannot = draft({ kind: 'CANNOT_DELIVER', reason: 'No' })
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
  it('a sheet saves only a complete answer; as asked again removes the change', () => {
    let state: PoConfirmViewModel = { ...initialModel(TODAY), link: 'valid', page }
    state = reduce(state, { type: 'openLine', line: leather, locale: 'it' })
    expect(state.sheet?.draft.kind).toBe('OTHER')
    state = reduce(state, { type: 'sheetSave', line: leather, locale: 'it' })
    expect(state.sheet?.tried).toBe(true)
    state = reduce(state, { type: 'sheetDraft', draft: { ...state.sheet!.draft, date: '2026-11-28', reason: 'Concia' } })
    state = reduce(state, { type: 'sheetSave', line: leather, locale: 'it' })
    expect(state.sheet).toBeNull()
    expect(state.answers[leather.id]?.date).toBe('2026-11-28')
    state = reduce(state, { type: 'openLine', line: leather, locale: 'it' })
    state = reduce(state, { type: 'sheetKind', line: leather, kind: 'AS_ASKED', locale: 'it' })
    state = reduce(state, { type: 'sheetSave', line: leather, locale: 'it' })
    expect(state.answers[leather.id]).toBeUndefined()
  })

  it('a newer read keeps what was typed; a dead link closes the dialogs; the expiry never hides an answer just sent', () => {
    let state: PoConfirmViewModel = { ...initialModel(TODAY), link: 'valid', page, answers: { [leather.id]: draft({ kind: 'CANNOT_DELIVER', reason: 'x' }) }, declineOpen: true }
    state = reduce(state, { type: 'read', page: { ...page, order: { ...page.order, version: 5 } } })
    expect(state.answers[leather.id]).toBeDefined()
    expect(reduce(state, { type: 'refused', problem: null, link: 'unavailable' })).toMatchObject({ link: 'unavailable', declineOpen: false })
    expect(reduce(state, { type: 'expired' }).link).toBe('expired')
    const done = reduce(state, { type: 'answered', page, done: { outcome: 'CONFIRMED', counts: null, fileName: null, supplierRef: null } })
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
      for (const kind of LINE_ANSWERS) {
        has(`lines.answer.${kind}`)
        has(`sheet.kinds.${kind}.title`)
        has(`sheet.kinds.${kind}.body`)
      }
      for (const change of LINE_CHANGES) has(`lines.changes.${change}`)
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
      for (const key of ['allAsAsked', 'asAsked', 'later', 'earlier', 'quantity', 'split', 'cannot']) has(`summary.${key}`, { count: 2 })
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
