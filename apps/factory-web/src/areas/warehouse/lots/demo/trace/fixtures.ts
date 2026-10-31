import { at, COLOURS, ITEMS, LOTS, RECEIPTS, SITE, COMPANY, SUPPLIERS, uid, WORK_ORDERS } from '../../../../_shared/stock/fixtures'
import type { Trace, TraceFind, TraceNode } from '../../../stock/daily/api'

/**
 * A made-up trace for the design cases (B-W2a-64; SCR-201-record Trace tab, SCR-201-trace): the released nappa lot traced
 * both ways — came from a tannery, its receipt and supplier DDT; went to two hides, issued to two work orders (one cut
 * into a cell and two bundles with serials shipped to a customer who received them; the other issued, not cut yet), a
 * customer the reader may not see, a hide on hold, a coarse gap and one still in work. Nothing here is real.
 */

const node = (kind: TraceNode['kind'], id: string, code: string | null, over: Partial<TraceNode> = {}): TraceNode => ({
  key: `${kind}:${id}`,
  kind,
  id,
  code,
  reach: 'EXACT',
  sides: ['FORWARD'],
  restricted: [],
  holds: [],
  ...over,
})

const CUSTOMER = { id: uid('9595', 1), code: 'MOTO-ESEMPIO', name: 'Moto Esempio S.r.l.' }
const lot = LOTS.nappa
const hide1 = uid('8282', 3)
const hide2 = uid('8282', 4)
const cell = uid('7878', 1)
const bundle1 = uid('7878', 11)
const bundle2 = uid('7878', 12)
const shipment = uid('9494', 1)
const serial = (n: number) => uid('7979', n)

export const LOT_TRACE: Trace = {
  start: { key: `LOT:${lot.id}`, kind: 'LOT', id: lot.id, code: lot.code },
  direction: 'BOTH',
  asOf: at(30, 9, 41),
  nodes: [
    node('SUPPLIER', SUPPLIERS.tannery.id, SUPPLIERS.tannery.code, { sides: ['BACKWARD'], party: SUPPLIERS.tannery }),
    node('RECEIPT', RECEIPTS.a.id, RECEIPTS.a.number, { sides: ['BACKWARD'], receipt: { status: 'POSTED', receivedAt: at(14, 10), supplierDdtNumber: 'DDT 412/26' } }),
    node('LOT', lot.id, lot.code, {
      sides: ['START'],
      lot: { item: { code: ITEMS.leather.code, name: ITEMS.leather.name, baseUom: 'FT2' }, colourCode: COLOURS.black.code, qualityStatus: 'RELEASED', onHand: '319.8000', scrapped: '0.0000', companyId: COMPANY, siteId: SITE.id },
    }),
    node('HIDE', hide1, 'HD-DEMO-0003', { hide: { lotId: lot.id, state: 'PARTLY_CUT', baseArea: '49.4000', onHand: '0.0000' } }),
    node('HIDE', hide2, 'HD-DEMO-0004', { hide: { lotId: lot.id, state: 'FULL', baseArea: '48.8000', onHand: '0.0000' }, holds: [{ id: uid('7676', 1), reasonCode: 'QUALITY_CHECK', placedAt: at(29, 15) }] }),
    node('WORK_ORDER', WORK_ORDERS.a.id, WORK_ORDERS.a.number, { workOrder: { batchNumber: WORK_ORDERS.a.batchNumber, status: 'COMPLETED', kind: 'SIZE_GRID', styleCode: 'DEMO-GIA-01', tracking: 'BATCH', finishedReceived: 12 } }),
    node('WORK_ORDER', WORK_ORDERS.b.id, WORK_ORDERS.b.number, { workOrder: { batchNumber: WORK_ORDERS.b.batchNumber, status: 'IN_PROGRESS', kind: 'SIZE_GRID', styleCode: 'DEMO-GIA-02', tracking: 'BATCH', finishedReceived: 0 } }),
    node('CELL', cell, 'BLK 50', { cell: { workOrderId: WORK_ORDERS.a.id, colourwayCode: 'BLK', size: '50', quantity: 12, released: 12, packed: 0, shipped: 12, returned: 0 } }),
    node('BUNDLE', bundle1, 'BN-D-0101', { bundle: { workOrderId: WORK_ORDERS.a.id, quantity: 6, part: 'Davanti', status: 'DONE', parentBundleId: null, cuts: 1, serials: 6 } }),
    node('BUNDLE', bundle2, 'BN-D-0102', { bundle: { workOrderId: WORK_ORDERS.a.id, quantity: 6, part: 'Dietro', status: 'DONE', parentBundleId: null, cuts: 1, serials: 6 } }),
    node('SHIPMENT', shipment, 'SH-D-0007', { reach: 'POSSIBLE', shipment: { status: 'SHIPPED', shippedAt: at(27, 16), ddtNumbers: ['118/2026'], left: true } }),
    node('CUSTOMER', CUSTOMER.id, CUSTOMER.code, { reach: 'POSSIBLE', party: CUSTOMER, received: true }),
    node('CUSTOMER', uid('9595', 2), null, { reach: 'POSSIBLE', restricted: ['parties.view'], party: null, received: true }),
  ],
  edges: [
    { from: `SUPPLIER:${SUPPLIERS.tannery.id}`, to: `RECEIPT:${RECEIPTS.a.id}`, link: 'SUPPLIED', exact: true, quantity: null, uom: null },
    { from: `RECEIPT:${RECEIPTS.a.id}`, to: `LOT:${lot.id}`, link: 'RECEIVED', exact: true, quantity: '412.5000', uom: 'FT2' },
    { from: `LOT:${lot.id}`, to: `HIDE:${hide1}`, link: 'HIDE_OF', exact: true, quantity: '49.4000', uom: 'FT2' },
    { from: `LOT:${lot.id}`, to: `HIDE:${hide2}`, link: 'HIDE_OF', exact: true, quantity: '48.8000', uom: 'FT2' },
    { from: `HIDE:${hide1}`, to: `WORK_ORDER:${WORK_ORDERS.a.id}`, link: 'ISSUED', exact: true, quantity: '49.4000', uom: 'FT2' },
    { from: `HIDE:${hide2}`, to: `WORK_ORDER:${WORK_ORDERS.b.id}`, link: 'ISSUED', exact: true, quantity: '48.8000', uom: 'FT2' },
    { from: `WORK_ORDER:${WORK_ORDERS.a.id}`, to: `CELL:${cell}`, link: 'SIZE', exact: true, quantity: '12', uom: 'PCS' },
    { from: `HIDE:${hide1}`, to: `BUNDLE:${bundle1}`, link: 'CUT', exact: true, quantity: null, uom: null },
    { from: `CELL:${cell}`, to: `BUNDLE:${bundle2}`, link: 'BUNDLED', exact: true, quantity: '6', uom: 'PCS' },
    { from: `CELL:${cell}`, to: `SHIPMENT:${shipment}`, link: 'SHIPPED', exact: false, quantity: '12', uom: 'PCS' },
    { from: `SHIPMENT:${shipment}`, to: `CUSTOMER:${CUSTOMER.id}`, link: 'DELIVERED_TO', exact: false, quantity: null, uom: null },
    { from: `SHIPMENT:${shipment}`, to: `CUSTOMER:${uid('9595', 2)}`, link: 'DELIVERED_TO', exact: false, quantity: null, uom: null },
  ],
  levels: [
    { kind: 'SUPPLIER', exact: 1, possible: 0 },
    { kind: 'RECEIPT', exact: 1, possible: 0 },
    { kind: 'LOT', exact: 1, possible: 0 },
    { kind: 'HIDE', exact: 2, possible: 0 },
    { kind: 'WORK_ORDER', exact: 2, possible: 0 },
    { kind: 'CELL', exact: 1, possible: 0 },
    { kind: 'BUNDLE', exact: 2, possible: 0 },
    { kind: 'SHIPMENT', exact: 0, possible: 1 },
    { kind: 'CUSTOMER', exact: 0, possible: 2 },
  ],
  gaps: [
    { code: 'BATCH_TRACKED', severity: 'COARSE', at: `WORK_ORDER:${WORK_ORDERS.a.id}`, count: 1 },
    { code: 'ISSUED_NOT_CUT', severity: 'IN_WORK', at: `HIDE:${hide2}`, count: 1 },
  ],
  customersReceived: { exact: 0, possible: 2 },
  restricted: [{ permission: 'parties.view', nodes: 1 }],
}

/** A lot that went nowhere yet: only where it came from. */
export const UNUSED_TRACE: Trace = {
  ...LOT_TRACE,
  start: { key: `LOT:${LOTS.nappaQuarantine.id}`, kind: 'LOT', id: LOTS.nappaQuarantine.id, code: LOTS.nappaQuarantine.code },
  nodes: [LOT_TRACE.nodes[0]!, LOT_TRACE.nodes[1]!, { ...LOT_TRACE.nodes[2]!, key: `LOT:${LOTS.nappaQuarantine.id}`, id: LOTS.nappaQuarantine.id, code: LOTS.nappaQuarantine.code }],
  edges: [LOT_TRACE.edges[0]!, { ...LOT_TRACE.edges[1]!, to: `LOT:${LOTS.nappaQuarantine.id}` }],
  levels: [LOT_TRACE.levels[0]!, LOT_TRACE.levels[1]!, LOT_TRACE.levels[2]!],
  gaps: [],
  customersReceived: { exact: 0, possible: 0 },
  restricted: [],
}

/** Opening stock: no supplier, no receipt (a broken chain backward). */
export const OPENING_TRACE: Trace = {
  ...UNUSED_TRACE,
  start: { key: `LOT:${uid('8181', 6)}`, kind: 'LOT', id: uid('8181', 6), code: 'LOT-D-000090' },
  nodes: [{ ...LOT_TRACE.nodes[2]!, key: `LOT:${uid('8181', 6)}`, id: uid('8181', 6), code: 'LOT-D-000090' }],
  edges: [],
  levels: [{ kind: 'LOT', exact: 1, possible: 0 }],
  gaps: [{ code: 'OPENING_STOCK', severity: 'BROKEN', at: `LOT:${uid('8181', 6)}`, count: 1 }],
}

/** A hide traced from the Trace dialog (SCR-201-trace): back to its lot and tannery, on to its work order and bundle. */
export const HIDE_TRACE: Trace = {
  ...LOT_TRACE,
  start: { key: `HIDE:${hide1}`, kind: 'HIDE', id: hide1, code: 'HD-DEMO-0003' },
  nodes: LOT_TRACE.nodes
    .filter((entry) => !['HIDE'].includes(entry.kind) || entry.id === hide1)
    .filter((entry) => entry.id !== WORK_ORDERS.b.id)
    .map((entry) => (entry.id === hide1 ? { ...entry, sides: ['START'] } : entry.kind === 'SUPPLIER' || entry.kind === 'RECEIPT' || entry.kind === 'LOT' ? { ...entry, sides: ['BACKWARD'] } : entry)),
  edges: [...LOT_TRACE.edges.filter((edge) => !edge.to.includes(hide2) && !edge.from.includes(hide2))],
  levels: LOT_TRACE.levels.map((level) => (level.kind === 'HIDE' ? { ...level, exact: 1 } : level.kind === 'WORK_ORDER' ? { ...level, exact: 1 } : level)),
  gaps: [LOT_TRACE.gaps[0]!],
}

/** Many serials of one bundle (a large trace: counted first, listed on opening the group). */
export const LARGE_TRACE: Trace = {
  ...LOT_TRACE,
  nodes: [...LOT_TRACE.nodes, ...Array.from({ length: 30 }, (_, index) => ({ key: `SERIAL:${serial(index + 1)}`, kind: 'SERIAL' as const, id: serial(index + 1), code: `SN-D-${String(index + 1).padStart(5, '0')}`, reach: 'EXACT' as const, sides: ['FORWARD' as const], restricted: [], holds: [], serial: { workOrderId: WORK_ORDERS.a.id, status: 'SHIPPED' } }))],
  edges: [...LOT_TRACE.edges, ...Array.from({ length: 30 }, (_, index) => ({ from: `BUNDLE:${bundle1}`, to: `SERIAL:${serial(index + 1)}`, link: 'SERIAL' as const, exact: true, quantity: null, uom: null }))],
  levels: [...LOT_TRACE.levels, { kind: 'SERIAL', exact: 30, possible: 0 }],
}

export const FIND_SEVERAL: TraceFind = {
  code: 'BT-D-0031',
  matches: [
    { kind: 'WORK_ORDER', id: WORK_ORDERS.a.id, code: WORK_ORDERS.a.number, matchedBy: 'BATCH_NUMBER', label: '' },
    { kind: 'LOT', id: lot.id, code: lot.code, matchedBy: 'DYE_BATCH', label: '' },
  ],
  problem: null,
}
