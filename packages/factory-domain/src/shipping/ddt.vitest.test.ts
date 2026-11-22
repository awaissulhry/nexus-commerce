import { describe, expect, it } from 'vitest'
import { composeDocument } from '../documents/compose'
import type { CompanyLegal } from '../documents/model'
import { canTransition } from '../state/machine'
import { cancelDdtProblems, ddtDocument, draftDdt, draftInvoicesWarning, goodsDescription, invoicesOfDdt, issueStateProblems, SHIPMENT_DDT_REASONS, type DdtFacts, type DdtGoods, type DdtRequest } from './ddt'
import { ddtNotNeededWords, ddtRequiredRefusal } from './ddt' // B-OS-017
import { handOverTimeProblems } from './shipments' // B-OS-014
import { events } from './events'
import { SHIPPING_DDT_CANCEL, SHIPPING_DDT_ISSUE, SHIPPING_FLOOR_PERMISSIONS, SHIPPING_PERMISSIONS } from './permissions'
import { shipmentMachine, shipProblems, type ShipmentFacts } from './shipments'

/* Every name, code, number and address here is made up. */

const NOW = new Date('2026-11-24T08:00:00.000Z')
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000).toISOString()

const COMPANY: CompanyLegal = {
  legalName: 'Fabbrica Esempio S.r.l.',
  address: { line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: null,
  currency: 'EUR',
}

const goods = (fields: Partial<DdtGoods> = {}): DdtGoods => ({
  workOrderSizeId: 'cell-1',
  salesOrderLineId: 'so-line-1',
  styleCode: 'JKT-01',
  styleName: 'Giacca moto in pelle',
  colourway: 'Nero',
  size: '52',
  quantity: 2,
  batchNumber: 'BT-0001',
  serials: [],
  ppe: { category: 'CATEGORY_II', standard: 'EN 17092-3:2020', class: 'AA' },
  ...fields,
})

const facts = (fields: Partial<DdtFacts> = {}, shipment: Partial<DdtFacts['shipment']> = {}): DdtFacts => ({
  shipment: {
    status: 'PACKED',
    transportBy: 'CARRIER',
    carrierName: 'Corriere Esempio',
    shipTo: { name: 'Officina Esempio', line1: 'Via Consegna 12', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT', phone: '+39 000 0000000' },
    shippedAt: null,
    ...shipment,
  },
  liveDdtNumber: null,
  company: COMPANY,
  billTo: { legalName: 'Cliente Esempio S.r.l.', vatNumber: 'IT00000001016', fiscalCode: '00000001016', address: { line1: 'Via Esempio 10', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' } },
  order: { number: 'SO-2026-0002', orderDate: '2026-11-12', customerRef: 'PO-78' },
  defaultAppearance: 'Scatole di cartone',
  parcels: [
    { seq: 2, grossWeightKg: '2.9000' },
    { seq: 1, grossWeightKg: '3.1' },
  ],
  goods: [goods({ workOrderSizeId: 'cell-2', colourway: 'Rosso', size: '50', quantity: 1, serials: ['S-0002', 'S-0001'] }), goods()],
  language: 'it',
  ...fields,
})

const problemsOf = (request: DdtRequest, base: DdtFacts = facts(), now = NOW) => draftDdt(base, request, now).problems.map((problem) => `${problem.path}: ${problem.message}`)

describe('a DDT from a packed shipment (DPR 472/1996 art. 1 c. 3; LOG-054)', () => {
  it('states every field from the shipment: sender, recipient, destination, reason, goods, packages, weight, carrier, start', () => {
    const { draft, problems } = draftDdt(facts(), {}, NOW)
    expect(problems).toEqual([])
    expect(draft).toMatchObject({
      documentDate: '2026-11-24',
      reason: 'SALE',
      reasonText: null,
      transportBy: 'CARRIER',
      carrier: { name: 'Corriere Esempio', address: null, vatNumber: null },
      startAt: '2026-11-24T08:00:00.000Z',
      appearance: 'Scatole di cartone',
      packages: 2,
      grossWeightKg: '6.0000',
      netWeightKg: null,
      freight: null,
      sender: { name: 'Fabbrica Esempio S.r.l.', vatNumber: 'IT12345670009', fiscalCode: '12345670009', address: COMPANY.address },
      recipient: { name: 'Cliente Esempio S.r.l.', vatNumber: 'IT00000001016', fiscalCode: '00000001016', address: { line1: 'Via Esempio 10', city: 'Bologna' } },
      destination: { name: 'Officina Esempio', line1: 'Via Consegna 12', postalCode: '40121', city: 'Bologna', country: 'IT' },
      documentRefs: [
        { kind: 'SALES_ORDER', number: 'SO-2026-0002', date: '2026-11-12' },
        { kind: 'CUSTOMER_ORDER', number: 'PO-78' },
      ],
      remarks: null,
    })
    expect(draft.lines).toEqual([
      expect.objectContaining({ seq: 1, code: 'JKT-01', quantity: '2', uom: 'PCS', size: '52', serials: [], description: 'Giacca moto in pelle, Nero, taglia 52 (DPI cat. II, EN 17092-3:2020, classe AA) - lotto BT-0001' }),
      expect.objectContaining({ seq: 2, quantity: '1', size: '50', serials: ['S-0001', 'S-0002'], description: 'Giacca moto in pelle, Rosso, taglia 50 (DPI cat. II, EN 17092-3:2020, classe AA) - lotto BT-0001 - matricole S-0001, S-0002' }),
    ])
  })

  it('prints no place of delivery when the goods go to the buyer, and composes into a DDT the documents layout accepts', () => {
    const atTheBuyer = facts({}, { transportBy: 'SENDER', shipTo: { line1: 'via esempio  10', postalCode: '40121', city: 'BOLOGNA', country: 'IT' } })
    const { draft } = draftDdt(atTheBuyer, { netWeightKg: '4.8', freight: 'FREE', remarks: 'Fragile' }, NOW)
    expect(draft).toMatchObject({ destination: null, carrier: null, transportBy: 'SENDER', netWeightKg: '4.8000', freight: 'FREE', remarks: 'Fragile' })
    const composed = composeDocument({ ...ddtDocument({ ...draft, number: '145/2026' }, 'it', 'EUR'), company: COMPANY })
    expect(composed.layout).toBe('DDT/1')
    expect(composed.identity).toEqual([
      { label: 'Numero', value: '145/2026' },
      { label: 'Data', value: '24/11/2026' },
    ])
    expect(composed.facts.map((fact) => fact.value)).toEqual(expect.arrayContaining(['Vendita', 'Mittente', 'Scatole di cartone', '2']))
    expect(composed.signatures).toHaveLength(3)
    expect(composed.table.rows.map((row) => row[0])).toEqual(['JKT-01', 'JKT-01'])
  })

  it('describes the goods in English for an English order, and without PPE words for a garment that is not PPE', () => {
    expect(goodsDescription(goods({ styleName: 'Leather jacket', colourway: 'Black', ppe: { category: 'CATEGORY_I', standard: null, class: null }, batchNumber: null, serials: ['B', 'A'] }), 'en')).toBe(
      'Leather jacket, Black, size 52 (PPE cat. I) - serials A, B',
    )
    expect(goodsDescription(goods({ ppe: { category: 'NOT_PPE', standard: 'x', class: 'y' } }), 'it')).toBe('Giacca moto in pelle, Nero, taglia 52 - lotto BT-0001')
  })

  it('names every missing or wrong field in plain words, at once', () => {
    const bare = facts({ defaultAppearance: null, billTo: { legalName: 'Cliente Esempio S.r.l.' }, parcels: [{ seq: 1, grossWeightKg: null }], company: { ...COMPANY, vatNumber: null } }, { carrierName: null, shipTo: {} })
    expect(problemsOf({ reason: 'OTHER', netWeightKg: '0' }, bare)).toEqual([
      'body/reasonText: Say the reason for the transport in words.',
      'body/carrier: Name the carrier (DPR 472/1996: the identity of whoever carries the goods).',
      "body/appearance: Describe the goods' external appearance, e.g. 'scatole di cartone' (aspetto esteriore dei beni, DPR 472/1996).",
      'shipment/parcels: Weigh parcel 1: the DDT states the gross weight.',
      'body/netWeightKg: Expected a net weight in kilograms above 0, with at most 4 decimals.',
      'company/vatNumber: The company needs its VAT number (partita IVA).',
      "shipment/recipient/address: The order's buyer has no complete address (street, postal code, city, country): the DDT prints it (DPR 472/1996).",
      'shipment/shipTo: The delivery address is not complete (street, postal code, city, country).',
    ])
    expect(problemsOf({ netWeightKg: '6.5' })).toEqual(['body/netWeightKg: The net weight is at most the gross weight (6.0000 kg).'])
    expect(problemsOf({ carrier: { name: 'Corriere Esempio' } }, facts({}, { transportBy: 'SENDER' }))).toEqual(['body/carrier: A carrier is named only when a carrier carries the goods (the shipment says who: transportBy).'])
    expect(problemsOf({ carrier: { name: ' ', address: { line1: 'Via Corriere 3', postalCode: '', city: 'Bologna', country: 'IT' } } })).toEqual([
      'body/carrier/name: Name the carrier (DPR 472/1996: the identity of whoever carries the goods).',
      "body/carrier/address: The carrier's address needs its street, postal code, city and country.",
    ])
    expect(problemsOf({}, facts({ goods: [], parcels: [] }))).toEqual([
      'shipment/parcels: The shipment has no parcels: the DDT states the number of packages.',
      'shipment/lines: The shipment has no goods: a DDT lists at least one line.',
    ])
  })

  it('takes the reasons a shipment to a customer travels for, and says why the others belong elsewhere', () => {
    expect(SHIPMENT_DDT_REASONS).toEqual(['SALE', 'RETURN_FROM_WORK', 'ON_APPROVAL', 'REPAIR', 'SAMPLE', 'OTHER'])
    for (const reason of SHIPMENT_DDT_REASONS) expect(problemsOf({ reason, reasonText: 'Prova' })).toEqual([])
    expect(problemsOf({ reason: 'TRANSFER' })).toEqual(["body/reason: A transfer between sites travels with the transfer's own DDT, not a shipment to a customer."])
    expect(problemsOf({ reason: 'WORK_ON_ACCOUNT' })).toEqual(["body/reason: Goods sent out to be worked on travel with the subcontracting delivery's DDT, not a shipment to a customer."])
    expect(problemsOf({ reason: 'RETURN' })).toEqual(["body/reason: Goods sent back to a supplier travel with the return's DDT, not a shipment to a customer."])
    expect(draftDdt(facts(), { reason: 'REPAIR', reasonText: ' garanzia ' }, NOW).draft).toMatchObject({ reason: 'REPAIR', reasonText: 'garanzia' })
  })
})

describe('the start of the transport (data e ora di inizio trasporto)', () => {
  it('a DDT issued before the goods leave: from now (a few minutes of grace) to 7 days ahead', () => {
    expect(draftDdt(facts(), { startAt: '2026-11-24T16:00:00+01:00' }, NOW).draft.startAt).toBe('2026-11-24T15:00:00.000Z')
    expect(problemsOf({ startAt: minutes(-9) })).toEqual([])
    expect(problemsOf({ startAt: minutes(-11) })).toEqual(['body/startAt: The transport starts once the DDT is issued (DPR 472/1996: the DDT travels with the goods), not before.'])
    expect(problemsOf({ startAt: minutes(7 * 24 * 60 + 1) })).toEqual(['body/startAt: Give a start at most 7 days ahead: a DDT is issued for goods about to leave.'])
    expect(problemsOf({ startAt: '24/11/2026 08:00' })).toEqual(['body/startAt: Give the date and time the transport starts, ISO 8601 with a zone.'])
  })

  it('the goods leave with the DDT (ship): the start is now', () => {
    expect(problemsOf({ ship: true, startAt: minutes(5) })).toEqual([])
    expect(problemsOf({ ship: true, startAt: minutes(60) })).toEqual(['body/startAt: The goods leave now: leave the start out, or give a time within 10 minutes of now.'])
  })

  it('a replacement for a cancelled DDT keeps the start of the transport that happened', () => {
    const shippedAt = new Date('2026-11-24T06:05:00.000Z')
    const shipped = facts({}, { status: 'SHIPPED', shippedAt })
    expect(draftDdt(shipped, {}, NOW).draft.startAt).toBe('2026-11-24T06:05:00.000Z')
    expect(problemsOf({ startAt: minutes(-120) }, shipped)).toEqual([])
    expect(problemsOf({ startAt: minutes(60) }, shipped)).toEqual(['body/startAt: The goods left already: the transport started before now.'])
  })
})

describe('when a DDT is issued, a shipment leaves and a DDT is cancelled', () => {
  it('issues for a PACKED shipment, or a replacement for a SHIPPED one; one live DDT per shipment', () => {
    expect(issueStateProblems('PACKED', null, false)).toEqual([])
    expect(issueStateProblems('PACKED', null, true)).toEqual([])
    expect(issueStateProblems('SHIPPED', null, false)).toEqual([])
    expect(issueStateProblems('DRAFT', null, false)).toEqual(['The shipment is a DRAFT: pack it first (a DDT is issued for packed goods).'])
    expect(issueStateProblems('DELIVERED', null, false)).toEqual(['The shipment is DELIVERED: no DDT is issued for it.'])
    expect(issueStateProblems('CANCELLED', null, false)).toEqual(['The shipment is CANCELLED: no DDT is issued for it.'])
    expect(issueStateProblems('PACKED', '145/2026', false)).toEqual(['DDT 145/2026 is live for this shipment: cancel it first (a shipment has one live DDT).'])
    expect(issueStateProblems('SHIPPED', null, true)).toEqual(['The goods left already: a replacement DDT does not ship them again.'])
  })

  it('leaves (PACKED → SHIPPED) only with a live DDT, unless an immediate invoice travels instead', () => {
    const packed = (fields: Partial<ShipmentFacts>): ShipmentFacts => ({ lines: [], parcels: [], liveDdts: 0, ...fields })
    const check = canTransition(shipmentMachine, 'PACKED', 'SHIPPED', packed({}))
    expect(check.ok ? [] : check.missing).toEqual(['a live DDT (DPR 472/1996: issue the DDT first)'])
    expect(canTransition(shipmentMachine, 'PACKED', 'SHIPPED', packed({ liveDdts: 1 })).ok).toBe(true)
    expect(canTransition(shipmentMachine, 'PACKED', 'SHIPPED', packed({ ddtRequired: false })).ok).toBe(true)
    expect(shipProblems({ liveDdts: 0, ddtRequired: true })).toHaveLength(1)
    expect(canTransition(shipmentMachine, 'SHIPPED', 'PACKED', packed({ liveDdts: 1 })).ok).toBe(false)
  })

  it('cancels once, while the goods are packed or travelling, and never once an issued invoice bills them', () => {
    expect(cancelDdtProblems({ cancelled: false, shipmentStatus: 'PACKED', invoiceNumbers: [] })).toEqual([])
    expect(cancelDdtProblems({ cancelled: false, shipmentStatus: 'SHIPPED', invoiceNumbers: [] })).toEqual([])
    expect(cancelDdtProblems({ cancelled: true, shipmentStatus: 'SHIPPED', invoiceNumbers: [] })).toEqual(['This DDT is cancelled already.'])
    expect(cancelDdtProblems({ cancelled: false, shipmentStatus: 'DELIVERED', invoiceNumbers: ['FT-2026-00003'] })).toEqual([
      'The shipment is DELIVERED: its transport is over, so its DDT stays as issued.',
      'Invoice FT-2026-00003 bills the goods of this DDT: an invoiced DDT stays as issued (a credit note corrects the invoice).',
    ])
  })

  it('splits the invoices naming a DDT: issued ones (any status after DRAFT) refuse, drafts only warn', () => {
    const split = invoicesOfDdt([
      { id: 'inv-3', number: null, status: 'DRAFT' },
      { id: 'inv-2', number: 'FT-2026-00009', status: 'DELIVERED' },
      { id: 'inv-1', number: 'FT-2026-00004', status: 'ISSUED' },
      { id: 'inv-4', number: null, status: 'DRAFT' },
    ])
    expect(split).toEqual({ issued: ['FT-2026-00004', 'FT-2026-00009'], drafts: ['inv-3', 'inv-4'] })
    expect(draftInvoicesWarning(split.drafts)).toBe('2 draft invoice(s) name this DDT: they cannot be issued until their lines name the DDT that replaces it.')
    expect(draftInvoicesWarning([])).toBeNull()
  })

  it('declares the DDT permissions (office only) and events', () => {
    expect(SHIPPING_PERMISSIONS).toEqual(expect.arrayContaining([SHIPPING_DDT_ISSUE, SHIPPING_DDT_CANCEL]))
    expect(SHIPPING_FLOOR_PERMISSIONS).not.toContain(SHIPPING_DDT_ISSUE)
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['ddt.issued', 'ddt.cancelled']))
    const issued = events.find((event) => event.type === 'ddt.issued')!
    expect(issued.payload.safeParse({ ddtId: '0190a1b2-0000-7000-8000-000000000001', shipmentId: '0190a1b2-0000-7000-8000-000000000002', number: '145/2026', documentDate: '2026-11-24', replacement: false, shipped: true }).success).toBe(true)
  })
})

// B-OP-042 (order page N6, lines-derived): a DDT of a shipment that carries several orders of one customer.
describe('a DDT of two orders of one customer (B-OP-042)', () => {
  const second = { number: 'SO-2026-0003', orderDate: '2026-11-14', customerRef: 'PO-81', billTo: { legalName: 'Cliente Esempio S.r.l.', vatNumber: 'IT 00000001016' } }
  const twoOrders = facts({
    orders: [{ number: 'SO-2026-0002', orderDate: '2026-11-12', customerRef: 'PO-78' }, second],
    goods: [goods({ workOrderSizeId: 'cell-3', styleCode: 'AAA-01', orderSeq: 1 }), goods({ workOrderSizeId: 'cell-2', colourway: 'Rosso', size: '50', quantity: 1 }), goods()],
  })

  it('one SALES_ORDER and one CUSTOMER_ORDER reference per order; the recipient stays the first order\'s buyer', () => {
    const { draft, problems } = draftDdt(twoOrders, {}, NOW)
    expect(problems).toEqual([])
    expect(draft.documentRefs).toEqual([
      { kind: 'SALES_ORDER', number: 'SO-2026-0002', date: '2026-11-12' },
      { kind: 'CUSTOMER_ORDER', number: 'PO-78' },
      { kind: 'SALES_ORDER', number: 'SO-2026-0003', date: '2026-11-14' },
      { kind: 'CUSTOMER_ORDER', number: 'PO-81' },
    ])
    expect(draft.recipient).toMatchObject({ name: 'Cliente Esempio S.r.l.', vatNumber: 'IT00000001016' })
  })

  it('groups the lines by order (the first order\'s first) and names each line\'s order and PO, in the DDT\'s language', () => {
    const { draft } = draftDdt(twoOrders, {}, NOW)
    expect(draft.lines.map((line) => [line.seq, line.workOrderSizeId])).toEqual([[1, 'cell-1'], [2, 'cell-2'], [3, 'cell-3']])
    expect(draft.lines[0]!.description).toBe('Giacca moto in pelle, Nero, taglia 52 (DPI cat. II, EN 17092-3:2020, classe AA) - lotto BT-0001 - ordine SO-2026-0002, vs. ordine PO-78')
    expect(draft.lines[2]!.description).toMatch(/ - ordine SO-2026-0003, vs\. ordine PO-81$/)
    expect(draftDdt({ ...twoOrders, language: 'en' }, {}, NOW).draft.lines[2]!.description).toMatch(/ - order SO-2026-0003, your order PO-81$/)
  })

  it('one order: references and lines exactly as before (nothing visible changes while N6 is held off)', () => {
    const before = draftDdt(facts(), {}, NOW).draft
    const one = draftDdt(facts({ orders: [{ number: 'SO-2026-0002', orderDate: '2026-11-12', customerRef: 'PO-78' }] }), {}, NOW).draft
    expect([one.documentRefs, one.lines]).toEqual([before.documentRefs, before.lines])
  })

  it('refuses in words an order that bills another VAT number: one DDT names one recipient', () => {
    const other = facts({ orders: [{ number: 'SO-2026-0002', orderDate: '2026-11-12', customerRef: 'PO-78' }, { ...second, billTo: { vatNumber: 'IT99999999999' } }] })
    expect(problemsOf({}, other)).toContain('shipment/recipient: SO-2026-0003 bills another VAT number than SO-2026-0002: one DDT names one recipient.')
  })
})

// ---- B-OS-014, B-OS-017 (order shipments tab): handed over at a typed time; "this shipment travels without a DDT" ----
describe('the goods handed over at a typed time (B-OS-014)', () => {
  const now = new Date('2026-11-22T10:00:00.000Z')
  const facts = { now, packedAt: new Date('2026-11-20T08:00:00.000Z'), ddtIssuedAt: new Date('2026-11-20T09:00:00.000Z'), reason: null as string | null }
  const paths = (at: string, over: Partial<typeof facts> = {}) => handOverTimeProblems(new Date(at), { ...facts, ...over }).map((issue) => issue.path)

  it('now (or minutes ago) needs no reason; more than 15 minutes back it does', () => {
    expect(paths('2026-11-22T10:00:00.000Z')).toEqual([])
    expect(paths('2026-11-22T09:50:00.000Z')).toEqual([])
    expect(paths('2026-11-21T15:30:00.000Z')).toEqual(['body/reason'])
    expect(paths('2026-11-21T15:30:00.000Z', { reason: '  ok  ' })).toEqual(['body/reason'])
    expect(paths('2026-11-21T15:30:00.000Z', { reason: 'The driver left before it was recorded.' })).toEqual([])
    expect(paths('2026-11-21T15:30:00.000Z', { reason: 'x'.repeat(501) })).toEqual(['body/reason'])
  })

  it('never ahead of now (5 minutes of clock), never more than 60 days back, never before packing nor before the DDT', () => {
    expect(paths('2026-11-22T10:04:00.000Z')).toEqual([])
    expect(handOverTimeProblems(new Date('2026-11-22T11:00:00.000Z'), facts)[0]!.message).toBe('The time is in the future.')
    expect(handOverTimeProblems(new Date('2026-09-01T10:00:00.000Z'), { ...facts, packedAt: null, ddtIssuedAt: null, reason: 'Recorded late.' })[0]!.message).toBe('At most 60 days back.')
    expect(handOverTimeProblems(new Date('2026-11-20T07:00:00.000Z'), { ...facts, reason: 'Recorded late.' })[0]!.message).toBe('The time is before the goods were packed.')
    expect(handOverTimeProblems(new Date('2026-11-20T08:30:00.000Z'), { ...facts, reason: 'Recorded late.' })[0]!.message).toBe('The time is before the DDT was issued.')
    // Without a DDT (it travels without one) only the packing bounds it.
    expect(paths('2026-11-20T08:30:00.000Z', { ddtIssuedAt: null, reason: 'Recorded late.' })).toEqual([])
  })
})

describe('this shipment travels without a DDT (B-OS-017, L13)', () => {
  const facts = { status: 'PACKED' as const, origin: 'NEXUS', ddtRequired: true, liveDdtNumber: null as string | null }

  it('a Nexus shipment that has not left, while no DDT of it is live; the same choice twice is refused', () => {
    expect(ddtRequiredRefusal(facts, false)).toBeNull()
    expect(ddtRequiredRefusal({ ...facts, status: 'DRAFT' }, false)).toBeNull()
    expect(ddtRequiredRefusal({ ...facts, ddtRequired: false }, true)).toBeNull()
    expect(ddtRequiredRefusal(facts, true)?.code).toBe('SAME')
    expect(ddtRequiredRefusal({ ...facts, liveDdtNumber: '145/2026' }, false)).toEqual({ code: 'DDT_LIVE', message: 'DDT 145/2026 is live for this shipment: cancel the DDT first.' })
    expect(ddtRequiredRefusal({ ...facts, status: 'SHIPPED' }, false)?.code).toBe('LEFT')
    expect(ddtRequiredRefusal({ ...facts, status: 'CANCELLED' }, false)?.code).toBe('CANCELLED')
    expect(ddtRequiredRefusal({ ...facts, origin: 'ELSEWHERE' }, false)?.code).toBe('ELSEWHERE')
  })

  it('no DDT is issued while it travels without one; with one required nothing changes', () => {
    expect(ddtNotNeededWords(true)).toBeNull()
    expect(ddtNotNeededWords(false)).toMatch(/^This shipment travels without a DDT/)
  })
})
// ---- end B-OS-014, B-OS-017
