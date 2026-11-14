import { describe, expect, it } from 'vitest'
import { ACCOUNT_CODE, keysOf, keyWords, MAPPING_KEYS, MAPPING_KINDS, mappingInForce, partyGroupOf, salesTaxKey, taxCodeKey, type MappingRow, type TaxCodeFacts } from './keys'

const code = (over: Partial<TaxCodeFacts>): TaxCodeFacts => ({ code: '22', label: 'Ordinary 22%', ratePct: '22.00', natura: null, accountCodeKey: null, validFrom: '2026-01-01', validTo: null, ...over })

describe('the account mapping keys (B-W2b-408, FIN-152)', () => {
  it('names every kind with fixed keys in words (tax codes add their own)', () => {
    expect(MAPPING_KINDS).toEqual(['ITEM_GROUP', 'TAX_CODE', 'COST_CATEGORY', 'PAYMENT_METHOD', 'PARTY_GROUP'])
    for (const kind of MAPPING_KINDS) for (const [key, words] of Object.entries(MAPPING_KEYS[kind])) expect([key, words.en.length > 0, words.it.length > 0]).toEqual([key, true, true])
    expect(Object.keys(MAPPING_KEYS.COST_CATEGORY)).toContain('VARIANCE_MATERIAL_PRICE')
    expect(Object.keys(MAPPING_KEYS.ITEM_GROUP)).toContain('LEATHER')
    expect(Object.keys(MAPPING_KEYS.ITEM_GROUP)).not.toContain('FINISHED')
  })

  it('puts a party in its group by the country it is established in', () => {
    expect([partyGroupOf('CUSTOMERS', 'IT'), partyGroupOf('CUSTOMERS', null), partyGroupOf('CUSTOMERS', 'DE'), partyGroupOf('SUPPLIERS', 'CH'), partyGroupOf('SUPPLIERS', 'GR')]).toEqual([
      'CUSTOMERS_IT',
      'CUSTOMERS_IT',
      'CUSTOMERS_EU',
      'SUPPLIERS_WORLD',
      'SUPPLIERS_EU',
    ])
  })

  it("keys a tax code by its account key, else its code; a VAT entry by the code in force for its rate and Natura", () => {
    const codes = [code({ accountCodeKey: 'VAT_SALES_22' }), code({ code: '10', ratePct: '10.00', accountCodeKey: 'VAT_10_OLD', validTo: '2025-12-31', validFrom: '2025-01-01' }), code({ code: '10', ratePct: '10.00', accountCodeKey: null, label: 'Reduced 10%' }), code({ code: 'N3.2', ratePct: '0.00', natura: 'N3.2', accountCodeKey: 'SALES_INTRA_EU' })]
    expect(taxCodeKey(codes[0]!)).toBe('VAT_SALES_22')
    expect(salesTaxKey(codes, { rate: '22.00', nature: null }, '2026-10-12')).toBe('VAT_SALES_22')
    expect(salesTaxKey(codes, { rate: '10.00', nature: null }, '2025-06-01')).toBe('VAT_10_OLD')
    expect(salesTaxKey(codes, { rate: '10.00', nature: null }, '2026-06-01')).toBe('10')
    expect(salesTaxKey(codes, { rate: '0.00', nature: 'N3.2' }, '2026-06-01')).toBe('SALES_INTRA_EU')
    // No code in force: the Natura, else the rate as a number.
    expect(salesTaxKey(codes, { rate: '4.00', nature: null }, '2026-06-01')).toBe('4')
    expect(salesTaxKey(codes, { rate: '0.00', nature: 'N2.2' }, '2026-06-01')).toBe('N2.2')
    expect(keysOf('TAX_CODE', codes)).toEqual(['VAT_SALES_22', 'VAT_10_OLD', '10', 'SALES_INTRA_EU', 'VAT_INPUT', 'WITHHOLDING'])
    expect(keyWords('TAX_CODE', '10', codes)).toEqual({ en: 'Output VAT: Reduced 10%', it: 'IVA a debito: Reduced 10%' })
    expect(keyWords('TAX_CODE', 'NOT_A_KEY', codes)).toBeNull()
  })

  it('takes the row with the latest first day on or before the day (none before its first row)', () => {
    const rows: MappingRow[] = [
      { id: 'a', kind: 'ITEM_GROUP', key: 'LEATHER', accountCode: '6101', validFrom: '2026-01-01' },
      { id: 'b', kind: 'ITEM_GROUP', key: 'LEATHER', accountCode: '6102', validFrom: '2027-01-01' },
      { id: 'c', kind: 'COST_CATEGORY', key: 'LEATHER', accountCode: '9999', validFrom: '2025-01-01' },
    ]
    expect(mappingInForce(rows, 'ITEM_GROUP', 'LEATHER', '2025-12-31')).toBeNull()
    expect(mappingInForce(rows, 'ITEM_GROUP', 'LEATHER', '2026-01-01')?.accountCode).toBe('6101')
    expect(mappingInForce(rows, 'ITEM_GROUP', 'LEATHER', '2026-12-31')?.accountCode).toBe('6101')
    expect(mappingInForce(rows, 'ITEM_GROUP', 'LEATHER', '2027-02-01')?.accountCode).toBe('6102')
  })

  it("writes accounts as the database's rule does", () => {
    expect(['6101', 'C.II.1/a', '1801-01', 'A'].every((value) => ACCOUNT_CODE.test(value))).toBe(true)
    expect(['', '-1801', '18 01', 'x'.repeat(41)].some((value) => ACCOUNT_CODE.test(value))).toBe(false)
  })
})
