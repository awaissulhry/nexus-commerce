import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { order } from '../../_demo/fixtures'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import type { DeliveryRow } from './delivered/api'
import { carriesOf, chipsOf, datesOf, nextOf, rowOf, shipmentsAnswer, stateOf, travelsOf } from './rows'
import { parcelWordsOf } from './rows' // F-OS-301
import { orderStaysOf, showAtOf, trackingDoorDrawn } from './rows' // os-fx7
import { ddtBlocksOf, factReadsOf, othersOf, problemsOf } from './facts' // os-fx7
import type { ShipmentRow } from './where'

/**
 * F-OS-103 (order SHIPMENTS tab, 10-design §5) — one row per shipment, pure: its chips, what it carries, its state (holds, problems,
 * came back, cancelled, Next ›), how it travels ("Not shown to your role", never a bare "—"), its dates (the old Deliveries card's
 * columns, no date twice); and the section's answer. Every new field optional: absent, nothing is drawn for it. Made-up data only.
 */

const ORDER = order('PARTLY_SHIPPED')
const [BLK, RED] = ORDER.lines
const row = (over: Partial<ShipmentRow> = {}): ShipmentRow => ({
  id: 'sh-1',
  number: 'SEED-SH-0012',
  status: 'PACKED',
  shippedAt: null,
  deliveredAt: null,
  version: 3,
  transportBy: 'CARRIER',
  carrier: { code: 'brt', name: 'BRT' },
  tracking: null,
  expectedDeliveryAt: null,
  ddt: null,
  mayTypeTracking: { allowed: false, code: 'NOT_A_CARRIER', why: null },
  withheld: [],
  orders: [{ id: ORDER.id, number: ORDER.number, customerRef: null }],
  origin: 'NEXUS',
  externalDdt: null,
  ...over,
})
const delivery = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({ id: 'sh-1', number: 'SEED-SH-0012', status: 'DELIVERED', carrierName: 'BRT', shippedAt: '2026-11-12T08:00:00.000Z', deliveredAt: '2026-11-14T09:30:00.000Z', deliveredVia: 'CARRIER', pod: null, openProblems: 0, mayOpen: true, ...over })

describe('the Shipment cell: its number, then its chips', () => {
  it('Also carries (same customer), split from, merged into, the DDT, made elsewhere, travels without a DDT', () => {
    const shared = row({ orders: [{ id: ORDER.id, number: ORDER.number, customerRef: null }, { id: 'so-3', number: 'SEED-SO-0003', customerRef: null }], splitFrom: { id: 'sh-0', number: 'SEED-SH-0010', reason: 'PART_READY' }, ddt: { number: '144/2026', date: '2026-11-12' } })
    expect(chipsOf(shared, ORDER.id)).toEqual([{ kind: 'also', id: 'so-3', number: 'SEED-SO-0003' }, { kind: 'splitFrom', id: 'sh-0', number: 'SEED-SH-0010' }, { kind: 'ddt', number: '144/2026' }])
    expect(chipsOf(row({ status: 'CANCELLED', mergedInto: { id: 'sh-9', number: 'SEED-SH-0015' } }), ORDER.id)).toEqual([{ kind: 'mergedInto', id: 'sh-9', number: 'SEED-SH-0015' }])
    expect(chipsOf(row({ origin: 'ELSEWHERE', externalDdt: { number: '118/B', date: '2026-11-10' } }), ORDER.id)).toEqual([{ kind: 'elsewhere', words: { ns: 'orders', key: 'elsewhere.chip', params: { ddt: '118/B' } } }])
    expect(chipsOf(row({ ddtRequired: false }), ORDER.id)).toEqual([{ kind: 'noDdt' }])
    // Absent (an older answer): no chip at all, never a false "travels without a DDT".
    expect(chipsOf(row(), ORDER.id)).toEqual([])
  })
})

describe('What it carries: this order\'s pieces by style and colour, the other orders\' pieces, a grid per style', () => {
  it('"24 pcs · 1 style", one line per colour line, "+ 18 pcs of SEED-SO-0003"; not read yet: null (the cell says Open in Warehouse ›)', () => {
    expect(carriesOf(row(), ORDER)).toBeNull()
    const shared = row({ orders: [{ id: ORDER.id, number: ORDER.number, customerRef: null }, { id: 'so-3', number: 'SEED-SO-0003', customerRef: null }], otherPieces: 18, contents: [{ lineId: BLK!.id, size: '50', pieces: 2 }, { lineId: BLK!.id, size: '52', pieces: 2 }, { lineId: RED!.id, size: '50', pieces: 20 }] })
    const carries = carriesOf(shared, ORDER)!
    expect(carries.pieces).toBe(24)
    expect(carries.styles).toBe(1)
    expect(carries.lines).toEqual([
      { lineId: BLK!.id, style: 'DEMO-JKT-01', colour: 'Nero', pieces: 4, mtm: false },
      { lineId: RED!.id, style: 'DEMO-JKT-01', colour: 'Rosso', pieces: 20, mtm: false },
    ])
    expect(carries.other).toEqual({ pieces: 18, orders: ['SEED-SO-0003'] })
    expect(carries.grids).toHaveLength(1)
    expect(carries.grids[0]!.value).toEqual({ [BLK!.id]: { '50': 2, '52': 2 }, [RED!.id]: { '50': 20, '52': 0 } })
  })
})

describe('the State cell', () => {
  it('each hold in force (a money hold or one the system placed: finance releases it); only on a draft or packed shipment', () => {
    const held = row({ holds: [{ reason: 'BALANCE_UNPAID', words: 'For SEED-SO-0003', bySystem: true, placedAt: '2026-11-19T08:00:00.000Z' }, { reason: 'QUALITY', words: null, bySystem: false, placedAt: '2026-11-20T08:00:00.000Z' }] })
    expect(stateOf(held, null).holds.map((hold) => [hold.reason, hold.finance])).toEqual([['BALANCE_UNPAID', true], ['QUALITY', false]])
    expect(stateOf({ ...held, status: 'SHIPPED' }, null).holds).toEqual([])
    expect(stateOf(held, null).next).toEqual({ kind: 'held' })
  })

  it('tracking problems while travelling; came back and whether received; the cancel\'s reason', () => {
    expect(stateOf(row({ status: 'SHIPPED' }), delivery({ status: 'SHIPPED', openProblems: 1 })).problems).toBe(1)
    expect(stateOf(row({ status: 'DELIVERED' }), delivery({ openProblems: 1 })).problems).toBe(0)
    expect(stateOf(row({ status: 'RETURNED' }), delivery({ status: 'RETURNED', returned: { at: '2026-11-19T10:00:00.000Z', received: false } })).cameBack).toEqual({ received: false })
    expect(stateOf(row({ status: 'RETURNED' }), null).cameBack).toEqual({ received: null })
    expect(stateOf(row({ status: 'CANCELLED', cancelReason: 'Merged into SEED-SH-0015' }), null).cancelled).toEqual({ reason: 'Merged into SEED-SH-0015' })
    expect(stateOf(row({ status: 'CANCELLED' }), null).cancelled).toEqual({ reason: null })
    expect(stateOf(row(), null).tone).toBe('info')
    expect(stateOf(row({ status: 'SHIPPED' }), null).tone).toBe('warning')
  })

  it('Next ›, in Warehouse\'s own order: pack it · issue the DDT · buy the labels · hand it over (the step stays in Warehouse)', () => {
    expect(nextOf(row({ status: 'DRAFT' }))).toEqual({ kind: 'step', step: 'pack', tab: 'lines' })
    expect(nextOf(row())).toEqual({ kind: 'step', step: 'ddt', tab: 'documents' })
    expect(nextOf(row({ ddtRequired: false }))).toEqual({ kind: 'step', step: 'hand', tab: 'carrier' })
    const unlabelled = [{ id: 'p1', seq: 1, number: 'BRT-1', url: null, source: 'LABEL', live: true }, { id: 'p2', seq: 2, number: null, url: null, source: null, live: false }]
    expect(nextOf(row({ ddt: { number: '151/2026', date: '2026-11-18' }, parcels: unlabelled }))).toEqual({ kind: 'step', step: 'labels', tab: 'carrier' })
    // A carrier booked by hand has no label to buy.
    expect(nextOf(row({ ddt: { number: '151/2026', date: '2026-11-18' }, parcels: unlabelled, tracking: { number: 'T-1', source: 'TYPED', parcels: [], live: false } }))).toEqual({ kind: 'step', step: 'hand', tab: 'carrier' })
    expect(nextOf(row({ status: 'SHIPPED' }))).toBeNull()
  })
})

describe('How it travels', () => {
  it('a carrier withheld from the reader says so — never a bare "—" (H2-B4)', () => {
    const blind = travelsOf(row({ carrier: null, withheld: ['shipments.detail'] }))
    expect(blind.carrier).toBeNull()
    expect(blind.withheld).toBe(true)
    expect(travelsOf(row({ carrier: null, transportBy: 'SENDER', withheld: ['shipments.detail'] })).carrier).toEqual({ ns: 'orders', key: 'ship.carrier.ownVan' })
  })

  it('a typed number with its link; a label\'s first number and how many more; "3 parcels · 2 tracked"; the hints', () => {
    const typed = travelsOf(row({ status: 'SHIPPED', tracking: { number: '157-12345675', source: 'TYPED', parcels: [], live: false, url: 'https://cargo.example.com/t/157-12345675' }, mayTypeTracking: { allowed: true, code: null, why: null } }))
    expect(typed.typed).toEqual({ number: '157-12345675', url: 'https://cargo.example.com/t/157-12345675' })
    expect(typed.trackingDoor).toBe(true)
    const labels = travelsOf(row({ tracking: { number: null, source: 'PARCELS', parcels: [{ number: 'BRT-1', url: 'https://brt.example.com/1' }, { number: 'BRT-2', url: null }, { number: 'BRT-3', url: null }], live: true }, parcels: [1, 2, 3].map((seq) => ({ id: `p${seq}`, seq, number: seq < 3 ? `BRT-${seq}` : null, url: null, source: seq < 3 ? 'LABEL' : null, live: true })) }))
    expect(labels.labels).toEqual({ first: 'BRT-1', url: 'https://brt.example.com/1', more: 2 })
    expect(labels.parcels).toEqual({ count: 3, tracked: 2 })
    expect(labels.trackingDoor).toBe(false) // held for a label: not drawn at all (P0-B3; D2)
    expect(travelsOf(row({ status: 'DRAFT' })).hints).toEqual([{ key: 'ships.travels.draft' }])
    expect(travelsOf(row({ status: 'SHIPPED', transportBy: 'SENDER', carrier: null })).hints).toEqual([{ key: 'ships.travels.ownVan' }])
    // os-fx7 (W-11): our van says so even with its parcels counted — "1 parcel", never "· 0 tracked"; a van draft gets no parcel-number hint.
    const van = travelsOf(row({ status: 'SHIPPED', transportBy: 'SENDER', carrier: null, parcels: [{ id: 'p1', seq: 1, number: null, url: null, source: null, live: false }] }))
    expect(van.hints).toEqual([{ key: 'ships.travels.ownVan' }])
    expect(van.parcels).toEqual({ count: 1, tracked: null })
    expect(travelsOf(row({ status: 'DRAFT', transportBy: 'SENDER', carrier: null })).hints).toEqual([{ key: 'ships.travels.ownVan' }])
    expect(travelsOf(row({ status: 'SHIPPED', origin: 'ELSEWHERE' })).hints).toEqual([{ key: 'ships.travels.elsewhere' }])
  })
})

describe('Dates: the old Deliveries card\'s columns in the row (no date twice)', () => {
  it('packed until it leaves, then left; expected (from the carrier / set by hand); delivered and how we know; the proof; came back', () => {
    expect(datesOf(row({ status: 'DRAFT' }), null)).toEqual([{ kind: 'notPacked' }])
    expect(datesOf(row({ packedAt: '2026-11-18T10:00:00.000Z' }), null)).toEqual([{ kind: 'packed', at: '2026-11-18T10:00:00.000Z' }])
    const travelling = row({ status: 'SHIPPED', packedAt: '2026-11-11T10:00:00.000Z', shippedAt: '2026-11-12T08:00:00.000Z', expectedDeliveryAt: '2026-11-20T00:00:00.000Z' })
    expect(datesOf(travelling, delivery({ status: 'SHIPPED', deliveredAt: null, deliveredVia: null, etaByHand: true }))).toEqual([
      { kind: 'left', at: '2026-11-12T08:00:00.000Z' },
      { kind: 'expected', at: '2026-11-20T00:00:00.000Z', how: 'hand' },
    ])
    const delivered = row({ status: 'DELIVERED', shippedAt: '2026-11-12T08:00:00.000Z', deliveredAt: '2026-11-14T09:30:00.000Z' })
    const file = { id: 'f1', name: 'proof.pdf', contentType: 'application/pdf', sizeBytes: 1000 }
    expect(datesOf(delivered, delivery({ pod: { signedBy: 'M. Rossi', signedAt: null, image: true, file } }))).toEqual([
      { kind: 'left', at: '2026-11-12T08:00:00.000Z' },
      { kind: 'delivered', at: '2026-11-14T09:30:00.000Z', how: 'CARRIER', reason: null },
      { kind: 'proof', signedBy: 'M. Rossi', file, download: true },
    ])
    // Set by hand over the carrier's labels, with its reason (office only); the carrier's later word.
    expect(datesOf(delivered, delivery({ deliveredVia: 'TYPED', byHand: { reason: 'The customer confirmed by phone.', overrode: true }, carrierLater: 'RETURNED' }))).toContainEqual({ kind: 'delivered', at: '2026-11-14T09:30:00.000Z', how: 'HAND', reason: 'The customer confirmed by phone.' })
    expect(datesOf(delivered, delivery({ carrierLater: 'RETURNED' }))).toContainEqual({ kind: 'carrierLater', status: 'RETURNED' })
    expect(datesOf(delivered, delivery({ deliveredVia: 'COLLECTED' }))).toContainEqual({ kind: 'delivered', at: '2026-11-14T09:30:00.000Z', how: 'COLLECTED', reason: null })
    // H3-B4: no right to the proof's image — no held Download at all (the row says who signed only).
    expect(datesOf(delivered, delivery({ pod: { signedBy: 'M. Rossi', signedAt: null, image: true }, mayOpen: false }))).toContainEqual({ kind: 'proof', signedBy: 'M. Rossi', file: null, download: false })
    expect(datesOf(row({ status: 'RETURNED', shippedAt: '2026-11-12T08:00:00.000Z' }), delivery({ status: 'RETURNED', returned: { at: '2026-11-19T10:00:00.000Z', received: false } }))).toContainEqual({ kind: 'cameBack', at: '2026-11-19T10:00:00.000Z' })
    expect(datesOf(row({ status: 'SHIPPED', transportBy: 'SENDER', shippedAt: '2026-11-12T08:00:00.000Z' }), null)).toContainEqual({ kind: 'noStatus' })
  })

  it('the row keeps its anchor (the dock\'s "Show on the page"); the Parcels fold only with its parcels and nothing withheld', () => {
    expect(rowOf(row(), ORDER, null).anchor).toBe('about-Shipment-sh-1')
    expect(rowOf(row(), ORDER, null).fold).toBeNull()
    expect(rowOf(row({ parcels: [{ id: 'p1', seq: 1, number: null, url: null, source: null, live: false }] }), ORDER, null).fold).toBe(1)
  })
})

describe('the section\'s answer', () => {
  it('"3 shipments · 1 shipped · 1 packed · 1 draft · SEED-SH-0011 expected … · 1 cancelled"; all cancelled: the count only', () => {
    const rows = [row({ id: 'a', status: 'SHIPPED', number: 'SEED-SH-0011', expectedDeliveryAt: '2026-11-14T00:00:00.000Z' }), row({ id: 'b' }), row({ id: 'c', status: 'DRAFT' }), row({ id: 'd', status: 'CANCELLED' })]
    expect(shipmentsAnswer(rows)).toEqual([
      { key: 'ships.answer.count', params: { count: 3 } },
      { key: 'ships.answer.status.SHIPPED', params: { count: 1 } },
      { key: 'ships.answer.status.PACKED', params: { count: 1 } },
      { key: 'ships.answer.status.DRAFT', params: { count: 1 } },
      { key: 'ships.answer.expected', params: { number: 'SEED-SH-0011' }, instants: { day: '2026-11-14T00:00:00.000Z' } },
      { key: 'ships.answer.status.CANCELLED', params: { count: 1 } },
    ])
    expect(shipmentsAnswer([row({ status: 'CANCELLED' })])).toEqual([{ key: 'ships.answer.status.CANCELLED', params: { count: 1 } }])
    expect(shipmentsAnswer([])).toEqual([])
  })
})

// ---- every word the tab's models and views name exists in both languages, with its plural forms ----
describe('F-OS-101: the tab\'s own words (order-shipments) exist in it and en', () => {
  const FILES = ['./where.ts', './rows.ts', './after-sales.ts', './doors.ts', './head.ts', './view/ShipmentsHead.tsx', './view/WhereSection.tsx', './view/ShipmentsSection.tsx', './view/ShipmentRow.tsx', './view/ParcelsFold.tsx', './view/AfterSalesSection.tsx']
  const source = FILES.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
  const keys = [...new Set([...source.matchAll(/'((?:head|where|ships|after)\.[a-zA-Z.]+)'/g)].map((match) => match[1]!))]
  // Keys made from a code: every code the tab draws.
  const made = [
    ...['shipped', 'packed', 'draft', 'planned', 'back', 'ready', 'making', 'closed'].map((bucket) => `where.bucket.${bucket}`),
    ...['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED'].map((status) => `where.fact.on.${status}`),
    ...['DELIVERED', 'SHIPPED', 'RETURNED', 'PACKED', 'DRAFT', 'CANCELLED'].map((status) => `ships.answer.status.${status}`),
    ...['pack', 'ddt', 'labels', 'hand'].map((step) => `ships.next.${step}`),
    ...['pending', 'cancelled', 'feesOnly'].map((state) => `where.state.${state}`),
    'after.kind.return',
    'after.kind.complaint',
  ]

  it('each key, or its plural forms', () => {
    expect(keys.length).toBeGreaterThan(60)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['order-shipments'] ?? {}
      for (const key of [...keys, ...made]) expect(words[key] ?? words[`${key}_other`], `${locale} ${key}`).toBeTruthy()
    }
  })
})

// ---- W3 (F-OS-301; plan D6): each parcel's contents in the Tracking numbers window; the DDT choice said on a packed row ----
describe('W3: what each parcel holds of this order, and the DDT choice on a packed row', () => {
  it('F-OS-301: "SEED-JKT-02 Black · 46 ×4 · 48 ×8" by parcel id — codes and numbers only; a parcel with nothing of it has none', () => {
    const words = parcelWordsOf(
      {
        parcels: [
          { id: 'p1', seq: 1, number: null, url: null, source: null, live: false, contents: [{ lineId: BLK!.id, size: '46', pieces: 4 }, { lineId: BLK!.id, size: '48', pieces: 8 }, { lineId: RED!.id, size: '50', pieces: 2 }] },
          { id: 'p2', seq: 2, number: null, url: null, source: null, live: false, contents: [] },
          { id: 'p3', seq: 3, number: null, url: null, source: null, live: false },
        ],
      },
      ORDER.lines,
    )
    expect(Object.keys(words)).toEqual(['p1'])
    expect(words.p1).toContain(' · 46 ×4 · 48 ×8')
    expect(words.p1!.split(' — ')).toHaveLength(2)
  })

  it('plan D6 → os-fx7 (W-07): the "travels without a DDT" line ONLY where the DDT cannot be issued — from the DDT refusal; no country read', () => {
    const may = { manage: true, pack: true, ddt: true, holdsRelease: false }
    const blocked = { ddtBlocks: ['vatNumber', 'rea'] }
    expect(stateOf(row({ may }), null, blocked)).toMatchObject({ next: { kind: 'step', step: 'ddt' }, ddtBlocked: ['vatNumber', 'rea'] })
    // An Italian company whose DDT can be issued (no refusal, or not read): no line at all.
    expect(stateOf(row({ may }), null, { ddtBlocks: [] }).ddtBlocked).toBeNull()
    expect(stateOf(row({ may }), null).ddtBlocked).toBeNull()
    expect(stateOf(row({ may: { ...may, ddt: false } }), null, blocked).ddtBlocked).toBeNull()
    expect(stateOf(row(), null, blocked).ddtBlocked).toBeNull()
    expect(stateOf(row({ may, ddtRequired: false }), null, blocked).ddtBlocked).toBeNull()
    expect(stateOf(row({ may, ddt: { number: '151/2026', date: '2026-11-18' } }), null, blocked).ddtBlocked).toBeNull()
    expect(stateOf(row({ may, origin: 'ELSEWHERE' }), null, blocked).ddtBlocked).toBeNull()
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale]['order-shipments']?.['ships.next.ddtBlocked'], locale).toBeTruthy()
      for (const field of ['legalName', 'address', 'vatNumber', 'fiscalCode', 'rea', 'shareCapital', 'currency']) expect(CATALOGUE[locale]['order-shipments']?.[`ships.next.ddtMissing.${field}`], `${locale} ${field}`).toBeTruthy()
      expect(CATALOGUE[locale]['order-shipments']?.['ships.next.ddtChoice'], locale).toBeUndefined()
    }
    expect(readFileSync(new URL('./view/ShipmentRow.tsx', import.meta.url), 'utf8')).toContain("t('ships.next.ddtBlocked'")
  })

  it('os-fx7 (W-07): the DDT refusals that block it are the company\'s own details; the form\'s are not', () => {
    expect(ddtBlocksOf([{ path: 'company/vatNumber' }, { path: 'body/appearance' }, { path: 'company/rea' }, { path: 'company/vatNumber' }, { path: 'shipment/parcels' }])).toEqual(['vatNumber', 'rea'])
    expect(ddtBlocksOf([{ path: 'body/carrier/name' }])).toEqual([])
    expect(ddtBlocksOf([{ path: 'company/somethingElse' }])).toEqual([])
  })

  it('F-OS-305 (os-fx3): "customer told {day}" on the row when the notice went; never told or not read: nothing', () => {
    expect(travelsOf(row({ noticeSentAt: '2026-11-12T10:00:00.000Z' })).toldAt).toBe('2026-11-12T10:00:00.000Z')
    expect(travelsOf(row({ noticeSentAt: null })).toldAt).toBeNull()
    expect(travelsOf(row()).toldAt).toBeNull()
    for (const locale of LOCALES) expect(CATALOGUE[locale]['order-shipments']?.['ships.travels.told'], locale).toBeTruthy()
  })
})
// ---- end W3

// ── os-fx7 (order SHIPMENTS tab; 30-walk W-01, W-05, W-06, W-09, W-10, W-12) ──
describe('os-fx7: the walk\'s gaps, in the rows model', () => {
  const may = { allowed: true, code: null, why: null }
  const parcel = (seq: number, source: string | null, number: string | null = null) => ({ id: `p${seq}`, seq, number, url: null, source, live: source === 'LABEL' })

  it('W-01: Tracking numbers… only on a CARRIER shipment PACKED or SHIPPED with a parcel no label tracks — never on a draft', () => {
    expect(trackingDoorDrawn(row({ status: 'DRAFT', mayTypeTracking: may }))).toBe(false)
    expect(travelsOf(row({ status: 'DRAFT', mayTypeTracking: may })).trackingDoor).toBe(false)
    expect(trackingDoorDrawn(row({ status: 'PACKED', mayTypeTracking: may, parcels: [parcel(1, null)] }))).toBe(true)
    expect(trackingDoorDrawn(row({ status: 'SHIPPED', mayTypeTracking: may, parcels: [parcel(1, 'LABEL', 'BRT-1'), parcel(2, 'TYPED', 'T-2')] }))).toBe(true)
    expect(trackingDoorDrawn(row({ status: 'SHIPPED', mayTypeTracking: may, parcels: [parcel(1, 'LABEL', 'BRT-1'), parcel(2, 'LABEL', 'BRT-2')] }))).toBe(false)
    expect(trackingDoorDrawn(row({ status: 'SHIPPED', mayTypeTracking: may }))).toBe(true) // an older answer: the consignment number alone
    expect(trackingDoorDrawn(row({ status: 'SHIPPED', mayTypeTracking: may, transportBy: 'SENDER' }))).toBe(false)
    expect(trackingDoorDrawn(row({ status: 'DELIVERED', mayTypeTracking: may }))).toBe(false)
    expect(trackingDoorDrawn(row({ status: 'PACKED' }))).toBe(false) // the read says it may not be typed here
  })

  it('W-06: the chip names what — the open problems\' kinds (once each), read for a live row with open problems only', () => {
    const shipped = row({ status: 'SHIPPED' })
    expect(problemsOf({ noScanDays: 3, problems: [{ kind: 'NO_SCAN', resolvedAt: null }, { kind: 'DELAYED', resolvedAt: '2026-11-15T10:00:00.000Z' }, { kind: 'NO_SCAN', resolvedAt: null }] })).toEqual({ kinds: ['NO_SCAN'], noScanDays: 3 })
    expect(problemsOf({ noScanDays: 3, problems: [{ kind: 'DELAYED', resolvedAt: '2026-11-15T10:00:00.000Z' }] })).toBeNull()
    expect(stateOf(shipped, delivery({ status: 'SHIPPED', openProblems: 1 }), { problems: { kinds: ['NO_SCAN'], noScanDays: 3 } }).problemKinds).toEqual({ kinds: ['NO_SCAN'], noScanDays: 3 })
    expect(stateOf(shipped, delivery({ status: 'SHIPPED', openProblems: 0 }), { problems: { kinds: ['NO_SCAN'], noScanDays: 3 } }).problemKinds).toBeNull()
    expect(stateOf(shipped, delivery({ status: 'SHIPPED', openProblems: 1 })).problemKinds).toBeNull()
    expect(factReadsOf(shipped, delivery({ status: 'SHIPPED', openProblems: 1 }), ORDER.id)).toEqual(['problems'])
    expect(factReadsOf(row({ status: 'DELIVERED' }), delivery({ openProblems: 1 }), ORDER.id)).toEqual([])
    for (const locale of LOCALES) expect(CATALOGUE[locale]['order-shipments']?.['ships.state.problemsWhat_one'], locale).toContain('{what}')
  })

  it('W-07 / W-12: which rows read the DDT refusal or the shared goods — few, never guessed', () => {
    const mayAll = { manage: true, pack: true, ddt: true, holdsRelease: false }
    expect(factReadsOf(row({ may: mayAll }), null, ORDER.id)).toEqual(['ddt'])
    expect(factReadsOf(row({ may: { ...mayAll, manage: false } }), null, ORDER.id)).toEqual([])
    const shared = row({ status: 'DRAFT', otherPieces: 3, orders: [{ id: ORDER.id, number: ORDER.number, customerRef: null }, { id: 'so-2', number: 'SEED-SO-0003', customerRef: null }] })
    expect(factReadsOf(shared, null, ORDER.id)).toEqual(['others'])
    expect(factReadsOf(row({ status: 'DRAFT', otherPieces: 0 }), null, ORDER.id)).toEqual([])
  })

  it('W-12: "+ 18 pcs of SEED-SO-0003 (SEED-JKT-02 Black 18)" — the other orders\' lines by order, style and colour', () => {
    const shared = row({ status: 'DRAFT', otherPieces: 20, contents: [], orders: [{ id: ORDER.id, number: ORDER.number, customerRef: null }, { id: 'so-2', number: 'SEED-SO-0003', customerRef: null }] })
    const lines = [
      { salesOrderId: 'so-2', styleCode: 'SEED-JKT-02', colourwayName: 'Black', quantity: 10 },
      { salesOrderId: 'so-2', styleCode: 'SEED-JKT-02', colourwayName: 'Black', quantity: 8 },
      { salesOrderId: 'so-2', styleCode: 'SEED-PNT-01', colourwayName: 'Navy', quantity: 2 },
      { salesOrderId: ORDER.id, styleCode: 'SEED-JKT-02', colourwayName: 'Red', quantity: 4 },
      { styleCode: 'SEED-JKT-02', colourwayName: 'Black', quantity: 99 },
    ]
    const others = othersOf(lines, shared, ORDER.id)
    expect(others).toEqual([{ number: 'SEED-SO-0003', pieces: 20, what: 'SEED-JKT-02 Black 18, SEED-PNT-01 Navy 2' }])
    expect(carriesOf(shared, ORDER, { others })?.others).toEqual(others)
    expect(carriesOf(shared, ORDER)?.others).toBeNull()
    for (const locale of LOCALES) expect(CATALOGUE[locale]['order-shipments']?.['ships.carries.otherWhat_other'], locale).toContain('({what})')
  })

  it('W-09: each grid carries its facts — the style\'s pieces and each colour\'s', () => {
    const carries = carriesOf(row({ contents: [{ lineId: BLK!.id, size: BLK!.sizes[0]!.size, pieces: 2 }, { lineId: BLK!.id, size: BLK!.sizes[1]!.size, pieces: 3 }] }), ORDER)
    const grid = carries?.grids[0]
    expect(grid?.pieces).toBe(5)
    expect(grid?.byColour[BLK!.id]).toBe(5)
  })

  it('W-10: Show in the thread opens at the row\'s newest moment; a fresh draft has none', () => {
    expect(showAtOf(row({ status: 'DRAFT' }), null)).toBeNull()
    expect(showAtOf(row({ packedAt: '2026-11-18T10:00:00.000Z', shippedAt: '2026-11-19T08:00:00.000Z' }), null)).toBe('2026-11-19T08:00:00.000Z')
    expect(showAtOf(row({ status: 'RETURNED', shippedAt: '2026-11-15T08:00:00.000Z' }), delivery({ returned: { at: '2026-11-19T10:00:00.000Z', received: false } }))).toBe('2026-11-19T10:00:00.000Z')
    expect(rowOf(row({ shippedAt: '2026-11-19T08:00:00.000Z' }), ORDER, null).showAt).toBe('2026-11-19T08:00:00.000Z')
    const view = readFileSync(new URL('./view/ShipmentRow.tsx', import.meta.url), 'utf8')
    expect(view).toContain("view.showAt && frame?.showInThread ? [{ id: 'show', label: f('discuss.showInThread')")
  })

  it('W-05: "The order stays Partly shipped: n garments are not delivered yet" — counted from the rows; unread contents: nothing', () => {
    const left = { id: 'sh-a', status: 'DELIVERED', contents: [{ lineId: BLK!.id, size: '48', pieces: 4 }] }
    const now = { id: 'sh-b', status: 'SHIPPED', contents: [{ lineId: BLK!.id, size: '50', pieces: 2 }] }
    const value = (rows: object[], status = 'PARTLY_SHIPPED') => ({ status, progress: { ...ORDER.progress, ordered: 10, closedShort: 1 }, chain: { ...ORDER.chain, shipments: rows.map((entry) => row(entry as Partial<ShipmentRow>)) } }) as unknown as Parameters<typeof orderStaysOf>[0]
    expect(orderStaysOf(value([left, now]), 'sh-b')).toEqual({ key: 'door.mark.orderStays.PARTLY_SHIPPED', params: { count: 3 } })
    expect(orderStaysOf(value([left, now], 'SHIPPED'), 'sh-b')).toEqual({ key: 'door.mark.orderStays.SHIPPED', params: { count: 3 } })
    expect(orderStaysOf(value([left, { ...now, contents: [{ lineId: BLK!.id, size: '50', pieces: 5 }] }]), 'sh-b')).toBeNull()
    expect(orderStaysOf(value([left, { id: 'sh-b', status: 'SHIPPED' }]), 'sh-b')).toBeNull()
    for (const locale of LOCALES) for (const status of ['PARTLY_SHIPPED', 'SHIPPED', 'other']) expect(CATALOGUE[locale]['order-shipments']?.[`door.mark.orderStays.${status}_other`], `${locale} ${status}`).toBeTruthy()
  })
})
// ── end os-fx7 ──
