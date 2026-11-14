import { readFileSync } from 'node:fs'
import { validateXML } from 'xmllint-wasm'
import { describe, expect, it } from 'vitest'
import { nonTaxable, taxable } from '../../tax/vat-treatment'
import { fatturaPaInputOf, type IssuedInvoice } from '../document'
import { buildFatturaPa } from '../fatturapa/build'
import { FAKE_IT_BUSINESS, FAKE_SELLER } from '../fatturapa/__fixtures__/samples'
import { declarationProblems, declarationStateOf, intentAmountOf, intentIssueProblems, intentTreatment, leavesIntent, remainingOf, takesIntent, type DeclarationFacts } from './intent'

// B-W2b-392 (FIN-100): every protocol, customer and amount here is made up.
const PROTOCOL = '26000000000000099-000001'
const declaration = (values: Partial<DeclarationFacts> = {}): DeclarationFacts & { id: string } => ({
  id: 'd1',
  protocolNumber: PROTOCOL,
  protocolDate: '2026-03-02',
  year: 2026,
  amount: 100_000,
  usedAmount: 0,
  checkedAt: '2026-03-03T10:00:00.000Z',
  revokedAt: null,
  ...values,
})
const n35 = (netAmount: number, kind = 'GOODS') => ({ kind, vatNature: 'N3.5', netAmount })
const codes = (problems: { code: string }[]) => problems.map((problem) => problem.code)

describe('a declaration of intent', () => {
  it("takes the tax agency's protocol, a date not in the future, its year or the next, an amount above 0", () => {
    expect(declarationProblems({ protocolNumber: PROTOCOL, protocolDate: '2026-03-02', year: 2027, amount: 1 }, '2026-11-14')).toEqual([])
    expect(declarationProblems({ protocolNumber: '2600000000000099-000001', protocolDate: '2026-11-15', year: 2028, amount: 0 }, '2026-11-14').map((issue) => issue.path)).toEqual([
      'body/protocolNumber',
      'body/protocolDate',
      'body/year',
      'body/amount',
    ])
  })

  it('is unchecked, checked, used up or revoked; what is left never goes below 0', () => {
    expect(declarationStateOf(declaration({ checkedAt: null }))).toBe('UNCHECKED')
    expect(declarationStateOf(declaration())).toBe('CHECKED')
    expect(declarationStateOf(declaration({ usedAmount: 100_000 }))).toBe('USED_UP')
    expect(declarationStateOf(declaration({ revokedAt: '2026-04-01T00:00:00.000Z' }))).toBe('REVOKED')
    expect(remainingOf(declaration({ usedAmount: 30_000 }))).toBe(70_000)
  })

  it('an invoice uses the net of its N3.5 lines, a deposit deducted counting negative', () => {
    expect(intentAmountOf([n35(50_000), n35(-20_000, 'DEPOSIT_DEDUCTION'), { kind: 'GOODS', vatNature: null, netAmount: 9_999 }])).toBe(30_000)
    expect(intentAmountOf([n35(-1, 'DEPOSIT_DEDUCTION')])).toBe(0)
  })

  it('turns taxable goods, services and charges VAT-free, never a deduction or the stamp duty; lets go only the N3.5 lines', () => {
    expect(takesIntent({ kind: 'GOODS', vat: taxable(22) })).toBe(true)
    expect(takesIntent({ kind: 'CHARGE', chargeKind: 'FREIGHT', vat: taxable(22) })).toBe(true)
    expect(takesIntent({ kind: 'CHARGE', chargeKind: 'STAMP_DUTY', vat: nonTaxable('N1', 'Art. 15 DPR 633/1972') })).toBe(false)
    expect(takesIntent({ kind: 'DEPOSIT_DEDUCTION', vat: taxable(22) })).toBe(false)
    expect(takesIntent({ kind: 'GOODS', vat: nonTaxable('N3.1', 'Art. 8') })).toBe(false)
    expect(leavesIntent({ kind: 'GOODS', vat: intentTreatment(null) })).toBe(true)
    expect(leavesIntent({ kind: 'DEPOSIT_DEDUCTION', vat: intentTreatment(null) })).toBe(false)
    expect(intentTreatment(null)).toEqual({ kind: 'NON_TAXABLE', natura: 'N3.5', legalReference: 'Art. 8 c.1 lett. c) DPR 633/1972' })
  })
})

describe('the checks before issue (codes INTENT_*)', () => {
  const facts = (values: Partial<Parameters<typeof intentIssueProblems>[0]> = {}) => intentIssueProblems({ switchOn: true, docType: 'TD01', declaration: declaration(), lines: [n35(50_000)], issueDate: '2026-11-14', ...values })

  it('passes a checked declaration of the year with enough left', () => {
    expect(facts()).toEqual([])
  })

  it('blocks a VAT-free invoice that is invalid or used up, in words', () => {
    expect(codes(facts({ declaration: declaration({ checkedAt: null }) }))).toEqual(['INTENT_UNCHECKED'])
    expect(codes(facts({ declaration: declaration({ year: 2027 }) }))).toEqual(['INTENT_YEAR'])
    expect(codes(facts({ declaration: declaration({ revokedAt: '2026-04-01T00:00:00.000Z' }) }))).toEqual(['INTENT_REVOKED'])
    const usedUp = facts({ declaration: declaration({ usedAmount: 80_000 }) })
    expect(usedUp).toEqual([
      {
        code: 'INTENT_USED_UP',
        path: 'declarationOfIntent',
        message: `Declaration of intent ${PROTOCOL} declares 1000.00 EUR and 800.00 EUR of it is used: this invoice needs 500.00 EUR, only 200.00 EUR is left. Charge VAT on the rest, or ask the customer for a new declaration.`,
      },
    ])
    expect(codes(facts({ lines: [{ kind: 'GOODS', vatNature: null, netAmount: 100 }] }))).toEqual(['INTENT_NO_LINES'])
    expect(codes(facts({ switchOn: false }))).toEqual(['INTENT_OFF'])
  })

  it('with the switch on, N3.5 lines without a declaration are refused; with it off they stay as W1 issues them', () => {
    expect(codes(facts({ declaration: null }))).toEqual(['INTENT_MISSING'])
    expect(facts({ declaration: null, docType: 'TD04' })).toEqual([])
    expect(facts({ declaration: null, switchOn: false })).toEqual([])
  })
})

describe('printed in the XML (AltriDatiGestionali INTENTO on each N3.5 line)', () => {
  const issued: IssuedInvoice = {
    id: '00000000-0000-7000-8000-0000000000aa',
    docType: 'TD01',
    number: 'FT-2026-00099',
    issueDate: '2026-11-14',
    currency: 'EUR',
    priceBasis: 'NET',
    seller: FAKE_SELLER,
    billTo: FAKE_IT_BUSINESS,
    lines: [
      { seq: 1, kind: 'GOODS', description: 'Giacca in pelle', itemCode: null, quantity: '1.0000', uom: 'PZ', unitPrice: '500.000000', discountPct: null, vatRatePct: '0.00', vatNature: 'N3.5', vatLegalRef: 'Art. 8 c.1 lett. c) DPR 633/1972', netAmount: 50_000, grossAmount: null },
      { seq: 2, kind: 'CHARGE', description: 'Imposta di bollo assolta in modo virtuale (DM 17.6.2014)', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '2.000000', discountPct: null, vatRatePct: '0.00', vatNature: 'N1', vatLegalRef: 'Art. 15 DPR 633/1972', netAmount: 200, grossAmount: null },
    ],
    netTotal: 50_200,
    vatTotal: 0,
    grossTotal: 50_200,
    vatSummary: [],
    stampDutyAmount: 200,
    causale: null,
    purchaseOrders: [],
    ddts: [],
    declarationOfIntent: { protocolNumber: PROTOCOL, protocolDate: '2026-03-02' },
  }

  it('names the protocol and its date on the N3.5 line only, with the stamp duty, valid against the official XSD', async () => {
    const input = fatturaPaInputOf(issued)
    expect(input.lines.map((line) => line.otherData ?? null)).toEqual([[{ type: 'INTENTO', text: PROTOCOL, date: '2026-03-02' }], null])
    const xml = buildFatturaPa(input).xml
    expect(xml).toMatch(new RegExp(`<Natura>N3.5</Natura>\\s*<AltriDatiGestionali>\\s*<TipoDato>INTENTO</TipoDato>\\s*<RiferimentoTesto>${PROTOCOL}</RiferimentoTesto>\\s*<RiferimentoData>2026-03-02</RiferimentoData>\\s*</AltriDatiGestionali>`))
    expect(xml.match(/<AltriDatiGestionali>/g)).toHaveLength(1)
    expect(xml).toContain('<ImportoBollo>2.00</ImportoBollo>')
    const fixtures = new URL('../fatturapa/__fixtures__/', import.meta.url)
    const schema = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', fixtures), 'utf8')
      .replace(/^﻿/, '')
      .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', 'schemaLocation="xmldsig-core-schema.xsd"')
    const result = await validateXML({
      xml: [{ fileName: 'intent.xml', contents: xml }],
      schema: [{ fileName: 'fatturapa.xsd', contents: schema }],
      preload: [{ fileName: 'xmldsig-core-schema.xsd', contents: readFileSync(new URL('xmldsig-core-schema.xsd', fixtures), 'utf8') }],
    })
    expect(result.errors.map((error) => error.rawMessage)).toEqual([])
  })

  it('without a declaration nothing is added', () => {
    expect(fatturaPaInputOf({ ...issued, declarationOfIntent: null }).lines.every((line) => line.otherData === undefined)).toBe(true)
  })
})
