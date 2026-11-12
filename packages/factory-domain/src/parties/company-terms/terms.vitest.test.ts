import { describe, expect, it } from 'vitest'
import { companyTermsProblems, poNumberProblem, termsInForce } from './terms'

/** Terms per company (B-W2b-290; SAL-028, SAL-013): the company's row field by field, else the party's own. */

const PARTY = { paymentTermsId: 'party-terms', paymentTerms: 'Bonifico 30 gg', priceListId: 'party-list', defaultDepositPct: '30.0000' }
const NONE = { paymentTermsId: null, paymentTerms: null, priceListId: null, depositPct: null, poNumberRequired: false }

describe('terms per company', () => {
  it("takes the party's own terms without a row of the company", () => {
    expect(termsInForce(PARTY, null)).toMatchObject({ paymentTermsId: 'party-terms', priceListId: 'party-list', depositPct: '30.0000', poNumberRequired: false, source: { paymentTerms: 'PARTY', priceList: 'PARTY', deposit: 'PARTY' } })
  })

  it("takes the company's row where it says something, field by field", () => {
    const terms = termsInForce(PARTY, { ...NONE, depositPct: '20.0000', poNumberRequired: true })
    expect(terms).toMatchObject({ paymentTermsId: 'party-terms', paymentTerms: 'Bonifico 30 gg', priceListId: 'party-list', depositPct: '20.0000', poNumberRequired: true, source: { deposit: 'COMPANY', priceList: 'PARTY' } })
    expect(termsInForce(PARTY, { ...NONE, paymentTerms: 'Anticipato' })).toMatchObject({ paymentTermsId: null, paymentTerms: 'Anticipato', source: { paymentTerms: 'COMPANY' } })
  })

  it('checks the deposit and the printed terms', () => {
    expect(companyTermsProblems({ depositPct: '0' }).map((issue) => issue.path)).toEqual(['depositPct'])
    expect(companyTermsProblems({ depositPct: '100.5' }).map((issue) => issue.path)).toEqual(['depositPct'])
    expect(companyTermsProblems({ depositPct: '35.5', paymentTerms: 'x'.repeat(501) }).map((issue) => issue.path)).toEqual(['paymentTerms'])
    expect(companyTermsProblems({ depositPct: null, paymentTerms: null })).toEqual([])
  })

  it('asks for the PO number only where the company requires it', () => {
    const who = { code: 'SEED-C1', company: 'Company A' }
    expect(poNumberProblem(false, null, who)).toBeNull()
    expect(poNumberProblem(true, ' PO-77 ', who)).toBeNull()
    expect(poNumberProblem(true, '  ', who)).toBe("SEED-C1 needs its purchase order number on every order with Company A: type the customer's PO number (customer reference) before the order is confirmed.")
  })
})
