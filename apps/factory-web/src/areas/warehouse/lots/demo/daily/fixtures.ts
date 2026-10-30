import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import type { PickerReason } from '../../../../_shared/reasons/api'
import { ROLE_PERMISSIONS, SITE, uid, WORK_ORDERS, at, type RoleCase } from '../../../../_shared/stock/fixtures'
import { stockCan, type StockCan } from '../../../../_shared/stock/model'
import type { HoldRow, WorkOrderOption } from '../../../stock/daily/api'
import type { ReserveDialogModel, ReserveHide, WriteOffDialogModel } from '../../../stock/daily/dialog-model'
import { blankWriteOff, type HoldFact, type WriteOffTarget } from '../../../stock/daily/model'
import { dailyCan, type DailyCan } from '../../shared/daily'

/**
 * Made-up every-day data for the design cases of Hides (SCR-200) and Lots & traceability (SCR-201) (B-W2a-64): the
 * abilities per role (with a production manager beside the shared role cases), HOLD and WRITE_OFF reasons in both
 * languages, quality holds on a lot and a hide, open work orders to reserve hides for, and the every-day dialogs' models.
 * Nothing here is a real company, person or number. Design-only (only fixtures and tests import it).
 */

export const dailyFor = (role: RoleCase): DailyCan => dailyCan(ROLE_PERMISSIONS[role])

/** A production manager (reserves, puts on hold, sees work orders; no release, no scrap of lots by hand). */
const PM_PERMISSIONS = [...(templateOf('production_manager')?.permissions ?? []), 'home.view']
export const PM_CAN: StockCan = stockCan(PM_PERMISSIONS)
export const PM_DAILY: DailyCan = dailyCan(PM_PERMISSIONS)

const reason = (list: 'HOLD' | 'WRITE_OFF', n: number, code: string, labelIt: string, labelEn: string, needsDetail = false): PickerReason => ({
  id: uid('7575', n),
  list,
  code,
  labelIt,
  labelEn,
  labelI18n: {},
  icon: null,
  colour: null,
  needsDetail,
  sortOrder: n,
})

export const HOLD_REASONS: PickerReason[] = [
  reason('HOLD', 1, 'QUALITY_CHECK', 'Controllo qualità', 'Quality check'),
  reason('HOLD', 2, 'SUSPECT_DEFECT', 'Difetto sospetto', 'Suspected defect'),
  reason('HOLD', 3, 'CUSTOMER_COMPLAINT', 'Reclamo cliente', 'Customer complaint', true),
]
export const WRITE_OFF_REASONS: PickerReason[] = [
  reason('WRITE_OFF', 11, 'DAMAGED', 'Danneggiato', 'Damaged'),
  reason('WRITE_OFF', 12, 'EXPIRED', 'Scaduto', 'Expired'),
  reason('WRITE_OFF', 13, 'OBSOLETE', 'Obsoleto', 'Obsolete'),
  reason('WRITE_OFF', 14, 'OTHER', 'Altro', 'Other', true),
]

export const holdFact = (n: number, subjectType: 'Lot' | 'Hide', reasonCode = 'QUALITY_CHECK', placedAt = at(29, 15)): HoldFact => ({ holdId: uid('7676', n), subjectType, reasonCode, placedAt })

export function holdRow(n: number, over: Partial<HoldRow> & Pick<HoldRow, 'subjectType' | 'subjects'>): HoldRow {
  return {
    id: uid('7676', n),
    siteId: SITE.id,
    status: 'ACTIVE',
    quantity: null,
    reasonCode: 'QUALITY_CHECK',
    reasonNote: null,
    sourceType: null,
    placedAt: at(29, 15),
    overdue: false,
    ageDays: 1,
    ncrId: null,
    releasedAt: null,
    closedAt: null,
    version: 1,
    ...over,
  }
}

export const WORK_ORDER_OPTIONS: WorkOrderOption[] = [
  { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, status: 'RELEASED', siteId: SITE.id, styleCode: 'DEMO-GIA-01', styleName: 'Giacca moto Demo', dueDate: '2026-11-12', pieces: 24 },
  { id: WORK_ORDERS.b.id, number: WORK_ORDERS.b.number, status: 'IN_PROGRESS', siteId: SITE.id, styleCode: 'DEMO-GIA-02', styleName: 'Giacca touring Demo', dueDate: '2026-11-20', pieces: 12 },
]

export function reserveDialog(hides: ReserveHide[], over: Partial<ReserveDialogModel> = {}): ReserveDialogModel {
  return {
    siteId: SITE.id,
    hides,
    canSeeWorkOrders: true,
    query: '',
    workOrders: { value: WORK_ORDER_OPTIONS, problem: null },
    workOrderId: null,
    note: '',
    posting: false,
    problem: null,
    done: null,
    timeZone: 'Europe/Rome',
    ...over,
  }
}

export function writeOffDialog(target: WriteOffTarget, over: Partial<WriteOffDialogModel> = {}): WriteOffDialogModel {
  return {
    target,
    draft: blankWriteOff(),
    reasons: { value: WRITE_OFF_REASONS, problem: null },
    withCost: false,
    canPhoto: true,
    canNcr: true,
    posting: false,
    problem: null,
    done: null,
    prefix: '/w/DEMO',
    ...over,
  }
}
