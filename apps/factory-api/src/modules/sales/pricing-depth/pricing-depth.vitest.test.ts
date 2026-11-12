import { describe, expect, it } from 'vitest'
import { quoteDocument } from '@nexus/factory-domain/sales/quotes/document'
import { withLineChecks } from '../line-checks/documents'
import { customerQuoteOf, type CustomerQuoteInput } from '../quotes/frozen'

/**
 * B-W2b-325, without a database. SAL-178: the line rules' findings join the quote's send checks (a BLOCKS one stops the
 * send even when nothing else does). SAL-170: a price list that shows only net prices (PriceList.showDiscount false) prints no list price and
 * no discount on the customer's quote — the PDF and the link page are both made from the one CustomerQuote.
 */

// A Prisma Decimal as the builder reads it (its text, and a rate's two places).
const decimal = (value: string) => ({ toString: () => value, toFixed: (places: number) => (places === 2 && !value.includes('.') ? `${value}.00` : value) })
const input = (showDiscount?: boolean): CustomerQuoteInput => ({
  quote: { number: 'Q-2026-0001', customerRef: null },
  version: {
    revision: 1,
    currency: 'EUR',
    language: 'en',
    taxMode: 'IT_B2B',
    validUntil: new Date('2026-12-31T00:00:00.000Z'),
    firmOffer: false,
    promiseDate: null,
    paymentTerms: null,
    termsText: null,
    termsVersion: null,
    depositPct: null,
    depositKind: null,
    depositAmount: null,
    noWithdrawal: false,
    netAmount: 510000,
    vatAmount: 112200,
    grossAmount: 622200,
  } as never,
  lines: [
    { id: 'l', versionId: 'v', seq: 10, styleId: 's', colourwayId: 'c', description: 'Jacket', note: null, quantity: 12, listUnitPrice: decimal('435'), unitPrice: decimal('425'), netAmount: 510000, vatRatePct: decimal('22'), vatNature: null, vatAmount: 112200, sizes: [{ size: '52', quantity: 12, unitPrice: null }] },
  ] as never,
  labels: { code: () => 'SEED-JKT-01 BLK', range: () => ['52'] },
  billTo: { legalName: 'Brand', kind: 'COMPANY', country: 'IT', taxMode: 'IT_B2B', address: { line1: 'Via 1', postalCode: '00100', city: 'Roma', country: 'IT' } } as never,
  shipTo: { line1: 'Via 1', postalCode: '00100', city: 'Roma', country: 'IT' } as never,
  contact: null,
  date: '2026-11-12',
  ...(showDiscount === undefined ? {} : { showDiscount }),
})

describe('the discount on the customer documents (SAL-170)', () => {
  it('prints the list price and the discount by default, only the net price when the list hides it', () => {
    const shown = customerQuoteOf(input())
    expect(shown.lines[0]).toMatchObject({ unitPrice: '425', listUnitPrice: '435' })
    expect(quoteDocument(shown).lines[0]!.discountPercent).toBe('2.3')
    const hidden = customerQuoteOf(input(false))
    expect(hidden.lines[0]).toMatchObject({ unitPrice: '425', listUnitPrice: null, discountPct: null })
    expect(quoteDocument(hidden).lines[0]!.discountPercent).toBeNull()
    // The amounts are the same either way: only what is printed changes.
    expect(quoteDocument(hidden).lines[0]!.amountMinor).toBe(quoteDocument(shown).lines[0]!.amountMinor)
  })
})

describe('the line rules in the send checks (SAL-178)', () => {
  const check = (severity: 'BLOCKS' | 'WARNING', code = 'BELOW_MINIMUM') => ({ code: code as 'BELOW_MINIMUM', severity, path: 'lines', message: code, lineId: null, size: null })
  it('a BLOCKS finding makes a ready quote not ready, a WARNING does not; BLOCKS stay first', () => {
    expect(withLineChecks({ ready: true, checks: [] }, [check('WARNING')])).toMatchObject({ ready: true })
    const blocked = withLineChecks({ ready: true, checks: [check('WARNING', 'TERMS_VERSION')] }, [check('WARNING'), check('BLOCKS')])
    expect(blocked.ready).toBe(false)
    expect(blocked.checks.map((entry) => entry.severity)).toEqual(['BLOCKS', 'WARNING', 'WARNING'])
    const none = { ready: true, checks: [] }
    expect(withLineChecks(none, [])).toBe(none)
  })
})
