import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { paymentNoticeSchema, type PaymentNotice } from '../band/api'
import { openNoticesOf, paidTooMuchOf } from '../band/model'
import { ORDER_FLOW_NS } from '../flow-words'
import { NoticesSection, NoticesWaitingRow, PaidTooMuch } from './view/FlowMoney'

/**
 * owb-of6 step 3 — the Money tab (design plan § 5m; R36, R37): the customer's "I paid" notices (a notice, never a payment) with
 * Recorded / Dismiss for payments.record; sales the same lines in words, no amount anywhere, no button; an open notice is a Waiting
 * entry; "Paid too much"; Undo after Take a payment out is NOT built (today's server cannot put a taken-out payment back). Written, not run.
 */

const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: {} }, node))
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const notice = (over: Partial<PaymentNotice> = {}): PaymentNotice => ({ id: 'n-1', version: 1, step: { id: 's-1', words: 'Deposit 30 %' }, paidOn: '2026-11-27', method: 'Bank transfer', note: null, fileId: null, currency: 'EUR', state: 'OPEN', at: '2026-11-27T10:00:00Z', ...over })

describe('owb-of6 step 3: sales — no amount anywhere, no button', () => {
  it('sales reads the notice in words: no amount (even when one is sent), no Recorded / Dismiss', () => {
    const drawn = html(createElement(NoticesSection, { notices: [notice({ amount: 32400 })], may: false, price: false, busy: null, problem: null }))
    expect(drawn).toContain('Deposit 30 %')
    expect(drawn).not.toContain('324')
    expect(drawn).not.toContain('€')
    expect(drawn).not.toContain('>Recorded<')
    expect(drawn).not.toContain('Dismiss')
  })
  it('payments.record with the price grain: the amount and the two answers; a RECORDED notice says how to record the payment itself', () => {
    const drawn = html(createElement(NoticesSection, { notices: [notice({ amount: 32400 }), notice({ id: 'n-2', state: 'RECORDED' })], may: true, price: true, busy: null, problem: null }))
    expect(drawn).toContain('324')
    expect(drawn).toContain('Dismiss')
    expect(drawn).toContain('Record payment…')
  })
  it('the read answers the amount only as an optional field (the price grain); the schema keeps it optional', () => {
    expect(paymentNoticeSchema.safeParse(notice()).success).toBe(true)
    expect(paymentNoticeSchema.safeParse({ ...notice(), amount: 100 }).success).toBe(true)
  })
})

describe('owb-of6 step 3: a notice → a Waiting entry; Paid too much', () => {
  it('open notices are counted for Waiting, with a door to Money; never for the designer', () => {
    expect(openNoticesOf([notice(), notice({ id: 'n-2', state: 'DISMISSED' }), notice({ id: 'n-3' })])).toBe(2)
    expect(openNoticesOf(null)).toBe(0)
    expect(html(createElement(NoticesWaitingRow, { count: 2, href: '/w/demo/sales/orders/o-1?tab=money#payment-notices' }))).toContain('The customer says it paid · 2')
    const waiting = read('../changes/view/WaitingSection.tsx')
    expect(waiting).toContain('openNotices > 0 && !model.can.viewOwn ? <NoticesWaitingRow')
  })
  it('Paid too much only when the total went below what is paid (price grain)', () => {
    expect(paidTooMuchOf({ total: 100000, paid: 104000 })).toBe(4000)
    expect(paidTooMuchOf({ total: 100000, paid: 100000 })).toBeNull()
    expect(paidTooMuchOf({ total: undefined, paid: 1 })).toBeNull()
    expect(html(createElement(PaidTooMuch, { over: 4000, currency: 'EUR' }))).toContain('is paid too much')
    expect(read('./view/MoneyTab.tsx')).toContain('const over = model.can.price ? paidTooMuchOf(')
  })
  it('every new word in English and Italian', () => {
    const keys = ['notices.title', 'notices.open_one', 'notices.open_other', 'notices.none', 'notices.info', 'notices.failed', 'notices.row', 'notices.noStep', 'notices.state.OPEN', 'notices.state.RECORDED', 'notices.state.DISMISSED', 'notices.busy', 'notices.recorded', 'notices.dismiss', 'notices.thenRecord', 'notices.waiting_one', 'notices.waiting_other', 'money.paidTooMuch']
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
