import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import type { PickerReason } from '../../../../_shared/reasons/api'
import type { ReleaseCheck, WorkOrder } from '../../../_shared/api'
import { releaseCheck, workOrder } from '../../../_shared/fixtures'
import type { Availability, Finished, Hold, HoldRecord, ReadinessRow, ScrapRow, Yield } from '../api'
import { dailyCan, NO_DAILY, type DailyCan, type DailyModel } from '../model'

/**
 * Made-up data for the W2a design cases of the work order screens (B-W2a-46): an invented plant "STAB-N", invented hide
 * and lot codes, a hold placed by an office user known by id only. Never real business data; no person's name, no money.
 * The abilities come from factory-domain's role templates: the production manager (holds, finished to stock, reserve,
 * scrap), the quality inspector (releases holds), the floor supervisor, sales.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

export type DailyRole = 'manager' | 'quality' | 'supervisor' | 'sales' | 'owner'
const TEMPLATE: Readonly<Record<DailyRole, string>> = { manager: 'production_manager', quality: 'quality_inspector', supervisor: 'floor_supervisor', sales: 'sales', owner: 'production_manager' }

export function demoCan(role: DailyRole): DailyCan {
  const permissions = [...(templateOf(TEMPLATE[role])?.permissions ?? [])]
  return dailyCan(role === 'owner' ? [...permissions, 'quality.holds.release'] : permissions)
}

const reason = (n: number, code: string, labelIt: string, labelEn: string, needsDetail = false): PickerReason => ({ id: uid('4646', n), list: 'HOLD', code, labelIt, labelEn, labelI18n: {}, icon: null, colour: null, needsDetail, sortOrder: n * 10 })
export const HOLD_REASONS: PickerReason[] = [
  reason(1, 'QUALITY_CHECK', 'Controllo qualità', 'Quality check'),
  reason(2, 'CUSTOMER_REQUEST', 'Richiesta del cliente', 'Customer request'),
  reason(3, 'SUPPLIER_CHECK', 'Verifica fornitore', 'Supplier check'),
  reason(4, 'OTHER', 'Altro', 'Other', true),
]

const WO = workOrder('IN_PROGRESS')

export const HOLD: Hold = {
  id: uid('4747', 1),
  siteId: WO.siteId,
  status: 'ACTIVE',
  subjectType: 'WorkOrder',
  subjects: [{ id: WO.id, label: WO.number, state: 'ON_HOLD' }],
  reasonCode: 'QUALITY_CHECK',
  reasonNote: 'Campione cuciture fuori tolleranza',
  placedAt: at(28, 14, 20),
  placedBy: { kind: 'USER', userId: uid('5151', 9) },
  expectedReleaseOn: '2026-11-02',
  overdue: false,
  ageDays: 2,
  ncrId: null,
  releasedAt: null,
  version: 1,
}

export const HOLD_RECORD: HoldRecord = {
  hold: HOLD,
  release: {
    checks: [
      { key: 'ACTIVE', ok: true, words: '' },
      { key: 'NOT_PLACER', ok: true, words: '' },
      { key: 'NOT_MAKER', ok: true, words: '' },
      { key: 'STATEMENT', ok: false, words: '' },
    ],
    releasable: false,
    mayRelease: true,
  },
}

/** The work order ON_HOLD (held from IN_PROGRESS under the hold above). */
export function heldWorkOrder(from: 'DRAFT' | 'IN_PROGRESS' = 'IN_PROGRESS'): WorkOrder {
  const base = workOrder(from === 'DRAFT' ? 'DRAFT' : 'IN_PROGRESS')
  return { ...base, status: 'ON_HOLD', nextActions: [], hold: { reason: 'Quality check: Campione cuciture fuori tolleranza', at: HOLD.placedAt, fromStatus: from, recordType: 'QualityHold', recordId: HOLD.id } }
}

export const READINESS: ReadinessRow = {
  workOrderId: WO.id,
  word: 'NOT_BOOKED',
  date: null,
  open: 1,
  materials: WO.spec.materials.map((material, index) => ({ itemId: material.itemId, itemColourId: material.itemColourId ?? null, word: index === 1 ? 'NOT_BOOKED' : index === 0 ? 'EXPECTED' : 'RECEIVED', date: index === 0 ? '2026-11-04' : null })),
  asOf: '2026-10-30',
}

export const FINISHED: Finished = {
  workOrderId: WO.id,
  number: WO.number,
  status: 'IN_PROGRESS',
  kind: 'SIZE_GRID',
  version: WO.version,
  siteCode: WO.site.code,
  blockers: [],
  reportable: true,
  places: [
    { id: uid('3434', 1), code: 'PF-01', name: 'Prodotti finiti', kind: 'FINISHED_GOODS', parentId: null, status: 'ACTIVE' },
    { id: uid('3434', 2), code: 'PF-01-A', name: 'Scaffale A', kind: 'BIN', parentId: uid('3434', 1), status: 'ACTIVE' },
  ],
  defaultLocationId: uid('3434', 1),
  cells: WO.cells.map((cell, index) => {
    const released = Math.max(0, cell.quantity - 2 - (index % 2))
    const inStock = index === 0 ? 2 : 0
    return { cellId: cell.id, colourwayCode: cell.colourwayCode, size: cell.size, sku: `DEMO-JKT-01-${cell.colourwayCode}-${cell.size}`, quantity: cell.quantity, netReleased: released, onShipments: 0, heldSerials: 0, inStock, canReport: Math.max(0, released - inStock) }
  }),
  garments: { pieces: 0, netReleased: 0, inStock: 0, canReport: 0 },
  allInStock: false,
  tracking: 'BATCH',
  reports: [{ id: uid('3535', 1), at: at(29, 16, 5), locationCode: 'PF-01', pieces: 2, open: 2, note: null, reversed: null }],
}
FINISHED.garments = FINISHED.cells.reduce((sum, cell) => ({ pieces: sum.pieces + cell.quantity, netReleased: sum.netReleased + cell.netReleased, inStock: sum.inStock + cell.inStock, canReport: sum.canReport + cell.canReport }), { pieces: 0, netReleased: 0, inStock: 0, canReport: 0 })

export const NOTHING_TO_FINISH: Finished = { ...FINISHED, reportable: false, cells: FINISHED.cells.map((cell) => ({ ...cell, netReleased: 0, inStock: 0, canReport: 0 })), garments: { ...FINISHED.garments, netReleased: 0, inStock: 0, canReport: 0 }, reports: [] }

const figures = (used: string, pattern: string, remnant: string, waste: string, wastePct: string, yieldPct: string, plannedPct = '82.00') => ({ used, unmatched: '0.0000', pattern, remnant, waste, wastePct, yieldPct, plannedPct, variancePct: (Number(yieldPct) - Number(plannedPct)).toFixed(2) })
export const YIELD: Yield = {
  plannedSource: 'STYLE',
  overall: figures('412.0000', '334.3000', '22.4000', '55.3000', '13.42', '81.14'),
  hides: [
    { hide: { id: uid('2626', 1), code: 'H-DEMO-0141', grade: 'A', shade: '2', state: 'CONSUMED' }, lot: { id: uid('2727', 1), code: 'L-DEMO-0042', supplierLotRef: 'TAN-77' }, supplier: { id: uid('6666', 9), name: 'Conceria Demo' }, item: { id: uid('1212', 1), code: 'PEL-NAPPA-NERO', uom: 'FT2' }, areaIn: '52.0000', ...figures('51.0000', '43.1000', '2.1000', '5.8000', '11.37', '84.51') },
    { hide: { id: uid('2626', 2), code: 'H-DEMO-0142', grade: 'B', shade: '2', state: 'CONSUMED' }, lot: { id: uid('2727', 1), code: 'L-DEMO-0042', supplierLotRef: 'TAN-77' }, supplier: { id: uid('6666', 9), name: 'Conceria Demo' }, item: { id: uid('1212', 1), code: 'PEL-NAPPA-NERO', uom: 'FT2' }, areaIn: '49.5000', ...figures('48.0000', '36.2000', '3.0000', '8.8000', '18.33', '75.42') },
    { hide: { id: uid('2626', 3), code: 'H-DEMO-0157', grade: 'A', shade: '3', state: 'PARTLY_CUT' }, lot: { id: uid('2727', 2), code: 'L-DEMO-0051', supplierLotRef: 'TAN-81' }, supplier: { id: uid('6666', 9), name: 'Conceria Demo' }, item: { id: uid('1212', 1), code: 'PEL-NAPPA-ROSSO', uom: 'FT2' }, areaIn: '50.2000', ...figures('31.0000', '25.9000', '0.0000', '5.1000', '16.45', '83.55') },
  ],
}

const op = (seq: number, code: string, name: string) => ({ id: uid('8181', seq), seq, code, name })
const cellOf = (index: number) => ({ id: WO.cells[index]!.id, colourwayCode: WO.cells[index]!.colourwayCode, size: WO.cells[index]!.size })
const scrap = (n: number, kind: 'SCRAP' | 'REWORK', operation: ReturnType<typeof op>, cell: number, pieces: number, code: string, it: string, en: string, status: string | null = null): ScrapRow => ({
  id: uid('9393', n),
  kind,
  at: at(29, 8 + n, 10),
  bundle: { id: uid('9494', n), code: `B-DEMO-${String(100 + n)}` },
  operation,
  cell: cellOf(cell),
  pieces,
  reasonCode: code,
  reasonLabel: { it, en },
  status,
})
const SEW = op(20, 'CUC', 'Cucitura')
const ASM = op(30, 'ASS', 'Assemblaggio')
export const SCRAP: ScrapRow[] = [
  scrap(1, 'SCRAP', SEW, 1, 1, 'TORN', 'Pelle strappata', 'Torn leather'),
  scrap(2, 'SCRAP', SEW, 2, 1, 'TORN', 'Pelle strappata', 'Torn leather'),
  scrap(3, 'REWORK', SEW, 3, 2, 'SEAM', 'Cucitura difettosa', 'Faulty seam', 'IN_PROGRESS'),
  scrap(4, 'REWORK', ASM, 1, 1, 'ZIP', 'Zip montata male', 'Zip fitted wrong', 'DONE'),
]

export const AVAILABILITY: Availability = {
  site: { id: WO.siteId, code: WO.site.code },
  item: { id: uid('1212', 1), code: 'PEL-NAPPA-NERO', name: 'Pelle nappa demo', baseUom: 'FT2' },
  colour: { id: uid('1313', 1), code: 'NERO' },
  hides: [
    { hide: { id: uid('2626', 11), code: 'H-DEMO-0170' }, lotId: uid('2727', 3), onHand: '51.2000', held: false, reservedFor: null },
    { hide: { id: uid('2626', 12), code: 'H-DEMO-0171' }, lotId: uid('2727', 3), onHand: '48.9000', held: false, reservedFor: null },
    { hide: { id: uid('2626', 13), code: 'H-DEMO-0172' }, lotId: uid('2727', 3), onHand: '50.4000', held: false, reservedFor: { type: 'WorkOrder', id: WO.id, number: WO.number } },
    { hide: { id: uid('2626', 14), code: 'H-DEMO-0173' }, lotId: uid('2727', 3), onHand: '47.6000', held: false, reservedFor: { type: 'WorkOrder', id: uid('9191', 12), number: 'WO-00012' } },
    { hide: { id: uid('2626', 15), code: 'H-DEMO-0188' }, lotId: uid('2727', 4), onHand: '52.3000', held: true, reservedFor: null },
  ],
}

/** A draft's release check with the W2a parts: the plan's readiness, a hold, a shortage expected in time. */
export function releaseCheckW2a(kind: 'expected' | 'held' | 'requested'): ReleaseCheck {
  const base = releaseCheck(kind === 'requested' ? 'material' : kind === 'expected' ? 'material' : 'ready')
  const short = base.materials[0]
  const readiness = {
    word: kind === 'expected' ? ('EXPECTED' as const) : kind === 'requested' ? ('REQUESTED' as const) : ('NOT_BOOKED' as const),
    date: kind === 'expected' ? '2026-11-04' : null,
    materials: short
      ? [{ itemId: short.itemId, itemColourId: short.itemColourId, label: short.label, uom: short.baseUom, word: kind === 'expected' ? ('EXPECTED' as const) : ('REQUESTED' as const), date: kind === 'expected' ? '2026-11-04' : null, needed: short.needed, reserved: '0', inStock: short.usable, onOrder: '300.00', short: short.short }]
      : [],
  }
  const checks = base.checks.map((check) => (check.code === 'MATERIAL' && kind === 'expected' ? { code: 'MATERIAL' as const, state: 'OK' as const, problems: [] } : check))
  const holds = kind === 'held' ? [{ holdId: HOLD.id, reason: 'Quality check', placedAt: HOLD.placedAt }] : []
  const allChecks: ReleaseCheck['checks'] = [...checks, kind === 'held' ? { code: 'HOLDS', state: 'BLOCKED', problems: [{ path: `holds/${HOLD.id}`, message: '' }] } : { code: 'HOLDS', state: 'OK', problems: [] }]
  const blockers = allChecks.filter((check) => check.state === 'BLOCKED').flatMap((check) => check.problems)
  return { ...base, status: kind === 'held' ? 'ON_HOLD' : 'DRAFT', checks: allChecks, blockers, releasable: blockers.length === 0, readiness, holds }
}

/** The daily sub-model of a released work order with every part read. */
export function dailyDemo(role: DailyRole, over: Partial<DailyModel> = {}): DailyModel {
  const can = demoCan(role)
  return {
    ...NO_DAILY(can),
    holds: can.holdsView ? { value: [], problem: null } : null,
    bundleHolds: can.holdsView ? [] : null,
    reasons: HOLD_REASONS,
    readiness: { value: READINESS, problem: null },
    finished: { value: FINISHED, problem: null },
    yield: { value: YIELD, problem: null },
    scrap: can.scrapView ? { value: SCRAP, problem: null } : null,
    ...over,
  }
}

/** The daily sub-model as the record reads it for a work order in this status (a draft reads no released part). */
export function dailyFor(role: DailyRole, status: string, over: Partial<DailyModel> = {}): DailyModel {
  if (status === 'DRAFT') return { ...dailyDemo(role), readiness: null, finished: null, yield: null, scrap: null, bundleHolds: null, ...over }
  return dailyDemo(role, over)
}

/** The shared fixtures' roles as the W2a role templates. */
export const DAILY_ROLE_OF = { owner: 'owner', manager: 'manager', teamLeader: 'supervisor', sales: 'sales' } as const
