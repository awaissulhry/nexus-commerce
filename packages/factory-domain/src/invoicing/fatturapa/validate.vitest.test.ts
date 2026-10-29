import { describe, expect, it } from 'vitest'
import { buildFatturaPa, checkFatturaPaInput } from './build'
import { fatturaPaText } from './format'
import {
  FAKE_EU_BUSINESS,
  FAKE_IT_BUSINESS,
  FAKE_IT_CONSUMER,
  FAKE_SELLER,
  TD01_EU_B2B,
  TD01_IT_B2B,
  TD02_IT_B2B_DEPOSIT,
  TD02_IT_B2B_DEPOSIT_DOC,
  TD04_IT_B2B_CREDIT_NOTE,
  TD24_IT_B2B_WITH_DEPOSIT,
} from './__fixtures__/samples'
import { FatturaPaInputError, type FatturaPaBuyer, type FatturaPaInvoiceInput } from './types'
import { taxable } from '../../tax/vat-treatment'

/** "path CODE" for each issue, to compare compactly. */
const issuesOf = (input: FatturaPaInvoiceInput): string[] =>
  checkFatturaPaInput(input).map((issue) => `${issue.path} ${issue.code}`)

const withBuyer = (buyer: FatturaPaBuyer): FatturaPaInvoiceInput => ({ ...TD01_IT_B2B, buyer })
const lineOf = TD01_IT_B2B.lines[0]!
const oneLine = (changes: Partial<typeof lineOf>): FatturaPaInvoiceInput => ({
  ...TD01_IT_B2B,
  lines: [{ ...lineOf, ...changes }],
  payment: undefined,
})

describe('the samples are valid input', () => {
  it('has no issue', () => {
    expect(issuesOf(TD01_IT_B2B)).toEqual([])
  })
})

describe('tax identifiers', () => {
  it('refuses a Partita IVA with a wrong check digit, or with the IT prefix', () => {
    expect(issuesOf({ ...TD01_IT_B2B, seller: { ...FAKE_SELLER, vatNumber: '12345670008' } })).toEqual([
      'seller.vatNumber PARTITA_IVA_INVALID',
    ])
    expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, vatNumber: 'IT76543210009' }))).toEqual(['buyer.vatNumber VAT_PREFIX'])
  })

  it('normalises spaces and case in tax ids', () => {
    expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, vatNumber: ' 765 4321 0009 ' }))).toEqual([])
    expect(issuesOf({ ...TD02_IT_B2B_DEPOSIT, buyer: { ...FAKE_IT_CONSUMER, fiscalCode: 'tstprv80a41z999i' } })).toEqual([])
  })

  it('refuses a codice fiscale with a wrong check letter', () => {
    expect(issuesOf({ ...TD02_IT_B2B_DEPOSIT, buyer: { ...FAKE_IT_CONSUMER, fiscalCode: 'TSTPRV80A41Z999J' } })).toEqual([
      'buyer.fiscalCode CODICE_FISCALE_INVALID',
    ])
  })

  it('refuses the buyer being the seller (SDI 00471)', () => {
    expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, vatNumber: FAKE_SELLER.vatNumber }))).toEqual([
      'buyer.vatNumber BUYER_IS_SELLER',
    ])
  })
})

describe('SDI code or PEC', () => {
  it('refuses a 6-character code (public bodies, FPA12), XXXXXXX for an Italian buyer, and a malformed code', () => {
    expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, sdiCode: 'UFABCD' }))).toEqual(['buyer.sdiCode SDI_CODE_PUBLIC_ADMINISTRATION'])
    expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, sdiCode: 'XXXXXXX' }))).toEqual(['buyer.sdiCode SDI_CODE_FOREIGN'])
    expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, sdiCode: 'AB-1234' }))).toEqual(['buyer.sdiCode SDI_CODE_INVALID'])
  })

  it('refuses a PEC that is not an e-mail address, or holds characters the schema refuses', () => {
    for (const pec of ['not-an-address', 'a,b@pec.example', 'a b@pec.example', 'x@localhost']) {
      expect(issuesOf(withBuyer({ ...FAKE_IT_BUSINESS, sdiCode: undefined, pec }))).toEqual(['buyer.pec EMAIL_INVALID'])
    }
  })

  it('accepts a foreign company identified for VAT in Italy, with its address abroad', () => {
    const buyer: FatturaPaBuyer = { ...FAKE_IT_BUSINESS, address: { street: 'Musterstraße', postcode: '10115', city: 'Berlin', country: 'DE' } }
    expect(issuesOf(withBuyer(buyer))).toEqual([])
  })
})

describe('foreign buyers', () => {
  it('refuses IT as the country of a foreign buyer (SDI 00313: XXXXXXX needs another country)', () => {
    expect(issuesOf({ ...TD01_EU_B2B, buyer: { ...FAKE_EU_BUSINESS, country: 'IT' } })).toEqual(['buyer.country FOREIGN_BUYER_ITALIAN'])
  })

  it('refuses an EU VAT number written with its country prefix, and a missing tax id', () => {
    expect(issuesOf({ ...TD01_EU_B2B, buyer: { ...FAKE_EU_BUSINESS, taxId: 'DE999999999' } })).toEqual(['buyer.taxId VAT_PREFIX'])
    expect(issuesOf({ ...TD01_EU_B2B, buyer: { ...FAKE_EU_BUSINESS, taxId: ' ' } })).toEqual(['buyer.taxId REQUIRED'])
  })

  it('needs a name, or a first and last name, not both', () => {
    const both = { ...FAKE_EU_BUSINESS, firstName: 'Ana', lastName: 'Test' } as FatturaPaBuyer
    expect(issuesOf({ ...TD01_EU_B2B, buyer: both })).toEqual(['buyer NAME_AND_PERSON'])
  })

  it('refuses a province on a foreign address', () => {
    const buyer = { ...FAKE_EU_BUSINESS, address: { ...FAKE_EU_BUSINESS.address, province: 'BE' } } as FatturaPaBuyer
    expect(issuesOf({ ...TD01_EU_B2B, buyer })).toEqual(['buyer.address.province PROVINCE_ABROAD'])
  })
})

describe('Italian addresses', () => {
  it('needs a 5-digit postcode and a 2-letter province', () => {
    const buyer = { ...FAKE_IT_BUSINESS, address: { ...FAKE_IT_BUSINESS.address, postcode: '4012', province: 'Bologna' } } as FatturaPaBuyer
    expect(issuesOf(withBuyer(buyer))).toEqual(['buyer.address.postcode CAP_INVALID', 'buyer.address.province PROVINCE_INVALID'])
  })
})

describe('amounts and text', () => {
  it('refuses a JavaScript number for an amount (decimals only)', () => {
    expect(issuesOf(oneLine({ quantity: 3 as unknown as string }))).toEqual(['lines[0].quantity DECIMAL_INVALID'])
  })

  it('refuses more than 8 decimals, a zero quantity, a negative price and a 100% discount', () => {
    expect(issuesOf(oneLine({ unitPrice: '1.123456789' }))).toEqual(['lines[0].unitPrice DECIMAL_PLACES'])
    expect(issuesOf(oneLine({ quantity: '0' }))).toEqual(['lines[0].quantity NOT_POSITIVE'])
    expect(issuesOf(oneLine({ unitPrice: '-1.00' }))).toEqual(['lines[0].unitPrice NEGATIVE'])
    expect(issuesOf(oneLine({ discountPercent: '100' }))).toEqual(['lines[0].discountPercent DISCOUNT_INVALID'])
  })

  it('carries typed text in Latin-1: dashes, curly quotes, the ellipsis, no-break spaces and the euro sign become plain', () => {
    const typed = 'Giacca \u2014 Rosso \u201cGolden\u201d \u2026 prezzo 389\u00a0\u20ac \u2013 taglia\u202f52'
    expect(issuesOf(oneLine({ description: typed }))).toEqual([])
    const xml = buildFatturaPa(oneLine({ description: typed })).xml
    expect(xml).toContain('Giacca - Rosso')
    expect(xml).toContain('Golden')
    expect(xml).toContain('... prezzo 389 EUR - taglia 52')
    expect(xml).not.toMatch(/[\u2013\u2014\u2026\u201c\u201d\u00a0\u202f\u20ac]/)
  })

  it('refuses a character with no close Latin-1 form, naming the field and the character, and never builds the file', () => {
    const issues = checkFatturaPaInput(oneLine({ description: 'Giacca \u2713 collaudata' }))
    expect(issues.map((issue) => `${issue.path} ${issue.code}`)).toEqual(['lines[0].description NOT_LATIN1'])
    expect(issues[0]!.message).toBe('holds "\u2713" (U+2713), which FatturaPA cannot carry and which has no close Latin-1 form; replace it')
    expect(() => buildFatturaPa(oneLine({ description: 'Giacca \u2713 collaudata' }))).toThrow(FatturaPaInputError)
    expect(issuesOf({ ...TD01_IT_B2B, causale: '\u65e5\u672c' })).toEqual(['causale NOT_LATIN1'])
  })

  it('a deposit deducted from goods typed with a dash matches their VAT (no false DEPOSIT_TREATMENT_UNMATCHED)', () => {
    // The golden flow's invoice: the goods lines named "<style> — <colour>, taglia <n>" were refused, so no goods line
    // was left to match the deposit's VAT. Carried as "-", every line counts and the deduction matches.
    const dashed: FatturaPaInvoiceInput = {
      ...TD24_IT_B2B_WITH_DEPOSIT,
      lines: TD24_IT_B2B_WITH_DEPOSIT.lines.map((line) => ({ ...line, description: line.description.replace(', ', ' \u2014 ') })),
    }
    expect(issuesOf(dashed)).toEqual([])
    expect(buildFatturaPa(dashed).xml).toContain('Giacca moto in pelle - rosso, taglia 52')
  })

  it('refuses an invoice number without a digit (SDI 00425) and a non-EUR currency', () => {
    expect(issuesOf({ ...TD01_IT_B2B, number: 'ABC' })).toEqual(['number NUMBER_WITHOUT_DIGIT'])
    expect(issuesOf({ ...TD01_IT_B2B, currency: 'USD' as 'EUR' })).toEqual(['currency CURRENCY_NOT_BUILT'])
  })

  it('refuses a gross line whose derived unit price cannot multiply back within a cent (SDI 00423)', () => {
    const huge: FatturaPaInvoiceInput = { ...oneLine({ quantity: '1000000000', unitPrice: '0.07', discountPercent: undefined }), priceBasis: 'GROSS' }
    expect(issuesOf(huge)).toEqual(['lines[0] LINE_UNIT_PRICE_ROUNDING'])
  })

  it('refuses a date that does not exist', () => {
    expect(issuesOf({ ...TD01_IT_B2B, date: '2026-02-30' })).toEqual(['date DATE_INVALID'])
  })
})

describe('VAT treatments', () => {
  it('refuses a rate Italy does not have, a retired parent Natura code (SDI 00445) and a missing wording', () => {
    expect(issuesOf(oneLine({ vat: { kind: 'TAXABLE', rate: 21 as 22 } }))).toEqual(['lines[0].vat.rate VAT_RATE_INVALID'])
    expect(issuesOf(oneLine({ vat: { kind: 'NON_TAXABLE', natura: 'N3' as 'N3.1', legalReference: 'x' } }))).toEqual([
      'lines[0].vat.natura NATURA_RETIRED',
    ])
    expect(issuesOf(oneLine({ vat: { kind: 'NON_TAXABLE', natura: 'N3.2', legalReference: '' } }))).toEqual([
      'lines[0].vat.legalReference REQUIRED',
    ])
  })
})

describe('document types', () => {
  it('DPR 633/1972 art. 21 c.4 — a TD24 needs its DDTs', () => {
    expect(issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, ddts: [], lines: TD24_IT_B2B_WITH_DEPOSIT.lines.map(({ ddtNumber: _, ...line }) => line) })).toEqual([
      'ddts TD24_NEEDS_DDT',
    ])
  })

  it('DPR 633/1972 art. 21 c.4 — a TD24 covers DDTs of one calendar month and is issued by the 15th of the next', () => {
    expect(
      issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, ddts: [{ number: 'D-0107', date: '2026-09-30' }, { number: 'D-0112', date: '2026-10-27' }] }),
    ).toEqual(['ddts TD24_DDTS_MONTHS'])
    const lateInput = { ...TD24_IT_B2B_WITH_DEPOSIT, date: '2026-11-16' }
    expect(issuesOf(lateInput)).toEqual(['date TD24_LATE'])
    expect(issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, date: '2026-11-15' })).toEqual([])
  })

  it('a DDT cannot be dated after the invoice; with several DDTs each line names its DDT', () => {
    expect(issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, date: '2026-10-25' })).toEqual(['ddts[1].date DDT_AFTER_INVOICE'])
    const [first, second, third] = TD24_IT_B2B_WITH_DEPOSIT.lines
    expect(issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, lines: [first!, second!, { ...third!, ddtNumber: undefined }] })).toEqual([
      'lines[2].ddtNumber LINE_DDT_MISSING',
      'ddts[1] DDT_WITHOUT_LINES',
    ])
    expect(issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, lines: [first!, second!, { ...third!, ddtNumber: 'D-9999' }] })).toContain(
      'lines[2].ddtNumber LINE_DDT_UNKNOWN',
    )
  })

  it('DPR 633/1972 art. 26 — a TD04 names the invoice it corrects, not dated after the credit note (SDI 00418)', () => {
    expect(issuesOf({ ...TD04_IT_B2B_CREDIT_NOTE, relatedInvoices: [] })).toEqual(['relatedInvoices TD04_NEEDS_INVOICE'])
    expect(issuesOf({ ...TD04_IT_B2B_CREDIT_NOTE, relatedInvoices: [{ number: '2026/0101', date: '2026-10-13' }] })).toEqual([
      'relatedInvoices[0].date RELATED_AFTER_INVOICE',
    ])
  })

  it('a TD02 or a TD04 cannot deduct a deposit or invoice DDTs', () => {
    const deduction = TD24_IT_B2B_WITH_DEPOSIT.depositDeductions!
    expect(issuesOf({ ...TD02_IT_B2B_DEPOSIT, depositDeductions: deduction })).toContain('depositDeductions DEPOSIT_DEDUCTION_NOT_ALLOWED')
    expect(issuesOf({ ...TD02_IT_B2B_DEPOSIT, ddts: [{ number: 'D-1', date: '2026-09-20' }] })).toEqual(['ddts DDT_NOT_ALLOWED'])
  })
})

describe('deposits deducted', () => {
  it('refuses a deposit larger than the lines it is deducted from', () => {
    const small: FatturaPaInvoiceInput = {
      ...TD24_IT_B2B_WITH_DEPOSIT,
      lines: [{ description: 'Guanti', quantity: '1', unitPrice: '45.00', vat: taxable(22) }],
      ddts: [{ number: 'D-0107', date: '2026-10-20' }],
      payment: undefined,
    }
    expect(issuesOf(small)).toEqual(['depositDeductions DEPOSIT_EXCEEDS_LINES'])
  })

  it('refuses a deposit VAT that is not the rate on its taxable amount, or a treatment no line has', () => {
    const wrongVat = { ...TD24_IT_B2B_WITH_DEPOSIT, depositDeductions: [{ invoiceNumber: '2026/A007', invoiceDate: '2026-09-20', amounts: [{ vat: taxable(22), taxable: '1500.00', vatAmount: '300.00' }] }] }
    expect(issuesOf(wrongVat)).toEqual(['depositDeductions[0].amounts[0].vatAmount DEPOSIT_VAT_MISMATCH'])
    const otherRate = { ...TD24_IT_B2B_WITH_DEPOSIT, depositDeductions: [{ invoiceNumber: '2026/A007', invoiceDate: '2026-09-20', amounts: [{ vat: taxable(10), taxable: '100.00', vatAmount: '10.00' }] }] }
    expect(issuesOf(otherRate)).toEqual(['depositDeductions[0].amounts[0].vat DEPOSIT_TREATMENT_UNMATCHED'])
  })

  it('refuses a deposit invoice dated after the final invoice (SDI 00418)', () => {
    const deduction = { ...TD24_IT_B2B_WITH_DEPOSIT.depositDeductions![0]!, invoiceDate: '2026-11-01' }
    expect(issuesOf({ ...TD24_IT_B2B_WITH_DEPOSIT, depositDeductions: [deduction] })).toEqual([
      'depositDeductions[0].invoiceDate RELATED_AFTER_INVOICE',
    ])
  })

  it('deducts part of a deposit when the deposit is used over several invoices', () => {
    const partial = {
      ...TD24_IT_B2B_WITH_DEPOSIT,
      depositDeductions: [{ invoiceNumber: TD02_IT_B2B_DEPOSIT_DOC.number, invoiceDate: TD02_IT_B2B_DEPOSIT_DOC.date, amounts: [{ vat: taxable(22), taxable: '750.00', vatAmount: '165.00' }] }],
      payment: { condition: 'TP02' as const, installments: [{ method: 'MP05' as const, amount: '5185.00' }] },
    }
    expect(buildFatturaPa(partial).totals.total.toFixed(2)).toBe('5185.00') // (5000 - 750) x 1.22
  })
})

describe('payment terms', () => {
  it('the payments add up to the amount due', () => {
    const input = { ...TD01_IT_B2B, payment: { condition: 'TP02' as const, installments: [{ method: 'MP05' as const, amount: '2080.42' }] } }
    const [issue] = checkFatturaPaInput(input)
    expect(issue?.code).toBe('PAYMENT_SUM_MISMATCH')
    expect(issue?.message).toContain('2080.43')
  })

  it('TP01 has two or more instalments; an IBAN must be valid', () => {
    expect(issuesOf({ ...TD01_IT_B2B, payment: { condition: 'TP01', installments: [{ method: 'MP05', amount: '2080.43' }] } })).toEqual([
      'payment.installments INSTALLMENTS_COUNT',
    ])
    expect(issuesOf({ ...TD01_IT_B2B, payment: { condition: 'TP02', installments: [{ method: 'MP05', amount: '2080.43', iban: 'IT00X9999999999000000000001' }] } })).toEqual([
      'payment.installments[0].iban IBAN_INVALID',
    ])
    const split = { condition: 'TP01' as const, installments: [{ method: 'MP12' as const, amount: '1040.21', dueDate: '2026-11-30' }, { method: 'MP12' as const, amount: '1040.22', dueDate: '2026-12-31' }] }
    expect(issuesOf({ ...TD01_IT_B2B, payment: split })).toEqual([])
  })
})

describe('errors', () => {
  it('lists every issue at once, and buildFatturaPa throws them as FatturaPaInputError', () => {
    const broken: FatturaPaInvoiceInput = {
      ...TD01_IT_B2B,
      number: 'X',
      seller: { ...FAKE_SELLER, vatNumber: '1' },
      buyer: { ...FAKE_IT_BUSINESS, sdiCode: '123' },
      lines: [{ ...lineOf, quantity: '-1' }],
    }
    const issues = checkFatturaPaInput(broken)
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['NUMBER_WITHOUT_DIGIT', 'PARTITA_IVA_INVALID', 'SDI_CODE_INVALID', 'NOT_POSITIVE']),
    )
    let thrown: unknown
    try {
      buildFatturaPa(broken)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(FatturaPaInputError)
    expect((thrown as FatturaPaInputError).issues).toEqual(issues)
    expect((thrown as FatturaPaInputError).message).toContain('seller.vatNumber')
  })
})

describe('fatturaPaText: what the file carries of typed text', () => {
  it('maps typographic forms and drops accents only where the field has no room for them', () => {
    expect(fatturaPaText('Giacca \u2014 Rosso, taglia 50')).toEqual({ ok: true, text: 'Giacca - Rosso, taglia 50' })
    expect(fatturaPaText('\u2018a\u2019 \u201cb\u201d \u2032 \u2033 \u2212 \u2010 \u2022 \u2122')).toEqual({ ok: true, text: `'a' "b" ' " - - - (TM)` })
    expect(fatturaPaText('Via\u00a0Roma\u202f5\tint.\n2\u200b\ufeff')).toEqual({ ok: true, text: 'Via Roma 5 int. 2' })
    // Latin-1 letters stay in a Latin-1 field; others lose what Latin-1 cannot hold.
    expect(fatturaPaText('Citt\u00e0 M\u00fcller Stra\u00dfe \u00c6ble')).toEqual({ ok: true, text: 'Citt\u00e0 M\u00fcller Stra\u00dfe \u00c6ble' })
    expect(fatturaPaText('\u0141\u00f3d\u017a \u0152uvre \ufb01ne \uff21\uff22\uff23 e\u0301')).toEqual({ ok: true, text: 'L\u00f3dz OEuvre fine ABC \u00e9' })
    // A basic-Latin field: no accent, no Latin-1 symbol.
    expect(fatturaPaText('Citt\u00e0 M\u00fcller Stra\u00dfe \u00c6ble \u00abx\u00bb', 'ASCII')).toEqual({ ok: true, text: 'Citta Muller Strasse AEble "x"' })
  })

  it('names the first character it cannot map, with its code point', () => {
    expect(fatturaPaText('ok \u2713')).toEqual({ ok: false, character: '\u2713', codePoint: 'U+2713' })
    expect(fatturaPaText('\u65e5\u672c')).toEqual({ ok: false, character: '\u65e5', codePoint: 'U+65E5' })
    expect(fatturaPaText('\ud83d\ude00')).toEqual({ ok: false, character: '\ud83d\ude00', codePoint: 'U+1F600' })
  })
})
