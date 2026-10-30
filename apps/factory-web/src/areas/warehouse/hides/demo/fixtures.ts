import { formatScanId } from '@nexus/factory-domain/numbering/scan-id'
import type { CutRow, HideRecord, HideRow, HidesPage, LedgerRow, PrinterOption } from '../../../_shared/stock/api'
import { at, COLOURS, DEVICES, hideRow, ITEMS, LOCATIONS, LOTS, named, PEOPLE, RECEIPTS, SITE, SUPPLIERS, uid, WORK_ORDERS, ledgerRow } from '../../../_shared/stock/fixtures'
import type { MovesPart } from '../../lots/shared/parts'
import type { PrintDialog } from '../model'

/**
 * Made-up hides for the design cases of Hides (SCR-200, SCR-200-record): tags as this factory prints them (an invented
 * tenant tag "DM"), a released nappa lot's hides in stock, partly cut at the cutting table, a remnant, one consumed,
 * three of a lot in quarantine and two suede hides of a lot whose Cr VI failed; cuts by an invented work order, the
 * moves of one hide, label printers. Nothing here is a real company, person, tag or number. Design-only.
 */

export const tag = (n: number): string => formatScanId({ type: 'HIDE', tenantTag: 'DM', ref: 4200 + n })

const quarantineLot = { id: LOTS.nappaQuarantine.id, code: LOTS.nappaQuarantine.code, qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', dyeBatch: 'TB-7790', shade: 'B' } as const
const suedeLot = { id: LOTS.suedeFail.id, code: LOTS.suedeFail.code, qualityStatus: 'BLOCKED', crViStatus: 'FAIL', dyeBatch: 'SC-1102', shade: 'A' } as const

const one = (n: number, over: Partial<HideRow> = {}): HideRow => hideRow(n, { code: tag(n), ...over })

export const HIDE_ROWS: HideRow[] = [
  one(1),
  one(2, { location: named(LOCATIONS.binA2) }),
  one(3, { state: 'PARTLY_CUT', onHand: '0.0000', left: '23.3000', location: null }),
  one(4, { state: 'REMNANT', onHand: '6.1000', left: '6.1000', location: named(LOCATIONS.cutting), defects: 'Ritaglio dal fianco destro' }),
  one(5, { state: 'CONSUMED', onHand: '0.0000', left: '0.0000', location: null }),
  one(6, { grade: 'B', defects: 'Due fori di zecca vicino alla schiena; vena sul collo' }),
  one(7, { lot: quarantineLot, shade: 'B', receivedAt: at(28, 10), location: named(LOCATIONS.quarantine) }),
  one(8, { lot: quarantineLot, shade: 'B', receivedAt: at(28, 10), location: named(LOCATIONS.quarantine) }),
  one(9, { lot: quarantineLot, shade: 'B', receivedAt: at(28, 10), location: named(LOCATIONS.quarantine), grade: 'C' }),
  one(10, { item: ITEMS.suede, colour: COLOURS.grey, lot: suedeLot, area: '5.2000', areaUom: 'M2', baseArea: '5.2000', onHand: '5.2000', left: '5.2000', thicknessMm: '1.00', receivedAt: at(9, 9) }),
  one(11, { item: ITEMS.suede, colour: COLOURS.grey, lot: suedeLot, area: '480.0000', areaUom: 'DM2', baseArea: '4.8000', onHand: '4.8000', left: '4.8000', thicknessMm: '1.00', receivedAt: at(9, 9) }),
]

export const HIDE_COUNTS: HidesPage['counts'] = {
  full: { hides: 8, area: [{ uom: 'FT2', quantity: '303.6000' }, { uom: 'M2', quantity: '10.0000' }] },
  partlyCut: { hides: 1, area: [{ uom: 'FT2', quantity: '23.3000' }] },
  remnant: { hides: 1, area: [{ uom: 'FT2', quantity: '6.1000' }] },
  quarantine: { hides: 3, area: [{ uom: 'FT2', quantity: '147.9000' }] },
  consumed: { hides: 1, area: [{ uom: 'FT2', quantity: '54.5000' }] },
}
export const HIDE_MATCHING: HidesPage['matching'] = { hides: 10, area: [{ uom: 'FT2', quantity: '333.0000' }, { uom: 'M2', quantity: '10.0000' }] }

export const PRINTERS: PrinterOption[] = [
  { id: uid('9797', 1), siteId: SITE.id, code: 'ZPL-MAG', name: 'Etichettatrice magazzino', kind: 'LABEL_ZPL', status: 'ACTIVE' },
  { id: uid('9797', 2), siteId: SITE.id, code: 'ZPL-TAG', name: 'Etichettatrice taglio', kind: 'LABEL_ZPL', status: 'ACTIVE' },
]

export function printDialog(hideIds: readonly string[], over: Partial<PrintDialog> = {}): PrintDialog {
  return { hideIds, printers: { value: PRINTERS, problem: null }, printerId: PRINTERS[0]!.id, copies: 1, busy: false, prints: null, problem: null, ...over }
}
const job = (n: number, status: 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED') => ({ id: uid('9898', n), status, version: 1, lastError: status === 'FAILED' ? 'printer offline' : null })
export const printedDialog = (hides: readonly HideRow[]): PrintDialog =>
  printDialog(
    hides.map((hide) => hide.id),
    {
      prints: hides.map((hide, index) => ({ hideId: hide.id, code: hide.code, job: job(index + 1, index === 0 ? 'PRINTED' : index === 1 ? 'SENT' : 'FAILED'), problem: null })),
    },
  )

// ---- one hide's record ---------------------------------------------------------------------------------------------------------

const cut = (n: number, over: Partial<CutRow> = {}): CutRow => ({
  id: uid('8484', n),
  at: at(29, 9, n * 7),
  deviceTime: at(29, 9, n * 7 - 1),
  workOrder: WORK_ORDERS.a,
  areaUsed: '16.0000',
  remnantArea: '0.0000',
  uom: 'FT2',
  baseAreaUsed: '16.0000',
  baseRemnantArea: '0.0000',
  pieces: 4,
  station: { id: uid('9999', 1), code: 'CUT-01', name: 'Tavolo taglio 1' },
  device: DEVICES.cut,
  cutBy: null,
  note: null,
  reversalOfId: null,
  reversedById: null,
  ...over,
})

/** Hide 3: issued whole to WO-D-0031 at the cutting table, two cuts (one entered twice and reversed), 23,3 ft² not cut yet. */
export function hideRecordOf(row: HideRow = HIDE_ROWS[2]!, over: Partial<HideRecord> = {}): HideRecord {
  const measured = row.baseArea
  const partly = row.state === 'PARTLY_CUT'
  const consumed = row.state === 'CONSUMED'
  const remnant = row.state === 'REMNANT'
  const cuts: CutRow[] = partly
    ? [cut(1), cut(2, { areaUsed: '12.6000', baseAreaUsed: '12.6000', pieces: 3, reversedById: uid('8484', 3) }), cut(3, { areaUsed: '12.6000', baseAreaUsed: '12.6000', pieces: 0, reversalOfId: uid('8484', 2), note: 'Inserito sul fascio sbagliato' }), cut(4, { areaUsed: '12.6000', baseAreaUsed: '12.6000', pieces: 3 })]
    : consumed
      ? [cut(1, { areaUsed: '30.0000', baseAreaUsed: '30.0000', pieces: 8 }), cut(2, { areaUsed: '24.5000', baseAreaUsed: '24.5000', pieces: 6 })]
      : remnant
        ? [cut(5, { areaUsed: '47.1000', baseAreaUsed: '47.1000', remnantArea: '6.1000', baseRemnantArea: '6.1000', pieces: 12 })]
        : []
  const cutArea = partly ? '28.6000' : consumed ? '54.5000' : remnant ? '47.1000' : '0.0000'
  return {
    hide: row,
    lot: {
      id: row.lot.id,
      code: row.lot.code,
      qualityStatus: row.lot.qualityStatus,
      qualityNote: row.lot.qualityStatus === 'BLOCKED' ? 'Cr VI oltre il limite' : null,
      crVi: { status: row.lot.crViStatus, valueMgKg: row.lot.crViStatus === 'PASS' ? '1.200' : row.lot.crViStatus === 'FAIL' ? '3.400' : null, limitMgKg: '3.000', testedOn: row.lot.crViStatus === 'PENDING' ? null : '2026-10-15' },
      supplier: SUPPLIERS.tannery,
      supplierLotRef: 'CD-26-0412',
      receipt: RECEIPTS.a,
    },
    area: { measured, cut: cutArea, remnant: remnant ? '6.1000' : '0.0000', onHand: row.onHand, uom: row.item.baseUom },
    cuts,
    stationOnly: true,
    ...over,
  }
}

export function hideMoves(row: HideRow = HIDE_ROWS[2]!): MovesPart {
  const hide = { id: row.id, code: row.code }
  const lot = { id: row.lot.id, code: row.lot.code }
  const rows: LedgerRow[] = [
    ledgerRow(13, { reason: 'ISSUE', lot, hide, from: { kind: 'LOCATION', location: named(LOCATIONS.cutting) }, to: { kind: 'WORK_ORDER', location: null }, quantity: row.baseArea, baseQuantity: row.baseArea, delta: `-${row.baseArea}`, document: { type: 'WorkOrder', ...WORK_ORDERS.a }, postedBy: { audience: 'FLOOR', name: null, device: DEVICES.cut }, occurredAt: at(29, 9, 1) }),
    ledgerRow(12, { reason: 'TRANSFER', lot, hide, from: { kind: 'LOCATION', location: named(LOCATIONS.binA1) }, to: { kind: 'LOCATION', location: named(LOCATIONS.cutting) }, quantity: row.baseArea, baseQuantity: row.baseArea, delta: '0.0000', postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, occurredAt: at(28, 9) }),
    ledgerRow(11, { reason: 'RECEIPT', lot, hide, from: { kind: 'SUPPLIER', location: null }, to: { kind: 'LOCATION', location: named(LOCATIONS.receiving) }, quantity: row.area, uom: row.areaUom, baseQuantity: row.baseArea, delta: row.baseArea, document: { type: 'GoodsReceipt', ...RECEIPTS.a }, postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null }, occurredAt: at(14, 10) }),
  ]
  return { rows, closing: row.onHand, more: false }
}
