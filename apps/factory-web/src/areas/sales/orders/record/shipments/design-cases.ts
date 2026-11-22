import type { Order } from '../../api'
import { at, canOf, LINE_BLK, LINE_RED, order, type Role } from '../../_demo/fixtures'
import { abilitiesOf } from '../../model'
import { rolePermissions } from '../../../../../shell/design-data'
import { LINKS_FULL, linksModel } from '../links/fixtures'
import type { OrderRecordModel } from '../record-model'
import type { Deliveries, DeliveryRow } from './delivered/api'

/**
 * T.1 (order SHIPMENTS tab; 15-steps T.1; 10-design §9 order cases) — the Shipments tab's design cases for the states the seed lacks, on
 * SO-2026-0088 (two lines: DEMO-JKT-01 Nero 48–54 ×2, Rosso 50–54 ×2 = 14 garments): no shipment yet · a shared draft with a joinable
 * one · split over draft, packed and shipped · a carrier booked by hand with 3 parcels typed (air waybill) · delivered by the carrier
 * and by hand · came back (received or not) · cancelled and merged · made elsewhere · held · a return and a complaint · every part
 * failed · the roles · "Seed Karachi Mills" with a shipment that travels without a DDT (no country is read: the same tab). The rooms
 * (S / M / L) are the end walk's: the gallery has no room control. Made-up data only. Fixtures (fixtures.ts) spreads these cases.
 */

type Base = (role: Role, value: Order, over?: Partial<OrderRecordModel>) => { role: Role; record: OrderRecordModel }
type ShipmentRow = Order['chain']['shipments'][number]
type Progress = Order['progress']

const uid = (n: number) => `0190f0e2-8282-7000-8000-${String(n).padStart(12, '0')}`
const THIS = { id: order().id, number: 'SO-2026-0088', customerRef: 'PO-ESEMPIO-88' }
const OTHER = { id: '0190f0e2-5151-7000-8000-000000000151', number: 'SO-2026-0151', customerRef: 'PO-ESEMPIO-151' }
const ALL = { manage: true, pack: true, ddt: true, holdsManage: true, holdsRelease: true }

/** One size's figures: released, shipped, on a shipment not left (planned), released and on none (ready now), closed short. */
interface SizeFigures {
  readonly released: number
  readonly shipped?: number
  readonly planned?: number
  readonly readyNow?: number
  readonly closed?: number
}

const progressOf = (ordered: number, figures: SizeFigures): Progress => {
  const shipped = figures.shipped ?? 0
  const closed = figures.closed ?? 0
  return { ordered, inWorkOrders: ordered, made: null, released: figures.released, shipped, invoiced: String(shipped), toShip: ordered - shipped - closed, closedShort: closed, planned: figures.planned ?? 0, readyNow: figures.readyNow ?? 0 }
}
const add = (a: Progress, b: Progress): Progress => ({ ordered: a.ordered + b.ordered, inWorkOrders: a.inWorkOrders + b.inWorkOrders, made: null, released: a.released + b.released, shipped: a.shipped + b.shipped, invoiced: String(Number(a.invoiced) + Number(b.invoiced)), toShip: a.toShip + b.toShip, closedShort: a.closedShort + b.closedShort, planned: (a.planned ?? 0) + (b.planned ?? 0), readyNow: (a.readyNow ?? 0) + (b.readyNow ?? 0) })
const ZERO: Progress = { ordered: 0, inWorkOrders: 0, made: null, released: 0, shipped: 0, invoiced: '0', toShip: 0, closedShort: 0, planned: 0, readyNow: 0 }

/** The order at a status with each size's figures (the server's counted buckets, B-OS-002) and its shipments. */
function osOrder(status: Order['status'], figures: (lineId: string, size: string, quantity: number) => SizeFigures, shipments: ShipmentRow[]): Order {
  const value = order(status)
  const lines = value.lines.map((line) => {
    const sizes = line.sizes.map((row) => ({ ...row, progress: progressOf(row.quantity, figures(line.id, row.size ?? '', row.quantity)) }))
    return { ...line, sizes, progress: sizes.reduce((total, row) => add(total, row.progress), ZERO) }
  })
  return { ...value, lines, progress: lines.reduce((total, line) => add(total, line.progress), ZERO), chain: { ...value.chain, shipments } }
}

const piece = (lineId: string, size: string, pieces = 2) => ({ lineId, size, pieces })

/** A shipment row of this order as the order read sends it with S1's fields (B-OS-001). */
function row(n: number, status: string, over: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: uid(n),
    number: `SH-2026-00${n}`,
    status,
    shippedAt: null,
    deliveredAt: null,
    version: 2,
    transportBy: 'CARRIER',
    carrier: { code: 'brt', name: 'BRT' },
    tracking: null,
    expectedDeliveryAt: null,
    ddt: null,
    mayTypeTracking: { allowed: false, code: 'LABELLED', why: null },
    withheld: [],
    orders: [THIS],
    origin: 'NEXUS',
    externalDdt: null,
    contents: [],
    otherPieces: 0,
    holds: [],
    cancelReason: null,
    cancelledAt: null,
    splitFrom: null,
    mergedInto: null,
    ddtRequired: true,
    packedAt: null,
    parcels: [],
    may: ALL,
    ...over,
  }
}

const label = (n: number, seq: number, number: string | null, contents: ReturnType<typeof piece>[]) => ({ id: uid(n * 10 + seq), seq, number, url: number ? `https://brt.example.com/track/${number}` : null, source: number ? 'LABEL' : null, live: !!number, contents })
const typed = (n: number, seq: number, number: string, contents: ReturnType<typeof piece>[]) => ({ id: uid(n * 10 + seq), seq, number, url: null, source: 'TYPED', live: false, contents })

/** A delivery row of the deliveries read (B-OS-003) for a shipment that left. */
function delivery(shipment: ShipmentRow, over: Partial<DeliveryRow> = {}): DeliveryRow {
  return { id: shipment.id, number: shipment.number, status: shipment.status, carrierName: shipment.carrier?.name ?? null, shippedAt: shipment.shippedAt, deliveredAt: shipment.deliveredAt, deliveredVia: null, pod: null, openProblems: 0, mayOpen: true, byHand: null, carrierLater: null, returned: null, expectedDeliveryAt: shipment.expectedDeliveryAt ?? null, etaByHand: false, ...over }
}
const deliveries = (value: Order, rows: DeliveryRow[]): { value: Deliveries; problem: null } => ({ value: { order: { id: value.id, number: value.number, status: value.status, deliveredAt: null }, shipments: rows, steps: [] }, problem: null })

// ---- the order cases (10-design §9) ----
const NOTHING = osOrder('IN_PRODUCTION', (_line, _size, q) => ({ released: Math.floor(q / 2), readyNow: Math.floor(q / 2) }), [])

const SHARED_DRAFT = row(62, 'DRAFT', { orders: [OTHER, THIS], contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')], otherPieces: 3, holds: [{ id: uid(901), reason: 'BALANCE_UNPAID', words: null, bySystem: true, placedAt: at(19, 9, 0, 11) }], mayTypeTracking: { allowed: true, code: null, why: null } })
const SHARED = osOrder('READY', (line, size) => ({ released: 2, planned: line === LINE_BLK && (size === '48' || size === '50') ? 2 : 0, readyNow: line === LINE_BLK && (size === '48' || size === '50') ? 0 : 2 }), [SHARED_DRAFT])

const SPLIT_SHIPPED = row(71, 'SHIPPED', { shippedAt: at(12, 9, 0, 11), ddt: { number: '144/2026', date: '2026-11-12' }, packedAt: at(11, 16, 0, 11), contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')], tracking: { number: null, source: 'PARCELS', parcels: [{ number: 'BRT05812290011', url: 'https://brt.example.com/track/BRT05812290011' }, { number: 'BRT05812290012', url: 'https://brt.example.com/track/BRT05812290012' }], live: true }, parcels: [label(71, 1, 'BRT05812290011', [piece(LINE_BLK, '48')]), label(71, 2, 'BRT05812290012', [piece(LINE_BLK, '50')])] })
const SPLIT_PACKED = row(72, 'PACKED', { ddt: { number: '151/2026', date: '2026-11-18' }, packedAt: at(18, 15, 0, 11), contents: [piece(LINE_BLK, '52'), piece(LINE_BLK, '54')], parcels: [label(72, 1, 'BRT05812290021', [piece(LINE_BLK, '52', 1)]), label(72, 2, 'BRT05812290022', [piece(LINE_BLK, '52', 1)]), label(72, 3, null, [piece(LINE_BLK, '54')])] })
const SPLIT_DRAFT = row(73, 'DRAFT', { contents: [piece(LINE_RED, '50')], splitFrom: { id: uid(72), number: 'SH-2026-0072', reason: 'PART_READY' }, mayTypeTracking: { allowed: true, code: null, why: null } })
const SPLIT_FIGURES = (line: string, size: string): SizeFigures => {
  if (line === LINE_BLK) return size === '48' || size === '50' ? { released: 2, shipped: 2 } : { released: 2, planned: 2 }
  if (size === '50') return { released: 2, planned: 2 }
  if (size === '52') return { released: 2, readyNow: 2 }
  return { released: 0 }
}
const SPLIT = osOrder('PARTLY_SHIPPED', SPLIT_FIGURES, [SPLIT_SHIPPED, SPLIT_PACKED, SPLIT_DRAFT])
const SPLIT_DELIVERIES = deliveries(SPLIT, [delivery(SPLIT_SHIPPED, { status: 'SHIPPED', deliveredVia: null, openProblems: 1, expectedDeliveryAt: at(14, 12, 0, 11) })])

const AWB_ROW = row(74, 'SHIPPED', {
  shippedAt: at(18, 9, 0, 11),
  carrier: { code: null, name: 'Seed Air Cargo' },
  tracking: { number: '157-12345675', source: 'TYPED', parcels: [], live: false, url: 'https://track.seed-air-cargo.example.com/157-12345675' },
  mayTypeTracking: { allowed: true, code: null, why: null },
  ddt: { number: '160/2026', date: '2026-11-18' },
  expectedDeliveryAt: at(20, 12, 0, 11),
  contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50'), piece(LINE_BLK, '52'), piece(LINE_BLK, '54')],
  parcels: [typed(74, 1, 'HAWB-0001', [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')]), typed(74, 2, 'HAWB-0002', [piece(LINE_BLK, '52')]), typed(74, 3, 'HAWB-0003', [piece(LINE_BLK, '54')])],
})
const AWB = osOrder('PARTLY_SHIPPED', (line) => (line === LINE_BLK ? { released: 2, shipped: 2 } : { released: 0 }), [AWB_ROW])
const AWB_DELIVERIES = deliveries(AWB, [delivery(AWB_ROW, { etaByHand: true })])

const DELIVERED_CARRIER = row(41, 'DELIVERED', { shippedAt: at(12, 9, 0, 11), deliveredAt: at(14, 11, 0, 11), ddt: { number: '144/2026', date: '2026-11-12' }, contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50'), piece(LINE_BLK, '52'), piece(LINE_BLK, '54')], parcels: [label(41, 1, 'BRT05812290041', [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')]), label(41, 2, 'BRT05812290042', [piece(LINE_BLK, '52'), piece(LINE_BLK, '54')])] })
const DELIVERED_HAND = row(47, 'DELIVERED', { shippedAt: at(15, 9, 0, 11), deliveredAt: at(18, 10, 0, 11), ddt: { number: '151/2026', date: '2026-11-15' }, contents: [piece(LINE_RED, '50'), piece(LINE_RED, '52'), piece(LINE_RED, '54')], parcels: [label(47, 1, 'BRT05812290047', [piece(LINE_RED, '50'), piece(LINE_RED, '52'), piece(LINE_RED, '54')])] })
const DELIVERED = osOrder('DELIVERED', () => ({ released: 2, shipped: 2 }), [DELIVERED_CARRIER, DELIVERED_HAND])
const DELIVERED_DELIVERIES = deliveries(DELIVERED, [
  delivery(DELIVERED_CARRIER, { deliveredVia: 'CARRIER', pod: { signedBy: 'M. Rossi', signedAt: at(14, 11, 0, 11), image: true } }),
  delivery(DELIVERED_HAND, { deliveredVia: 'TYPED', byHand: { reason: 'The customer confirmed the delivery by phone; the carrier never scanned it.', overrode: true } }),
])

const BACK_ROW = row(72, 'RETURNED', { shippedAt: at(15, 9, 0, 11), ddt: { number: '151/2026', date: '2026-11-15' }, contents: [piece(LINE_RED, '50'), piece(LINE_RED, '52'), piece(LINE_RED, '54')], parcels: [label(72, 1, 'BRT05812290072', [piece(LINE_RED, '50'), piece(LINE_RED, '52'), piece(LINE_RED, '54')])] })
const BACK = (received: boolean) => osOrder('PARTLY_SHIPPED', (line) => (line === LINE_BLK ? { released: 2, shipped: 2 } : received ? { released: 2, readyNow: 2 } : { released: 2 }), [DELIVERED_CARRIER, BACK_ROW])
const BACK_DELIVERIES = (received: boolean) => deliveries(BACK(received), [delivery(DELIVERED_CARRIER, { deliveredVia: 'CARRIER' }), delivery(BACK_ROW, { returned: { at: at(19, 10, 0, 11), received } })])

const MERGED = row(68, 'CANCELLED', { cancelReason: 'Merged into SH-2026-0069', cancelledAt: at(20, 9, 0, 11), mergedInto: { id: uid(69), number: 'SH-2026-0069' }, contents: [], may: ALL })
const MERGE_TARGET = row(69, 'DRAFT', { contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50'), piece(LINE_RED, '50')], mayTypeTracking: { allowed: true, code: null, why: null } })
const onTarget = (line: string, size: string): boolean => (line === LINE_BLK && (size === '48' || size === '50')) || (line === LINE_RED && size === '50')
const CANCELLED = osOrder('READY', (line, size) => ({ released: 2, ...(onTarget(line, size) ? { planned: 2 } : { readyNow: 2 }) }), [MERGE_TARGET, MERGED])

const ELSEWHERE_ROW = row(76, 'SHIPPED', { shippedAt: at(10, 8, 0, 11), origin: 'ELSEWHERE', externalDdt: { number: '118/B', date: '2026-11-10' }, transportBy: 'SENDER', carrier: null, mayTypeTracking: { allowed: false, code: 'NOT_A_CARRIER', why: null }, contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50'), piece(LINE_BLK, '52'), piece(LINE_BLK, '54'), piece(LINE_RED, '50'), piece(LINE_RED, '52'), piece(LINE_RED, '54')], ddtRequired: false })
const ELSEWHERE = osOrder('SHIPPED', () => ({ released: 2, shipped: 2 }), [ELSEWHERE_ROW])
const ELSEWHERE_DELIVERIES = deliveries(ELSEWHERE, [delivery(ELSEWHERE_ROW, { carrierName: null })])

const HELD_ROW = row(78, 'PACKED', { ddt: { number: '162/2026', date: '2026-11-19' }, packedAt: at(19, 15, 0, 11), contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')], holds: [{ id: uid(911), reason: 'CREDIT', words: null, bySystem: true, placedAt: at(19, 16, 0, 11) }, { id: uid(912), reason: 'QUALITY', words: 'Re-check the zip pulls on size 50.', bySystem: false, placedAt: at(20, 8, 0, 11) }], parcels: [label(78, 1, null, [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')])], mayTypeTracking: { allowed: true, code: null, why: null } })
const HELD = osOrder('READY', (line, size) => ({ released: 2, ...(line === LINE_BLK && (size === '48' || size === '50') ? { planned: 2 } : { readyNow: 2 }) }), [HELD_ROW])

// Seed Karachi Mills (Pakistan): a Nexus shipment packed and waiting for its DDT (the choice said), one that travelled without a DDT.
const PK_PACKED = row(81, 'PACKED', { carrier: { code: null, name: 'Seed Air Cargo' }, packedAt: at(20, 15, 0, 11), contents: [piece(LINE_RED, '50'), piece(LINE_RED, '52')], mayTypeTracking: { allowed: true, code: null, why: null }, parcels: [typed(81, 1, 'HAWB-0081', [piece(LINE_RED, '50'), piece(LINE_RED, '52')])] })
const PK_LEFT = row(80, 'SHIPPED', { shippedAt: at(18, 9, 0, 11), carrier: { code: null, name: 'Seed Air Cargo' }, ddtRequired: false, tracking: { number: '157-12345675', source: 'TYPED', parcels: [], live: false, url: null }, mayTypeTracking: { allowed: true, code: null, why: null }, contents: [piece(LINE_BLK, '48'), piece(LINE_BLK, '50'), piece(LINE_BLK, '52'), piece(LINE_BLK, '54')], parcels: [typed(80, 1, 'HAWB-0080-1', [piece(LINE_BLK, '48'), piece(LINE_BLK, '50')]), typed(80, 2, 'HAWB-0080-2', [piece(LINE_BLK, '52'), piece(LINE_BLK, '54')])] })
const PAKISTAN = osOrder('PARTLY_SHIPPED', (line, size) => (line === LINE_BLK ? { released: 2, shipped: 2 } : size === '54' ? { released: 0 } : { released: 2, planned: 2 }), [PK_LEFT, PK_PACKED])
const PAKISTAN_DELIVERIES = deliveries(PAKISTAN, [delivery(PK_LEFT, { etaByHand: false })])

const FAILED = 'problem.read.unavailable'
/** The after-sales doors' rights (sales.returns.manage, quality.complaints.log) on top of a role's. */
const withAfterSales = (role: Role) => ({ ...canOf(role), returnsManage: true, complaintsLog: true })
const roleCan = (key: Parameters<typeof rolePermissions>[0]) => abilitiesOf(rolePermissions(key))
/** The rows as the server answers a viewer: each row's own rights (`may`, B-OS-001) — Warehouse's, or none (Sales, PM, Read-only). */
const WAREHOUSE_MAY = { manage: true, pack: true, ddt: true, holdsManage: true, holdsRelease: false }
const NO_MAY = { manage: false, pack: false, ddt: false, holdsManage: false, holdsRelease: false }
const seenWith = (value: Order, may: NonNullable<ShipmentRow['may']>): Order => ({ ...value, chain: { ...value.chain, shipments: value.chain.shipments.map((entry) => ({ ...entry, may, ...(may.manage ? {} : { mayTypeTracking: { allowed: false, code: 'NO_RIGHT', why: null } }) })) } })

export function shipmentsLaneCases(base: Base) {
  const tab = (role: Role, value: Order, over: Partial<OrderRecordModel> = {}) => base(role, value, { tab: 'shipments', ...over })
  return [
    { id: 'os-none', label: 'F-OS · Owner · Shipments: no shipment yet — 7 garments ready now, 7 still to be made or released; Create shipment… opens', model: tab('owner', NOTHING) },
    { id: 'os-shared', label: 'F-OS · Owner · A draft shared with SO-2026-0151, on hold by that order\'s balance; a draft of the same customer to join', model: tab('owner', SHARED, { joinable: [{ shipmentId: uid(65), number: 'SH-2026-0065', held: null }] }) },
    { id: 'os-split', label: 'F-OS · Owner · Split: shipped (BRT labels, no carrier news: 1 tracking problem) · packed (2 of 3 labelled) · a draft split from it', model: tab('owner', SPLIT, { shipmentDeliveries: SPLIT_DELIVERIES }) },
    { id: 'os-awb', label: 'F-OS · Owner · An air waybill: Seed Air Cargo booked by hand, 157-12345675, 3 parcels each typed, expected set by hand', model: tab('owner', AWB, { shipmentDeliveries: AWB_DELIVERIES }) },
    { id: 'os-delivered', label: 'F-OS · Owner · Delivered: one from the carrier with its proof, one set by hand over the labels (the reason, office only)', model: tab('owner', DELIVERED, { shipmentDeliveries: DELIVERED_DELIVERIES }) },
    { id: 'os-back', label: 'F-OS · Owner · Came back with the carrier, not received yet: receive the garments in Warehouse', model: tab('owner', BACK(false), { shipmentDeliveries: BACK_DELIVERIES(false) }) },
    { id: 'os-back-received', label: 'F-OS · Owner · Came back and received: the garments count as ready now again', model: tab('owner', BACK(true), { shipmentDeliveries: BACK_DELIVERIES(true) }) },
    { id: 'os-merged', label: 'F-OS · Owner · A draft merged into another: "Show 1 cancelled" (Cancelled: Merged into SH-2026-0069)', model: tab('owner', CANCELLED) },
    { id: 'os-elsewhere', label: 'F-OS · Owner · Made elsewhere (paper DDT 118/B), our van: Mark delivered… in ⋯', model: tab('owner', ELSEWHERE, { shipmentDeliveries: ELSEWHERE_DELIVERIES }) },
    { id: 'os-held', label: 'F-OS · Owner · Packed and held: credit (by the system, finance releases it) and quality (a person, why)', model: tab('owner', HELD) },
    { id: 'os-after', label: 'F-OS · Owner · Delivered, with a return and a complaint: Open a return… and Log a complaint… on the head, Send a claim link… in ⋯', model: tab('owner', DELIVERED, { can: withAfterSales('owner'), shipmentDeliveries: DELIVERED_DELIVERIES, links: linksModel({ ...LINKS_FULL, rePromises: [], gates: [] }) }) },
    { id: 'os-failed', label: 'F-OS · Owner · Every part failed: each its own line with Try again; nothing says "nothing"', model: tab('owner', SPLIT, { shipmentDeliveries: { value: null, problem: FAILED }, links: { state: 'error', problem: FAILED } }) },
    { id: 'os-pakistan', label: 'F-OS · Owner · Seed Karachi Mills (Pakistan): one travelled without a DDT (Set by hand), one packed waits — the DDT choice said; no country is read', model: tab('owner', PAKISTAN, { shipmentDeliveries: PAKISTAN_DELIVERIES }) },
    // The roles on ONE order (split): what each reads and does (D2: hidden without the right, held only by state).
    { id: 'os-role-warehouse', label: 'F-OS · Roles · Warehouse: every shipment act; no after-sales door (Returns only in the list)', model: tab('manager', seenWith(SPLIT, WAREHOUSE_MAY), { can: roleCan('warehouse'), shipmentDeliveries: SPLIT_DELIVERIES }) },
    { id: 'os-role-sales', label: 'F-OS · Roles · Sales: reads every cell, no shipment act; Open a return… and Log a complaint…', model: tab('sales', seenWith(SPLIT, NO_MAY), { can: { ...canOf('sales'), returnsManage: true, complaintsLog: true }, shipmentDeliveries: SPLIT_DELIVERIES, links: linksModel({ ...LINKS_FULL, rePromises: [], gates: [] }) }) },
    { id: 'os-role-manager', label: 'F-OS · Roles · Production manager: reads; Log a complaint… only', model: tab('manager', seenWith(SPLIT, NO_MAY), { can: roleCan('production_manager'), shipmentDeliveries: SPLIT_DELIVERIES }) },
    { id: 'os-role-readonly', label: 'F-OS · Roles · Read-only: reads every cell, no act at all', model: tab('manager', seenWith(SPLIT, NO_MAY), { can: roleCan('read_only'), shipmentDeliveries: SPLIT_DELIVERIES }) },
  ]
}
