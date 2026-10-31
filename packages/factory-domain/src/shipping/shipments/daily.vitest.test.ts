import { describe, expect, it } from 'vitest'
import { contentsKey, currentPackingList, nextPackingList, packingListNumber, packingListProblems } from '../packing/versions'
import { backorderTotals, backorderWords, closedShortAtShipProblems, orderCapProblems, sizeBackorder } from './backorder'
import { freightByRule, freightChargeProblems, freightRuleProblems, type FreightFacts } from './freight'
import { cellInStock, onShipmentsFromRelease, takeFromStock } from './stock'
import { collectedProblems, voidAllPlan, voidAllProblems, voidOutcomeWords } from './void'

const size = (overrides: Partial<Parameters<typeof sizeBackorder>[0]> = {}) =>
  sizeBackorder({ size: '52', ordered: 4, closedShort: false, shipped: 0, open: 0, thisShipment: 0, netReleased: 0, onShipments: 0, ...overrides })

describe('partial shipments and the backorder (LOG-004)', () => {
  it('what stays behind is ordered less shipped less on its way, and the released part of it is ready now', () => {
    expect(size({ shipped: 1, thisShipment: 1, netReleased: 3, onShipments: 2 })).toMatchObject({ closed: 0, backorder: 2, readyNow: 1, inProduction: 1 })
    expect(size({ open: 3, thisShipment: 2 })).toMatchObject({ backorder: 0, readyNow: 0, inProduction: 0 })
  })

  it('SAL-210: a line closed short leaves nothing behind (ordered less shipped is closed)', () => {
    expect(size({ closedShort: true, shipped: 1, netReleased: 4 })).toMatchObject({ closed: 3, backorder: 0, readyNow: 0 })
  })

  it('totals and words over the sizes', () => {
    const sizes = [size({ shipped: 1, netReleased: 2, onShipments: 1 }), size({ size: '54', ordered: 2 })]
    const totals = backorderTotals(sizes)
    expect(totals).toMatchObject({ ordered: 6, shipped: 1, backorder: 5, readyNow: 1, inProduction: 4 })
    expect(backorderWords(totals)).toBe('5 garments of the order stay on backorder; 1 released and ready for the next shipment; 4 still to be made or released.')
    expect(backorderWords({ backorder: 0, readyNow: 0, inProduction: 0 })).toBeNull()
  })

  it('a size never ships more than ordered; a closed-short line takes nothing more', () => {
    const facts = { label: 'Order line 10 (JKT BLK), size 52', ordered: 2, closedShort: false, onShipments: 1 }
    expect(orderCapProblems(facts, 1)).toEqual([])
    expect(orderCapProblems(facts, 2)).toEqual(['Order line 10 (JKT BLK), size 52: 2 ordered and 1 on shipments already, so 1 more can ship; 2 asked.'])
    expect(orderCapProblems({ ...facts, closedShort: true, closeShortReason: 'customer cancelled the rest' }, 1)[0]).toMatch(/closed short \(customer cancelled the rest\): what is left of it will not ship/)
    expect(orderCapProblems({ ...facts, closedShort: true }, 0)).toEqual([])
  })

  it('a packed shipment of a line closed after packing does not leave', () => {
    expect(closedShortAtShipProblems([{ label: 'Order line 10', closedShort: false, garments: 2 }])).toEqual([])
    expect(closedShortAtShipProblems([{ label: 'Order line 10', closedShort: true, garments: 2 }])[0]).toMatch(/^Order line 10 \(2 garments\): the order line was closed short/)
  })
})

describe('shipping from finished-goods stock (B-W2a-12 with B-W2a-48)', () => {
  it('takes the work order’s garments out of stock first, place by place, the rest from the release', () => {
    const [take] = takeFromStock([{ cellId: 'c', label: 'WO-1 BLK 52', garments: 5, inStock: 3, places: [{ locationId: 'a', code: 'A1-FG', onHand: 2 }, { locationId: 'b', code: 'A1-FG-2', onHand: 4 }] }])
    expect(take).toEqual({ cellId: 'c', label: 'WO-1 BLK 52', garments: 5, fromPlaces: [{ locationId: 'a', code: 'A1-FG', quantity: 2 }, { locationId: 'b', code: 'A1-FG-2', quantity: 1 }], fromStock: 3, fromRelease: 2 })
  })

  it('never more than the places hold, nor than the work order has in stock', () => {
    expect(takeFromStock([{ cellId: 'c', label: 'x', garments: 4, inStock: 4, places: [{ locationId: 'a', code: 'A', onHand: 1 }] }])[0]).toMatchObject({ fromStock: 1, fromRelease: 3 })
    expect(takeFromStock([{ cellId: 'c', label: 'x', garments: 2, inStock: 0, places: [{ locationId: 'a', code: 'A', onHand: 9 }] }])[0]).toMatchObject({ fromStock: 0, fromRelease: 2, fromPlaces: [] })
  })

  it('a garment shipped from stock is counted once by "Report finished to stock"', () => {
    expect(cellInStock(3, 2)).toBe(1)
    expect(cellInStock(1, 2)).toBe(0)
    expect(onShipmentsFromRelease(5, 3)).toBe(2)
    expect(onShipmentsFromRelease(1, 3)).toBe(0)
  })
})

describe('the freight charged to the customer (LOG-105)', () => {
  const facts = (overrides: Partial<FreightFacts> = {}): FreightFacts => ({
    settings: { rule: 'PER_SHIPMENT', amount: 1200, freeFrom: 50_000, currency: 'EUR' },
    transportBy: 'CARRIER',
    incoterm: null,
    orderCurrency: 'EUR',
    orderNet: 20_000,
    parcels: 2,
    ...overrides,
  })

  it('per shipment, per parcel, free from the order value, none', () => {
    expect(freightByRule(facts())).toMatchObject({ charge: 1200, basis: 'PER_SHIPMENT' })
    expect(freightByRule(facts({ settings: { rule: 'PER_PARCEL', amount: 700, freeFrom: null, currency: 'EUR' } }))).toMatchObject({ charge: 1400, basis: 'PER_PARCEL' })
    expect(freightByRule(facts({ orderNet: 50_000 }))).toMatchObject({ charge: 0, basis: 'FREE_FROM' })
    expect(freightByRule(facts({ settings: { rule: 'NONE', amount: null, freeFrom: null, currency: 'EUR' } }))).toMatchObject({ charge: 0, basis: 'RULE_NONE' })
  })

  it('the customer’s carriage, a replacement order, another currency, no settings', () => {
    expect(freightByRule(facts({ transportBy: 'RECIPIENT' }))).toMatchObject({ charge: 0, basis: 'CUSTOMER_COLLECTS' })
    expect(freightByRule(facts({ incoterm: 'exw' }))).toMatchObject({ charge: 0, basis: 'BUYER_INCOTERM' })
    expect(freightByRule(facts({ incoterm: 'DAP' }))).toMatchObject({ basis: 'PER_SHIPMENT' })
    expect(freightByRule(facts({ orderNet: 0 }))).toMatchObject({ charge: 0, basis: 'NO_PRICE' })
    expect(freightByRule(facts({ orderCurrency: 'USD' }))).toMatchObject({ charge: null, basis: 'OTHER_CURRENCY' })
    expect(freightByRule(facts({ settings: null }))).toMatchObject({ charge: null, basis: 'NO_SETTINGS' })
  })

  it('never a figure in the words (they reach readers without the price grain)', () => {
    for (const result of [freightByRule(facts()), freightByRule(facts({ orderNet: 60_000 })), freightByRule(facts({ settings: { rule: 'PER_PARCEL', amount: 700, freeFrom: null, currency: 'EUR' } }))]) {
      expect(result.words).not.toMatch(/1200|12[.,]00|700|1400|500/)
    }
  })

  it('a rule as sent, and a charge until the shipment is cancelled', () => {
    expect(freightRuleProblems({ rule: 'NONE' })).toEqual([])
    expect(freightRuleProblems({ rule: 'NONE', amount: 5 }).map((problem) => problem.path)).toEqual(['body/amount'])
    expect(freightRuleProblems({ rule: 'PER_SHIPMENT' }).map((problem) => problem.path)).toEqual(['body/amount'])
    expect(freightRuleProblems({ rule: 'PER_PARCEL', amount: -1, freeFrom: 1.5 }).map((problem) => problem.path)).toEqual(['body/amount', 'body/freeFrom'])
    expect(freightChargeProblems('SHIPPED', 900)).toEqual([])
    expect(freightChargeProblems('CANCELLED', 900)).toEqual(['The shipment is CANCELLED: its freight charge no longer changes.'])
  })
})

describe('voiding labels every day (LOG-028)', () => {
  const parcels = [
    { parcelId: 'p1', seq: 1, labelled: true, latest: 'LABEL_CREATED' as const },
    { parcelId: 'p2', seq: 2, labelled: true, latest: 'IN_TRANSIT' as const },
    { parcelId: 'p3', seq: 3, labelled: false, latest: null },
  ]

  it('a parcel the carrier has keeps its label', () => {
    expect(collectedProblems({ seq: 1, latest: null })).toEqual([])
    expect(collectedProblems({ seq: 1, latest: 'LABEL_CREATED' })).toEqual([])
    expect(collectedProblems({ seq: 2, latest: 'IN_TRANSIT' })[0]).toMatch(/^The carrier has parcel 2 already \(tracking says in transit\)/)
  })

  it('void all: the labelled parcels the carrier does not have yet', () => {
    const plan = voidAllPlan(parcels)
    expect(plan.toVoid.map((parcel) => parcel.seq)).toEqual([1])
    expect(plan.kept.map((parcel) => parcel.seq)).toEqual([2])
    expect(voidAllProblems('SHIPPED', parcels)).toEqual(['The shipment is SHIPPED; labels are voided only before the goods leave.'])
    expect(voidAllProblems('PACKED', [parcels[2]!])).toEqual(['No parcel of this shipment has a carrier label.'])
    expect(voidOutcomeWords('QUEUED')).toMatch(/confirms it later/)
  })
})

describe('the packing list, version by version (LOG-012)', () => {
  const contents = {
    parcels: [{ id: 'a', seq: 1, grossWeightKg: '2.5000' }, { id: 'b', seq: 2, grossWeightKg: null }],
    lines: [{ parcelId: 'a', workOrderSizeId: 'c1', quantity: 2, serials: ['S2', 'S1'] }, { parcelId: 'b', workOrderSizeId: 'c2', quantity: 1, serials: [] }],
  }

  it('the same packing gives the same key, whatever the order of rows and serials', () => {
    const shuffled = { parcels: [...contents.parcels].reverse(), lines: [...contents.lines].reverse().map((line) => ({ ...line, serials: [...line.serials].reverse() })) }
    expect(contentsKey(shuffled)).toBe(contentsKey(contents))
    expect(contentsKey({ ...contents, parcels: [{ ...contents.parcels[0]!, grossWeightKg: '2.6000' }, contents.parcels[1]!] })).not.toBe(contentsKey(contents))
  })

  it('W2b rows: the newest contents and language print again; anything else is n + 1, reusing an older version\'s file when it matches', () => {
    const versions = [{ fileId: 'f1', version: 1, fingerprint: 'x', language: 'it' as const }]
    expect(nextPackingList([], 'x', 'it')).toEqual({ again: null, reuse: null, version: 1 })
    expect(nextPackingList(versions, 'x', 'it')).toEqual({ again: versions[0], reuse: null, version: 1 })
    // Another language is another file, and so another version (a version is one row, one file).
    expect(nextPackingList(versions, 'x', 'en')).toEqual({ again: null, reuse: null, version: 2 })
    expect(nextPackingList(versions, 'y', 'it')).toEqual({ again: null, reuse: null, version: 2 })
    // Contents back to version 1's: version 3, printed with version 1's file; the newest is the current one.
    const three = [...versions, { fileId: 'f2', version: 2, fingerprint: 'y', language: 'it' as const }]
    expect(nextPackingList(three, 'x', 'it')).toEqual({ again: null, reuse: versions[0], version: 3 })
    expect(currentPackingList(three, 'y', 'PACKED')).toEqual(three[1])
    expect(currentPackingList(three, 'x', 'PACKED')).toBeNull()
    expect(currentPackingList(three, 'y', 'CANCELLED')).toBeNull()
    expect(packingListNumber('SH-00003', 1)).toBe('SH-00003')
    expect(packingListNumber('SH-00003', 2)).toBe('SH-00003/2')
    expect(packingListProblems('CANCELLED', 2, 0)).toEqual(['The shipment is CANCELLED: it has no packing list any more.'])
    expect(packingListProblems('PACKED', 2, 1)[0]).toMatch(/1 garment\(s\) are not in a parcel yet/)
  })
})
