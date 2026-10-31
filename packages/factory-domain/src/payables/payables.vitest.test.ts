import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { readFatturaPa, sameTaxId } from './fatturapa'
import { matchLine, matchStatusOf, matchWords, MATCH_SETTINGS, sameUnit, type GoodsFacts } from './match'
import { PAYABLES_PERMISSIONS } from './permissions'
import { approvalProblems, actionProblems, preparersOf, receivedLineKind, suggestMapping, toApprove, typedSupplierProblem, vatSummaryOf, type InvoiceFacts } from './rules'
import { supplierInvoiceXml } from './testing'
import { parseXml, XmlReadError } from './xml'

/** Every VAT number, name and amount here is made up (office code 000). */
const SUPPLIER_VAT = '00000002022'
const BUYER_VAT = '00000003038'

describe('the XML reader', () => {
  it('reads elements, attributes, text, CDATA and entities, dropping namespace prefixes', () => {
    const root = parseXml('<?xml version="1.0"?>\n<!-- a comment --><p:Root xmlns:p="urn:x" versione="FPR12"><A>1 &amp; 2 &#x41;&#66;</A><B><![CDATA[<raw>]]></B><C/></p:Root>')
    expect(root.name).toBe('Root')
    expect(root.attributes).toEqual({ versione: 'FPR12' })
    expect(root.children.map((child) => [child.name, child.text])).toEqual([['A', '1 & 2 AB'], ['B', '<raw>'], ['C', '']])
  })
  it('refuses a DTD (no entity can expand), mismatched tags and an unknown entity', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(XmlReadError)
    expect(() => parseXml('<a><b></a></b>')).toThrow(/does not match/)
    expect(() => parseXml('<a>&nope;</a>')).toThrow(/Unknown entity/)
    expect(() => parseXml('<a></a><b></b>')).toThrow(/More than one root/)
  })
})

describe('reading a supplier FatturaPA (FIN-136)', () => {
  const { xml } = supplierInvoiceXml({
    supplierVat: SUPPLIER_VAT,
    buyerVat: BUYER_VAT,
    number: '2026/0412',
    date: '2026-11-13',
    lines: [
      { description: 'Pelle bovina nera, scelta A', quantity: '105', uom: 'FT2', unitPrice: '4.30', itemCode: 'SEED-ART-100' },
      { description: 'Trasporto', quantity: '1', unitPrice: '15.00' },
    ],
    orders: [{ number: 'SEED-PO-0001', date: '2026-10-30' }],
    ddts: [{ number: 'DDT-58', date: '2026-11-11' }],
    dueDate: '2026-12-31',
  })
  const read = readFatturaPa(xml)

  it('names the supplier and the buyer by their tax ids', () => {
    expect(read.supplier).toMatchObject({ country: 'IT', vatCode: SUPPLIER_VAT, vatNumber: `IT${SUPPLIER_VAT}`, name: 'Conceria Fittizia S.r.l.' })
    expect(read.buyer.vatNumber).toBe(`IT${BUYER_VAT}`)
    expect(sameTaxId(`IT${BUYER_VAT}`, read.buyer.vatCode)).toBe(true)
    expect(sameTaxId(`IT${BUYER_VAT}`, 'IT00000009999')).toBe(false)
  })
  it('reads the document as printed: type, number, date, sums in minor units, the VAT summary, the due date', () => {
    expect(read.documents).toHaveLength(1)
    const document = read.documents[0]!
    expect(document).toMatchObject({ docType: 'TD01', kind: 'INVOICE', currency: 'EUR', number: '2026/0412', issueDate: '2026-11-13', netTotal: 46_650, vatTotal: 10_263, grossTotal: 56_913, dueDate: '2026-12-31' })
    expect(document.vatSummary).toEqual([{ rate: '22.00', nature: null, taxable: 46_650, vat: 10_263 }])
    expect(document.paymentTerms?.installments[0]).toMatchObject({ method: 'MP05', amount: 56_913, dueDate: '2026-12-31' })
  })
  it('reads the lines (four places of quantity, six of price) and the order and delivery note they refer to', () => {
    const [leather, freight] = read.documents[0]!.lines
    expect(leather).toMatchObject({ seq: 1, description: 'Pelle bovina nera, scelta A', itemCode: 'SEED-ART-100', quantity: '105.0000', uom: 'FT2', unitPrice: '4.300000', netAmount: 45_150, vatRatePct: '22.00', vatNature: null })
    expect(freight).toMatchObject({ seq: 2, quantity: '1.0000', netAmount: 1_500 })
    expect(read.documents[0]!.orders[0]).toMatchObject({ document: 'SEED-PO-0001', date: '2026-10-30' })
    expect(read.documents[0]!.ddts[0]).toMatchObject({ number: 'DDT-58', date: '2026-11-11' })
  })
  it('a credit note is a CREDIT_NOTE that names the invoice it credits', () => {
    const credit = readFatturaPa(supplierInvoiceXml({ supplierVat: SUPPLIER_VAT, buyerVat: BUYER_VAT, documentType: 'TD04', number: '2026/0450', date: '2026-11-20', lines: [{ description: 'Storno differenza prezzo', quantity: '1', unitPrice: '10.50' }], relatedInvoices: [{ number: '2026/0412', date: '2026-11-13' }] }).xml)
    expect(credit.documents[0]).toMatchObject({ docType: 'TD04', kind: 'CREDIT_NOTE', netTotal: 1_050 })
    expect(credit.documents[0]!.related[0]).toMatchObject({ document: '2026/0412', date: '2026-11-13' })
  })
  it('says in words what it cannot read', () => {
    expect(() => readFatturaPa('<Fattura/>')).toThrow(/not a FatturaPA/)
    expect(() => readFatturaPa(xml.replace(/<Numero>2026\/0412<\/Numero>/, ''))).toThrow(/Numero is missing/)
    expect(() => readFatturaPa('not xml at all <')).toThrow(/not readable XML/)
  })
})

describe('the three-way match (FIN-137)', () => {
  const leather: GoodsFacts = { kind: 'GOODS', orderedQuantity: '420.0000', orderedUnitPrice: '4.200000', orderUom: 'FT2', received: '105.0000', billedElsewhere: '0', ended: false, lineTolerancePct: null }

  it('matches what arrived at the order’s price', () => {
    const match = matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 44_100 }, leather, 'EUR')
    expect(match).toMatchObject({ withinTolerance: true, verdict: 'WITHIN', differenceAmount: 0, quantity: 'SAME', price: 'SAME', receivedQuantity: '105.0000', orderedUnitPrice: '4.200000', invoicedUnitPrice: '4.200000' })
    expect(matchWords(match, 'FT2', { prices: true })).toEqual({ en: 'Matched', it: 'Corrisponde' })
  })
  it('a higher price is a difference outside the (undecided: exact) tolerance; the value is what it asks beyond', () => {
    const match = matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 45_150 }, leather, 'EUR')
    expect(match).toMatchObject({ withinTolerance: false, verdict: 'DIFFERENCE', differenceAmount: 1_050, price: 'HIGHER', invoicedUnitPrice: '4.300000', priceTolerancePct: '0.0000' })
    expect(matchWords(match, 'FT2', { prices: true }).en).toBe('Price differs +0.100000/FT2')
    expect(matchWords(match, 'FT2', { prices: false }).en).toBe('Price above the order’s')
  })
  it('more than arrived while the order still waits for goods: WAITING; once the line ended: a DIFFERENCE', () => {
    const waiting = matchLine({ quantity: '210.0000', uom: 'FT2', netAmount: 88_200 }, leather, 'EUR')
    expect(waiting).toMatchObject({ verdict: 'WAITING', withinTolerance: false, quantity: 'MORE', differenceAmount: 88_200 - 44_100 })
    expect(matchLine({ quantity: '210.0000', uom: 'FT2', netAmount: 88_200 }, { ...leather, ended: true }, 'EUR').verdict).toBe('DIFFERENCE')
    expect(matchLine({ quantity: '500.0000', uom: 'FT2', netAmount: 210_000 }, leather, 'EUR').verdict).toBe('DIFFERENCE')
  })
  it('an order line’s own area tolerance counts for the quantity; what other invoices bill is not billed twice', () => {
    expect(matchLine({ quantity: '108.0000', uom: 'FT2', netAmount: 45_360 }, { ...leather, lineTolerancePct: '5.0000' }, 'EUR')).toMatchObject({ withinTolerance: true, quantityTolerancePct: '5.0000' })
    expect(matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 44_100 }, { ...leather, billedElsewhere: '105.0000', ended: true }, 'EUR')).toMatchObject({ receivedQuantity: '0.0000', withinTolerance: false, verdict: 'DIFFERENCE' })
  })
  it('asking less (fewer units, a lower price) is within, and said', () => {
    const match = matchLine({ quantity: '100.0000', uom: 'MQ', netAmount: 41_000 }, leather, 'EUR')
    expect(match).toMatchObject({ withinTolerance: true, quantity: 'LESS', price: 'LOWER', unitDiffers: true })
    expect(matchWords(match, 'FT2', { prices: true }).en).toContain('Within the tolerance')
  })
  it('a subcontractor’s work: pieces back good at the fee per piece', () => {
    const work = { kind: 'SUBCONTRACT' as const, orderedPieces: 7, piecesBackGood: 5, orderedValue: '31.500000', goodValue: '22.500000', billedElsewhere: '0', ended: false }
    expect(matchLine({ quantity: '5.0000', uom: 'PZ', netAmount: 2_250 }, work, 'EUR')).toMatchObject({ withinTolerance: true, orderedUnitPrice: '4.500000', differenceAmount: 0 })
    expect(matchLine({ quantity: '7.0000', uom: 'PZ', netAmount: 3_150 }, work, 'EUR')).toMatchObject({ verdict: 'WAITING', differenceAmount: 900 })
    expect(matchLine({ quantity: null, uom: null, netAmount: 2_250 }, work, 'EUR')).toMatchObject({ invoicedQuantity: '5.0000', withinTolerance: true })
  })
  it('units the supplier writes otherwise are the same unit once tidied', () => {
    expect(sameUnit('MQ', 'M2')).toBe(true)
    expect(sameUnit('pz', 'PCS')).toBe(true)
    expect(sameUnit('FT2', 'M2')).toBe(false)
    expect(sameUnit(null, 'FT2')).toBe(true)
  })
  it('the invoice’s match status', () => {
    const goods = { kind: 'GOODS' as const, mapped: true }
    expect(matchStatusOf('INVOICE', [{ kind: 'GOODS', mapped: false }], [])).toBe('PENDING')
    expect(matchStatusOf('INVOICE', [{ kind: 'SERVICE', mapped: false }, { kind: 'CHARGE', mapped: false }], [])).toBe('NO_PO')
    expect(matchStatusOf('INVOICE', [goods], [{ withinTolerance: true, verdict: 'WITHIN', accepted: false }])).toBe('MATCHED')
    expect(matchStatusOf('INVOICE', [goods], [{ withinTolerance: false, verdict: 'DIFFERENCE', accepted: true }])).toBe('DIFFERENCES')
    expect(matchStatusOf('INVOICE', [goods], [{ withinTolerance: false, verdict: 'WAITING', accepted: false }])).toBe('WAITING_GOODS')
    expect(matchStatusOf('INVOICE', [goods], [{ withinTolerance: false, verdict: 'WAITING', accepted: true }])).toBe('DIFFERENCES')
    expect(matchStatusOf('CREDIT_NOTE', [{ kind: 'GOODS', mapped: false }], [])).toBe('NO_PO')
  })
  it('the settings say they are not decided (the accountant’s), in both languages', () => {
    expect(MATCH_SETTINGS).toMatchObject({ basis: 'RECEIVED', quantityTolerancePct: '0', priceTolerancePct: '0', decided: false })
    expect(MATCH_SETTINGS.words.it).toContain('commercialista')
  })
})

describe('mapping a received line to its order', () => {
  const lines = [
    { id: 'l1', siteId: 's1', orderNumber: 'SEED-PO-0001', seq: 1, supplierArticleCode: 'SEED-ART-100', itemCode: 'LEA-BLK', ddtNumbers: ['DDT-58'], open: true },
    { id: 'l2', siteId: 's1', orderNumber: 'SEED-PO-0001', seq: 2, supplierArticleCode: null, itemCode: 'PROT-SH', ddtNumbers: [], open: true },
    { id: 'l3', siteId: 's1', orderNumber: 'SEED-PO-0009', seq: 1, supplierArticleCode: 'SEED-ART-100', itemCode: 'LEA-BLK', ddtNumbers: [], open: true },
  ]
  const subcontracts = [{ id: 'sc1', siteId: 's1', number: 'SC-2026-0001' }]
  it('by the order the supplier names, then the article code', () => {
    expect(suggestMapping({ seq: 1, itemCode: 'SEED-ART-100' }, { orders: [{ lines: [], document: 'SEED-PO-0001', item: null }], ddts: [] }, lines, subcontracts)).toEqual({ kind: 'GOODS', purchaseOrderLineId: 'l1', siteId: 's1', how: 'ORDER_CODE' })
    expect(suggestMapping({ seq: 1, itemCode: null }, { orders: [{ lines: [1], document: 'SEED-PO-0001', item: '2' }], ddts: [] }, lines, subcontracts)).toMatchObject({ purchaseOrderLineId: 'l2', how: 'ORDER_LINE' })
  })
  it('by the delivery note, by the code alone only when one line has it, and a subcontract order by its number', () => {
    expect(suggestMapping({ seq: 1, itemCode: null }, { orders: [], ddts: [{ lines: [], number: 'ddt-58' }] }, lines, subcontracts)).toMatchObject({ purchaseOrderLineId: 'l1', how: 'DDT_ONLY_LINE' })
    expect(suggestMapping({ seq: 1, itemCode: 'SEED-ART-100' }, { orders: [], ddts: [] }, lines, subcontracts)).toBeNull()
    expect(suggestMapping({ seq: 1, itemCode: 'PROT-SH' }, { orders: [], ddts: [] }, lines, subcontracts)).toMatchObject({ purchaseOrderLineId: 'l2', how: 'CODE' })
    expect(suggestMapping({ seq: 1, itemCode: null }, { orders: [{ lines: [], document: 'SC-2026-0001', item: null }], ddts: [] }, lines, subcontracts)).toEqual({ kind: 'SUBCONTRACT', subcontractOrderId: 'sc1', siteId: 's1', how: 'ORDER' })
  })
  it('an invoice naming two orders without line numbers never puts a line on an order line of another article (B-W2a-F7)', () => {
    const two = [
      { id: 'a1', siteId: 's1', orderNumber: 'PO-A', seq: 10, supplierArticleCode: 'ART-LEA', itemCode: 'LEA-BLK', ddtNumbers: ['DDT-1'], open: true },
      { id: 'b1', siteId: 's1', orderNumber: 'PO-B', seq: 10, supplierArticleCode: 'ART-PRO', itemCode: 'PROT-SH', ddtNumbers: ['DDT-1'], open: true },
    ]
    const both = { orders: [{ lines: [], document: 'PO-A', item: null }, { lines: [], document: 'PO-B', item: null }], ddts: [] }
    // The protector line goes on PO-B's protector line, never on PO-A's only line (the leather).
    expect(suggestMapping({ seq: 2, itemCode: 'ART-PRO' }, both, two, [])).toEqual({ kind: 'GOODS', purchaseOrderLineId: 'b1', siteId: 's1', how: 'ORDER_CODE' })
    expect(suggestMapping({ seq: 1, itemCode: 'art-lea' }, both, two, [])).toMatchObject({ purchaseOrderLineId: 'a1', how: 'ORDER_CODE' })
    // An article neither order has stays unmapped (the person maps it); so does a line without an article (two equal lines).
    expect(suggestMapping({ seq: 3, itemCode: 'ART-ZIP' }, both, two, [])).toBeNull()
    expect(suggestMapping({ seq: 3, itemCode: null }, both, two, [])).toBeNull()
    // One order named: its only line when the article fits or none is named; never one of another article.
    const onlyA = { orders: [{ lines: [], document: 'PO-A', item: null }], ddts: [] }
    expect(suggestMapping({ seq: 1, itemCode: null }, onlyA, two, [])).toMatchObject({ purchaseOrderLineId: 'a1', how: 'ORDER_ONLY_LINE' })
    expect(suggestMapping({ seq: 1, itemCode: 'ART-ZIP' }, onlyA, two, [])).toBeNull()
    // The order's line number does not override another article; the delivery note's only line neither.
    expect(suggestMapping({ seq: 1, itemCode: 'ART-PRO' }, { orders: [{ lines: [1], document: 'PO-A', item: '10' }], ddts: [] }, two, [])).toMatchObject({ purchaseOrderLineId: 'b1', how: 'CODE' })
    expect(suggestMapping({ seq: 1, itemCode: 'ART-ZIP' }, { orders: [], ddts: [{ lines: [], number: 'DDT-9' }] }, [{ ...two[0]!, ddtNumbers: ['DDT-9'] }], [])).toBeNull()
  })
  it('an accessory, discount or rebate line is a charge', () => {
    expect(receivedLineKind('AC', null)).toBe('CHARGE')
    expect(receivedLineKind('SC', null)).toBe('CHARGE')
    expect(receivedLineKind(null, null)).toBe('GOODS')
  })
})

describe('approval, separation of duties and the actions', () => {
  const base: InvoiceFacts = { number: '2026/0412', status: 'RECEIVED', source: 'SDI', kind: 'INVOICE', matchStatus: 'MATCHED', createdById: null, xmlFileId: 'x', unaccepted: 0, linesNet: null, netTotal: 46_650, lines: 2 }
  it('is ready once matched, with every difference accepted', () => {
    expect(approvalProblems(base, 'u1')).toEqual([])
    expect(toApprove({ status: 'RECEIVED', matchStatus: 'DIFFERENCES', unaccepted: 0 })).toBe(true)
    expect(approvalProblems({ ...base, matchStatus: 'DIFFERENCES', unaccepted: 1 }, 'u1').map((problem) => problem.code)).toEqual(['DIFFERENCES'])
    expect(approvalProblems({ ...base, matchStatus: 'WAITING_GOODS' }, 'u1').map((problem) => problem.code)).toEqual(['WAITING_GOODS'])
    expect(approvalProblems({ ...base, matchStatus: 'PENDING' }, 'u1').map((problem) => problem.code)).toEqual(['NOT_MATCHED'])
  })
  it('never by the person who entered it', () => {
    const typed = { ...base, source: 'MANUAL' as const, createdById: 'u1', xmlFileId: null, linesNet: 46_650 }
    expect(approvalProblems(typed, 'u1')).toEqual([{ code: 'OWN_INVOICE', message: 'You entered this invoice, so someone else approves it.' }])
    expect(approvalProblems(typed, 'u2')).toEqual([])
    expect(approvalProblems({ ...typed, linesNet: 40_000 }, 'u2').map((problem) => problem.code)).toEqual(['LINES_DO_NOT_ADD_UP'])
  })
  it('four eyes on an SDI invoice: never by the person who mapped or matched its lines, or accepted one of its differences (B-W2a-F7)', () => {
    const prepared = { ...base, mappedByIds: ['mapper'], acceptedByIds: ['accepter'] }
    expect(approvalProblems(prepared, 'mapper')).toEqual([{ code: 'OWN_MAPPING', message: 'You mapped or matched its lines, so someone else approves it.' }])
    expect(approvalProblems(prepared, 'accepter')).toEqual([{ code: 'OWN_ACCEPTANCE', message: 'You accepted one of its differences, so someone else approves it.' }])
    expect(approvalProblems(prepared, 'third')).toEqual([])
    // One refusal says it: whoever entered a typed invoice is told that first.
    expect(approvalProblems({ ...prepared, source: 'MANUAL', createdById: 'mapper', xmlFileId: null, linesNet: 46_650 }, 'mapper').map((problem) => problem.code)).toEqual(['OWN_INVOICE'])
  })
  it('who prepared it, from its rows and its audit: the system is nobody, a figure change maps nothing', () => {
    const changeLine = (actorId: string, before: unknown, after: unknown) => ({ action: 'payables.changeLine', actorId, before, after })
    const marked = (value: unknown) => ({ $money: 'cost', value })
    expect(
      preparersOf({
        lines: [{ createdById: null }, { createdById: 'typist' }],
        matches: [{ createdById: null, acceptedById: null }, { createdById: 'matcher', acceptedById: 'buyer' }],
        audit: [
          changeLine('mapper', marked({ lineId: 'l1', kind: 'GOODS', purchaseOrderLineId: null, subcontractOrderId: null }), marked({ lineId: 'l1', kind: 'GOODS', purchaseOrderLineId: 'pol1', subcontractOrderId: null })),
          changeLine('corrector', marked({ lineId: 'l2', kind: 'CHARGE', purchaseOrderLineId: null, subcontractOrderId: null, netAmount: 100 }), marked({ lineId: 'l2', kind: 'CHARGE', purchaseOrderLineId: null, subcontractOrderId: null, netAmount: 120 })),
          { action: 'payables.withoutOrder', actorId: 'servicer', before: null, after: { lines: [3], kind: 'SERVICE' } },
          { action: 'payables.acceptDifference', actorId: 'earlier', before: null, after: { matchId: 'm0' } },
        ],
      }),
    ).toEqual({ mappedByIds: ['mapper', 'matcher', 'servicer', 'typist'], acceptedByIds: ['buyer', 'earlier'] })
    expect(preparersOf({ lines: [{ createdById: null }], matches: [{ createdById: null, acceptedById: null }], audit: [] })).toEqual({ mappedByIds: [], acceptedByIds: [] })
  })
  it('an SDI invoice is never edited or voided; a paid one moves no more', () => {
    expect(actionProblems({ number: 'n', status: 'RECEIVED', source: 'SDI' })).toMatchObject({ edit: expect.stringContaining('SDI'), void: expect.stringContaining('never voided'), map: null, dispute: null })
    expect(actionProblems({ number: 'n', status: 'PAID', source: 'MANUAL' })).toMatchObject({ edit: expect.any(String), map: expect.any(String), pay: expect.any(String), void: expect.any(String), withdraw: expect.any(String) })
    expect(actionProblems({ number: 'n', status: 'APPROVED', source: 'MANUAL' })).toMatchObject({ pay: null, withdraw: null })
  })
  it('an Italian supplier’s invoice comes through SDI, never typed', () => {
    expect(typedSupplierProblem('IT')).toContain('SDI')
    expect(typedSupplierProblem('DE')).toBeNull()
  })
  it('a typed invoice’s VAT summary per rate and nature', () => {
    expect(vatSummaryOf([{ netAmount: 10_000, vatRatePct: '22', vatNature: null }, { netAmount: 333, vatRatePct: '22.00', vatNature: null }, { netAmount: 5_000, vatRatePct: '0', vatNature: 'N6.1' }])).toEqual([
      { rate: '22.00', nature: null, taxable: 10_333, vat: 2_273 },
      { rate: '0.00', nature: 'N6.1', taxable: 5_000, vat: 0 },
    ])
  })
})

describe('the catalogues', () => {
  it('declares the permissions and gives them to finance and the buyer (never approve or pay to the buyer)', () => {
    for (const name of PAYABLES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('finance')!.permissions).toEqual(expect.arrayContaining([...PAYABLES_PERMISSIONS]))
    expect(templateOf('buyer')!.permissions).toEqual(expect.arrayContaining(['payables.view', 'payables.manage', 'payables.differences.accept']))
    expect(templateOf('buyer')!.permissions).not.toContain('payables.approve')
    expect(templateOf('buyer')!.permissions).not.toContain('payables.pay')
    expect(templateOf('read_only')!.permissions).toContain('payables.view')
    expect(templateOf('planner')!.permissions).not.toContain('payables.view')
  })
  it('declares the events, with no money on a live screen', () => {
    for (const type of ['supplier_invoice.received', 'supplier_invoice.matched', 'supplier_invoice.approved', 'supplier_invoice.paid', 'supplier_invoice.sdi_pickup_due', 'supplier_invoice.sdi_picked_up']) expect(EVENT_CATALOGUE.find(type, 1)).toBeTruthy()
  })
})
