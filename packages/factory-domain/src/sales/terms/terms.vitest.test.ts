import { describe, expect, it } from 'vitest'
import { depositRequestFor } from '../deposits/deposits'
import { DEPOSIT_DUE_DAYS, quoteTerms } from '../quotes/terms'
import {
  belowMinimum,
  checkPaymentTerms,
  commercialTermsProblems,
  depositDueDaysOf,
  depositOf,
  dueDateOf,
  endOfMonth,
  instalmentsOf,
  invoiceDueOf,
  invoiceTypePreset,
  quoteDefaultsOf,
  scheduleOf,
  splitByShare,
  termsNameIn,
  termsSummary,
  type Instalment,
} from './terms'

const DEP30: Instalment[] = [
  { sharePct: '30.0000', from: 'ORDER', days: 0, endOfMonth: false },
  { sharePct: '70.0000', from: 'BEFORE_SHIPPING', days: 0, endOfMonth: false },
]
const BB30FM: Instalment[] = [{ sharePct: '100.0000', from: 'INVOICE', days: 30, endOfMonth: true }]
const RIBA_30_60: Instalment[] = [
  { sharePct: '50.0000', from: 'INVOICE', days: 30, endOfMonth: true },
  { sharePct: '50.0000', from: 'INVOICE', days: 60, endOfMonth: true },
]

describe('checkPaymentTerms (FIN-075)', () => {
  it('normalises a valid entry: code in capitals, shares with 4 places, other languages kept', () => {
    const checked = checkPaymentTerms({ code: ' dep30 ', name: " 30% all'ordine ", nameI18n: { EN: ' 30% with the order ', de: '' }, method: 'MP05', instalments: [{ sharePct: '30', from: 'ORDER', days: 7 }, { sharePct: '70', from: 'BEFORE_SHIPPING', days: 0 }] })
    expect(checked).toEqual({
      ok: true,
      terms: {
        code: 'DEP30',
        name: "30% all'ordine",
        nameI18n: { en: '30% with the order' },
        method: 'MP05',
        instalments: [
          { sharePct: '30.0000', from: 'ORDER', days: 7, endOfMonth: false },
          { sharePct: '70.0000', from: 'BEFORE_SHIPPING', days: 0, endOfMonth: false },
        ],
        earlyPaymentDiscountPct: null,
        earlyPaymentDays: null,
      },
    })
  })

  it('says what is wrong, in words, with its path', () => {
    const checked = checkPaymentTerms({
      code: 'bad code!',
      name: '',
      method: 'MP24',
      instalments: [
        { sharePct: '30', from: 'ORDER', days: 0 },
        { sharePct: '30', from: 'ORDER', days: 400 },
        { sharePct: '0', from: 'INVOICE', days: 30 },
      ],
      earlyPaymentDiscountPct: '2',
    })
    expect(checked.ok).toBe(false)
    const paths = (checked as { issues: { path: string; message: string }[] }).issues.map((issue) => issue.path)
    expect(paths).toEqual(['code', 'name', 'method', 'instalments/1/days', 'instalments/2/sharePct', 'instalments', 'instalments', 'earlyPaymentDiscountPct'])
    expect((checked as { issues: { message: string }[] }).issues.map((issue) => issue.message)).toContain('The shares total 60%: they must total 100%.')
    expect((checked as { issues: { message: string }[] }).issues.map((issue) => issue.message)).toContain('At most one instalment on the order: it is the deposit asked at acceptance.')
  })

  it('takes an early-payment discount with its days, both or neither, below 100%', () => {
    const base = { code: 'BB60', name: 'Bonifico 60 gg', method: 'MP05', instalments: [{ sharePct: '100', from: 'INVOICE' as const, days: 60 }] }
    expect(checkPaymentTerms({ ...base, earlyPaymentDiscountPct: '2', earlyPaymentDays: 10 })).toMatchObject({ ok: true, terms: { earlyPaymentDiscountPct: '2.0000', earlyPaymentDays: 10 } })
    expect(checkPaymentTerms({ ...base, earlyPaymentDays: 10 }).ok).toBe(false)
    expect(checkPaymentTerms({ ...base, earlyPaymentDiscountPct: '100', earlyPaymentDays: 10 }).ok).toBe(false)
  })

  it('reads stored instalments back, dropping a malformed one', () => {
    expect(instalmentsOf([{ sharePct: '100.0000', from: 'INVOICE', days: 30, endOfMonth: true }, { sharePct: 5, from: 'X' }, null])).toEqual(BB30FM)
    expect(instalmentsOf('x')).toEqual([])
  })
})

describe('due dates, shares and the schedule', () => {
  it('moves to the month end after the days ("30 gg d.f.f.m.")', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
    expect(endOfMonth('2028-02-01')).toBe('2028-02-29')
    expect(dueDateOf('2026-01-10', { days: 30, endOfMonth: true })).toBe('2026-02-28')
    expect(dueDateOf('2026-01-31', { days: 30, endOfMonth: true })).toBe('2026-03-31')
    expect(dueDateOf('2026-01-31', { days: 30, endOfMonth: false })).toBe('2026-03-02')
    expect(dueDateOf('2026-12-15', { days: 0, endOfMonth: false })).toBe('2026-12-15')
  })

  it('splits an amount by share in minor units, the last part taking the rest', () => {
    expect(splitByShare(100_001, ['30.0000', '70.0000'])).toEqual([30_000, 70_001])
    expect(splitByShare(100, ['33.3333', '33.3333', '33.3334'])).toEqual([33, 33, 34])
    expect(splitByShare(1, ['50', '50'])).toEqual([1, 0])
    expect(splitByShare(500, [])).toEqual([])
  })

  it("makes an order's payment schedule from its terms (SAL-216's input)", () => {
    expect(scheduleOf(DEP30, 2_283_84)).toEqual([
      { ...DEP30[0], seq: 10, amount: 68_515 },
      { ...DEP30[1], seq: 20, amount: 159_869 },
    ])
  })

  it("gives an invoice's due dates, FatturaPA condition and early-payment date", () => {
    expect(invoiceDueOf({ method: 'MP12', instalments: RIBA_30_60, earlyPaymentDiscountPct: null, earlyPaymentDays: null }, '2026-11-12', 120_001)).toEqual({
      condition: 'TP01',
      method: 'MP12',
      instalments: [
        { dueDate: '2026-12-31', amount: 60_001 },
        { dueDate: '2027-01-31', amount: 60_000 },
      ],
      earlyPayment: null,
    })
    expect(invoiceDueOf({ method: 'MP05', instalments: [{ sharePct: '100.0000', from: 'INVOICE', days: 60, endOfMonth: false }], earlyPaymentDiscountPct: '2.0000', earlyPaymentDays: 10 }, '2026-11-12', 50_000)).toMatchObject({
      condition: 'TP02',
      instalments: [{ dueDate: '2027-01-11', amount: 50_000 }],
      earlyPayment: { discountPct: '2', byDate: '2026-11-22' },
    })
    // Terms paid before the invoice (a deposit, the balance before shipping): the invoice's rest is due on its day.
    expect(invoiceDueOf({ method: 'MP05', instalments: DEP30, earlyPaymentDiscountPct: null, earlyPaymentDays: null }, '2026-11-12', 10_000).instalments).toEqual([{ dueDate: '2026-11-12', amount: 10_000 }])
  })

  it('names the deposit the terms ask on the order and its due days', () => {
    expect(depositOf(DEP30)).toEqual({ sharePct: '30', days: 0 })
    expect(depositOf(BB30FM)).toBeNull()
    expect(depositDueDaysOf(DEP30, 7)).toBe(0)
    expect(depositDueDaysOf([{ ...DEP30[0]!, days: 10 }, DEP30[1]!], 7)).toBe(10)
    expect(depositDueDaysOf(BB30FM, 7)).toBe(7)
    expect(depositDueDaysOf(null, 7)).toBe(7)
  })
})

describe('words', () => {
  it('prints the name in the document language, else the company one', () => {
    const terms = { name: "30% all'ordine, saldo prima della spedizione", nameI18n: { en: '30% with the order, the balance before shipping' } }
    expect(termsNameIn(terms, 'en')).toBe('30% with the order, the balance before shipping')
    expect(termsNameIn(terms, 'it')).toBe("30% all'ordine, saldo prima della spedizione")
    expect(termsNameIn({ name: 'Bonifico', nameI18n: null }, 'de')).toBe('Bonifico')
  })

  it('sums the rules up in Italian and English', () => {
    expect(termsSummary({ method: 'MP05', instalments: DEP30, earlyPaymentDiscountPct: null, earlyPaymentDays: null }, 'it')).toBe("Bonifico bancario: 30% all'ordine · 70% prima della spedizione")
    expect(termsSummary({ method: 'MP12', instalments: RIBA_30_60, earlyPaymentDiscountPct: null, earlyPaymentDays: null }, 'en')).toBe('Bank receipt (Ri.Ba.): 50% 30 days from the invoice, end of month · 50% 60 days from the invoice, end of month')
    expect(termsSummary({ method: 'MP05', instalments: [{ sharePct: '100.0000', from: 'INVOICE', days: 60, endOfMonth: false }], earlyPaymentDiscountPct: '2.0000', earlyPaymentDays: 10 }, 'it')).toBe('Bonifico bancario: 100% a 60 gg data fattura · sconto 2% entro 10 gg')
  })
})

describe("the customer's commercial terms (SAL-012)", () => {
  it('checks the plain fields', () => {
    expect(commercialTermsProblems({ defaultDepositPct: '30', incoterm: 'DAP', preferredCarrierCode: 'brt', minimumOrderAmount: 100_000, currency: 'EUR', language: 'it' })).toEqual([])
    expect(commercialTermsProblems({ defaultDepositPct: '0', incoterm: 'XYZ', preferredCarrierCode: ' ', minimumOrderAmount: -1, currency: 'eur', language: 'ita' }).map((issue) => issue.path)).toEqual([
      'defaultDepositPct',
      'incoterm',
      'preferredCarrierCode',
      'minimumOrderAmount',
      'currency',
      'language',
    ])
    expect(commercialTermsProblems({ defaultDepositPct: null, incoterm: null, preferredCarrierCode: null, minimumOrderAmount: null })).toEqual([])
  })

  it('presets the invoice type from the invoice timing: TD01 per shipment, TD24 monthly', () => {
    expect(invoiceTypePreset('PER_SHIPMENT')).toBe('TD01')
    expect(invoiceTypePreset('MONTHLY')).toBe('TD24')
  })

  it("starts a quote from the customer's terms: its deposit, else its terms' order share, else the settings'", () => {
    const terms = { id: 'terms-1', name: "30% all'ordine", nameI18n: { en: '30% with the order' }, instalments: DEP30 }
    expect(quoteDefaultsOf({ partyDepositPct: null, terms, partyTermsText: 'old text', settingsDepositPct: '20', language: 'en' })).toEqual({ paymentTermsId: 'terms-1', paymentTerms: '30% with the order', depositPct: '30' })
    expect(quoteDefaultsOf({ partyDepositPct: '40.0000', terms, partyTermsText: null, settingsDepositPct: '20', language: 'it' })).toEqual({ paymentTermsId: 'terms-1', paymentTerms: "30% all'ordine", depositPct: '40' })
    // Terms that ask nothing on the order ask no deposit; no terms: the settings' and the printed text.
    expect(quoteDefaultsOf({ partyDepositPct: null, terms: { id: 't', name: 'BB30FM', nameI18n: null, instalments: BB30FM }, partyTermsText: null, settingsDepositPct: '20', language: 'it' }).depositPct).toBeNull()
    expect(quoteDefaultsOf({ partyDepositPct: null, terms: null, partyTermsText: 'Bonifico 60 gg', settingsDepositPct: '20', language: 'it' })).toEqual({ paymentTermsId: null, paymentTerms: 'Bonifico 60 gg', depositPct: '20' })
  })

  it('tells a quote below the minimum order how much is missing', () => {
    expect(belowMinimum(100_000, 80_000, 'EUR')).toEqual({ minimum: 100_000, short: 20_000, currency: 'EUR' })
    expect(belowMinimum(100_000, 100_000, 'EUR')).toBeNull()
    expect(belowMinimum(null, 0, 'EUR')).toBeNull()
  })
})

describe('the deposit due days the terms give (W1 leftover: a constant 7)', () => {
  const TERMS = {
    language: 'it' as const,
    taxMode: 'IT_B2B' as const,
    currency: 'EUR',
    validUntil: '2026-11-28',
    firmOffer: false,
    promiseDate: null,
    deposit: { pct: '30', kind: 'ACCONTO' as const, amount: 228384 },
    noWithdrawal: false,
    termsText: null,
    termsVersion: null,
  }
  const depositClause = (input: Parameters<typeof quoteTerms>[0]) => quoteTerms(input).clauses.find((clause) => clause.code === 'DEPOSIT')!.text

  it('prints the days of the order instalment, "the day of acceptance" for 0, 7 without terms', () => {
    expect(depositClause({ ...TERMS, depositDueDays: 10 })).toBe("Acconto all'accettazione: 30% del totale, € 2.283,84, da versare con bonifico bancario entro 10 giorni dall'accettazione.")
    expect(depositClause({ ...TERMS, depositDueDays: 0 })).toBe("Acconto all'accettazione: 30% del totale, € 2.283,84, da versare con bonifico bancario il giorno dell'accettazione.")
    expect(depositClause({ ...TERMS, language: 'en', deposit: { ...TERMS.deposit, kind: 'CAPARRA' }, depositDueDays: 0 })).toMatch(/by bank transfer on the day of acceptance\.$/)
    expect(depositClause(TERMS)).toMatch(new RegExp(`entro ${DEPOSIT_DUE_DAYS} giorni dall'accettazione\\.$`))
  })

  it('makes the deposit request due after those days', () => {
    const version = { depositPct: '30', depositKind: 'ACCONTO' as const, depositAmount: 30_000, currency: 'EUR' }
    expect(depositRequestFor(version, '2026-10-29', null, 10)?.dueDate).toBe('2026-11-08')
    expect(depositRequestFor(version, '2026-10-29', null, 0)?.dueDate).toBe('2026-10-29')
    expect(depositRequestFor(version, '2026-10-29', null)?.dueDate).toBe('2026-11-05')
  })
})
