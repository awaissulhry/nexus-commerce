import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateXML } from 'xmllint-wasm'
import { Dec } from '../../tax/decimal'
import { LEGAL_WORDING, nonTaxable, taxable, treatmentKey } from '../../tax/vat-treatment'
import { creditable, creditCausale, creditNoteDraft, creditProblems, refundDueAfter, type CreditedInvoice } from '../credit-note/credit-note'
import { fatturaPaInputOf, type IssuedInvoice } from '../document'
import { buildFatturaPa } from '../fatturapa/build'
import { computeInvoiceTotals, storedVatOf } from '../invoices'
import { addDays, chooseInvoiceType, daysBetween, deferredDeadline, immediateDeadline } from './deadlines'
import { deductionProblems, planDeductions, type DepositInvoiceFacts } from './deductions'
import { orderSettlement, type SettlementFacts } from './settlement'
import { ddtInvoiceProblems, draftGoodsLines, notInvoiced, type InvoicedQuantity, type OrderLinePrice, type ShippedQuantity } from './shipped'

// Every company, party, VAT number, order and amount here is made up (the FatturaPA samples' fake numbers: office 000).

const FIXTURES = new URL('../fatturapa/__fixtures__/', import.meta.url)
const DSIG = 'xmldsig-core-schema.xsd'
const schema = readFileSync(new URL('Schema_VFPR12_v1.2.3.xsd', FIXTURES), 'utf8')
  .replace(/^﻿/, '')
  .replace('schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"', `schemaLocation="${DSIG}"`)
const xsdErrors = async (xml: string) =>
  (await validateXML({ xml: [{ fileName: 'invoice.xml', contents: xml }], schema: [{ fileName: 'fatturapa.xsd', contents: schema }], preload: [{ fileName: DSIG, contents: readFileSync(new URL(DSIG, FIXTURES), 'utf8') }] })).errors.map((error) => error.rawMessage)

const IT22 = taxable(22)
const N32 = nonTaxable('N3.2', LEGAL_WORDING.INTRA_EU_SUPPLY)
const D1 = '019a0000-0000-7000-8000-0000000000d1'
const D2 = '019a0000-0000-7000-8000-0000000000d2'
const L1 = '019a0000-0000-7000-8000-0000000000a1'
const L2 = '019a0000-0000-7000-8000-0000000000a2'

describe('TD01 or TD24, and by when (DPR 633/1972 art. 21 c.4; FIN-055, FIN-065)', () => {
  it('counts days on business dates', () => {
    expect(addDays('2026-10-25', 12)).toBe('2026-11-06')
    expect(addDays('2026-12-28', 12)).toBe('2027-01-09')
    expect(daysBetween('2026-10-29', '2026-11-06')).toBe(8)
  })

  it('one DDT within its 12 days: an immediate invoice (TD01), a TD24 allowed too', () => {
    const choice = chooseInvoiceType([{ number: '12/2026', date: '2026-10-25' }], '2026-10-29')
    expect(choice).toMatchObject({ docType: 'TD01', suggested: 'TD01', allowed: ['TD01', 'TD24'], deadline: { docType: 'TD01', dueBy: '2026-11-06', daysLeft: 8, state: 'OPEN' }, deferred: { dueBy: '2026-11-15' } })
    expect(choice.deadline!.words).toBe('Immediate invoice (TD01) by 06/11/2026, 12 days after DDT 12/2026 of 25/10/2026 (DPR 633/1972 art. 21 c.4): 8 days left.')
    expect(chooseInvoiceType([{ number: '12/2026', date: '2026-10-25' }], '2026-10-29', 'TD24')).toMatchObject({ docType: 'TD24', deadline: { dueBy: '2026-11-15' } })
  })

  it('several DDTs of a month, or one past its 12 days: a deferred invoice (TD24) by the 15th of the next month', () => {
    const several = chooseInvoiceType([{ number: '12/2026', date: '2026-10-02' }, { number: '15/2026', date: '2026-10-20' }], '2026-11-12')
    expect(several).toMatchObject({ docType: 'TD24', allowed: ['TD24'], deadline: { dueBy: '2026-11-15', daysLeft: 3, state: 'DUE_SOON' } })
    expect(chooseInvoiceType([{ number: '12/2026', date: '2026-10-02' }], '2026-10-20')).toMatchObject({ docType: 'TD24', allowed: ['TD24'] })
    const tooMany = chooseInvoiceType([{ number: '12/2026', date: '2026-10-02' }, { number: '15/2026', date: '2026-10-20' }], '2026-10-21', 'TD01')
    expect(tooMany.docType).toBeNull()
    expect(tooMany.problems[0]!.message).toContain('several DDTs make a deferred invoice (TD24)')
  })

  it('DDTs of two months make two invoices; both limits passed: late, one TD01 per DDT', () => {
    expect(chooseInvoiceType([{ number: '1', date: '2026-09-30' }, { number: '2', date: '2026-10-01' }], '2026-10-02').problems[0]!.message).toContain('one invoice per month')
    expect(chooseInvoiceType([{ number: '1', date: '2026-09-02' }], '2026-10-20')).toMatchObject({ docType: 'TD01', allowed: ['TD01'], deadline: { state: 'LATE', daysLeft: -36 } })
    expect(chooseInvoiceType([{ number: '1', date: '2026-09-02' }, { number: '2', date: '2026-09-03' }], '2026-10-20').problems[0]!.message).toContain('it is late')
    expect(immediateDeadline({ number: '1', date: '2026-10-17' }, '2026-10-29').words).toContain('due today')
    expect(deferredDeadline('2026-12', '2027-01-16')).toMatchObject({ dueBy: '2027-01-15', state: 'LATE' })
  })
})

describe('shipped, not invoiced (FIN-054, FIN-116)', () => {
  const shipped: ShippedQuantity[] = [
    { ddtId: D1, salesOrderLineId: L1, size: '52', quantity: 1 },
    { ddtId: D1, salesOrderLineId: L1, size: '52', quantity: 1 },
    { ddtId: D1, salesOrderLineId: L2, size: '50', quantity: 3 },
  ]
  const billed = (quantity: string, draft: boolean, line = L1, size = '52'): InvoicedQuantity => ({ invoiceId: draft ? 'draft-1' : 'inv-1', number: draft ? null : 'FT-2026-00005', draft, ddtId: D1, salesOrderLineId: line, size, quantity })

  it('per DDT, order line and size: shipped less issued, and what drafts hold apart', () => {
    const rows = notInvoiced(shipped, [billed('1.0000', false), billed('2.0000', true, L2, '50')])
    expect(rows.map((row) => [row.size, row.shipped.toString(), row.invoiced.toString(), row.inDraft.toString(), row.notInvoiced.toString(), row.toInvoice.toString()])).toEqual([
      ['52', '2', '1', '0', '1', '1'],
      ['50', '3', '0', '2', '3', '1'],
    ])
  })

  it('the issue never bills a DDT twice: beyond what it carried less other issued invoices is refused in words', () => {
    const ddts = new Map([[D1, { id: D1, number: '12/2026', cancelled: false, shipmentStatus: 'SHIPPED' }]])
    const line = (quantity: string) => ({ seq: 1, kind: 'GOODS', ddtId: D1, salesOrderLineId: L1, size: '52', quantity })
    expect(ddtInvoiceProblems([line('2.0000')], ddts, shipped, [])).toEqual([])
    const twice = ddtInvoiceProblems([line('2.0000')], ddts, shipped, [billed('2.0000', false)])
    expect(twice).toMatchObject([{ code: 'DDT_INVOICED', path: 'lines/0/quantity' }])
    expect(twice[0]!.message).toBe('DDT 12/2026 carried 2 of size 52 of this order line and 2 are invoiced already (FT-2026-00005): line 1 bills 2. Shipped goods are invoiced once; a correction is a credit note.')
    expect(ddtInvoiceProblems([line('2.0000')], ddts, shipped, [billed('2.0000', true)])).toEqual([]) // a draft is not invoiced
    expect(ddtInvoiceProblems([{ ...line('1.0000'), size: '54' }], ddts, shipped, []).map((problem) => problem.code)).toEqual(['DDT_NOT_CARRIED'])
    expect(ddtInvoiceProblems([line('1.0000')], new Map([[D1, { id: D1, number: '12/2026', cancelled: true, shipmentStatus: 'SHIPPED' }]]), shipped, []).map((problem) => problem.code)).toEqual(['DDT_CANCELLED'])
    expect(ddtInvoiceProblems([line('1.0000')], new Map([[D1, { id: D1, number: '12/2026', cancelled: false, shipmentStatus: 'PACKED' }]]), shipped, []).map((problem) => problem.code)).toEqual(['DDT_NOT_SHIPPED'])
  })

  it('the goods lines: one per DDT, order line and size, at the size price else the line price, VAT by the rules', () => {
    const price = (id: string, description: string, unitPrice: string, sizes: Record<string, string | null> = {}): OrderLinePrice => ({ salesOrderLineId: id, orderId: 'o1', orderNumber: 'SO-0001', description, itemCode: 'JKT-03-BLK', unitPrice, sizePrices: sizes, vatRatePct: '22.00' })
    const prices = new Map([[L1, price(L1, 'Giacca moto nera', '420.000000', { '52': '430.000000' })], [L2, price(L2, 'Pantalone', '200.000000')]])
    const { lines, problems } = draftGoodsLines(
      [
        { ddtId: D2, ddtNumber: '15/2026', ddtDate: '2026-10-20', salesOrderLineId: L2, size: '50', quantity: new Dec(3) },
        { ddtId: D1, ddtNumber: '12/2026', ddtDate: '2026-10-02', salesOrderLineId: L1, size: '52', quantity: new Dec(2) },
      ],
      prices,
      () => IT22,
    )
    expect(problems).toEqual([])
    expect(lines.map((line) => [line.ddtId, line.core.description, line.core.itemCode, line.core.quantity, line.core.unitPrice])).toEqual([
      [D1, 'Giacca moto nera, taglia 52', 'JKT-03-BLK-52', '2.0000', '430.000000'],
      [D2, 'Pantalone, taglia 50', 'JKT-03-BLK-50', '3.0000', '200.000000'],
    ])
    expect(draftGoodsLines([{ ddtId: D1, ddtNumber: '12/2026', ddtDate: '2026-10-02', salesOrderLineId: 'missing', size: '52', quantity: new Dec(1) }], prices, () => IT22).problems).toHaveLength(1)
  })
})

describe('the deposit deducted on the final invoice (FIN-078)', () => {
  const td02 = (overrides: Partial<DepositInvoiceFacts> = {}): DepositInvoiceFacts => ({
    id: 'td02-1',
    companyId: 'c1',
    docType: 'TD02',
    status: 'DELIVERED',
    number: 'FT-2026-00004',
    issueDate: '2026-10-01',
    netTotal: 24590,
    grossTotal: 30000,
    entries: [{ treatment: IT22, taxable: 24590, vat: 5410 }],
    creditedNet: 0,
    creditedGross: 0,
    deductedNet: 0,
    deductedBy: [],
    ...overrides,
  })
  const goods = new Map([[treatmentKey(IT22), 84000]])

  it('the whole TD02 at once, with its own gross: a negative line with its treatment', () => {
    const plan = planDeductions([td02()], goods, 'EUR')
    expect(plan.skipped).toEqual([])
    expect(plan.lines).toEqual([
      { depositInvoiceId: 'td02-1', core: { kind: 'DEPOSIT_DEDUCTION', description: 'Storno acconto fattura n. FT-2026-00004 del 01/10/2026', itemCode: null, quantity: '1', uom: null, unitPrice: '-245.900000', discountPct: null, vat: IT22, deduction: { netAmount: -24590, grossAmount: -30000 } } },
    ])
  })

  it('never twice, never above its net less its credits, never below 0 for the invoice, never a rejected or foreign-treatment TD02', () => {
    expect(planDeductions([td02({ deductedNet: 24590, deductedBy: ['FT-2026-00005'] })], goods, 'EUR')).toMatchObject({ lines: [], skipped: [{ reason: 'Deposit invoice FT-2026-00004 is deducted already (FT-2026-00005).' }] })
    expect(planDeductions([td02({ creditedNet: 10000, creditedGross: 12200 })], goods, 'EUR').lines[0]!.core.deduction).toEqual({ netAmount: -14590, grossAmount: -17800 })
    expect(planDeductions([td02()], new Map([[treatmentKey(IT22), 10000]]), 'EUR').lines[0]!.core.deduction).toEqual({ netAmount: -10000, grossAmount: -12200 })
    expect(planDeductions([td02({ status: 'REJECTED' })], goods, 'EUR').skipped[0]!.reason).toContain('rejected by SDI')
    expect(planDeductions([td02()], new Map([[treatmentKey(N32), 84000]]), 'EUR').skipped[0]!.reason).toContain('taxed otherwise')
  })

  it('at issue: above the TD02 net (less credits, less other issued invoices) is refused in words', () => {
    const deposits = new Map([['td02-1', td02({ deductedNet: 20000, deductedBy: ['FT-2026-00005'] })]])
    const problems = deductionProblems('c1', [{ index: 1, depositInvoiceId: 'td02-1', netAmount: -24590 }], deposits, 'EUR')
    expect(problems).toMatchObject([{ code: 'DEDUCTION_OVER', path: 'lines/1' }])
    expect(problems[0]!.message).toContain('Deposit invoice FT-2026-00004 has a net of 245.90 EUR; 0.00 EUR of it is credited and 200.00 EUR deducted already (FT-2026-00005)')
    expect(deductionProblems('c1', [{ index: 1, depositInvoiceId: 'td02-1', netAmount: -4590 }], deposits, 'EUR')).toEqual([])
    expect(deductionProblems('c2', [{ index: 1, depositInvoiceId: 'td02-1', netAmount: -1 }], deposits, 'EUR').map((problem) => problem.code)).toEqual(['DEDUCTION_STATE'])
  })

  it('a TD24 of a DDT with the deposit deducted is XSD-valid and totals goods + VAT - deposit', async () => {
    const plan = planDeductions([td02()], goods, 'EUR')
    const core = [{ kind: 'GOODS' as const, description: 'Giacca moto nera, taglia 52', itemCode: 'JKT-03-BLK-52', quantity: '2.0000', uom: 'PZ', unitPrice: '420.000000', vat: IT22 }, plan.lines[0]!.core]
    const totals = computeInvoiceTotals(core, 'NET', 'EUR')
    expect([totals.netTotal, totals.vatTotal, totals.grossTotal]).toEqual([59410, 13070, 72480])
    const invoice: IssuedInvoice = {
      id: '019a0000-0000-7000-8000-000000000024',
      docType: 'TD24',
      number: 'FT-2026-00005',
      issueDate: '2026-10-29',
      currency: 'EUR',
      priceBasis: 'NET',
      seller: { vatNumber: '12345670009', name: 'Pelletteria Fittizia S.r.l.', taxRegime: 'RF01', address: { street: 'Via dei Conciatori Finti 1', postcode: '20121', city: 'Milano', province: 'MI', country: 'IT' } },
      billTo: { kind: 'IT_BUSINESS', vatNumber: '76543210009', name: 'Cliente Fittizio S.r.l.', address: { street: 'Viale delle Prove 42', postcode: '40121', city: 'Bologna', province: 'BO', country: 'IT' }, sdiCode: 'FAKE001' },
      lines: core.map((line, index) => ({
        seq: index + 1,
        kind: line.kind,
        description: line.description,
        itemCode: line.itemCode ?? null,
        quantity: new Dec(line.quantity).toFixed(4),
        uom: line.uom ?? null,
        unitPrice: line.unitPrice,
        discountPct: null,
        ...storedVatOf(line.vat),
        netAmount: totals.lines[index]!.netAmount,
        grossAmount: totals.lines[index]!.grossAmount,
        deposit: line.kind === 'DEPOSIT_DEDUCTION' ? { number: 'FT-2026-00004', issueDate: '2026-10-01' } : null,
      })),
      netTotal: totals.netTotal,
      vatTotal: totals.vatTotal,
      grossTotal: totals.grossTotal,
      vatSummary: totals.vatSummary,
      stampDutyAmount: totals.stampDutyAmount,
      causale: 'Fattura differita (art. 21 c.4 lett. a DPR 633/1972)',
      purchaseOrders: [{ number: 'PO-91' }],
      ddts: [{ number: '12/2026', date: '2026-10-29' }],
    }
    const doc = buildFatturaPa(fatturaPaInputOf(invoice))
    expect(await xsdErrors(doc.xml)).toEqual([])
    expect(doc.xml).toContain('<TipoDocumento>TD24</TipoDocumento>')
    expect(doc.xml).toContain('<NumeroDDT>12/2026</NumeroDDT>')
    expect(doc.xml).toContain('<ImportoTotaleDocumento>724.80</ImportoTotaleDocumento>')
  })
})

describe('credit notes (TD04; DPR 633/1972 art. 26; FIN-069)', () => {
  const invoice = (overrides: Partial<CreditedInvoice> = {}): CreditedInvoice => ({
    id: 'inv-1',
    docType: 'TD24',
    status: 'DELIVERED',
    number: 'FT-2026-00005',
    issueDate: '2026-10-29',
    currency: 'EUR',
    priceBasis: 'NET',
    netTotal: 59410,
    grossTotal: 72480,
    summary: [{ treatment: IT22, taxable: 59410, vat: 13070 }],
    lines: [
      { id: 'l1', seq: 1, kind: 'GOODS', description: 'Giacca moto nera, taglia 52', itemCode: 'JKT-03-BLK-52', quantity: '2.0000', uom: 'PZ', unitPrice: '420.000000', discountPct: null, vat: IT22, salesOrderLineId: L1, size: '52' },
      { id: 'l2', seq: 2, kind: 'DEPOSIT_DEDUCTION', description: 'Storno acconto', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '-245.900000', discountPct: null, vat: IT22, salesOrderLineId: null, size: null },
    ],
    creditedNet: 0,
    creditedGross: 0,
    deductedNet: 0,
    paid: 72480,
    ...overrides,
  })

  it('says why and cites the invoice; FULL mirrors its summary, LINES its lines, AMOUNT one of its treatments', () => {
    expect(creditCausale('DEFECT', 'cucitura', { number: 'FT-2026-00005', issueDate: '2026-10-29' })).toBe('Nota di credito: Merce difettosa - cucitura - rif. fattura n. FT-2026-00005 del 29/10/2026 (art. 26 DPR 633/1972)')
    const full = creditNoteDraft(invoice(), { mode: 'FULL' }, 'BILLING_ERROR').draft!
    expect(computeInvoiceTotals(full.lines.map((line) => line.core), full.priceBasis, 'EUR')).toMatchObject({ netTotal: 59410, vatTotal: 13070, grossTotal: 72480 })
    const lines = creditNoteDraft(invoice(), { mode: 'LINES', lines: [{ lineId: 'l1', quantity: '1' }] }, 'RETURN').draft!
    expect(lines.lines).toMatchObject([{ core: { kind: 'GOODS', quantity: '1.0000', unitPrice: '420.000000' }, salesOrderLineId: L1, size: '52' }])
    const amount = creditNoteDraft(invoice(), { mode: 'AMOUNT', amount: 5000, basis: 'NET' }, 'PRICE_REDUCTION').draft!
    expect(computeInvoiceTotals(amount.lines.map((line) => line.core), amount.priceBasis, 'EUR')).toMatchObject({ netTotal: 5000, vatTotal: 1100, grossTotal: 6100 })
  })

  it('refuses a draft, a rejected invoice, a credit note, a deduction line, more than a line holds', () => {
    expect(creditNoteDraft(invoice({ status: 'REJECTED' }), { mode: 'FULL' }, 'OTHER').problems[0]!.message).toContain('correct it and send it again')
    expect(creditNoteDraft(invoice({ docType: 'TD04' }), { mode: 'FULL' }, 'OTHER').draft).toBeNull()
    expect(creditNoteDraft(invoice(), { mode: 'LINES', lines: [{ lineId: 'l2' }] }, 'OTHER').problems[0]!.path).toBe('body/lines/0/lineId')
    expect(creditNoteDraft(invoice(), { mode: 'LINES', lines: [{ lineId: 'l1', quantity: '3' }] }, 'OTHER').problems[0]!.path).toBe('body/lines/0/quantity')
    expect(creditNoteDraft(invoice({ creditedGross: 100 }), { mode: 'FULL' }, 'OTHER').problems[0]!.path).toBe('body/full')
    expect(creditNoteDraft(invoice(), { mode: 'AMOUNT', amount: 5000, basis: 'NET', vat: N32 }, 'OTHER').problems[0]!.path).toBe('body/vatRatePct')
  })

  it('never above what is creditable; a TD02 also within its net less deductions; a refund is due on what is paid', () => {
    expect(creditable(invoice({ creditedGross: 6100 }))).toEqual({ gross: 66380, net: null })
    expect(creditProblems({ causale: 'x', netTotal: 5000, grossTotal: 6100 }, invoice())).toEqual([])
    const over = creditProblems({ causale: 'x', netTotal: 60000, grossTotal: 73200 }, invoice())
    expect(over).toMatchObject([{ code: 'CREDIT_OVER', path: 'totals' }])
    expect(over[0]!.message).toContain('passes the 724.80 EUR still creditable')
    expect(creditProblems({ causale: ' ', netTotal: 1, grossTotal: 1 }, invoice()).map((problem) => problem.code)).toEqual(['CREDIT_REASON'])
    const deposit = invoice({ docType: 'TD02', netTotal: 24590, grossTotal: 30000, deductedNet: 24590, summary: [{ treatment: IT22, taxable: 24590, vat: 5410 }] })
    expect(creditProblems({ causale: 'x', netTotal: 100, grossTotal: 122 }, deposit).map((problem) => problem.code)).toEqual(['CREDIT_OVER'])
    expect(refundDueAfter(invoice(), 6100)).toBe(6100)
    expect(refundDueAfter(invoice({ paid: 0 }), 6100)).toBe(0)
  })
})

describe('the order settled: shipped, invoiced, delivered by SDI, paid (PLAN §4.7)', () => {
  const facts = (overrides: Partial<SettlementFacts> = {}): SettlementFacts => ({
    order: { id: 'o1', number: 'SO-0003', status: 'CONFIRMED', currency: 'EUR' },
    lines: [{ salesOrderLineId: L1, seq: 10, description: 'Giacca', sizes: [{ size: '52', ordered: 2 }] }],
    shipped: [{ salesOrderLineId: L1, size: '52', quantity: 2 }],
    invoiced: [{ salesOrderLineId: L1, size: '52', quantity: '2.0000' }],
    invoices: [{ id: 'inv-1', docType: 'TD24', number: 'FT-2026-00005', status: 'DELIVERED', grossTotal: 72480, creditedGross: 0, paid: 72480 }],
    depositRequests: [{ id: 'r1', status: 'PAID', fiscalDocument: 'TD02', amount: 30000, paid: 30000 }],
    depositInvoices: [{ id: 'td02-1', depositRequestId: 'r1', number: 'FT-2026-00004', status: 'DELIVERED', netTotal: 24590, grossTotal: 30000, creditedNet: 0, creditedGross: 0, deductedNet: 24590 }],
    creditNotes: [],
    ...overrides,
  })
  const gaps = (input: SettlementFacts) => orderSettlement(input).missing.map((gap) => gap.code)

  it('settled when every piece holds', () => {
    expect(orderSettlement(facts())).toMatchObject({ settled: true, missing: [], fullyShipped: true, fullyInvoiced: true, documentsFinal: true, money: { balanceDue: 0, refundDue: 0 } })
  })

  it('each missing piece in words', () => {
    expect(gaps(facts({ shipped: [{ salesOrderLineId: L1, size: '52', quantity: 1 }], invoiced: [{ salesOrderLineId: L1, size: '52', quantity: '1.0000' }] }))).toEqual(['NOT_SHIPPED'])
    expect(gaps(facts({ invoiced: [] }))).toEqual(['NOT_INVOICED'])
    expect(gaps(facts({ invoices: [{ id: 'inv-1', docType: 'TD24', number: 'FT-2026-00005', status: 'SENT', grossTotal: 72480, creditedGross: 0, paid: 72480 }] }))).toEqual(['AT_SDI'])
    expect(orderSettlement(facts({ invoices: [{ id: 'inv-1', docType: 'TD24', number: 'FT-2026-00005', status: 'DELIVERED', grossTotal: 72480, creditedGross: 0, paid: 50000 }] })).missing).toEqual([{ code: 'BALANCE_DUE', message: "224.80 EUR is still to be paid on the order's invoices." }])
    expect(gaps(facts({ depositInvoices: [{ id: 'td02-1', depositRequestId: 'r1', number: 'FT-2026-00004', status: 'DELIVERED', netTotal: 24590, grossTotal: 30000, creditedNet: 0, creditedGross: 0, deductedNet: 0 }] }))).toEqual(['DEPOSIT_NOT_DEDUCTED'])
    expect(gaps(facts({ order: { id: 'o1', number: 'SO-0003', status: 'CANCELLED', currency: 'EUR' } }))).toEqual(['ORDER_CANCELLED'])
  })

  it('a credit note on what is paid leaves a refund due (unsettled); a deposit paid on a NONE request pays the invoice', () => {
    const credited = facts({
      invoices: [{ id: 'inv-1', docType: 'TD24', number: 'FT-2026-00005', status: 'DELIVERED', grossTotal: 72480, creditedGross: 6100, paid: 72480 }],
      creditNotes: [{ id: 'nc-1', number: 'FT-2026-00006', status: 'DELIVERED', creditOfId: 'inv-1' }],
    })
    expect(orderSettlement(credited)).toMatchObject({ settled: false, money: { refundDue: 6100 }, missing: [{ code: 'REFUND_DUE' }] })
    const none = facts({
      depositRequests: [{ id: 'r1', status: 'PAID', fiscalDocument: 'NONE', amount: 30000, paid: 30000 }],
      depositInvoices: [],
      invoices: [{ id: 'inv-1', docType: 'TD24', number: 'FT-2026-00005', status: 'NOT_DELIVERABLE', grossTotal: 102480, creditedGross: 0, paid: 72480 }],
    })
    expect(orderSettlement(none)).toMatchObject({ settled: true, money: { balanceDue: 0, depositsPaidWithoutInvoice: 30000 } })
  })
})
