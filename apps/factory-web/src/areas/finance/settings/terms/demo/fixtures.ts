import { termsSummary } from '@nexus/factory-domain/sales/terms/terms'
import { COMPANY, at } from '../../../_demo/fixtures'
import type { MethodState } from '../../costing/api'
import type { PaymentTerms } from '../api'

/**
 * Made-up payment terms and costing states for B-W2a-80's design cases (Finance settings): a deposit + balance before
 * shipping, 30/60 days end of month, Ri.Ba. 60 days with an early-payment discount, an archived one. Their words come from
 * factory-domain's termsSummary, as the API answers them. Nothing here is a real company's terms. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

function terms(n: number, over: Pick<PaymentTerms, 'code' | 'name' | 'method' | 'instalments'> & Partial<PaymentTerms>): PaymentTerms {
  const facts = { method: over.method, instalments: over.instalments, earlyPaymentDiscountPct: over.earlyPaymentDiscountPct ?? null, earlyPaymentDays: over.earlyPaymentDays ?? null }
  const order = over.instalments.find((item) => item.from === 'ORDER')
  return {
    id: uid('6161', n),
    companyId: COMPANY,
    nameI18n: null,
    earlyPaymentDiscountPct: null,
    earlyPaymentDays: null,
    deposit: order ? { sharePct: order.sharePct, days: order.days } : null,
    summary: { it: termsSummary(facts, 'it'), en: termsSummary(facts, 'en') },
    status: 'ACTIVE',
    customers: 0,
    version: 1,
    updatedAt: at(20, 9),
    ...over,
  }
}

export const TERMS: PaymentTerms[] = [
  terms(1, { code: 'DEP30BS', name: 'Acconto 30% all’ordine, saldo prima della spedizione', nameI18n: { en: '30% deposit on order, balance before shipping' }, method: 'MP05', instalments: [{ sharePct: '30', from: 'ORDER', days: 7, endOfMonth: false }, { sharePct: '70', from: 'BEFORE_SHIPPING', days: 0, endOfMonth: false }], customers: 2, version: 3 }),
  terms(2, { code: 'BB3060FM', name: 'Bonifico 30/60 gg data fattura fine mese', nameI18n: { en: 'Bank transfer 30/60 days end of month' }, method: 'MP05', instalments: [{ sharePct: '50', from: 'INVOICE', days: 30, endOfMonth: true }, { sharePct: '50', from: 'INVOICE', days: 60, endOfMonth: true }], customers: 1 }),
  terms(3, { code: 'RIBA60', name: 'Ri.Ba. 60 gg data fattura', method: 'MP12', instalments: [{ sharePct: '100', from: 'INVOICE', days: 60, endOfMonth: false }], earlyPaymentDiscountPct: '2', earlyPaymentDays: 10 }),
  terms(4, { code: 'CONSEGNA', name: 'Rimessa diretta alla consegna', method: 'MP01', instalments: [{ sharePct: '100', from: 'DELIVERY', days: 0, endOfMonth: false }], status: 'ARCHIVED' }),
]

export const METHOD_UNDECIDED: MethodState = { companyId: COMPANY, settingsId: null, from: 'DEFAULT', method: 'UNDECIDED', provisional: true, locked: false, lockedAt: null, firstEntryAt: '2026-10-03T08:15:00.000Z', entries: 14, open: true, version: null }
export const METHOD_CHOSEN: MethodState = { ...METHOD_UNDECIDED, settingsId: COMPANY, from: 'COMPANY', method: 'STANDARD', provisional: false, firstEntryAt: null, entries: 0, version: 1 }
export const METHOD_LOCKED: MethodState = { ...METHOD_CHOSEN, locked: true, lockedAt: '2026-10-03T08:15:00.000Z', firstEntryAt: '2026-10-03T08:15:00.000Z', entries: 128, open: false, version: 2 }
