import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { REFUND_SOURCES as DOMAIN_SOURCES, REFUND_STATUSES as DOMAIN_STATUSES, REFUND_VIEWS as DOMAIN_VIEWS } from '@nexus/factory-domain/payments/refunds'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { writeProblem } from '../../_shared/model'
import { permissionsOf } from '../../invoices/daily/demo/fixtures'
import { designScreen as paymentsScreen } from '../list/fixtures'
import { PAYMENT_ROWS_VIEWS } from '../list/list-model'
import { REFUND_SOURCES, REFUND_STATUSES, REFUND_VIEWS } from './api'
import { OPEN_REFUNDS, REFUND_DUE, REFUND_OF_BALANCE, REFUND_PAID, REFUNDS_ALL } from './demo/fixtures'
import { emptyRefund, moveHeld, moveProblems, REFUND_ROWS, refundAbilitiesOf, refundAmountOf, refundAskOf, refundGoWords, refundHeld, refundProblems, refundRowsFrom, refundRowsOf, refundsCsv, refundsTile, refundsTouched, settlesWords, targetOfNote } from './model'

const TODAY = '2026-10-29'
const finance = refundAbilitiesOf(permissionsOf('finance'))
const sales = refundAbilitiesOf(permissionsOf('sales'))
const note = targetOfNote(OPEN_REFUNDS.creditNotesToRefund[0]!)

describe('B-W2a-80 refunds — the enums mirror factory-domain; who may', () => {
  it('statuses, sources and views', () => {
    expect([...REFUND_STATUSES]).toEqual([...DOMAIN_STATUSES])
    expect([...REFUND_SOURCES]).toEqual([...DOMAIN_SOURCES])
    expect([...REFUND_VIEWS]).toEqual([...DOMAIN_VIEWS])
  })
  it('finance refunds and voids; sales only reads (with prices)', () => {
    expect(finance).toEqual({ view: true, refund: true, void: true, price: true })
    expect(sales).toEqual({ view: true, refund: false, void: false, price: true })
    expect(refundHeld(finance)).toBeNull()
    expect(refundHeld(sales)?.key).toBe('refund.held.noRight')
    expect(refundHeld({ ...finance, price: false })?.key).toBe('refund.held.noPrice')
    expect(refundHeld(finance, true)?.key).toBe('refund.held.offline')
  })
})

describe('Refunds to make and the rows of Payments › Refunds', () => {
  it('the tile counts refunds due and credit notes with money left; unknown "—"', () => {
    expect(refundsTile(null)).toEqual({ value: '—', hint: null })
    expect(refundsTile(OPEN_REFUNDS)).toEqual({ value: '2', hint: { key: 'refunds.tileHint', params: { due: 1, notes: 1 } } })
  })
  it('the rows: what is to refund now (credit notes, then refunds due) or the API’s views', () => {
    expect(PAYMENT_ROWS_VIEWS).toContain('refunds')
    expect(refundRowsOf('paid')).toBe('paid')
    expect(refundRowsOf('nonsense')).toBe('open')
    expect(REFUND_ROWS[0]).toBe('open')
    const open = refundRowsFrom('open', OPEN_REFUNDS, null)!
    expect(open.map((row) => row.kind)).toEqual(['toRefund', 'refund'])
    expect(refundRowsFrom('open', null, null)).toBeNull()
    expect(refundRowsFrom('all', null, REFUNDS_ALL)!.map((row) => row.id)).toEqual(REFUNDS_ALL.map((refund) => refund.id))
  })
  it('what a refund settles, in words', () => {
    expect(settlesWords(REFUND_DUE)).toEqual({ key: 'refunds.ofNote', params: { number: 'FT-2026-00041', invoice: 'FT-2026-00021' } })
    expect(settlesWords(REFUND_OF_BALANCE).key).toBe('refunds.ofPayment')
  })
  it('a refund event, a released over-payment or a payment re-reads the tile', () => {
    expect(refundsTouched({ type: 'refund.paid' })).toBe(true)
    expect(refundsTouched({ type: 'payment.overpayment_released' })).toBe(true)
    expect(refundsTouched({ type: 'shipment.shipped' })).toBe(false)
  })
})

describe('the Refund dialog: capped at what is refundable; made now or to make by a day', () => {
  it('nothing typed refunds all; above the cap is held; a value date not in the future and a reference', () => {
    const draft = { ...emptyRefund(TODAY), reference: 'TRN-1' }
    expect(refundProblems(note, draft, TODAY)).toEqual({})
    expect(refundAmountOf(note, draft)).toBe(6100)
    expect(refundProblems(note, { ...draft, amount: '61,01' }, TODAY).amount).toBe('refund.problem.over')
    expect(refundProblems(note, { ...draft, amount: 'abc' }, TODAY).amount).toBe('refund.problem.amount')
    expect(refundProblems(note, { ...draft, paidOn: '2026-10-30' }, TODAY).paidOn).toBe('refund.problem.future')
    expect(refundProblems(note, { ...draft, reference: ' ' }, TODAY).reference).toBe('refund.problem.reference')
    expect(refundProblems(null, draft, TODAY).target).toBe('refund.problem.target')
    expect(refundProblems({ ...note, cap: 0 }, draft, TODAY).target).toBe('refund.problem.nothing')
    expect(refundProblems(note, { ...draft, when: 'later', dueDate: '' }, TODAY).dueDate).toBe('refund.problem.date')
  })
  it('the body: the credit note or the payment, the amount only when typed, paid or due', () => {
    expect(refundAskOf(note, { ...emptyRefund(TODAY), reference: ' TRN-1 ' })).toEqual({ creditNoteId: note.kind === 'creditNote' ? note.creditNoteId : '', paid: { paidOn: TODAY, externalRef: 'TRN-1' } })
    expect(refundAskOf({ kind: 'payment', paymentId: 'p1', label: 'CRO', partyName: 'X', currency: 'EUR', cap: 5000 }, { ...emptyRefund(TODAY), when: 'later', amount: '20,00', dueDate: '2026-11-03', note: ' asked by phone ' })).toEqual({ paymentId: 'p1', amount: 2000, internalNote: 'asked by phone', dueDate: '2026-11-03' })
    expect(refundGoWords(note, emptyRefund(TODAY), 'en')).toEqual({ key: 'refund.go', params: { amount: '€61.00' } })
    expect(refundGoWords(null, { ...emptyRefund(TODAY), when: 'later' }, 'en').key).toBe('refund.goLaterPlain')
  })
  it('a refund’s moves: due → made or cancelled (payments.refund); made → voided (payments.void)', () => {
    expect(moveHeld(REFUND_DUE, 'paid', finance)).toBeNull()
    expect(moveHeld(REFUND_DUE, 'cancel', finance)).toBeNull()
    expect(moveHeld(REFUND_DUE, 'void', finance)?.key).toBe('refunds.held.voidNotPaid')
    expect(moveHeld(REFUND_PAID, 'void', finance)).toBeNull()
    expect(moveHeld(REFUND_PAID, 'paid', finance)?.key).toBe('refunds.held.notDue')
    expect(moveHeld(REFUND_DUE, 'paid', sales)?.key).toBe('refund.held.noRight')
    expect(moveHeld(REFUND_PAID, 'void', sales)?.key).toBe('refunds.held.noVoid')
    expect(moveProblems('paid', { paidOn: TODAY, reference: '', reason: '' }, TODAY)).toEqual({ reference: 'refund.problem.reference' })
    expect(moveProblems('cancel', { paidOn: '', reference: '', reason: 'no' }, TODAY)).toEqual({ reason: 'refunds.problem.reason' })
  })
  it('a reference counted already is said in words (the shared mapping)', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/paid/externalRef' }])).key).toBe('problem.write.reference')
  })
  it('the CSV: amounts only with the price grain', () => {
    const rows = refundRowsFrom('open', OPEN_REFUNDS, null)!
    const words = { header: (key: string) => key, state: () => 'state', settles: () => 'settles' }
    expect(refundsCsv(rows, true, words, 'en').split('\n')[0]).toBe('customer,settles,state,due,paidOn,reference,amount')
    expect(refundsCsv(rows, false, words, 'en').split('\n')[0]).toBe('customer,settles,state,due,paidOn,reference')
  })
})

const LEFT_KEY = /\b(?:refund|refunds|balance|payment|payments|payTile|payRows|placed|match|recordPay|common|held|list|live|col|bulk|item|problem|notice|stepUp)\.[a-zA-Z]+(?:\.[a-zA-Z0-9_]+)*\b/
const NOT_KEYS = /\b[\w.-]+@[\w.-]+\.\w+\b|\b[\w-]+\.(?:pdf|csv|xml)\b/g
const PERMISSION = /\b(?:invoices|payments|orders|companies|integrations)\.(?:view|manage|issue|record|void|bank|refund)\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every W2a payments design case draws in both languages with no key on screen', () => {
  it(`SCR-082 w2a cases × it, en`, () => {
    const cases = paymentsScreen.cases.filter((item) => item.id.startsWith('w2a-'))
    expect(cases.length).toBeGreaterThan(15)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = render(paymentsScreen as unknown as DesignScreen<unknown>, item.model, locale).replace(NOT_KEYS, '')
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html, `${item.id} (${locale})`).not.toMatch(PERMISSION)
      }
    }
  })
  it('the tile and the band’s Refund are on the payments page', () => {
    const item = paymentsScreen.cases.find((entry) => entry.id === 'w2a-refunds-tile')!
    const html = render(paymentsScreen as unknown as DesignScreen<unknown>, item.model, 'en')
    expect(html).toContain('Refunds to make')
    expect(html).toContain('Refund…')
  })
  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-daily'])['finance-daily']!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const status of REFUND_STATUSES) has(`refunds.state.${status}`)
      for (const rows of REFUND_ROWS) {
        has(`refunds.rows.${rows}`)
        has(`refunds.empty.${rows}.title`)
        has(`refunds.empty.${rows}.body`)
      }
      for (const move of ['paid', 'cancel', 'void']) for (const part of ['verb', 'title', 'go', 'body']) has(`refunds.move.${move}.${part}`)
      for (const option of ['now', 'later']) {
        has(`refund.whenOption.${option}`)
        has(`refund.whenHint.${option}`)
      }
      for (const column of ['customer', 'settles', 'state', 'due', 'paidOn', 'reference', 'amount']) has(`refunds.csv.${column}`)
      has('refunds.count', 2)
    }
  })
})
