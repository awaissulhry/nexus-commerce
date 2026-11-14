import { describe, expect, it } from 'vitest'
import { documentCurrencyProblem, draftLanguageOf, euroEquivalentOf, euroEquivalentWords, invoiceCurrencyOf, invoiceLanguageOf, languageProblem, printLanguageOf, typedRateProblems } from './language-currency'

// B-W2b-396 (FIN-063, PLT-131): every name, rate and amount here is made up.
describe("the invoice's language (the contact's, else the customer's)", () => {
  const contact = (name: string, language: string | null, roles = ['INVOICES'], status = 'ACTIVE') => ({ name, language, roles, status })

  it("takes the first active invoices contact that reads its own language, else the customer's", () => {
    expect(draftLanguageOf([contact('Zeta', 'de'), contact('Alfa', 'en')], 'it')).toEqual({ language: 'en', source: 'CONTACT' })
    expect(draftLanguageOf([contact('Alfa', null), contact('Beta', 'fr', ['ORDERS']), contact('Gamma', 'es', ['INVOICES'], 'ARCHIVED')], 'de')).toEqual({ language: 'de', source: 'CUSTOMER' })
    expect(invoiceLanguageOf('en', 'it')).toEqual({ language: 'en', source: 'INVOICE' })
    expect(invoiceLanguageOf(null, 'fr')).toEqual({ language: 'fr', source: 'CUSTOMER' })
    expect(languageProblem('EN')).not.toBeNull()
    expect(languageProblem('en')).toBeNull()
    expect([printLanguageOf('en'), printLanguageOf('it'), printLanguageOf('de')]).toEqual(['en', 'it', 'it'])
  })
})

describe("the invoice's currency and its euro equivalent", () => {
  it("bills in its orders' one currency, else the company's; never two", () => {
    expect(invoiceCurrencyOf(['USD', 'USD'], 'EUR')).toEqual({ currency: 'USD' })
    expect(invoiceCurrencyOf([], 'EUR')).toEqual({ currency: 'EUR' })
    expect(invoiceCurrencyOf(['USD', 'EUR'], 'EUR')).toEqual({ problem: 'One invoice bills one currency: these orders are in EUR and USD. Invoice each currency on its own.' })
  })

  it('prints only a currency with at most two decimals', () => {
    expect(documentCurrencyProblem('USD')).toBeNull()
    expect(documentCurrencyProblem('JPY')).toBeNull()
    expect(documentCurrencyProblem('KWD')).toMatch(/^KWD has 3 decimals/)
    expect(documentCurrencyProblem('usd')).toBe('usd is not an ISO 4217 currency.')
  })

  it('checks a typed rate: above 0, eight decimals at most, of today or before, not on a euro invoice', () => {
    expect(typedRateProblems('USD', { exchangeRate: '1.0850', rateDate: '2026-11-12' }, '2026-11-14')).toEqual([])
    expect(typedRateProblems('USD', { exchangeRate: '0', rateDate: '2026-11-12' }, '2026-11-14').map((issue) => issue.path)).toEqual(['body/exchangeRate'])
    expect(typedRateProblems('USD', { exchangeRate: '1.1', rateDate: '2026-11-15' }, '2026-11-14').map((issue) => issue.path)).toEqual(['body/rateDate'])
    expect(typedRateProblems('EUR', { exchangeRate: '1.1', rateDate: '2026-11-12' }, '2026-11-14').map((issue) => issue.path)).toEqual(['body/exchangeRate'])
  })

  it('converts the total and the taxable amount once each; the VAT is the difference, so they add up', () => {
    // 1,000.00 USD + 22 % = 1,220.00 USD at 1 EUR = 1.085 USD.
    const euro = euroEquivalentOf({ currency: 'USD', netTotal: 100_000, grossTotal: 122_000 }, '1.08500000')
    expect(euro).toEqual({ netEur: 92_166, vatEur: 20_276, grossEur: 112_442 })
    expect(euro.netEur + euro.vatEur).toBe(euro.grossEur)
    expect(euroEquivalentOf({ currency: 'JPY', netTotal: 100_000, grossTotal: 122_000 }, '160.5')).toEqual({ netEur: 62_305, vatEur: 13_707, grossEur: 76_012 })
    expect(euroEquivalentWords('USD', { exchangeRate: '1.085', rateDate: '2026-11-12' }, euro, 'it')).toBe(
      'Controvalore in euro al cambio 1 EUR = 1,085 USD del 12/11/2026 (art. 13 c.4 DPR 633/1972): imponibile € 921,66, IVA € 202,76, totale € 1.124,42.',
    )
    expect(euroEquivalentWords('USD', { exchangeRate: '1.085', rateDate: '2026-11-12' }, euro, 'en')).toMatch(/^Euro equivalent at 1 EUR = 1\.085 USD of 12 Nov 2026/)
  })
})
