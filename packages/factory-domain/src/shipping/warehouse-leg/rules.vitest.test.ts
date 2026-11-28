import { describe, expect, it } from 'vitest'
import { LEG_REFUSALS, LEG_WORDS, labelFileFits, leavingWarnings, legMayOf, legProblems, legStateOf, warehouseShipTo, type LabelFileFacts, type LegFacts } from './rules'

// Made-up facts: ids, names and addresses are invented for the test.
const SHIPMENT = 'shipment-1'
const PARTY = 'party-alpha'
const at = (iso: string) => new Date(iso)
const file = (over: Partial<LabelFileFacts> = {}): LabelFileFacts => ({ recordType: 'Shipment', recordId: SHIPMENT, status: 'AVAILABLE', kind: 'DOCUMENT', contentType: 'application/pdf', category: null, partyId: PARTY, byOffice: false, ...over })
const facts = (over: Partial<LegFacts> = {}): LegFacts => ({ shipmentStatus: 'SHIPPED', arrived: false, forwarded: false, ...over })
const office = { shipmentId: SHIPMENT, partyId: PARTY, door: 'office' as const }
const portal = { shipmentId: SHIPMENT, partyId: PARTY, door: 'portal' as const }

describe('the leg’s state (the legs read)', () => {
  it('on the way, at our warehouse, sent on', () => {
    expect(legStateOf({ arrivedAt: null, forwardedAt: null })).toBe('ON_THE_WAY')
    expect(legStateOf({ arrivedAt: at('2026-11-20T09:00:00Z'), forwardedAt: null })).toBe('AT_OUR_WAREHOUSE')
    expect(legStateOf({ arrivedAt: at('2026-11-20T09:00:00Z'), forwardedAt: at('2026-11-22T09:00:00Z') })).toBe('SENT_ON')
  })
})

describe('legProblems: arrived only while SHIPPED and once', () => {
  it('refuses before the goods left, and a second time', () => {
    expect(legProblems('ARRIVED', facts({ shipmentStatus: 'PACKED' }))).toEqual(['NOT_LEFT'])
    expect(legProblems('ARRIVED', facts({ shipmentStatus: 'DRAFT' }))).toEqual(['NOT_LEFT'])
    expect(legProblems('ARRIVED', facts())).toEqual([])
    expect(legProblems('ARRIVED', facts({ arrived: true }))).toEqual(['ARRIVED_ALREADY'])
    expect(legProblems('ARRIVED', facts({ shipmentStatus: 'CANCELLED' }))).toEqual(['CANCELLED'])
  })
})

describe('legProblems: forward only after arrived and once, with the sale DDT', () => {
  it('refuses before it arrived and a second time', () => {
    expect(legProblems('FORWARD', facts({ liveDdtReason: 'SALE' }))).toEqual(['NOT_ARRIVED'])
    expect(legProblems('FORWARD', facts({ arrived: true, forwarded: true, liveDdtReason: 'SALE' }))).toEqual(['SENT_ON_ALREADY'])
  })

  it('needs a live SALE DDT unless the shipment travels without one', () => {
    expect(legProblems('FORWARD', facts({ arrived: true, ddtRequired: true, liveDdtReason: 'TRANSFER' }))).toEqual(['NO_SALE_DDT'])
    expect(legProblems('FORWARD', facts({ arrived: true, ddtRequired: true, liveDdtReason: null }))).toEqual(['NO_SALE_DDT'])
    expect(legProblems('FORWARD', facts({ arrived: true, ddtRequired: true, liveDdtReason: 'SALE' }))).toEqual([])
    expect(legProblems('FORWARD', facts({ arrived: true, ddtRequired: false, liveDdtReason: null }))).toEqual([])
  })
})

describe('legProblems: the label is a CUSTOMER_LABEL file of the shipment’s party', () => {
  it('takes a PDF or a picture of the shipment, of its customer, until it was sent on', () => {
    expect(legProblems('LABEL', facts({ label: file(), target: portal }))).toEqual([])
    expect(legProblems('LABEL', facts({ shipmentStatus: 'DRAFT', label: file({ kind: 'PHOTO', contentType: 'image/png' }), target: office }))).toEqual([])
    expect(legProblems('LABEL', facts({ arrived: true, forwarded: true, label: file(), target: portal }))).toEqual(['LABEL_AFTER_SEND_ON'])
    expect(legProblems('LABEL', facts({ label: null, target: portal }))).toEqual(['LABEL_FILE'])
    expect(legProblems('LABEL', facts({ label: file() }))).toEqual(['LABEL_FILE'])
  })

  it('refuses another record’s file, another customer’s file, a deleted one, a sheet or a fiscal paper', () => {
    expect(labelFileFits(file({ recordId: 'shipment-2' }), office)).toBe(false)
    expect(labelFileFits(file({ recordType: 'SalesOrder' }), office)).toBe(false)
    expect(labelFileFits(file({ partyId: 'party-beta' }), office)).toBe(false)
    expect(labelFileFits(file({ status: 'QUARANTINED' }), office)).toBe(false)
    expect(labelFileFits(file({ category: 'MEASUREMENTS' }), office)).toBe(false)
    expect(labelFileFits(file({ kind: 'FISCAL_ARCHIVE' }), office)).toBe(false)
    expect(labelFileFits(file({ contentType: 'application/zip' }), office)).toBe(false)
    expect(labelFileFits(file({ category: 'CUSTOMER_LABEL' }), office)).toBe(true)
  })

  it('the portal names only the customer’s own upload; the office may name its own (on behalf)', () => {
    expect(labelFileFits(file({ byOffice: true, partyId: null }), office)).toBe(true)
    expect(labelFileFits(file({ byOffice: true, partyId: null }), portal)).toBe(false)
    expect(labelFileFits(file({ byOffice: true }), portal)).toBe(false)
    expect(labelFileFits(file({ byOffice: false, partyId: null }), portal)).toBe(false)
  })
})

describe('what the reader may do on a leg', () => {
  it('arrived and Send on with shipping.manage; the label with plan OR manage', () => {
    expect(legMayOf({ shipmentStatus: 'SHIPPED', arrived: false, forwarded: false }, { manage: true, plan: false })).toEqual({ arrived: true, sendOn: false, label: true })
    expect(legMayOf({ shipmentStatus: 'SHIPPED', arrived: true, forwarded: false }, { manage: true, plan: false })).toEqual({ arrived: false, sendOn: true, label: true })
    expect(legMayOf({ shipmentStatus: 'SHIPPED', arrived: true, forwarded: false }, { manage: false, plan: true })).toEqual({ arrived: false, sendOn: false, label: true })
    expect(legMayOf({ shipmentStatus: 'DELIVERED', arrived: true, forwarded: true }, { manage: true, plan: true })).toEqual({ arrived: false, sendOn: false, label: false })
    expect(legMayOf({ shipmentStatus: 'DRAFT', arrived: false, forwarded: false }, { manage: true, plan: true })).toEqual({ arrived: false, sendOn: false, label: true })
    expect(legMayOf({ shipmentStatus: 'SHIPPED', arrived: false, forwarded: false }, { manage: false, plan: false })).toEqual({ arrived: false, sendOn: false, label: false })
  })
})

describe('the payment due is a warning when the goods leave to the customer (R39 (a))', () => {
  it('warns once a before-shipping step is open, never for the way to our own warehouse', () => {
    expect(leavingWarnings({ openBeforeShipping: 1, toOurWarehouse: false })).toEqual(['PAYMENT_DUE_AT_SHIP'])
    expect(leavingWarnings({ openBeforeShipping: 2, toOurWarehouse: true })).toEqual([])
    expect(leavingWarnings({ openBeforeShipping: 0, toOurWarehouse: false })).toEqual([])
  })
})

describe('our warehouse’s address as the ship-to', () => {
  it('snapshots a complete address with the site’s name; an incomplete one is none', () => {
    expect(warehouseShipTo({ name: 'Seed warehouse North', address: { line1: 'Via Magazzino 3', postalCode: '00000', city: 'Seedport', country: 'IT', province: 'MI' } })).toEqual({ name: 'Seed warehouse North', line1: 'Via Magazzino 3', postalCode: '00000', city: 'Seedport', province: 'MI', country: 'IT' })
    expect(warehouseShipTo({ name: 'Seed warehouse North', address: { line1: 'Via Magazzino 3', city: 'Seedport', country: 'IT' } })).toBeNull()
    expect(warehouseShipTo({ name: 'Seed warehouse North', address: null })).toBeNull()
  })
})

describe('every refusal has words in English and Italian', () => {
  it('none is empty', () => {
    for (const code of LEG_REFUSALS) {
      expect(LEG_WORDS[code].en.trim(), code).not.toBe('')
      expect(LEG_WORDS[code].it.trim(), code).not.toBe('')
    }
  })
})
