import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, inShell, panels, panelsModel, PREFIX, TIME_ZONE, type Role } from '../../../_shared/buying/fixtures'
import { part } from '../../../_shared/buying/model'
import type { LotWithHides, Receipt } from '../api'
import { DDT_PHOTOS, DISCREPANCY_COUNTS, dailyModel } from '../demo/daily/fixtures'
import { LOTS, lotOf, receipt } from '../demo/fixtures'
import type { ReceiptRecordModel } from '../model'
import { ReceiptRecordView } from './view/ReceiptRecordView'

/**
 * SCR-062 — the lots of a goods receipt and their quality state (with SCR-061's hides one by one, read back) with
 * made-up data only: a leather lot in quarantine waiting for its chromium VI result (limit 3 mg/kg), its nine hides with
 * tag, tannery number, area, grade, thickness, shade, defects and what lies of them now; a protector lot released at
 * receipt; a lot held by the receiver, a certified PPE component waiting for its certificate, a lot rejected by a
 * reversal, a Cr VI failure; the hides selected for export; and the part's states. Roles: Warehouse, Buyer (with values),
 * Read-only.
 */

export interface LotsCase {
  role: Role
  record: ReceiptRecordModel
}

export function receiptCase(role: Role, value: Receipt = receipt(), over: Partial<ReceiptRecordModel> = {}): { role: Role; record: ReceiptRecordModel } {
  const can = canOf(role)
  // B-W2a-63: every receipt case carries the W2a parts (Documents check, Discrepancies) as the real page does.
  const daily = over.daily ?? dailyModel(role)
  const counted = { ...value, discrepancies: value.discrepancies.count > 0 ? value.discrepancies : DISCREPANCY_COUNTS, ddtPhotos: value.ddtPhotos.length > 0 ? value.ddtPhotos : DDT_PHOTOS }
  const shown = can.cost ? counted : { ...counted, value: undefined, lines: counted.lines.map((line) => ({ ...line, value: undefined })) }
  return {
    role,
    record: { prefix: PREFIX, can, tab: 'lines', receipt: { status: 'ready', value: shown }, lots: part(LOTS), live: 'live', dockOpen: false, changed: null, notice: null, notes: null, busy: false, dialog: null, dialogProblem: null, panelsPreview: panelsModel('GoodsReceipt', value.id, value.number), timeZone: TIME_ZONE, ...over, daily },
  }
}

export function ReceiptDesign({ model }: { model: { role: Role; record: ReceiptRecordModel } }) {
  const value = model.record.receipt.status === 'ready' ? model.record.receipt.value : null
  return inShell(`/warehouse/receipts/${value?.id ?? 'x'}`, createElement(ReceiptRecordView, { model: model.record, panels: model.record.tab === 'activity' || model.record.dockOpen ? panels('GoodsReceipt', value?.id ?? 'x', value?.number ?? '') : null }), model.role)
}

const lotsWith = (first: Partial<LotWithHides>): LotWithHides[] => [{ ...LOTS[0]!, ...first }, LOTS[1]!]
const lotsCase = (role: Role, lots: LotWithHides[] = LOTS, over: Partial<ReceiptRecordModel> = {}) => receiptCase(role, receipt(), { tab: 'lots', lots: part(lots), ...over })

export const designScreen = defineDesignScreen<LotsCase>({
  screen: 'SCR-062',
  title: 'Lots & hides of a receipt (quality hold, hides one by one)',
  view: ReceiptDesign,
  cases: [
    { id: 'lots', label: 'A leather lot in quarantine (Cr VI pending, limit 3 mg/kg) with its nine hides; a protector lot released at receipt', model: lotsCase('warehouse'), note: 'The lot code opens the lot record in Warehouse › Lots & traceability (its stock and trace); the quality step releases it in Compliance › Tests & substances, which that record links.' },
    { id: 'held', label: 'Held by the receiver for a quality check', model: lotsCase('warehouse', lotsWith({ requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', holds: ['QUALITY_HOLD'] })) },
    { id: 'ppe', label: 'A certified PPE component: its certificate is checked first', model: lotsCase('warehouse', [LOTS[0]!, { ...LOTS[1]!, ...lotOf(45, { code: 'LA-000045', qualityStatus: 'QUARANTINE', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', crViLimitMgKg: null, holds: ['PPE_CERTIFICATE'], baseQuantity: '24.0000', hideCount: 0, dyeBatch: null, shade: null }), lineSeq: 20, hides: [], onHand: '24.0000' }]) },
    { id: 'released', label: 'Released by the quality step (Cr VI pass)', model: lotsCase('warehouse', lotsWith({ qualityStatus: 'RELEASED', crViStatus: 'PASS', holds: [] })) },
    { id: 'cr-vi-failed', label: 'Cr VI failed: blocked', model: lotsCase('warehouse', lotsWith({ qualityStatus: 'BLOCKED', crViStatus: 'FAIL' })) },
    { id: 'rejected', label: 'Rejected by the reversal of its receipt', model: receiptCase('warehouse', receipt({ status: 'REVERSED', reversedAt: '2026-10-29T10:05:00.000Z', reversalReason: 'Booked against the wrong order', reversal: null }), { tab: 'lots', lots: part(lotsWith({ qualityStatus: 'REJECTED', onHand: '0.0000', hides: LOTS[0]!.hides.map((hide) => ({ ...hide, onHand: '0.0000' })) })) }) },
    { id: 'partly-cut', label: 'Some hides partly cut (what lies of them now)', model: lotsCase('warehouse', lotsWith({ qualityStatus: 'RELEASED', crViStatus: 'PASS', holds: [], hides: LOTS[0]!.hides.map((hide, index) => (index < 3 ? { ...hide, state: index === 0 ? 'CONSUMED' : 'PARTLY_CUT', onHand: index === 0 ? '0.0000' : '9.4000' } : hide)) })) },
    { id: 'hides-selected', label: 'Hides selected: Export N (CSV)', model: lotsCase('warehouse', LOTS, { selected: LOTS[0]!.hides.slice(0, 4).map((hide) => hide.id) }) },
    { id: 'buyer', label: 'Buyer: the same, values on the Lines tab only', model: lotsCase('buyer') },
    { id: 'read-only', label: 'Read-only: the lot code still opens the lot record (inventory.stock.view); its quality decisions need quality.lots.view', model: receiptCase('readOnly', receipt(), { tab: 'lots', can: { ...canOf('readOnly'), lots: false } }) },
    { id: 'no-lots', label: 'A receipt counted by quantity only (no lots)', model: lotsCase('warehouse', []) },
    { id: 'loading', label: 'The lots loading', model: lotsCase('warehouse', LOTS, { lots: { value: null, problem: null } }) },
    { id: 'error', label: "The lots couldn't be read", model: lotsCase('warehouse', LOTS, { lots: { value: null, problem: 'problem.offline' } }) },
  ],
})
