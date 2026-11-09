import { defineDesignScreen } from '../../lib/design/design-screen'
import type { PaymentIntent } from '../../lib/payments/online'
import type { PayPage } from './api'
import { IDLE_CARD, type CardStepModel, type PayViewModel } from './model'
import { PayView } from './view/PayView'

/**
 * SCR-199 Pay online (links.pay; B-W2b-199, W1's bank transfer part kept) — made-up data only (PLAN §3.1): an invented
 * seller, order and invoice, the deposit 30 % of 7,612.80 = 2,283.84, the IBAN registry's Italian example number, the
 * FAKE payment provider. Each case is one state the customer can meet: to pay (a deposit by DEPOSIT_INFO, an invoice by
 * PAYMENT), every step of card and SEPA on the FAKE provider (chosen, opening, its fields, the bank's confirmation,
 * waiting, declined, a SEPA debit on its way), the refusals and holds in our words, paid with the receipt, nothing to pay,
 * a link that no longer opens, loading, an error.
 */

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: '00000000-0000-4000-8000-000000000199',
  method: 'CARD',
  amount: 228384,
  currency: 'EUR',
  status: 'WAITING',
  providerRef: 'pi_fake_abcdefghijklmnopabcdefghijklmnop',
  failureCode: null,
  finishedAt: null,
  createdAt: '2026-11-03T09:40:00.000Z',
  ...over,
})

function depositPage(over: Partial<PayPage> = {}): PayPage {
  return {
    what: { target: 'DEPOSIT_REQUEST', id: '00000000-0000-4000-8000-0000000001a9', number: null, orderNumber: 'SO-2026-0088', quoteDocument: 'Q-2026-0188 v2', issueDate: null, dueDate: '2026-11-04', currency: 'EUR', total: 228384, settled: 0, open: 228384 },
    status: 'TO_PAY',
    bank: { method: 'BANK_TRANSFER', amount: 228384, currency: 'EUR', dueDate: '2026-11-04', reference: 'Acconto Q-2026-0188 v2 SO-2026-0088', bank: { accountHolder: 'Officina Demo S.r.l.', iban: 'IT60X0542811101000000123456', bic: null, bankName: 'Banca Esempio' } },
    card: { available: true, methods: ['CARD', 'SEPA_DEBIT'], provider: 'PAYMENT_FAKE', mode: 'FAKE', reason: null },
    intent: null,
    from: { legalName: 'Officina Demo S.r.l.', tradeName: 'Officina Demo' },
    expiresAt: '2026-11-28T16:05:00.000Z',
    ...over,
  }
}

function invoicePage(over: Partial<PayPage> = {}): PayPage {
  return depositPage({
    what: { target: 'INVOICE', id: '00000000-0000-4000-8000-0000000002b9', number: 'FT-2026-00042', orderNumber: 'SO-2026-0088', quoteDocument: null, issueDate: '2026-10-20', dueDate: '2026-11-19', currency: 'EUR', total: 761280, settled: 228384, open: 532896 },
    bank: { method: 'BANK_TRANSFER', amount: 532896, currency: 'EUR', dueDate: '2026-11-19', reference: 'Fattura FT-2026-00042', bank: { accountHolder: 'Officina Demo S.r.l.', iban: 'IT60X0542811101000000123456', bic: 'BEXAITMM', bankName: 'Banca Esempio' } },
    ...over,
  })
}

const card = (over: Partial<CardStepModel> = {}): CardStepModel => ({ ...IDLE_CARD, ...over })
const base = (over: Partial<PayViewModel> = {}): PayViewModel => ({ link: 'valid', purpose: 'DEPOSIT_INFO', page: depositPage(), deposit: { kind: 'ACCONTO', depositPct: '30' }, problem: null, copied: null, card: IDLE_CARD, ...over })
const invoice = (over: Partial<PayViewModel> = {}): PayViewModel => base({ purpose: 'PAYMENT', page: invoicePage(), deposit: null, ...over })
const paid = intent({ status: 'SUCCEEDED', finishedAt: '2026-11-03T09:42:10.000Z' })

export const designScreen = defineDesignScreen<PayViewModel>({
  screen: 'SCR-199',
  title: 'Pay online (link)',
  view: PayView,
  cases: [
    { id: 'to-pay', label: 'A deposit to pay (DEPOSIT_INFO): what you pay, the bank transfer, card or SEPA', model: base(), note: 'The page from the deposit mail. Card and SEPA run on the FAKE provider only (GATE-SPEND).' },
    { id: 'invoice', label: 'An invoice to pay (PAYMENT), part paid already', model: invoice() },
    { id: 'card-chosen', label: 'Card chosen: Continue', model: base({ card: card({ method: 'CARD' }) }) },
    { id: 'card-opening', label: 'Opening the payment', model: base({ card: card({ method: 'CARD', phase: 'starting' }) }) },
    { id: 'card-fields', label: 'The test provider’s fields (its buttons play the card)', model: base({ card: card({ method: 'CARD', phase: 'ready', intent: intent(), fields: true }) }) },
    { id: 'card-confirm', label: 'The bank asks to confirm (3-D Secure)', model: base({ card: card({ method: 'CARD', phase: 'ready', intent: intent(), fields: true, confirming: true }) }) },
    { id: 'card-sending', label: 'A button pressed: its answer awaited', model: base({ card: card({ method: 'CARD', phase: 'ready', intent: intent(), fields: true, sending: true }) }) },
    { id: 'card-waiting', label: 'Waiting for your bank… don’t close this page', model: base({ card: card({ method: 'CARD', phase: 'paying', intent: intent(), fields: true }) }) },
    { id: 'card-declined', label: 'Declined: the reason in our words, Try again or another way', model: base({ card: card({ method: 'CARD', phase: 'paying', intent: intent({ status: 'FAILED', failureCode: 'card_declined', finishedAt: '2026-11-03T09:41:00.000Z' }) }) }) },
    { id: 'card-auth-failed', label: 'The bank’s confirmation failed', model: base({ card: card({ method: 'CARD', phase: 'paying', intent: intent({ status: 'FAILED', failureCode: 'payment_intent_authentication_failure', finishedAt: '2026-11-03T09:41:00.000Z' }) }) }) },
    { id: 'card-resumed', label: 'A payment of the same person taken up again (a reload)', model: base({ card: card({ method: 'CARD', phase: 'ready', intent: intent(), fields: true, resumed: true }) }) },
    { id: 'sepa-fields', label: 'SEPA Direct Debit: sign the mandate', model: base({ card: card({ method: 'SEPA_DEBIT', phase: 'ready', intent: intent({ method: 'SEPA_DEBIT' }), fields: true }) }) },
    { id: 'sepa-on-its-way', label: 'SEPA on its way: the money arrives in a few days (the bank’s later answer in the test provider)', model: base({ card: card({ method: 'SEPA_DEBIT', phase: 'paying', intent: intent({ method: 'SEPA_DEBIT' }), fields: true }) }) },
    { id: 'reopened-waiting', label: 'The page opened while a payment of this link is under way', model: base({ page: depositPage({ intent: intent({ method: 'SEPA_DEBIT' }) }), card: card({ method: 'SEPA_DEBIT', phase: 'paying', intent: intent({ method: 'SEPA_DEBIT' }) }) }) },
    { id: 'refused-in-progress', label: 'Refused: another payment of this document is under way', model: base({ card: card({ method: 'CARD', problem: 'card.refusal.IN_PROGRESS' }) }) },
    { id: 'refused-provider', label: 'Refused: the payment service did not answer', model: invoice({ card: card({ method: 'SEPA_DEBIT', problem: 'card.refusal.PROVIDER' }) }) },
    { id: 'card-unavailable', label: 'Card not offered (no payment account): bank transfer only', model: base({ page: depositPage({ card: { available: false, methods: [], provider: null, mode: null, reason: 'NO_ACCOUNT' } }) }) },
    { id: 'card-held-live', label: 'Held: a live provider waits for the Owner (GATE-SPEND)', model: base({ page: depositPage({ card: { available: true, methods: ['CARD', 'SEPA_DEBIT'], provider: 'STRIPE', mode: 'SANDBOX', reason: null } }) }) },
    { id: 'offline', label: 'No connection: card waits, the bank transfer stays', model: base({ offline: true }) },
    { id: 'copied', label: 'The IBAN copied', model: base({ copied: 'IBAN' }) },
    { id: 'no-bank', label: 'No bank account entered yet: the details follow by e-mail', model: base({ page: depositPage({ bank: { ...depositPage().bank!, bank: null } }) }) },
    { id: 'invoice-no-bank', label: 'An invoice without bank details here: they are on the invoice', model: invoice({ page: invoicePage({ bank: { ...invoicePage().bank!, bank: null } }) }) },
    { id: 'quote-only', label: 'A deposit of a quote without an order yet', model: base({ page: depositPage({ what: { ...depositPage().what, orderNumber: null } }) }) },
    { id: 'paid', label: 'Paid by card: the receipt and what follows', model: base({ page: depositPage({ status: 'PAID', bank: null, what: { ...depositPage().what, settled: 228384, open: 0 }, intent: paid }) }) },
    { id: 'paid-invoice', label: 'An invoice paid by SEPA', model: invoice({ page: invoicePage({ status: 'PAID', bank: null, what: { ...invoicePage().what, settled: 761280, open: 0 }, intent: intent({ ...paid, method: 'SEPA_DEBIT', amount: 532896 }) }) }) },
    { id: 'paid-transfer', label: 'Paid another way (bank transfer): thank you, no card receipt', model: base({ page: depositPage({ status: 'PAID', bank: null, what: { ...depositPage().what, settled: 228384, open: 0 } }) }) },
    { id: 'closed', label: 'Nothing to pay (cancelled or settled another way)', model: base({ page: depositPage({ status: 'CLOSED', bank: null, what: { ...depositPage().what, open: 0 } }) }) },
    { id: 'unavailable', label: 'The link opens nothing any more (used, expired or replaced)', model: base({ link: 'unavailable', page: null }) },
    { id: 'loading', label: 'Loading', model: base({ page: null }) },
    { id: 'error', label: 'The page could not be read: Try again', model: base({ page: null, problem: 'problem.read' }) },
  ],
})
