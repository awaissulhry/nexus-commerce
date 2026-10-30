/**
 * The trace both ways (B-W2a-27; SCM-240 backward, SCM-241 forward; design warehouse.lots lt-trace-tree and lt-trace;
 * A1 §2.5): one graph over the links W1 records, read from a lot, a hide, a bundle, a work order (its batch number), a
 * garment serial or a shipment. No table of its own: receipts, issues, cut logs, bundles, serials, shipment lines,
 * DDTs and subcontract kits ARE the links. A recall (EN 17092 garments, PPE Reg. 2016/425) needs the answer complete or
 * the place where the chain is broken said in words: a link the records do not hold is named (a gap), never skipped.
 *
 * The kinds of node, in the order the trace tree shows its levels (upstream → downstream): the supplier, the goods
 * receipt, the lot, the hide, the subcontract order its kit went out with, the work order (its batch), the work order's
 * size (a cell: colourway and size), the bundle, the garment serial, the shipment and the customer.
 */

export const TRACE_START_KINDS = ['LOT', 'HIDE', 'BUNDLE', 'WORK_ORDER', 'SERIAL', 'SHIPMENT'] as const
export type TraceStartKind = (typeof TRACE_START_KINDS)[number]

export const TRACE_NODE_KINDS = ['SUPPLIER', 'RECEIPT', 'LOT', 'HIDE', 'SUBCONTRACT', 'WORK_ORDER', 'CELL', 'BUNDLE', 'SERIAL', 'SHIPMENT', 'CUSTOMER'] as const
export type TraceNodeKind = (typeof TRACE_NODE_KINDS)[number]

/** BACKWARD: where it came from (to the supplier's lot); FORWARD: where it went (to the customer); BOTH: the two. */
export const TRACE_DIRECTIONS = ['BACKWARD', 'FORWARD', 'BOTH'] as const
export type TraceDirection = (typeof TRACE_DIRECTIONS)[number]

/**
 * EXACT: a chain of recorded links says the node holds (or is held in) the start. POSSIBLE: the records know the link
 * only for a whole work order or a whole size (material issued by quantity, a garment without its bundle, a batch-tracked
 * shipment that names the size, not the bundle): the node may hold it, and a recall must count it.
 */
export const TRACE_REACHES = ['EXACT', 'POSSIBLE'] as const
export type TraceReach = (typeof TRACE_REACHES)[number]

export const TRACE_SIDES = ['START', 'BACKWARD', 'FORWARD'] as const
export type TraceSide = (typeof TRACE_SIDES)[number]

/**
 * What an edge is, always written upstream → downstream: SUPPLIED (supplier → receipt, or → lot without a receipt),
 * RECEIVED (receipt → lot), HIDE_OF (lot → hide), ISSUED (lot or hide → work order: the issue ledger less returns and
 * reversals), KIT (lot or hide → subcontract order: sent to the workshop), WORKED_FOR (subcontract order → its work
 * order), SIZE (work order → cell), BUNDLED (cell → bundle), CUT (hide → bundle: the bundle names a live cut log entry of
 * the hide), SPLIT (bundle → the bundle split from it), SERIAL (bundle or cell → garment serial), SHIPPED (serial, cell or
 * bundle → shipment), DELIVERED_TO (shipment → customer).
 */
export const TRACE_LINKS = ['SUPPLIED', 'RECEIVED', 'HIDE_OF', 'ISSUED', 'KIT', 'WORKED_FOR', 'SIZE', 'BUNDLED', 'CUT', 'SPLIT', 'SERIAL', 'SHIPPED', 'DELIVERED_TO'] as const
export type TraceLink = (typeof TRACE_LINKS)[number]

/**
 * Where the records stop or blur, said in words. BROKEN: a link is missing, the trace cannot go further from that node.
 * COARSE: the link is known only for a whole work order or size; everything that may hold it is listed as POSSIBLE.
 * IN_WORK: the goods are still being worked (issued, not cut; cut, not bundled); the trace ends there until the floor
 * records the next step.
 */
export const TRACE_GAP_SEVERITIES = ['BROKEN', 'COARSE', 'IN_WORK'] as const
export type TraceGapSeverity = (typeof TRACE_GAP_SEVERITIES)[number]

export const TRACE_GAP_CODES = [
  'OPENING_STOCK',
  'NO_SUPPLIER',
  'NO_ISSUE',
  'BUNDLE_WITHOUT_CUTS',
  'SERIAL_WITHOUT_BUNDLE',
  'LINE_WITHOUT_SERIALS',
  'BATCH_TRACKED',
  'ISSUED_BY_QUANTITY',
  'SUBCONTRACT_RETURN',
  'ISSUED_NOT_CUT',
  'CUT_NOT_BUNDLED',
  'SERIALS_COLLAPSED',
] as const
export type TraceGapCode = (typeof TRACE_GAP_CODES)[number]

export const TRACE_GAP_SEVERITY: Readonly<Record<TraceGapCode, TraceGapSeverity>> = {
  OPENING_STOCK: 'BROKEN',
  NO_SUPPLIER: 'BROKEN',
  NO_ISSUE: 'BROKEN',
  BUNDLE_WITHOUT_CUTS: 'BROKEN',
  SERIAL_WITHOUT_BUNDLE: 'COARSE',
  LINE_WITHOUT_SERIALS: 'COARSE',
  BATCH_TRACKED: 'COARSE',
  ISSUED_BY_QUANTITY: 'COARSE',
  SUBCONTRACT_RETURN: 'COARSE',
  ISSUED_NOT_CUT: 'IN_WORK',
  CUT_NOT_BUNDLED: 'IN_WORK',
  SERIALS_COLLAPSED: 'COARSE',
}

/** The gap in words (English, as the API's other problems; the screens have their own words per code). */
export function traceGapMessage(code: TraceGapCode, at: string, count: number): string {
  switch (code) {
    case 'OPENING_STOCK':
      return `${at} came in as opening stock, before the factory app: there is no receipt or supplier DDT on record.`
    case 'NO_SUPPLIER':
      return `${at} names no supplier and no receipt: the trace cannot say where it came from.`
    case 'NO_ISSUE':
      return `Work order ${at} has no material issued or cut on record: the trace cannot reach its lots.`
    case 'BUNDLE_WITHOUT_CUTS':
      return `Bundle ${at} names no live cut: its hides are known only for its work order, and every hide issued there is listed as possible.`
    case 'SERIAL_WITHOUT_BUNDLE':
      return `${count} garment${count === 1 ? '' : 's'} of ${at} got a serial before the bundle was known: their hides and lots are known only for the work order.`
    case 'LINE_WITHOUT_SERIALS':
      return `${count} garment${count === 1 ? '' : 's'} on shipment ${at} carry no serial on record: they are known only by their size.`
    case 'BATCH_TRACKED':
      return `The garments of ${at} carry the batch number, not a serial: a shipment names the size, not the bundle, so every shipment of the size is listed as possible.`
    case 'ISSUED_BY_QUANTITY':
      return `${at}: material issued by quantity (not hide by hide) is recorded for the whole work order, not for a garment; it is listed as possible.`
    case 'SUBCONTRACT_RETURN':
      return `Subcontract order ${at}: what came back from the workshop is recorded by bundle in the audit log, not as a link; every garment of its work order may hold the material sent.`
    case 'ISSUED_NOT_CUT':
      return `${at} is issued to ${count} work order${count === 1 ? '' : 's'} and not cut there yet: the trace ends at the work order for now.`
    case 'CUT_NOT_BUNDLED':
      return `${count} cut${count === 1 ? '' : 's'} of ${at} are in no bundle yet: the pieces are still in the cutting room.`
    case 'SERIALS_COLLAPSED':
      return `${count} serials are counted on their bundles and sizes, not listed one by one: trace a work order or a bundle to see each serial.`
  }
}

/** The shipments that left the site: their customer received (or is receiving) the goods. RETURNED came back unshipped. */
export const LEFT_SHIPMENT_STATUSES: readonly string[] = ['SHIPPED', 'DELIVERED']

/** The serial nodes one answer lists; beyond, they are counted on their bundle and size (SERIALS_COLLAPSED). */
export const TRACE_SERIAL_NODE_LIMIT = 2000

/** The QualityHold subject types (holds.prisma) per node kind. */
export const HOLD_SUBJECT_OF: Readonly<Partial<Record<TraceNodeKind, string>>> = {
  LOT: 'Lot',
  HIDE: 'Hide',
  WORK_ORDER: 'WorkOrder',
  BUNDLE: 'Bundle',
  SERIAL: 'GarmentSerial',
  SHIPMENT: 'Shipment',
}

export const nodeKey = (kind: TraceNodeKind, id: string): string => `${kind}:${id}`
