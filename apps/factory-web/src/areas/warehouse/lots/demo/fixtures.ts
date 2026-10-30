import type { LedgerRow, LotRecord, LotRow } from '../../../_shared/stock/api'
import { at, COLOURS, DEVICES, ITEMS, LOCATIONS, LOTS, named, PEOPLE, RECEIPTS, SUPPLIERS, uid, WORK_ORDERS, ledgerRow, lotRow } from '../../../_shared/stock/fixtures'
import type { ReleaseChecklist } from '../api'
import type { MovesPart } from '../shared/parts'

/**
 * Made-up lots for the design cases of Lots & traceability (SCR-201, SCR-201-record) and the hides' lot links: a
 * released nappa lot with Cr VI 1,2 < 3 mg/kg, one in quarantine waiting for its result, a suede lot that failed Cr VI
 * (blocked), a lining lot, a protector lot (PPE component), an opening-stock lot and a rejected one. Nothing here is a
 * real company, supplier, customer, person or number. Design-only: no `designScreen` here.
 */

export const LOT_ROWS: LotRow[] = [
  lotRow({ id: LOTS.nappa.id, code: LOTS.nappa.code }),
  lotRow({
    id: LOTS.nappaQuarantine.id,
    code: LOTS.nappaQuarantine.code,
    supplierLotRef: 'CD-26-0433',
    dyeBatch: 'TB-7790',
    shade: 'B',
    receivedAt: at(28, 10),
    receipt: RECEIPTS.b,
    qualityStatus: 'QUARANTINE',
    qualityDecidedAt: null,
    crVi: { required: true, status: 'PENDING', valueMgKg: null, limitMgKg: '3.000', evidence: null, testedOn: null },
    documents: 0,
    onHand: '386.4000',
    hides: 8,
    issuedTo: 0,
  }),
  lotRow({
    id: LOTS.suedeFail.id,
    code: LOTS.suedeFail.code,
    item: ITEMS.suede,
    colour: COLOURS.grey,
    supplierLotRef: 'CD-26-0398',
    dyeBatch: 'SC-1102',
    shade: 'A',
    receivedAt: at(9, 9),
    qualityStatus: 'BLOCKED',
    qualityNote: 'Cr VI oltre il limite',
    crVi: { required: true, status: 'FAIL', valueMgKg: '3.400', limitMgKg: '3.000', evidence: 'LOT_REPORT', testedOn: '2026-10-12' },
    documents: 1,
    onHand: '31.2000',
    hides: 6,
    issuedTo: 1,
  }),
  lotRow({
    id: LOTS.lining.id,
    code: LOTS.lining.code,
    item: ITEMS.lining,
    colour: COLOURS.black,
    supplier: SUPPLIERS.fabric,
    supplierLotRef: 'TE-5521',
    dyeBatch: null,
    shade: null,
    crVi: { required: false, status: 'NOT_REQUIRED', valueMgKg: null, limitMgKg: null, evidence: null, testedOn: null },
    documents: 1,
    onHand: '120.0000',
    hides: 0,
    issuedTo: 2,
  }),
  lotRow({
    id: LOTS.protector.id,
    code: LOTS.protector.code,
    item: ITEMS.protector,
    colour: null,
    supplier: SUPPLIERS.protector,
    supplierLotRef: 'PP-2026-118',
    dyeBatch: null,
    shade: null,
    receivedAt: at(27, 14),
    qualityStatus: 'QUARANTINE',
    qualityDecidedAt: null,
    crVi: { required: false, status: 'NOT_REQUIRED', valueMgKg: null, limitMgKg: null, evidence: null, testedOn: null },
    documents: 0,
    onHand: '48.0000',
    hides: 0,
    issuedTo: 0,
  }),
  lotRow({
    id: uid('8181', 6),
    code: 'LOT-D-000090',
    supplierLotRef: null,
    dyeBatch: 'TB-6610',
    receivedAt: at(1, 8, 0, 9),
    receipt: null,
    opening: true,
    crVi: { required: true, status: 'PASS', valueMgKg: '0.800', limitMgKg: '3.000', evidence: 'SUPPLIER_REPORT', testedOn: '2026-08-20' },
    documents: 1,
    onHand: '96.3000',
    hides: 2,
    issuedTo: 0,
  }),
  lotRow({
    id: uid('8181', 7),
    code: 'LOT-D-000088',
    supplierLotRef: 'CD-26-0301',
    qualityStatus: 'REJECTED',
    qualityNote: 'Ricevimento stornato',
    receivedAt: at(2, 10),
    crVi: { required: true, status: 'PENDING', valueMgKg: null, limitMgKg: '3.000', evidence: null, testedOn: null },
    documents: 0,
    onHand: '0.0000',
    hides: 0,
    issuedTo: 0,
  }),
]

export const LOT_COUNTS = { quarantine: 2, waitingCrVi: 1, crViFailed: 1, blocked: 1, rejected: 1, released: 3 }

export const lotOf = (id: string): LotRow => LOT_ROWS.find((row) => row.id === id)!

const SHIPMENT = { id: uid('9494', 1), number: 'SH-D-0007', status: 'SHIPPED', customer: { id: uid('9595', 1), code: 'MOTO-ESEMPIO', name: 'Moto Esempio S.r.l.' }, garments: 12 }

/** Where a lot's stock lies: leather in two places (a quarter at the cutting rack), other stock in one bin. */
function stockOf(row: LotRow): LotRecord['stock'] {
  const onHand = Number(row.onHand)
  if (onHand === 0) return []
  const held = (value: string) => (row.qualityStatus === 'RELEASED' ? '0.0000' : value)
  if (row.item.tracking !== 'HIDE') return [{ location: named(LOCATIONS.binA1), onHand: row.onHand, held: held(row.onHand), hides: 0 }]
  const rack = (Math.round(onHand * 2.5) / 10).toFixed(4)
  const store = (onHand - Number(rack)).toFixed(4)
  const rackHides = Math.max(1, Math.round(row.hides / 4))
  return [
    { location: named(LOCATIONS.binA1), onHand: store, held: held(store), hides: row.hides - rackHides },
    { location: named(LOCATIONS.cutting), onHand: rack, held: held(rack), hides: rackHides },
  ]
}

/** The released nappa lot's record: stock in two places, used by two work orders, one of them shipped. */
export function lotRecordOf(row: LotRow = LOT_ROWS[0]!, over: Partial<LotRecord> = {}): LotRecord {
  const used = row.issuedTo > 0
  return {
    lot: row,
    stock: stockOf(row),
    hides: { inStock: row.hides, consumed: row.item.tracking === 'HIDE' && used ? 3 : 0, scrapped: 0 },
    trace: {
      backward: {
        supplier: row.supplier,
        receipt: row.receipt ? { id: row.receipt.id, number: row.receipt.number, status: 'POSTED', receivedAt: row.receivedAt ?? at(14, 10), supplierDdtNumber: 'DDT 412/26', supplierDdtDate: '2026-10-13' } : null,
        purchaseOrder: row.receipt ? { id: uid('9696', 1), number: 'PO-D-0021', lineSeq: 10 } : null,
      },
      forward: used
        ? {
            workOrders: [
              { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, batchNumber: WORK_ORDERS.a.batchNumber, status: 'COMPLETED', issued: '146.2000', returned: '6.1000', atWorkOrder: '140.1000', hides: 3 },
              ...(row.issuedTo > 1 ? [{ id: WORK_ORDERS.b.id, number: WORK_ORDERS.b.number, batchNumber: WORK_ORDERS.b.batchNumber, status: 'IN_PROGRESS', issued: '48.8000', returned: '0.0000', atWorkOrder: '48.8000', hides: 1 }] : []),
            ],
            shipments: [SHIPMENT],
            customers: 1,
          }
        : { workOrders: [], shipments: [], customers: 0 },
    },
    moves: used ? 6 : 1,
    ...over,
  }
}

export const CHECKLIST_OPEN: ReleaseChecklist = {
  mode: 'RELEASE',
  ready: false,
  checks: [
    { code: 'STATE', state: 'OK', fix: null },
    { code: 'RECEIPT', state: 'OK', fix: null },
    { code: 'CR_VI', state: 'OPEN', fix: 'Record the result.' },
    { code: 'PPE_CERTIFICATE', state: 'NOT_NEEDED', fix: null },
    { code: 'SUPPLIER_DOCUMENTS', state: 'NOT_NEEDED', fix: null },
    { code: 'HOLD', state: 'NOT_NEEDED', fix: null },
    { code: 'RELEASER', state: 'OK', fix: null },
  ],
}
export const CHECKLIST_DONE: ReleaseChecklist = { ...CHECKLIST_OPEN, ready: true, checks: CHECKLIST_OPEN.checks.map((check) => (check.code === 'CR_VI' ? { ...check, state: 'OK', fix: null } : check)) }
export const CHECKLIST_RELEASED: ReleaseChecklist = { ...CHECKLIST_OPEN, ready: false, checks: CHECKLIST_OPEN.checks.map((check) => (check.code === 'STATE' ? { ...check, state: 'OPEN', fix: null } : check.code === 'CR_VI' ? { ...check, state: 'OK', fix: null } : check)) }

/** The moves of the released nappa lot, newest first (a receipt, a transfer, issues to two work orders, a remnant back). */
export function lotMoves(lot: LotRow = LOT_ROWS[0]!): MovesPart {
  const rows: LedgerRow[] = [
    ledgerRow(6, { reason: 'RETURN', lot: { id: lot.id, code: lot.code }, hide: { id: uid('8282', 3), code: 'HD-DEMO-0003' }, from: { kind: 'WORK_ORDER', location: null }, to: { kind: 'LOCATION', location: named(LOCATIONS.cutting) }, quantity: '6.1000', baseQuantity: '6.1000', delta: '6.1000', document: { type: 'WorkOrder', ...WORK_ORDERS.a }, postedBy: { audience: 'FLOOR', name: null, device: DEVICES.cut }, occurredAt: at(29, 11, 40) }),
    ledgerRow(5, { reason: 'ISSUE', lot: { id: lot.id, code: lot.code }, hide: { id: uid('8282', 4), code: 'HD-DEMO-0004' }, from: { kind: 'LOCATION', location: named(LOCATIONS.cutting) }, to: { kind: 'WORK_ORDER', location: null }, quantity: '48.8000', baseQuantity: '48.8000', delta: '-48.8000', document: { type: 'WorkOrder', ...WORK_ORDERS.b }, postedBy: { audience: 'FLOOR', name: null, device: DEVICES.cut }, occurredAt: at(29, 10, 5) }),
    ledgerRow(4, { reason: 'ISSUE', lot: { id: lot.id, code: lot.code }, hide: { id: uid('8282', 3), code: 'HD-DEMO-0003' }, from: { kind: 'LOCATION', location: named(LOCATIONS.cutting) }, to: { kind: 'WORK_ORDER', location: null }, quantity: '49.4000', baseQuantity: '49.4000', delta: '-49.4000', document: { type: 'WorkOrder', ...WORK_ORDERS.a }, postedBy: { audience: 'FLOOR', name: null, device: DEVICES.cut }, occurredAt: at(28, 15, 20) }),
    ledgerRow(3, { reason: 'TRANSFER', lot: { id: lot.id, code: lot.code }, from: { kind: 'LOCATION', location: named(LOCATIONS.binA1) }, to: { kind: 'LOCATION', location: named(LOCATIONS.cutting) }, quantity: '98.2000', baseQuantity: '98.2000', delta: '0.0000', postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, occurredAt: at(28, 9, 0) }),
    ledgerRow(2, { reason: 'ADJUSTMENT', lot: { id: lot.id, code: lot.code }, hide: { id: uid('8282', 8), code: 'HD-DEMO-0008' }, from: { kind: 'LOCATION', location: named(LOCATIONS.binA1) }, to: { kind: 'ADJUSTMENT', location: null }, quantity: '0.6000', baseQuantity: '0.6000', delta: '-0.6000', note: 'Area misurata di nuovo: 0,6 ft² in meno', postedBy: { audience: 'OFFICE', name: PEOPLE.marco, device: null }, occurredAt: at(20, 16, 10) }),
    ledgerRow(1, { reason: 'RECEIPT', lot: { id: lot.id, code: lot.code }, from: { kind: 'SUPPLIER', location: null }, to: { kind: 'LOCATION', location: named(LOCATIONS.receiving) }, quantity: '412.5000', baseQuantity: '412.5000', delta: '412.5000', document: { type: 'GoodsReceipt', ...RECEIPTS.a }, postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, occurredAt: at(14, 10) }),
  ]
  return { rows, closing: '319.8000', more: false }
}
