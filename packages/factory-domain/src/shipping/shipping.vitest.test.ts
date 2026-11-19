import { describe, expect, it } from 'vitest'
import { composeDocument } from '../documents/compose'
import type { CompanyLegal } from '../documents/model'
import { canTransition } from '../state/machine'
import { events } from './events'
import { packingListDocument } from './packing-list'
import { SHIPPING_FLOOR_PERMISSIONS, SHIPPING_PERMISSIONS } from './permissions'
import { packingPrinterProblems, shippingSettingsProblems } from './settings'
import {
  // B-OP-040 (order page N6).
  JOIN_PROBLEM_CODES, // B-OP-047
  joinProblems,
  joinShipmentOf,
  joinVerdict,
  NOT_A_CELL,
  ordersOn,
  sameShipTo,
  type JoinOrder,
  lineProblems,
  lineQuantityProblems,
  nextParcelSeq,
  packingProblems,
  parcelChangeProblems,
  parcelMeasureProblems,
  placementOf,
  readyBySalesOrder,
  renumberedParcels,
  shipmentMachine,
  shippable,
  shippableProblems,
  type PackLine,
  type ShipmentFacts,
} from './shipments'

/* Every name, code and address here is made up. */

const line = (fields: Partial<PackLine> & { id: string }): PackLine => ({ workOrderSizeId: 'cell-1', parcelId: null, quantity: 2, serials: 0, serialTracked: false, ...fields })

describe('only released garments ship (LOG-002, QHS-058; Reg. (EU) 2016/425 art. 8)', () => {
  it('Reg. 2016/425 art. 8: a cell ships its releases less their reversals, less what shipments that are not cancelled hold', () => {
    expect(shippable({ released: 4, reversed: 1, onShipments: 1 })).toBe(2)
    expect(shippable({ released: 2, reversed: 1, onShipments: 1 })).toBe(0)
    expect(shippable({ released: 1, reversed: 1, onShipments: 1 })).toBe(0)
    expect(shippableProblems({ released: 2, reversed: 0, onShipments: 1, label: 'WO-0003 BLK 52' }, 1)).toEqual([])
    expect(shippableProblems({ released: 2, reversed: 1, onShipments: 1, label: 'WO-0003 BLK 52' }, 1)).toEqual([
      'Only released garments ship: WO-0003 BLK 52 has 1 released (less reversals) and 1 on shipments, so 0 can still ship; 1 asked.',
    ])
  })

  it("a line is the shipment's party and sales order, made at its site, from 1 garment, while the shipment is a DRAFT", () => {
    const shipment = { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-3', status: 'DRAFT' as const }
    expect(lineProblems(shipment, { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-3' }, 1, 'body/lines/0')).toEqual([])
    // B-OP-046 (order page N6): the "other order" case is now the other-PARTY one — another customer's garments read as an
    // unknown cell (another order of the same customer joins only as joinProblems allows: see the B-OP-040 block).
    expect(lineProblems(shipment, { siteId: 'A1', partyId: 'P2', salesOrderId: 'SO-2' }, 1, 'body/lines/0')).toEqual([{ path: 'body/lines/0/workOrderSizeId', message: 'Not a work order cell.' }])
    expect(lineProblems(shipment, { siteId: 'B1', partyId: 'P1', salesOrderId: 'SO-3' }, 1, 'body/lines/0')[0]!.message).toMatch(/another site/)
    expect(lineProblems({ ...shipment, status: 'PACKED' }, { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-3' }, 0, 'body')).toEqual([
      { path: 'body', message: 'The shipment is PACKED; its lines change only while it is a DRAFT.' },
      { path: 'body/quantity', message: 'A line ships at least one garment.' },
    ])
    expect(lineQuantityProblems(line({ id: 'L1', serials: 2 }), 1)).toEqual(['The line holds 2 serial(s); unpack 1 of them first.'])
    expect(lineQuantityProblems(line({ id: 'L1' }), 0)).toEqual(['A line ships at least one garment; remove it instead.'])
  })
})

describe('packing: garments into parcels (LOG-039)', () => {
  it('moves a whole line, splits part of it, merges into the parcel that holds its cell, and does nothing when it is there', () => {
    const lines = [line({ id: 'L1', quantity: 3 }), line({ id: 'L2', parcelId: 'P2', quantity: 1 }), line({ id: 'L3', workOrderSizeId: 'cell-2', parcelId: 'P1' })]
    expect(placementOf(lines[0]!, 'P1', 3, lines)).toEqual({ ok: true, placement: { kind: 'move', lineId: 'L1', parcelId: 'P1' } })
    expect(placementOf(lines[0]!, 'P1', 1, lines)).toEqual({ ok: true, placement: { kind: 'split', fromLineId: 'L1', keeps: 2, quantity: 1, parcelId: 'P1' } })
    expect(placementOf(lines[0]!, 'P2', 2, lines)).toEqual({ ok: true, placement: { kind: 'merge', fromLineId: 'L1', intoLineId: 'L2', quantity: 2, removesSource: false, movesSerials: false } })
    expect(placementOf(lines[1]!, null, 1, lines)).toEqual({ ok: true, placement: { kind: 'merge', fromLineId: 'L2', intoLineId: 'L1', quantity: 1, removesSource: true, movesSerials: false } })
    expect(placementOf(lines[2]!, 'P1', 2, lines)).toEqual({ ok: true, placement: { kind: 'none' } })
    expect(placementOf(lines[0]!, 'P1', 4, lines)).toEqual({ ok: false, problem: 'Move from 1 to 3 garment(s) of this line.' })
  })

  it('moves a line that holds serials only whole, its serials with it', () => {
    const lines = [line({ id: 'L1', quantity: 2, serials: 1, serialTracked: true }), line({ id: 'L2', parcelId: 'P1', quantity: 1, serialTracked: true })]
    expect(placementOf(lines[0]!, 'P1', 1, lines)).toEqual({ ok: false, problem: 'The line holds 1 serial(s): move it whole, or unpack its serials and pack them one by one.' })
    expect(placementOf(lines[0]!, 'P1', 2, lines)).toEqual({ ok: true, placement: { kind: 'merge', fromLineId: 'L1', intoLineId: 'L2', quantity: 2, removesSource: true, movesSerials: true } })
  })

  it('weighs in kilograms and measures in centimetres above 0, numbers parcels from 1 and closes the gaps', () => {
    expect(parcelMeasureProblems({ grossWeightKg: '3.1', lengthCm: '60', widthCm: '40.5', heightCm: null })).toEqual([])
    expect(parcelMeasureProblems({ grossWeightKg: '0', lengthCm: '1.234' })).toEqual([
      { path: 'body/grossWeightKg', message: 'Expected a weight in kilograms above 0, with at most 4 decimals.' },
      { path: 'body/lengthCm', message: 'Expected centimetres above 0, with at most 2 decimals.' },
    ])
    expect(nextParcelSeq([])).toBe(1)
    expect(nextParcelSeq([{ seq: 1 }, { seq: 3 }])).toBe(4)
    expect(renumberedParcels([{ id: 'c', seq: 4 }, { id: 'a', seq: 1 }, { id: 'b', seq: 3 }])).toEqual([
      { id: 'b', seq: 2 },
      { id: 'c', seq: 3 },
    ])
    expect(parcelChangeProblems('PACKED', { grossWeightKg: null })).toEqual(['The shipment is PACKED: every parcel keeps a weight (unpack it first).'])
    expect(parcelChangeProblems('SHIPPED', { grossWeightKg: '2' })).toEqual(['The shipment is SHIPPED; its parcels change only until it leaves.'])
  })
})

describe('the shipment machine (PLT-097: a move says what is missing)', () => {
  const facts = (fields: Partial<ShipmentFacts> = {}): ShipmentFacts => ({
    lines: [line({ id: 'L1', parcelId: 'P1', quantity: 2, serialTracked: true, serials: 2 })],
    parcels: [{ id: 'P1', seq: 1, grossWeightKg: '3.1000', labelled: false }],
    liveDdts: 0,
    ...fields,
  })

  it('packs a shipment whose garments are all in weighed parcels, with a serial each for a serial-tracked style (Q31)', () => {
    expect(canTransition(shipmentMachine, 'DRAFT', 'PACKED', facts()).ok).toBe(true)
    expect(packingProblems({ lines: [], parcels: [] })).toEqual(['at least one line of released garments', 'at least one parcel'])
    const missing = facts({
      lines: [line({ id: 'L1', quantity: 2, serialTracked: true, serials: 1 }), line({ id: 'L2', parcelId: 'P1', workOrderSizeId: 'cell-2', quantity: 1 })],
      parcels: [
        { id: 'P1', seq: 1, grossWeightKg: null, labelled: false },
        { id: 'P2', seq: 2, grossWeightKg: '1', labelled: false },
      ],
    })
    const check = canTransition(shipmentMachine, 'DRAFT', 'PACKED', missing)
    expect(check.ok).toBe(false)
    expect(check.ok ? [] : check.missing).toEqual([
      'every garment in a parcel (2 not packed)',
      'every parcel weighed (parcel 1 not weighed)',
      'garments in every parcel (parcel 2 is empty: remove it)',
      'a serial for each garment of a serial-tracked style (1 missing)',
    ])
  })

  it('unpacks or cancels only without a carrier label or a live DDT; never ships here (B-W1-47) and never leaves CANCELLED', () => {
    expect(canTransition(shipmentMachine, 'PACKED', 'DRAFT', facts()).ok).toBe(true)
    const declared = facts({ parcels: [{ id: 'P1', seq: 1, grossWeightKg: '3', labelled: true }], liveDdts: 1 })
    const check = canTransition(shipmentMachine, 'PACKED', 'CANCELLED', declared)
    expect(check.ok ? [] : check.missing).toEqual(['no carrier label (1 parcel(s) labelled: void the labels first)', 'no live DDT (cancel the DDT first)'])
    expect(canTransition(shipmentMachine, 'DRAFT', 'SHIPPED', facts()).ok).toBe(false)
    expect(canTransition(shipmentMachine, 'CANCELLED', 'DRAFT', facts()).ok).toBe(false)
    expect(shipmentMachine.finals).toEqual(['DELIVERED', 'RETURNED', 'CANCELLED'])
  })
})

describe('the ready-to-ship list (SCR-066)', () => {
  it('keeps the cells that can still ship, grouped by sales order', () => {
    const cells = [
      { workOrderSizeId: 'c1', salesOrderId: 'SO-2', released: 2, reversed: 1, onShipments: 0 },
      { workOrderSizeId: 'c2', salesOrderId: 'SO-2', released: 1, reversed: 0, onShipments: 1 },
      { workOrderSizeId: 'c3', salesOrderId: 'SO-3', released: 2, reversed: 0, onShipments: 1 },
    ]
    expect(readyBySalesOrder(cells)).toEqual([
      { salesOrderId: 'SO-2', cells: [{ ...cells[0], shippable: 1 }] },
      { salesOrderId: 'SO-3', cells: [{ ...cells[2], shippable: 1 }] },
    ])
  })
})

describe('shipping settings (LOG-117)', () => {
  const sender = { name: 'Fabbrica Esempio S.r.l.', line1: 'Via Esempio 1', postalCode: '00000', city: 'Esempio', country: 'IT' }

  it('needs a sender who and where, a carrier code for a service, and a cut-off HH:MM', () => {
    expect(shippingSettingsProblems({ senderAddress: sender, defaultCarrierCode: 'brt', defaultServiceCode: 'brt:express', cutOffTime: '16:30' })).toEqual([])
    expect(
      shippingSettingsProblems({
        senderAddress: { ...sender, name: ' ', country: 'it', email: 'nope' },
        returnAddress: { ...sender, city: '' },
        defaultCarrierCode: 'BRT Express',
        defaultServiceCode: 'x',
        cutOffTime: '24:00',
      }).map((issue) => issue.path),
    ).toEqual([
      'body/senderAddress/name',
      'body/senderAddress/country',
      'body/senderAddress/email',
      'body/returnAddress/city',
      'body/defaultCarrierCode',
      'body/cutOffTime',
    ])
    expect(shippingSettingsProblems({ senderAddress: sender, defaultServiceCode: 'x' })).toEqual([
      { path: 'body/defaultServiceCode', message: 'A default service belongs to a default carrier: name the carrier too.' },
    ])
  })

  it("takes the site's own printers: labels on a ZPL printer, documents on an A4 one, never an archived one", () => {
    expect(packingPrinterProblems('labelPrinterId', { siteId: 'A1', kind: 'LABEL_ZPL', status: 'ACTIVE' }, 'A1', 'body/labelPrinterId')).toEqual([])
    expect(packingPrinterProblems('labelPrinterId', { siteId: 'A1', kind: 'A4_PDF', status: 'ACTIVE' }, 'A1', 'x')[0]!.message).toMatch(/label printer/)
    expect(packingPrinterProblems('documentPrinterId', { siteId: 'B1', kind: 'A4_PDF', status: 'ACTIVE' }, 'A1', 'x')[0]!.message).toBe('Not a printer of this site.')
    expect(packingPrinterProblems('documentPrinterId', { siteId: 'A1', kind: 'A4_PDF', status: 'ARCHIVED' }, 'A1', 'x')[0]!.message).toBe('This printer is archived.')
  })
})

describe('the packing list', () => {
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

  it('lists the garments parcel by parcel, with batch and serials, the parcels and their weight, and no price', () => {
    const document = packingListDocument({
      number: 'SH-2026-00001',
      date: '2026-11-23',
      language: 'it',
      currency: 'EUR',
      party: { name: 'Cliente Esempio S.r.l.', address: null },
      shipTo: { name: 'Officina Esempio', line1: 'Via Esempio 12', postalCode: '00000', city: 'Esempio', country: 'IT' },
      salesOrderNumber: 'SO-0003',
      customerRef: 'PO-78',
      parcels: [
        { id: 'P2', seq: 2, grossWeightKg: '2.9000' },
        { id: 'P1', seq: 1, grossWeightKg: '3.1000' },
      ],
      lines: [
        { parcelId: 'P2', styleCode: 'JKT-03', styleName: 'Giacca', colourway: 'Nero', size: '52', quantity: 1, batchNumber: 'BT-3', serials: ['S-2'] },
        { parcelId: 'P1', styleCode: 'JKT-02', styleName: 'Giacca', colourway: 'Nero', size: '50', quantity: 2, batchNumber: null, serials: [] },
      ],
    })
    const composed = composeDocument({ ...document, company: COMPANY })
    expect(composed.table.rows).toEqual([
      ['1', 'JKT-02', 'Giacca, Nero, taglia 50', '2', 'PCS'],
      ['2', 'JKT-03', 'Giacca, Nero, taglia 52 - lotto BT-3 - matricole S-2', '1', 'PCS'],
    ])
    expect(document.packing).toEqual({ packages: 2, grossWeightKg: '6.0000', shipTo: expect.objectContaining({ name: 'Officina Esempio' }) })
    expect(composed.facts.map((fact) => fact.value)).toEqual(['SO-0003', 'PO-78', '2', '6'])
    expect(composed.totals).toEqual([])
  })

  // B-OP-042 (order page N6): a packing list of a shipment that carries two orders of one customer.
  it('names every order the shipment carries: one SALES_ORDER and CUSTOMER_ORDER reference each, the first first', () => {
    const base = {
      number: 'SH-2026-00002',
      date: '2026-11-23',
      language: 'it' as const,
      currency: 'EUR' as const,
      party: { name: 'Cliente Esempio S.r.l.', address: null },
      shipTo: null,
      salesOrderNumber: 'SO-0003',
      customerRef: 'PO-78',
      parcels: [{ id: 'P1', seq: 1, grossWeightKg: '1.0000' }],
      lines: [{ parcelId: 'P1', styleCode: 'JKT-02', styleName: 'Giacca', colourway: 'Nero', size: '50', quantity: 1, batchNumber: null, serials: [] }],
    }
    const two = packingListDocument({ ...base, orders: [{ number: 'SO-0003', customerRef: 'PO-78' }, { number: 'SO-0004', customerRef: null }] })
    expect(two.references).toEqual([
      { kind: 'SALES_ORDER', number: 'SO-0003' },
      { kind: 'CUSTOMER_ORDER', number: 'PO-78' },
      { kind: 'SALES_ORDER', number: 'SO-0004' },
    ])
    // One order: as before.
    expect(packingListDocument(base).references).toEqual(packingListDocument({ ...base, orders: [{ number: 'SO-0003', customerRef: 'PO-78' }] }).references)
  })
})

describe('declarations', () => {
  it('declares seven permissions (the floor packs only) and ten events without money', () => {
    expect(SHIPPING_PERMISSIONS).toEqual(['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage', 'shipping.ddt.issue', 'shipping.ddt.cancel'])
    expect(SHIPPING_FLOOR_PERMISSIONS).toEqual(['shipping.pack'])
    expect(events.map((event) => event.type)).toEqual(['shipment.created', 'shipment.status_changed', 'shipment.packing_changed', 'shipping.settings_saved', 'ddt.issued', 'ddt.cancelled', 'shipment.labels_bought', 'shipment.label_voided', 'shipment.tracking_recorded', 'shipment.tracking_poll_due', 'shipment.documents_attached', 'shipment.documents_link_sent', 'ddt.source_issued', 'ddt.source_cancelled',
      // B-W2a-48: the freight charged and the intra-EU transport evidence.
      'shipment.freight_changed', 'shipping.freight_rule_saved', 'shipment.evidence_changed',
      // B-W2b-19: the carrier's freight cost and a carrier return back into finished goods.
      'shipment.freight_cost_changed', 'shipment.carrier_return_received',
      // B-OP-040: the orders a shipment carries changed.
      'shipment.orders_changed',
      // B-W2b-170: links to the branded tracking page made.
      'shipment.tracking_link_made'])
  })
})

// B-OP-040 (order page N6, lines-derived): several orders of one customer on one shipment — B-OP-047: switched on.
describe('several orders of one customer on one shipment (B-OP-040; on since B-OP-047)', () => {
  const milano = { name: 'Brand Alpha store', line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano', country: 'IT' }
  const first: JoinOrder = { id: 'SO-1', number: 'SO-0150', partyId: 'P1', companyId: 'C1', status: 'CONFIRMED', shipTo: milano, currency: 'EUR', taxMode: 'IT_B2B', incoterm: null, billTo: { legalName: 'Brand Alpha', vatNumber: 'IT 0000000000 1' } }
  const shipment = joinShipmentOf(first, { number: 'SH-0012', status: 'DRAFT', siteId: 'A1', siteCompanyId: 'C1', customerHold: null })
  const other = (fields: Partial<JoinOrder> = {}): JoinOrder => ({ ...first, id: 'SO-2', number: 'SO-0151', ...fields })

  it('the same address normalised (case, spaces, postal code): an order of the same customer, address, currency and terms joins (B-OP-047)', () => {
    expect(sameShipTo(milano, { ...milano, line1: '  via  esempio 1 ', postalCode: '20 100', city: 'MILANO', country: 'it' })).toBe(true)
    expect(joinProblems(shipment, other({ shipTo: { ...milano, city: ' milano ' }, billTo: { vatNumber: 'IT00000000001' } }))).toEqual([])
    expect(joinVerdict(joinProblems(shipment, other()))).toEqual({ allowed: true, code: null, why: null })
    expect(JOIN_PROBLEM_CODES).not.toContain('MULTI_ORDER_OFF')
    expect(joinVerdict([])).toEqual({ allowed: true, code: null, why: null })
    expect(joinVerdict(joinProblems(shipment, other({ currency: 'USD' }))).code).toBe('CURRENCY')
  })

  it('says the real reason first, in words: another address, company, currency, tax mode, Incoterm, VAT number, state, hold', () => {
    const bologna = { ...milano, line1: 'Via Altra 2', postalCode: '40100', city: 'Bologna' }
    expect(joinProblems(shipment, other({ shipTo: bologna }))[0]).toEqual({ code: 'SHIP_TO', message: 'SO-0151 goes to Bologna, shipment SH-0012 to Milano: one shipment goes to one address.' })
    expect(joinProblems(shipment, other({ shipTo: { ...milano, line1: 'Via Altra 2' } }))[0]!.message).toBe('SO-0151 goes to Via Altra 2, Milano, shipment SH-0012 to Via Esempio 1, Milano: one shipment goes to one address.')
    expect(joinProblems(shipment, other({ companyId: 'C2' }))[0]!.code).toBe('COMPANY')
    expect(joinProblems(shipment, other({ currency: 'USD' }))[0]!.message).toBe('SO-0151 is in USD, shipment SH-0012 in EUR: one shipment is in one currency.')
    expect(joinProblems(shipment, other({ taxMode: 'EU_B2B' }))[0]!.code).toBe('TAX_MODE')
    expect(joinProblems(shipment, other({ incoterm: 'EXW' }))[0]!.message).toBe('SO-0151 ships EXW, shipment SH-0012 with no Incoterm: one shipment has one Incoterm.')
    expect(joinProblems(shipment, other({ billTo: { vatNumber: 'IT99999999999' } }))[0]!.code).toBe('BILL_TO_VAT')
    expect(joinProblems(shipment, other({ status: 'PENDING_APPROVAL' }))[0]!.message).toBe('SO-0151 is PENDING_APPROVAL: only an open order (confirmed, in production, ready or partly shipped) joins a shipment.')
    for (const status of ['CANCELLED', 'CLOSED', 'SHIPPED']) expect(joinProblems(shipment, other({ status }))[0]!.code).toBe('ORDER_STATE')
    expect(joinProblems({ ...shipment, status: 'PACKED' }, other())[0]).toEqual({ code: 'SHIPMENT_STATE', message: 'Shipment SH-0012 is PACKED: orders join a shipment only while it is a DRAFT.' })
    expect(joinProblems({ ...shipment, customerHold: 'BRAND-ALPHA is on hold.' }, other())[0]).toEqual({ code: 'CUSTOMER_HOLD', message: 'BRAND-ALPHA is on hold.' })
    expect(joinProblems(shipment, other({ siteIds: ['B1'] }))[0]!.code).toBe('SITE')
    // Garments at the shipment's site among others: it joins; every real reason is said, in order (B-OP-047: nothing after them).
    expect(joinProblems(shipment, other({ siteIds: ['A1', 'B1'] }))).toEqual([])
    expect(joinProblems(shipment, other({ currency: 'USD', incoterm: 'EXW' })).map((problem) => problem.code)).toEqual(['CURRENCY', 'INCOTERM'])
    // A new shipment has no number yet.
    expect(joinProblems({ ...shipment, number: null }, other({ currency: 'USD' }))[0]!.message).toBe('SO-0151 is in USD, this shipment in EUR: one shipment is in one currency.')
  })

  it("never names another customer's order: it is answered as an unknown one, with no other reason", () => {
    expect(joinProblems(shipment, other({ partyId: 'P2', currency: 'USD' }))).toEqual([{ code: 'CUSTOMER', message: 'Sales order not found.' }])
  })

  it("a line of another order joins only as joinProblems allows; another customer's cell reads as an unknown cell", () => {
    const draft = { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-1', status: 'DRAFT' as const }
    expect(ordersOn(draft)).toEqual(['SO-1'])
    expect(ordersOn({ ...draft, salesOrderIds: ['SO-1', 'SO-2'] })).toEqual(['SO-1', 'SO-2'])
    expect(lineProblems(draft, { siteId: 'A1', partyId: 'P2', salesOrderId: 'SO-9' }, 1, 'body/lines/0')).toEqual([{ path: 'body/lines/0/workOrderSizeId', message: NOT_A_CELL }])
    expect(NOT_A_CELL).toBe('Not a work order cell.')
    const currency = 'SO-0151 is in USD, shipment SH-0012 in EUR: one shipment is in one currency.'
    expect(lineProblems(draft, { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-2' }, 1, 'body/lines/0', [currency])).toEqual([{ path: 'body/lines/0/workOrderSizeId', message: currency }])
    // Joining allowed (B-OP-047): the site rule still holds.
    expect(lineProblems(draft, { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-2' }, 1, 'body/lines/0', [])).toEqual([])
    expect(lineProblems(draft, { siteId: 'B1', partyId: 'P1', salesOrderId: 'SO-2' }, 1, 'body/lines/0', [])[0]!.message).toMatch(/another site/)
    // An order already on the shipment needs no join.
    expect(lineProblems({ ...draft, salesOrderIds: ['SO-1', 'SO-2'] }, { siteId: 'A1', partyId: 'P1', salesOrderId: 'SO-2' }, 1, 'body/lines/0')).toEqual([])
  })
})
