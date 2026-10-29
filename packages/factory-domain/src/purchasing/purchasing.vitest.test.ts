import { describe, expect, it } from 'vitest'
import { composeDocument } from '../documents/compose'
import type { CompanyLegal } from '../documents/model'
import type { ItemUnits } from '../product/units/units'
import { cancellationMail, lineText, purchaseOrderDocument, purchaseOrderDocumentNumber, purchaseOrderMail, type SupplierLine, type SupplierOrder } from './document'
import {
  baseQuantityOf,
  cancelProblem,
  confirmLinkDays,
  defaultUnitPrice,
  draftProblem,
  estimatedHidesOf,
  inUnit,
  lineAmount,
  lineProblems,
  newLinkProblem,
  orderAmount,
  ordersContactOf,
  purchaseQuantityOf,
  sendChecks,
  supplierLanguageOf,
  type SendFacts,
  type SendLineFacts,
} from './orders'

/**
 * Purchase orders (B-W1-30), pure: hand-computed numbers. Every company, supplier, material and price is made up.
 */

// Leather bought by the hide of 52.5 ft², counted in ft², cut in dm².
const LEATHER: ItemUnits = { baseUom: 'FT2', purchaseUom: 'HIDE', purchaseFactor: '52.5', consumptionUom: 'DM2', consumptionFactor: '0.10763910' }
const PROTECTOR: ItemUnits = { baseUom: 'PCS', purchaseUom: 'PCS', purchaseFactor: '1', consumptionUom: 'PCS', consumptionFactor: '1' }

describe("a line's numbers (SCM-075: leather by area and hides)", () => {
  it('counts the line in the base unit, prices it once to the cent, and sums the order', () => {
    expect(baseQuantityOf('5', 'HIDE', LEATHER)).toBe('262.5000')
    // 1 m² = 10.7639104… ft², exactly: 24.3 m² = 261.5630… ft².
    expect(baseQuantityOf('24.3', 'M2', LEATHER)).toBe('261.5630')
    expect(baseQuantityOf('3', 'KG', LEATHER)).toBeNull()
    // 5 hides × 220.50 € = 1102.50 €; 262.5 ft² × 4.199999 € = 1102.4997… → 1102.50 € (one rounding).
    expect(lineAmount('5', '220.5', 'EUR')).toBe(110_250)
    expect(lineAmount('262.5', '4.199999', 'EUR')).toBe(110_250)
    expect(lineAmount('12', '3.333333', 'EUR')).toBe(4_000)
    expect(orderAmount([{ netAmount: 110_250 }, { netAmount: 4_000 }])).toBe(114_250)
  })

  it("starts a line at the item's standard price in the line's unit, only in the item's currency", () => {
    const item = { standardCost: '4.200000', currency: 'EUR', units: LEATHER }
    expect(defaultUnitPrice(item, 'HIDE', 'EUR')).toBe('220.500000')
    expect(defaultUnitPrice(item, 'FT2', 'EUR')).toBe('4.200000')
    // 4.2 € per ft² is 45.208424… € per m².
    expect(defaultUnitPrice(item, 'M2', 'EUR')).toBe('45.208424')
    expect(defaultUnitPrice(item, 'HIDE', 'USD')).toBeNull()
    expect(defaultUnitPrice({ ...item, standardCost: null }, 'HIDE', 'EUR')).toBeNull()
  })

  it('estimates the hides of a leather area (rounded up), nothing for other kinds', () => {
    expect(estimatedHidesOf('LEATHER', '262.5000', LEATHER)).toBe(5)
    expect(estimatedHidesOf('LEATHER', '263.0000', LEATHER)).toBe(6)
    expect(estimatedHidesOf('PROTECTOR', '12.0000', PROTECTOR)).toBeNull()
    // No hide factor: no estimate.
    expect(estimatedHidesOf('LEATHER', '100', { ...LEATHER, purchaseUom: 'FT2', purchaseFactor: '1' })).toBeNull()
  })

  it('moves a line to another unit at the same quantity and the same price per base unit', () => {
    expect(inUnit({ quantity: '262.5', unitPrice: '4.2' }, 'FT2', 'HIDE', LEATHER)).toEqual({ quantity: '5.0000', unitPrice: '220.500000' })
    expect(inUnit({ quantity: '107.639104', unitPrice: '4.2' }, 'FT2', 'M2', LEATHER)).toEqual({ quantity: '10.0000', unitPrice: '45.208424' })
    expect(inUnit({ quantity: '5', unitPrice: '1' }, 'HIDE', 'KG', LEATHER)).toBeNull()
  })

  it("converts a line to the supplier's purchase unit for its minimum and steps", () => {
    expect(purchaseQuantityOf('210', 'FT2', LEATHER)).toBe('4.0000')
    expect(purchaseQuantityOf('5', 'HIDE', LEATHER)).toBe('5.0000')
    expect(purchaseQuantityOf('5', 'KG', LEATHER)).toBeNull()
  })
})

describe('what a line may say', () => {
  const leather = { kind: 'LEATHER', status: 'ACTIVE', units: LEATHER }
  const ok = { quantity: '5', uom: 'HIDE' as const, needDate: '2026-12-18', unitPrice: '220.5' }

  it('accepts a leather line with its specs, and names each wrong field', () => {
    expect(lineProblems({ ...ok, grade: 'A', thicknessMinMm: '1.2', thicknessMaxMm: '1.4', oneDyeBatch: true, areaTolerancePct: '5' }, leather)).toEqual([])
    expect(lineProblems({ ...ok, quantity: '0', uom: 'KG', unitPrice: '-1', needDate: '18/12/2026', thicknessMinMm: '1.4', thicknessMaxMm: '1.2', areaTolerancePct: '101' }, leather).map((issue) => issue.path)).toEqual([
      'body/quantity',
      'body/uom',
      'body/unitPrice',
      'body/needDate',
      'body/thicknessMaxMm',
      'body/areaTolerancePct',
    ])
    expect(lineProblems(ok, { ...leather, status: 'ARCHIVED' })).toEqual([{ path: 'body/itemId', message: 'The material is archived: it is not bought any more.' }])
  })

  it('refuses the leather fields on another material', () => {
    const protector = { kind: 'PROTECTOR', status: 'ACTIVE', units: PROTECTOR }
    expect(lineProblems({ quantity: '12', uom: 'PCS', needDate: '2026-12-18', oneDyeBatch: false }, protector)).toEqual([])
    expect(lineProblems({ quantity: '12', uom: 'PCS', needDate: '2026-12-18', grade: 'A', oneDyeBatch: true }, protector).map((issue) => issue.path)).toEqual(['body/grade', 'body/oneDyeBatch'])
  })
})

describe('what stops a send (SCM-055)', () => {
  const line = (over: Partial<SendLineFacts> = {}): SendLineFacts => ({
    seq: 10,
    itemCode: 'LEA-BLK',
    unitPrice: '220.500000',
    needDate: '2026-12-18',
    purchaseQuantity: '5.0000',
    purchaseUom: 'HIDE',
    minOrderQuantity: '5',
    orderMultiple: null,
    leadTimeDays: 14,
    ...over,
  })
  const facts = (over: Partial<SendFacts> = {}): SendFacts => ({
    status: 'DRAFT',
    today: '2026-11-02',
    supplier: { name: 'Conceria Finta', status: 'ACTIVE', roles: ['SUPPLIER'] },
    contact: { name: 'Ufficio Ordini', email: 'ordini@conceria-finta.example', roles: ['ORDERS'], active: true },
    companyLegal: [],
    deliveryAddress: true,
    requestedDate: null,
    lines: [line()],
    ...over,
  })

  it('is ready with an active supplier, its orders contact, priced lines needed later', () => {
    expect(sendChecks(facts())).toEqual({ ready: true, checks: [] })
  })

  it('blocks on the supplier, the contact, the letterhead, the site, the lines and past dates', () => {
    const checks = sendChecks(
      facts({
        status: 'SENT',
        supplier: { name: 'Conceria Finta', status: 'BLOCKED', roles: ['CUSTOMER'] },
        contact: { name: 'Mario Prova', email: null, roles: ['QUALITY'], active: true },
        companyLegal: [{ path: 'company/reaNumber', message: 'The REA number is missing.' }],
        deliveryAddress: false,
        requestedDate: '2026-11-01',
        lines: [line({ unitPrice: '0' }), line({ seq: 20, needDate: '2026-11-01' })],
      }),
    )
    expect(checks.ready).toBe(false)
    expect(checks.checks.map((check) => [check.code, check.severity])).toEqual([
      ['NOT_DRAFT', 'BLOCKS'],
      ['NOT_A_SUPPLIER', 'BLOCKS'],
      ['SUPPLIER_NOT_ACTIVE', 'BLOCKS'],
      ['CONTACT_NOT_ORDERS', 'BLOCKS'],
      ['NO_CONTACT_EMAIL', 'BLOCKS'],
      ['COMPANY_LEGAL', 'BLOCKS'],
      ['NO_DELIVERY_ADDRESS', 'BLOCKS'],
      ['REQUESTED_DATE_PAST', 'BLOCKS'],
      ['LINE_NOT_PRICED', 'BLOCKS'],
      ['NEED_DATE_PAST', 'BLOCKS'],
    ])
    expect(checks.checks.find((check) => check.code === 'SUPPLIER_NOT_ACTIVE')?.message).toBe('Conceria Finta is blocked: pick another approved source.')
    expect(sendChecks(facts({ supplier: { name: 'Conceria Nuova', status: 'PROSPECT', roles: ['SUPPLIER'] } })).checks[0]?.message).toBe('Conceria Nuova is still a prospect: approve it as a supplier first.')
    expect(sendChecks(facts({ contact: null, lines: [] })).checks.map((check) => check.code)).toEqual(['NO_CONTACT', 'NO_LINES'])
  })

  it("warns, never blocks, on the supplier's minimum, steps and lead time", () => {
    const checks = sendChecks(facts({ lines: [line({ purchaseQuantity: '4.0000' }), line({ seq: 20, itemCode: 'PROT-01', purchaseQuantity: '10.0000', purchaseUom: 'PCS', minOrderQuantity: null, orderMultiple: '12', needDate: '2026-11-10' })] }))
    expect(checks.ready).toBe(true)
    expect(checks.checks.map((check) => [check.code, check.message])).toEqual([
      ['BELOW_MINIMUM', 'Line 10 (LEA-BLK) asks 4 HIDE; the supplier sells at least 5 HIDE.'],
      ['NOT_A_MULTIPLE', 'Line 20 (PROT-01) asks 10 PCS; the supplier sells in steps of 12 PCS.'],
      ['LATE_FOR_LEAD_TIME', "Line 20 (PROT-01) is needed on 2026-11-10; with 14 days' lead time it arrives on 2026-11-16 at the earliest."],
    ])
  })
})

describe('the office actions by state (SCM-053)', () => {
  it('edits only a draft, sends a new link only to an order waiting for its supplier', () => {
    expect(draftProblem('DRAFT')).toBeNull()
    expect(draftProblem('SENT')).toBe('The order is sent and waiting for the supplier: its lines and terms change only while it is a draft.')
    expect(newLinkProblem('SENT')).toBeNull()
    expect(newLinkProblem('DRAFT')).toBe('The order is not sent yet: send it.')
    expect(newLinkProblem('CONFIRMED')).toMatch(/waits for no confirmation/)
  })

  it('cancels a draft or an order the supplier has not confirmed; never a confirmed or received one', () => {
    expect(['DRAFT', 'SENT', 'DECLINED'].map((status) => cancelProblem(status as 'DRAFT'))).toEqual([null, null, null])
    expect(cancelProblem('CONFIRMED')).toMatch(/^The supplier confirmed this order: it is a contract now/)
    expect(cancelProblem('PARTLY_RECEIVED')).toMatch(/Goods were received/)
    expect(cancelProblem('CANCELLED')).toBe('The order is cancelled already.')
  })

  it('keeps the confirm link until the latest need date, at least 14 and at most 60 days', () => {
    expect(confirmLinkDays('2026-11-02', '2026-12-18')).toBe(46)
    expect(confirmLinkDays('2026-11-02', '2026-11-05')).toBe(14)
    expect(confirmLinkDays('2026-11-02', '2027-03-01')).toBe(60)
    expect(confirmLinkDays('2026-11-02', null)).toBe(14)
  })

  it("picks the supplier's first active orders contact with an e-mail, and the language it reads", () => {
    const contacts = [
      { id: 'a', status: 'ACTIVE', roles: ['QUALITY'], email: 'q@example.com' },
      { id: 'b', status: 'ARCHIVED', roles: ['ORDERS'], email: 'old@example.com' },
      { id: 'c', status: 'ACTIVE', roles: ['ORDERS'], email: null },
      { id: 'd', status: 'ACTIVE', roles: ['ORDERS', 'INVOICES'], email: 'orders@example.com' },
    ]
    expect(ordersContactOf(contacts)?.id).toBe('d')
    expect(ordersContactOf(contacts.slice(0, 3))).toBeNull()
    expect(supplierLanguageOf(null, 'it')).toBe('it')
    expect(supplierLanguageOf('de', 'it')).toBe('en')
  })
})

describe('the document and the mails (SCM-054, SCM-055)', () => {
  const COMPANY: CompanyLegal = {
    legalName: 'Pelletteria Fittizia S.r.l.',
    address: { line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
    vatNumber: 'IT12345670009',
    fiscalCode: '12345670009',
    reaOffice: 'MI',
    reaNumber: '0000001',
    shareCapital: '10000.00',
    currency: 'EUR',
  }
  const leatherLine: SupplierLine = {
    seq: 10,
    code: 'CF-A12',
    name: 'Vacchetta pieno fiore',
    colour: { name: 'Nero', supplierCode: 'N12' },
    description: null,
    quantity: '5.0000',
    uom: 'HIDE',
    unitPrice: '220.500000',
    netAmount: 110_250,
    needDate: '2026-12-18',
    leather: { grade: 'A', thicknessMinMm: '1.20', thicknessMaxMm: '1.40', oneDyeBatch: true, areaTolerancePct: '5.0000', estimatedHides: 5, baseQuantity: '262.5000', baseUom: 'FT2' },
    requiresCrViTest: true,
    note: null,
  }
  const order: SupplierOrder = {
    number: 'PO-00012',
    revision: 1,
    language: 'it',
    date: '2026-11-02',
    currency: 'EUR',
    supplier: { name: 'Conceria Finta S.p.A.', address: { line1: 'Via Finta 9', postalCode: '56029', city: 'Santa Croce', country: 'IT' }, vatNumber: 'IT00000002022' },
    deliverTo: { name: 'Stabilimento 1', line1: 'Via Esempio 1', postalCode: '00000', city: 'Seedville', country: 'IT' },
    requestedDate: null,
    incoterms: 'EXW Santa Croce',
    paymentTerms: '60 giorni data fattura',
    note: null,
    lines: [leatherLine, { ...leatherLine, seq: 20, code: 'PROT-01', name: 'Protezione spalla', colour: null, quantity: '12.0000', uom: 'PCS', unitPrice: '3.333333', netAmount: 4_000, leather: null, requiresCrViTest: false }],
    netAmount: 114_250,
  }

  it('spells out the leather specs and the Cr VI test in the line, in the supplier language', () => {
    expect(lineText(leatherLine, 'it')).toBe(
      'Vacchetta pieno fiore · colore Nero (cod. fornitore N12) · scelta A · spessore 1,2–1,4 mm · un solo bagno di tintura · tolleranza superficie ±5% · circa 5 pelli (262,5 ft²) · prova Cr VI richiesta per ogni lotto (REACH All. XVII voce 47)',
    )
    expect(lineText(leatherLine, 'en')).toBe(
      'Vacchetta pieno fiore · colour Nero (supplier code N12) · grade A · thickness 1.2–1.4 mm · one dye batch · area tolerance ±5% · about 5 hides (262.5 ft²) · Cr VI test required for every lot (REACH Annex XVII entry 47)',
    )
  })

  it('composes the PURCHASE_ORDER layout with prices, need dates and the net total (no VAT on an order)', () => {
    const composed = composeDocument({ ...purchaseOrderDocument(order), company: COMPANY, sample: false })
    expect(composed.layout).toBe('PURCHASE_ORDER/1')
    expect(composed.table.rows[0]).toEqual(['CF-A12', expect.stringContaining('circa 5 pelli'), '5', 'HIDE', '220,50', '18/12/2026', '€ 1.102,50'])
    expect(composed.totals.map((row) => row.value)).toEqual(['€ 1.142,50', '€ 1.142,50'])
    expect(composed.facts.map((fact) => fact.value)).toEqual(['EXW Santa Croce', '60 giorni data fattura'])
    expect(purchaseOrderDocumentNumber('PO-00012', 1)).toBe('PO-00012')
    expect(purchaseOrderDocumentNumber('PO-00012', 2)).toBe('PO-00012 rev. 2')
  })

  it('stores the mail without the link and sends it with the link; the cancellation tells the supplier', () => {
    const mail = purchaseOrderMail({ language: 'it', number: 'PO-00012', recipientName: 'Ufficio Ordini', linkUntil: '2026-12-18', message: null, resend: false })
    expect(mail.subject).toBe('Ordine di acquisto PO-00012')
    expect(mail.stored).toBe("Gentile Ufficio Ordini,\n\nle inviamo il nostro ordine di acquisto PO-00012: il documento è in allegato.\n\nPer confermare l'ordine (quantità e date) o per rifiutarlo usi il link personale contenuto nell'e-mail inviata, valido fino al 18/12/2026.")
    expect(mail.withLink('https://factory.example/l#token=abc')).toMatch(/valido fino al 18\/12\/2026:\nhttps:\/\/factory\.example\/l#token=abc$/)
    expect(mail.stored).not.toContain('token')
    expect(purchaseOrderMail({ language: 'en', number: 'PO-00012', recipientName: null, linkUntil: '2026-12-18', message: 'Our own words.', resend: true }).stored).toBe(
      'Our own words.\n\nTo confirm the order (quantities and dates) or decline it, use the personal link in the e-mail as sent, valid until 18 Dec 2026.',
    )
    expect(cancellationMail({ language: 'en', number: 'PO-00012', recipientName: 'Order Desk', message: null })).toEqual({
      subject: 'Purchase order PO-00012 cancelled',
      body: 'Dear Order Desk,\n\nour purchase order PO-00012 is cancelled: please do not deliver it. Its confirm link no longer works.',
    })
  })
})
