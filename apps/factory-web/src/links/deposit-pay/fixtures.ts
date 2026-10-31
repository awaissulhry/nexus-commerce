import { defineDesignScreen } from '../../lib/design/design-screen'
import type { LinkDeposit } from './api'
import type { DepositPayViewModel } from './model'
import { DepositPayView } from './view/DepositPayView'

/**
 * SCR-199 Pay the deposit by bank transfer (W1 part of links.pay, DEPOSIT_INFO) — made-up data only (PLAN §3.1): an
 * invented seller and order, the deposit 30 % of 7,612.80 = 2,283.84, the IBAN registry's Italian example number. Each
 * case is one state the customer can meet: to pay, a field copied, part paid already, no bank account entered yet,
 * paid, a link that no longer opens, loading, an error.
 */

function linkDeposit(over: Partial<LinkDeposit> = {}): LinkDeposit {
  return {
    deposit: { kind: 'ACCONTO', depositPct: '30', currency: 'EUR', amount: 228384, dueDate: '2026-11-04', status: 'OPEN', paid: false },
    quote: { document: 'Q-2026-0188 v2' },
    order: { number: 'SO-2026-0088' },
    from: { legalName: 'Officina Demo S.r.l.', tradeName: 'Officina Demo' },
    instructions: {
      method: 'BANK_TRANSFER',
      amount: 228384,
      currency: 'EUR',
      dueDate: '2026-11-04',
      reference: 'Acconto Q-2026-0188 v2 SO-2026-0088',
      bank: { accountHolder: 'Officina Demo S.r.l.', iban: 'IT60X0542811101000000123456', bic: null, bankName: 'Banca Esempio' },
    },
    expiresAt: '2026-11-28T16:05:00.000Z',
    ...over,
  }
}

const base = (over: Partial<DepositPayViewModel> = {}): DepositPayViewModel => ({ link: 'valid', deposit: linkDeposit(), copied: null, ...over })

export const designScreen = defineDesignScreen<DepositPayViewModel>({
  screen: 'SCR-199',
  title: 'Pay the deposit by bank transfer (link)',
  view: DepositPayView,
  cases: [
    { id: 'to-pay', label: 'The deposit to pay: amount, due date, the bank transfer with Copy', model: base(), note: 'The customer’s page from the bank-details mail (DEPOSIT_INFO). Card payment is W2b.' },
    { id: 'copied', label: 'The IBAN copied', model: base({ copied: 'IBAN' }) },
    { id: 'part-paid', label: 'Part paid already: what is left to pay', model: base({ deposit: linkDeposit({ instructions: { ...linkDeposit().instructions, amount: 128384 } }) }) },
    { id: 'typed-order', label: 'A deposit of an order typed without a quote (B-W2b-16)', model: base({ deposit: linkDeposit({ quote: null, instructions: { ...linkDeposit().instructions, reference: 'Acconto SO-2026-0091' } }) }) },
    { id: 'quote-only', label: 'A deposit of a quote without an order yet', model: base({ deposit: linkDeposit({ order: null, instructions: { ...linkDeposit().instructions, reference: 'Acconto Q-2026-0188 v2' } }) }) },
    { id: 'no-bank', label: 'No bank account entered yet: the details follow by e-mail', model: base({ deposit: linkDeposit({ instructions: { ...linkDeposit().instructions, bank: null } }) }) },
    { id: 'paid', label: 'Paid — thank you', model: base({ deposit: linkDeposit({ deposit: { ...linkDeposit().deposit, status: 'PAID', paid: true } }) }) },
    { id: 'unavailable', label: 'The link opens nothing any more (used, expired or replaced)', model: base({ link: 'unavailable', deposit: null }) },
    { id: 'loading', label: 'Loading', model: base({ link: 'loading', deposit: null }) },
    { id: 'error', label: 'The page could not be read', model: base({ link: 'error', deposit: null }) },
  ],
})
