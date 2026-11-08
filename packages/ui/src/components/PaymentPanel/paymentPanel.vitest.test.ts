import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PaymentPanel, type PaymentPanelProps } from './PaymentPanel'
import { PAYMENT_PANEL_LABELS } from './PaymentPanelLabels'
import { PAYMENT_STATES, paymentPanelView, paymentStartHeld } from './paymentPanelModel'

const noop = () => {}
const METHODS = [
  { id: 'CARD', label: 'Card', description: 'Visa, Mastercard' },
  { id: 'SEPA', label: 'SEPA Direct Debit' },
]
const base: PaymentPanelProps = { amount: '714,00 €', purpose: 'Deposit for quote Q-2026-0042', providerName: 'Stripe', state: 'idle' }
const render = (props: Partial<PaymentPanelProps>) => renderToStaticMarkup(createElement(PaymentPanel, { ...base, ...props }))

describe('paymentPanelView', () => {
  it('busy only while a step runs; fields while ready, paying or waiting; the method changes only when idle or failed', () => {
    const v = (state: (typeof PAYMENT_STATES)[number]) => paymentPanelView({ state, canStart: true, canPay: true })
    expect(PAYMENT_STATES.filter((s) => v(s).busy)).toEqual(['starting', 'paying', 'waiting'])
    expect(PAYMENT_STATES.filter((s) => v(s).showFields)).toEqual(['ready', 'paying', 'waiting'])
    expect(PAYMENT_STATES.filter((s) => v(s).chooseMethod)).toEqual(['idle', 'failed'])
    expect(PAYMENT_STATES.map((s) => v(s).action)).toEqual(['start', null, 'pay', 'paying', null, null, null])
    expect(PAYMENT_STATES.map((s) => v(s).status)).toEqual([null, 'starting', null, 'paying', 'waiting', null, null])
  })

  it('no Pay button when the provider’s fields carry their own submit; nothing at all when held', () => {
    expect(paymentPanelView({ state: 'ready', canPay: false }).action).toBeNull()
    expect(paymentPanelView({ state: 'idle', canStart: true, held: true })).toEqual({ busy: false, chooseMethod: false, showFields: false, action: null, status: null })
  })

  it('Continue is held until a method is chosen, when there is a choice', () => {
    expect(paymentStartHeld(METHODS, null, 'pick')).toBe('pick')
    expect(paymentStartHeld(METHODS, 'NOPE', 'pick')).toBe('pick')
    expect(paymentStartHeld(METHODS, 'SEPA', 'pick')).toBeNull()
    expect(paymentStartHeld(undefined, null, 'pick')).toBeNull()
  })
})

describe('PaymentPanel markup', () => {
  it('says what is paid and how much; idle: the methods as radio cards and Continue held until one is chosen', () => {
    const html = render({ methods: METHODS, method: null, onStart: noop, onMethod: noop })
    expect(html).toMatch(/<h3 id="[^"]+" class="nds-pay-title">Deposit for quote Q-2026-0042<\/h3>/)
    expect(html).toContain('<span class="nds-vh">Amount: </span>714,00 €')
    expect(html).toContain('<legend class="nds-pay-legend">How do you want to pay?</legend>')
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(2)
    expect(html).toMatch(/aria-disabled="true" aria-description="Choose how to pay first."[^>]*>Continue to payment<\/button>/)
    expect(html).toContain('Card and bank details go straight to Stripe. We never see them.')
  })

  it('never draws an input of its own for card or bank data: only the page’s fields and the provider’s box', () => {
    const html = render({ state: 'ready', method: 'CARD', methods: METHODS, fields: createElement('button', { type: 'button' }, 'Succeed'), mountFields: () => {}, onPay: noop })
    expect(html).toContain('role="group" aria-label="Payment details, by Stripe"><button type="button">Succeed</button><div class="nds-pay-mount"></div></div>')
    expect(html).not.toMatch(/<input(?![^>]*type="radio")/)
    expect(html).toContain('>Pay 714,00 €</button>')
    // The method is fixed once a payment is under way: said, not chosen.
    expect(html).toContain('<strong>Card</strong>')
    expect(html).not.toContain('type="radio"')
  })

  it('busy while sending and waiting: aria-busy, the words in one polite region, the button held with why', () => {
    const paying = render({ state: 'paying', onPay: noop })
    expect(paying).toMatch(/<section class="nds-pay" data-state="paying" aria-labelledby="[^"]+" aria-busy="true">/)
    expect(paying).toMatch(/aria-live="polite" aria-atomic="true">.*Sending to Stripe…/)
    expect(paying).toMatch(/aria-description="This takes a few seconds."/)
    const waiting = render({ state: 'waiting' })
    expect(waiting).toContain(PAYMENT_PANEL_LABELS.waiting)
    const idle = render({ onStart: noop })
    expect(idle).toContain('<p class="nds-pay-status" aria-live="polite" aria-atomic="true"></p>')
    expect(idle).not.toContain('aria-busy')
  })

  it('failed: the words and Try again in an alert; paid: the words and the receipt, no security note', () => {
    const failed = render({ state: 'failed', failure: 'Your bank declined the card.', onRetry: noop })
    expect(failed).toMatch(/data-tone="danger" role="alert">.*The payment did not go through.*Your bank declined the card\..*>Try again<\/button>/)
    const paid = render({ state: 'succeeded', succeeded: { words: 'Paid at 10:42. Thank you.', receipt: 'Receipt sent to anna@brand.example' } })
    expect(paid).toMatch(/data-tone="success" role="status">.*Paid at 10:42\. Thank you\..*Receipt sent to anna@brand\.example/)
    expect(paid).not.toContain('nds-pay-secure')
  })

  it('held: the reason on screen and nothing to press; host words reach every line', () => {
    const held = render({ heldReason: 'Only your Finance colleague can pay invoices.', onStart: noop, methods: METHODS })
    expect(held).toContain('role="note"')
    expect(held).toContain('Only your Finance colleague can pay invoices.')
    expect(held).not.toContain('<button')
    const it2 = render({ onStart: noop, labels: { start: 'Continua al pagamento', secure: (p?: string) => `I dati vanno direttamente a ${p}.` } })
    expect(it2).toContain('Continua al pagamento')
    expect(it2).toContain('I dati vanno direttamente a Stripe.')
  })
})
