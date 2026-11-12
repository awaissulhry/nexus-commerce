import type { SupplyLate, SupplyLateList } from './api'
import { supplyLateCan } from './model'
import type { SupplyLateSlot } from './use-supply-late'

/**
 * Made-up supply-too-late data for SCR-125's design cases (B-W2b-336): an invented purchase order ("PO-DEMO-0091"), suppliers
 * ("Conceria Demo", "Pellami Esempio"), work orders, orders and customers. Nothing here is a real company, person or number.
 * Exports no designScreen: the cases live in the Exceptions fixtures (one screen, one file).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE_ID = '0190f0e2-1111-7000-8000-000000000001'

/** The Exceptions fixtures' supply-too-late row (row 2: PO-DEMO-0091 line 10, 8 days late). */
export const SUPPLY_LATE_ROW_ID = uid('8801', 2)

export const SUPPLY_LATE: SupplyLate = {
  id: SUPPLY_LATE_ROW_ID,
  siteId: SITE_ID,
  status: 'ACKNOWLEDGED',
  version: 2,
  purchaseOrderLineId: uid('5802', 91),
  record: { type: 'PurchaseOrder', id: uid('5801', 91) },
  foundBy: 'RUN',
  supplyDate: '2026-11-20',
  needDate: '2026-11-12',
  overdue: false,
  daysLate: 8,
  ordersAffected: 2,
  firstSeenAt: '2026-11-14T05:02:00.000Z',
  lastSeenAt: '2026-11-16T05:02:00.000Z',
  fixes: {
    chase: {
      purchaseOrder: { id: uid('5801', 91), number: 'PO-DEMO-0091', status: 'CONFIRMED' },
      supplier: { id: uid('4242', 1), code: 'S-DEMO-01', name: 'Conceria Demo' },
      line: { id: uid('5802', 91), seq: 10, item: 'DEMO-FOD-02' },
      supplyDate: '2026-11-20',
      needDate: '2026-11-12',
      daysLate: 8,
    },
    move: [
      { workOrder: { id: uid('9999', 221), number: 'WO-DEMO-0221', status: 'RELEASED', dueDate: '2026-11-27' }, plannedStart: '2026-11-17T07:00:00.000Z', plannedFinish: '2026-11-26T15:00:00.000Z', materialState: 'LATE', earliestStart: '2026-11-21', inTime: false },
      { workOrder: { id: uid('9999', 224), number: 'WO-DEMO-0224', status: 'RELEASED', dueDate: '2026-12-04' }, plannedStart: '2026-11-24T07:00:00.000Z', plannedFinish: '2026-12-02T15:00:00.000Z', materialState: 'OK', earliestStart: '2026-11-21', inTime: true },
    ],
    buyElsewhere: [
      { supplier: { id: uid('4242', 2), code: 'S-DEMO-02', name: 'Pellami Esempio' }, sourceId: uid('4343', 2), leadTimeDays: 3, arrives: '2026-11-19', inTime: false, requirementId: uid('5502', 2) },
      { supplier: { id: uid('4242', 3), code: 'S-DEMO-03', name: 'Tessuti Demo' }, sourceId: uid('4343', 3), leadTimeDays: null, arrives: null, inTime: null, requirementId: uid('5502', 2) },
    ],
    repromise: [
      { orderLine: { id: uid('5151', 3), seq: 10 }, order: { id: uid('5050', 3), number: 'SO-DEMO-1043', status: 'IN_PRODUCTION' }, customer: { id: uid('4141', 1), code: 'C-DEMO-01', name: 'Moto Demo Srl' }, current: '2026-12-04', finish: '2026-12-10', risk: 'AT_RISK', waiting: null, may: true },
      { orderLine: { id: uid('5151', 4), seq: 20 }, order: { id: uid('5050', 4), number: 'SO-DEMO-1044', status: 'CONFIRMED' }, customer: { id: uid('4141', 3), code: 'C-DEMO-03', name: 'Team Corse Demo' }, current: '2026-12-11', finish: '2026-12-15', risk: 'AT_RISK', waiting: { proposalId: uid('8080', 1) }, may: true },
    ],
  },
}

export const SUPPLY_LATE_FOUND_BY_DATE: SupplyLate = { ...SUPPLY_LATE, foundBy: 'SUPPLIER_DATE', status: 'NEW' }
export const SUPPLY_LATE_BARE: SupplyLate = { ...SUPPLY_LATE, fixes: { ...SUPPLY_LATE.fixes!, move: [], buyElsewhere: [], repromise: [] } }

const LIST: SupplyLateList = { site: { id: SITE_ID, code: 'ST1', name: 'Stabilimento demo' }, asOf: '2026-11-16T08:12:00.000Z', tile: 2, exceptions: [SUPPLY_LATE] }

/** The slot as the page fills it: the tile read, nothing open. */
export function supplyLateSlot(permissions: readonly string[], over: Partial<SupplyLateSlot> = {}): SupplyLateSlot {
  return { can: supplyLateCan(permissions), list: { status: 'ready', value: LIST }, detail: null, checking: false, checked: null, problem: null, ...over }
}

/** The slot with the supply-too-late detail open (its fixes read). */
export const openSlot = (permissions: readonly string[], value: SupplyLate = SUPPLY_LATE, over: Partial<SupplyLateSlot> = {}): SupplyLateSlot =>
  supplyLateSlot(permissions, { detail: { id: value.id, loaded: { status: 'ready', value } }, ...over })
