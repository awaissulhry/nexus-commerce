import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { composeDocument, documentProblems } from '../../documents/compose'
import type { CompanyLegal } from '../../documents/model'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { Dec } from '../../tax/decimal'
import { createBody, receiveBody, shipBody } from './contracts'
import { transferDdtDocument, type TransferDdtFacts } from './ddt'
import { INVENTORY_TRANSFERS_MANAGE } from './permissions'
import {
  differenceOf,
  draftProblems,
  inTransitOf,
  isLate,
  lineProblems,
  lineStateOf,
  openDifference,
  quantityOut,
  receiveProblems,
  settleProblems,
  shipProblems,
  statusAfterReceipt,
  tilesOf,
  TRANSFER_REFUSAL_WORDS,
  TRANSFER_REFUSALS,
  transferActions,
  typedQuantity,
} from './rules'

const d = (value: string) => new Dec(value)
const ID = '0190f0e2-0000-7000-8000-000000000001'
const ID2 = '0190f0e2-0000-7000-8000-000000000002'

describe('the permission, the template and the event', () => {
  it('inventory.transfers.manage is declared and the warehouse template holds it (office only)', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(INVENTORY_TRANSFERS_MANAGE)).toBe(true)
    expect(templateOf('warehouse')?.permissions).toContain(INVENTORY_TRANSFERS_MANAGE)
    expect(templateOf('buyer')?.permissions ?? []).not.toContain(INVENTORY_TRANSFERS_MANAGE)
    expect(templateOf('quality_inspector')?.permissions ?? []).not.toContain(INVENTORY_TRANSFERS_MANAGE)
  })

  it('inventory.transfer_changed is in the catalogue, live for inventory.stock.view', () => {
    const event = EVENT_DEFINITIONS.find((entry) => entry.type === 'inventory.transfer_changed')
    expect(event?.live?.permission).toBe('inventory.stock.view')
  })

  it('every refusal has its words', () => {
    for (const code of TRANSFER_REFUSALS) expect(TRANSFER_REFUSAL_WORDS[code]).toBeTruthy()
  })
})

describe('quantities and lines', () => {
  it('a typed quantity: above 0 (or 0 when asked), at most 4 decimals', () => {
    expect(typedQuantity('12.5')?.toString()).toBe('12.5')
    expect(typedQuantity('0')).toBeNull()
    expect(typedQuantity('0', true)?.isZero()).toBe(true)
    expect(typedQuantity('1.23456')).toBeNull()
    expect(typedQuantity('-1')).toBeNull()
    expect(quantityOut(d('30.5000'))).toBe('30.5')
    expect(quantityOut(d('28'))).toBe('28')
  })

  it('in transit is what entered the transit place less what left it', () => {
    const transit = 'T'
    const moves = [
      { fromLocationId: 'BIN', toLocationId: transit, baseQuantity: '30' },
      { fromLocationId: transit, toLocationId: null, baseQuantity: '28' },
    ]
    expect(inTransitOf(moves, transit).toString()).toBe('2')
    expect(inTransitOf([...moves, { fromLocationId: transit, toLocationId: null, baseQuantity: '2' }], transit).isZero()).toBe(true)
  })

  it('a line: draft, in transit, received, short with its reason, settled', () => {
    const line = { shippedQuantity: '30', receivedQuantity: '28', inTransit: '2', differenceReasonCode: null, resolvedAt: null }
    expect(lineStateOf({ ...line, shippedQuantity: null })).toBe('DRAFT')
    expect(lineStateOf(line)).toBe('IN_TRANSIT')
    expect(differenceOf(line).toString()).toBe('2')
    expect(lineStateOf({ ...line, differenceReasonCode: 'SHORT' })).toBe('SHORT')
    expect(openDifference({ ...line, differenceReasonCode: 'SHORT' })).toBe(true)
    expect(lineStateOf({ ...line, differenceReasonCode: 'SHORT', resolvedAt: '2026-11-12T10:00:00.000Z' })).toBe('SETTLED')
    expect(lineStateOf({ ...line, receivedQuantity: '30', inTransit: '0' })).toBe('RECEIVED')
  })

  it('a line names the lot and hide its tracking asks, a hide whole, a lot that travels, no more than the place holds', () => {
    const base = { tracking: 'LOT' as const, lotId: 'L', hideId: null, lotStatus: 'RELEASED', quantity: d('10'), available: d('12'), hideElsewhere: false }
    expect(lineProblems(base)).toEqual([])
    expect(lineProblems({ ...base, lotId: null }).map((entry) => entry.code)).toEqual(['LOT_REQUIRED'])
    expect(lineProblems({ ...base, tracking: 'NONE' }).map((entry) => entry.code)).toEqual(['NOT_TRACKED'])
    expect(lineProblems({ ...base, tracking: 'HIDE' }).map((entry) => entry.code)).toEqual(['HIDE_REQUIRED'])
    expect(lineProblems({ ...base, lotStatus: 'BLOCKED' }).map((entry) => entry.code)).toEqual(['LOT_NOT_SENT'])
    expect(lineProblems({ ...base, quantity: d('13') }).map((entry) => entry.code)).toEqual(['NOT_ENOUGH_STOCK'])
    expect(lineProblems({ ...base, tracking: 'HIDE', hideId: 'H', quantity: d('10') }).map((entry) => entry.code)).toEqual(['HIDE_WHOLE'])
    expect(lineProblems({ ...base, tracking: 'HIDE', hideId: 'H', quantity: d('12') })).toEqual([])
    expect(lineProblems({ ...base, tracking: 'HIDE', hideId: 'H', quantity: d('12'), hideElsewhere: true }).map((entry) => entry.code)).toEqual(['HIDE_ON_ANOTHER_LINE'])
  })
})

describe('the steps', () => {
  it('a draft goes to another active site, expected not before it leaves', () => {
    expect(draftProblems({ fromSiteId: 'A', toSiteId: 'A', fromActive: true, toActive: true }).refusals.map((entry) => entry.code)).toEqual(['SAME_SITE'])
    expect(draftProblems({ fromSiteId: 'A', toSiteId: 'B', fromActive: true, toActive: false }).refusals.map((entry) => entry.code)).toEqual(['SITE_CLOSED'])
    expect(draftProblems({ fromSiteId: 'A', toSiteId: 'B', fromActive: true, toActive: true, shipOn: '2026-11-12', expectedOn: '2026-11-11' }).fields).toHaveLength(1)
  })

  it('the ship needs a draft with lines, each with a place and the stock it takes', () => {
    expect(shipProblems('SHIPPED', []).map((entry) => entry.code)).toEqual(['NOT_DRAFT'])
    expect(shipProblems('DRAFT', []).map((entry) => entry.code)).toEqual(['NO_LINES'])
    const line = { seq: 10, pickPlaceId: 'P', quantity: d('5'), available: d('5'), hide: false }
    expect(shipProblems('DRAFT', [line])).toEqual([])
    expect(shipProblems('DRAFT', [{ ...line, pickPlaceId: null }]).map((entry) => entry.code)).toEqual(['NO_PICK_PLACE'])
    expect(shipProblems('DRAFT', [{ ...line, available: d('4') }]).map((entry) => entry.code)).toEqual(['NOT_ENOUGH_STOCK'])
  })

  it('a receipt: no more than in transit, a hide whole, a place to put it, a known reason, something said', () => {
    const lines = [
      { id: 'L1', seq: 10, hide: false, shippedQuantity: d('30'), receivedQuantity: d('0'), inTransit: d('30'), differenceReasonCode: null, putPlaceId: 'P' },
      { id: 'L2', seq: 20, hide: true, shippedQuantity: d('50'), receivedQuantity: d('0'), inTransit: d('50'), differenceReasonCode: null, putPlaceId: null },
    ]
    const reasons = new Set(['SHORT', 'DAMAGED'])
    const codes = (entries: Parameters<typeof receiveProblems>[2]) => receiveProblems('SHIPPED', lines, entries, reasons).refusals.map((entry) => entry.code)
    expect(codes([{ lineId: 'L1', quantity: d('28'), differenceReasonCode: 'SHORT' }])).toEqual([])
    expect(codes([{ lineId: 'L1', quantity: d('31'), differenceReasonCode: null }])).toEqual(['MORE_THAN_IN_TRANSIT'])
    expect(codes([{ lineId: 'L2', quantity: d('20'), differenceReasonCode: null }])).toEqual(['HIDE_WHOLE', 'NO_PUT_PLACE'])
    expect(codes([{ lineId: 'L1', quantity: d('28'), differenceReasonCode: 'LOST_AT_SEA' }])).toEqual(['REASON_UNKNOWN'])
    expect(codes([{ lineId: 'L1', quantity: d('0'), differenceReasonCode: null }])).toEqual(['NOTHING_RECEIVED'])
    expect(receiveProblems('DRAFT', lines, [], reasons).refusals.map((entry) => entry.code)).toEqual(['NOT_IN_TRANSIT'])
    expect(receiveProblems('SHIPPED', lines, [{ lineId: 'X', quantity: d('1'), differenceReasonCode: null }], reasons).fields).toHaveLength(1)
  })

  it('after a receipt: RECEIVED once every line arrived or says why not; else PARTLY_RECEIVED once something arrived', () => {
    const full = { shippedQuantity: '30', receivedQuantity: '30', differenceReasonCode: null }
    const short = { shippedQuantity: '30', receivedQuantity: '28', differenceReasonCode: null }
    const none = { shippedQuantity: '30', receivedQuantity: '0', differenceReasonCode: null }
    expect(statusAfterReceipt('SHIPPED', [full])).toBe('RECEIVED')
    expect(statusAfterReceipt('SHIPPED', [full, short])).toBe('PARTLY_RECEIVED')
    expect(statusAfterReceipt('SHIPPED', [full, { ...short, differenceReasonCode: 'SHORT' }])).toBe('RECEIVED')
    expect(statusAfterReceipt('SHIPPED', [none])).toBe('SHIPPED')
  })

  it('a difference is settled once, after its reason, while something of it is in transit; sent back only if nothing arrived', () => {
    const facts = { status: 'RECEIVED' as const, shipped: true, differenceReasonCode: 'SHORT', resolvedAt: null, receivedQuantity: d('28'), inTransit: d('2') }
    expect(settleProblems(facts, 'ADJUSTMENT')).toEqual([])
    expect(settleProblems(facts, 'SENT_BACK').map((entry) => entry.code)).toEqual(['SENT_BACK_PART'])
    expect(settleProblems({ ...facts, receivedQuantity: d('0'), inTransit: d('30') }, 'SENT_BACK')).toEqual([])
    expect(settleProblems({ ...facts, differenceReasonCode: null }, 'CARRIER_CLAIM').map((entry) => entry.code)).toEqual(['REASON_FIRST'])
    expect(settleProblems({ ...facts, resolvedAt: 'x' }, 'ADJUSTMENT').map((entry) => entry.code)).toEqual(['SETTLED'])
    expect(settleProblems({ ...facts, inTransit: d('0') }, 'ADJUSTMENT').map((entry) => entry.code)).toEqual(['NOTHING_TO_SETTLE'])
    expect(settleProblems({ ...facts, status: 'DRAFT', shipped: false }, 'ADJUSTMENT').map((entry) => entry.code)).toEqual(['NOT_SHIPPED'])
  })

  it('the record holds each step with its reason: the sender ships, the receiver receives', () => {
    const facts = { status: 'DRAFT' as const, lines: 1, unplacedLines: 0, shortLines: 0, openDifferences: 0, hasDdt: false, manageFrom: true, manageTo: false }
    const draft = transferActions(facts)
    expect(draft.ship.allowed).toBe(true)
    expect(draft.receive.refusal).toBe('NO_RIGHT_TO')
    expect(draft.printDdt.refusal).toBe('NO_DDT')
    expect(transferActions({ ...facts, lines: 0 }).ship.refusal).toBe('NO_LINES')
    expect(transferActions({ ...facts, shortLines: 1 }).ship.refusal).toBe('NOT_ENOUGH_STOCK')
    expect(transferActions({ ...facts, manageFrom: false }).ship.refusal).toBe('NO_RIGHT_FROM')
    const shipped = transferActions({ ...facts, status: 'SHIPPED', hasDdt: true, manageFrom: false, manageTo: true })
    expect([shipped.receive.allowed, shipped.ship.refusal, shipped.cancel.refusal, shipped.printDdt.allowed]).toEqual([true, 'NO_RIGHT_FROM', 'NO_RIGHT_FROM', true])
    expect(transferActions({ ...facts, status: 'RECEIVED', manageTo: true, openDifferences: 1 }).settle.allowed).toBe(true)
  })

  it('the tiles: in transit, arriving today, with differences; late is in transit and expected before today', () => {
    expect(tilesOf({ status: 'SHIPPED', expectedOn: '2026-11-12', openDifferences: 0 }, '2026-11-12')).toEqual(['IN_TRANSIT', 'ARRIVING_TODAY'])
    expect(tilesOf({ status: 'RECEIVED', expectedOn: '2026-11-12', openDifferences: 1 }, '2026-11-12')).toEqual(['WITH_DIFFERENCES'])
    expect(isLate({ status: 'PARTLY_RECEIVED', expectedOn: '2026-11-11' }, '2026-11-12')).toBe(true)
    expect(isLate({ status: 'RECEIVED', expectedOn: '2026-11-11' }, '2026-11-12')).toBe(false)
  })
})

describe('the contracts', () => {
  it('take what the screens send and refuse the rest', () => {
    expect(createBody.safeParse({ fromSiteId: ID, toSiteId: ID2 }).success).toBe(true)
    expect(createBody.safeParse({ fromSiteId: ID, toSiteId: ID2, colour: 'x' }).success).toBe(false)
    expect(shipBody.safeParse({ version: 1, transportBy: 'SENDER', packages: 2, grossWeightKg: '12.5' }).success).toBe(true)
    expect(shipBody.safeParse({ version: 1, transportBy: 'SENDER', packages: 0, grossWeightKg: '12.5' }).success).toBe(false)
    expect(shipBody.safeParse({ version: 1, transportBy: 'SENDER', packages: 1, grossWeightKg: '1', trackingUrl: 'http://x' }).success).toBe(false)
    expect(receiveBody.safeParse({ version: 2, lines: [{ lineId: ID, quantity: '28', differenceReasonCode: 'SHORT' }] }).success).toBe(true)
    expect(receiveBody.safeParse({ version: 2, lines: [{ lineId: ID, quantity: '28', differenceReasonCode: 'TWO WORDS' }] }).success).toBe(false)
  })
})

describe('the DDT', () => {
  const company: CompanyLegal = {
    legalName: 'Pelli Inventate S.r.l.',
    tradeName: null,
    address: { line1: 'Via Inventata 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
    vatNumber: 'IT12345670009',
    fiscalCode: '12345670009',
    reaOffice: 'MI',
    reaNumber: '0000001',
    shareCapital: null,
    soleShareholder: null,
    inLiquidation: null,
    currency: 'EUR',
    pec: null,
    documentFooter: null,
  }
  const facts: TransferDdtFacts = {
    number: '144/2026',
    date: '2026-11-12',
    language: 'it',
    currency: 'EUR',
    transferNumber: 'TRF-2026-0007',
    fromSite: { code: 'A1', name: 'Plant A' },
    toSite: { code: 'B1', name: 'Plant B', address: { line1: 'Via Seconda 2', postalCode: '35100', city: 'Padova', country: 'IT' } },
    recipient: { name: 'Pelli Inventate S.r.l.', address: company.address, vatNumber: 'IT12345670009', fiscalCode: '12345670009' },
    reason: 'TRANSFER',
    reasonText: null,
    transportBy: 'SENDER',
    carrier: null,
    startAt: '2026-11-12T08:00:00.000Z',
    appearance: 'colli',
    packages: 2,
    grossWeightKg: '18.5',
    lines: [{ code: 'LIN-01', name: 'Lining', colour: 'Grey', lot: 'L-0001', hide: null, quantity: '30', uom: 'M' }],
  }

  it('prints the sending company, the receiving company and site, the transfer and its goods', () => {
    const document = transferDdtDocument(facts)
    expect(documentProblems({ ...document, company })).toEqual([])
    expect(document.transport?.destination?.city).toBe('Padova')
    expect(document.notes).toBe('Trasferimento TRF-2026-0007 tra sedi: A1 Plant A → B1 Plant B.')
    expect(document.lines[0]?.description).toBe('Lining, Grey - lotto L-0001')
    expect(composeDocument({ ...document, company, sample: false }).type).toBe('DDT')
    expect(transferDdtDocument({ ...facts, language: 'en' }).notes).toBe('Transfer TRF-2026-0007 between sites: A1 Plant A → B1 Plant B.')
  })

  it('a receiving company without its address prints the site’s; a carrier is named', () => {
    const document = transferDdtDocument({ ...facts, recipient: { ...facts.recipient, address: null }, transportBy: 'CARRIER', carrier: { name: 'Corriere Inventato' } })
    expect(document.party.address?.city).toBe('Padova')
    expect(document.transport?.carrier?.name).toBe('Corriere Inventato')
  })
})
