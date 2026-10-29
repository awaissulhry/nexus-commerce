import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import { RecordPanelsView } from '../../../record-panels/view/RecordPanelsView'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { BundleRow, CutLog, FinalState, PickList, ReleaseCheck, SiteWip, WorkOrder, WorkOrderBundles, WorkOrderCell, WorkOrderCounts, WorkOrderRow, WorkOrderStatus, WorkOrderWip } from './api'
import { abilitiesOf, type ProductionCan } from './model'

/**
 * Made-up work orders for the design cases of SCR-069 … SCR-073 (B-W1-38 part 2): an invented company, site, style
 * ("DEMO-JKT-01"), customers ("Moto Demo S.r.l.", "Esempio Racing S.p.A."), people ("Bea Esempio") and codes; every
 * figure worked out by hand. Nothing here is a real company, person, order or number. Design-only (a fixtures file: only
 * fixtures and tests import it); it exports no `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
export const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = DEMO_COMPANIES[0].id
const SITE = { id: uid('2222', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
const STYLE = { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo', ppeCategory: 'II', sizes: ['46', '48', '50', '52', '54', '56'] }
const ORDERS = [
  { id: uid('5151', 1), number: 'SO-DEMO-0042', customerRef: 'PO-ESEMPIO-7', status: 'IN_PRODUCTION', partyId: uid('6666', 1), partyName: 'Moto Demo S.r.l.', depositRequired: true },
  { id: uid('5151', 2), number: 'SO-DEMO-0043', customerRef: null, status: 'CONFIRMED', partyId: uid('6666', 2), partyName: 'Esempio Racing S.p.A.', depositRequired: false },
]

// ---- roles ---------------------------------------------------------------------------------------------------------------------

const PRODUCTION = ['workorders.view', 'workorders.manage', 'workorders.release', 'production.cut.correct', 'production.bundles', 'production.scan.correct', 'print.view', 'print.labels', 'inventory.issue', 'quality.inspections.view', 'orders.view']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...PRODUCTION, 'threads.read', 'threads.post', 'files.read', 'files.upload'],
  manager: ['home.view', ...PRODUCTION, 'threads.read', 'threads.post', 'files.read', 'files.upload'],
  /** In the Office a team leader works as the floor supervisor: follows the lines, decides scan corrections. */
  teamLeader: ['home.view', 'workorders.view', 'production.scan.correct', 'print.view', 'print.labels', 'threads.read', 'threads.post', 'files.read'],
  sales: ['home.view', 'workorders.view', 'orders.view', 'threads.read', 'threads.post', 'files.read', 'files.upload', 'email.triage'],
} as const
export type Role = keyof typeof ROLES
export const canOf = (role: Role): ProductionCan => abilitiesOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'manager'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- the list ------------------------------------------------------------------------------------------------------------------

const row = (n: number, status: WorkOrderStatus, extra: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  id: uid('9191', n),
  number: `WO-${String(n).padStart(5, '0')}`,
  batchNumber: status === 'DRAFT' || status === 'CANCELLED' ? null : `BA-${String(n + 40).padStart(5, '0')}`,
  status,
  kind: 'SIZE_GRID',
  version: 3,
  companyId: COMPANY,
  siteId: SITE.id,
  siteCode: SITE.code,
  styleId: STYLE.id,
  styleCode: STYLE.code,
  styleName: STYLE.name,
  revision: 3,
  colourways: ['BLK'],
  orders: [{ id: ORDERS[0]!.id, number: ORDERS[0]!.number, partyName: ORDERS[0]!.partyName }],
  cells: 4,
  pieces: 24,
  progress: status === 'DRAFT' ? null : { cut: 0, bundled: 0, sewn: 0, finished: 0 },
  dueDate: '2026-11-20',
  daysLate: status === 'DRAFT' || status === 'RELEASED' || status === 'IN_PROGRESS' ? 0 : null,
  priority: 0,
  releasedAt: status === 'DRAFT' ? null : at(20, 9),
  createdAt: at(18, 9),
  ...extra,
})

export const LIST_ROWS: WorkOrderRow[] = [
  row(12, 'DRAFT', { colourways: ['BLK', 'RED'], cells: 6, pieces: 26, dueDate: '2026-11-27', priority: 5 }),
  row(11, 'DRAFT', { pieces: 12, cells: 3, dueDate: '2026-12-04', orders: [{ id: ORDERS[1]!.id, number: ORDERS[1]!.number, partyName: ORDERS[1]!.partyName }] }),
  row(10, 'RELEASED', { pieces: 18, cells: 3, colourways: ['RED'] }),
  row(9, 'IN_PROGRESS', { colourways: ['BLK', 'RED'], cells: 6, pieces: 26, progress: { cut: 23, bundled: 20, sewn: 12, finished: 6 }, dueDate: '2026-11-06', priority: 8 }),
  row(8, 'IN_PROGRESS', { pieces: 30, progress: { cut: 30, bundled: 30, sewn: 24, finished: 18 }, dueDate: '2026-10-24', daysLate: 5, priority: 9 }),
  row(7, 'IN_PROGRESS', { pieces: 12, progress: { cut: 12, bundled: 0, sewn: 0, finished: 0 }, dueDate: '2026-11-12' }),
  row(6, 'COMPLETED', { pieces: 20, progress: { cut: 20, bundled: 20, sewn: 20, finished: 20 }, dueDate: '2026-10-22' }),
  row(5, 'CLOSED', { pieces: 16, progress: { cut: 16, bundled: 16, sewn: 16, finished: 16 }, dueDate: '2026-10-10' }),
  row(4, 'CANCELLED', { pieces: 8, progress: null, dueDate: '2026-10-15', revision: 2 }),
  row(3, 'IN_PROGRESS', { pieces: 40, progress: { cut: 40, bundled: 36, sewn: 30, finished: 22 }, dueDate: '2026-10-27', daysLate: 2, orders: [{ id: ORDERS[1]!.id, number: ORDERS[1]!.number, partyName: ORDERS[1]!.partyName }] }),
]
export const OPEN_ROWS = LIST_ROWS.filter((entry) => ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(entry.status))
export const COUNTS: WorkOrderCounts = { draft: 2, released: 1, inProgress: 4, completed: 1, open: 7, late: 2 }

// ---- one work order --------------------------------------------------------------------------------------------------------

const cell = (n: number, colour: 'BLK' | 'RED', size: string, quantity: number, progress: WorkOrderCell['progress'] = { cut: null, bundled: null, sewn: null, finished: null }): WorkOrderCell => ({
  id: uid('8181', n),
  version: 1,
  colourwayId: colour === 'BLK' ? uid('7777', 11) : uid('7777', 12),
  colourwayCode: colour,
  colourwayName: colour === 'BLK' ? 'Nero' : 'Rosso',
  size,
  quantity,
  salesOrderLineId: colour === 'BLK' ? uid('5252', 1) : uid('5252', 2),
  salesOrderId: ORDERS[0]!.id,
  lineSeq: colour === 'BLK' ? 1 : 2,
  progress,
})

const OPS = [
  { seq: 10, code: 'TAGLIO', name: 'Taglio pelle', kind: 'CUTTING', minutes: '6.5', scan: true },
  { seq: 20, code: 'ASM-CORPO', name: 'Assemblaggio corpo', kind: 'ASSEMBLY', minutes: '38', scan: true },
  { seq: 30, code: 'CUC-IMP', name: 'Impuntura', kind: 'SEWING', minutes: '22', scan: true },
  { seq: 35, code: 'STIRO', name: 'Stiro', kind: 'FINISHING', minutes: '4', scan: false },
  { seq: 40, code: 'CTRL', name: 'Controllo finale', kind: 'INSPECTION', minutes: '6', scan: true },
  { seq: 50, code: 'IMB', name: 'Imballo', kind: 'PACKING', minutes: '2.5', scan: true },
] as const

const operations = (frozen: boolean): WorkOrder['spec']['operations'] =>
  OPS.map((op, index) => ({
    id: frozen ? uid('4141', index + 1) : null,
    seq: op.seq,
    routingSeq: op.seq,
    code: op.code,
    name: op.name,
    standardMinutes: op.minutes,
    scanRequired: op.scan,
    workCentreKind: op.kind,
    workCentreId: uid('3131', index + 1),
    workCentreCode: `WC-${op.code}`,
  }))

const MATERIALS: WorkOrder['spec']['materials'] = [
  { itemId: uid('1212', 1), itemCode: 'PEL-NAPPA-NERO', itemName: 'Pelle nappa demo', itemColourId: uid('1313', 1), colourCode: 'NERO', baseUom: 'FT2', planned: '1252.16', issued: '1104.00', balance: '148.16' },
  { itemId: uid('1212', 1), itemCode: 'PEL-NAPPA-ROSSO', itemName: 'Pelle nappa demo', itemColourId: uid('1313', 2), colourCode: 'ROSSO', baseUom: 'FT2', planned: '288.96', issued: '160.00', balance: '128.96' },
  { itemId: uid('1212', 2), itemCode: 'FOD-RETE', itemName: 'Fodera rete demo', itemColourId: null, colourCode: null, baseUom: 'M', planned: '49.14', issued: '49.14', balance: '0' },
  { itemId: uid('1212', 3), itemCode: 'PROT-SPALLA', itemName: 'Protezione spalla demo', itemColourId: null, colourCode: null, baseUom: 'PCS', planned: '52', issued: '40', balance: '12' },
]

const PROGRESS_9: Record<string, WorkOrderCell['progress']> = {
  'BLK 48': { cut: 4, bundled: 4, sewn: 4, finished: 2 },
  'BLK 50': { cut: 6, bundled: 6, sewn: 4, finished: 2 },
  'BLK 52': { cut: 6, bundled: 6, sewn: 4, finished: 2 },
  'BLK 54': { cut: 4, bundled: 4, sewn: 0, finished: 0 },
  'RED 50': { cut: 3, bundled: 0, sewn: 0, finished: 0 },
  'RED 52': { cut: 0, bundled: 0, sewn: 0, finished: 0 },
}

function cellsOf(progressed: boolean): WorkOrderCell[] {
  const plan: Array<[number, 'BLK' | 'RED', string, number]> = [
    [1, 'BLK', '48', 4],
    [2, 'BLK', '50', 6],
    [3, 'BLK', '52', 6],
    [4, 'BLK', '54', 4],
    [5, 'RED', '50', 3],
    [6, 'RED', '52', 3],
  ]
  return plan.map(([n, colour, size, quantity]) => cell(n, colour, size, quantity, progressed ? PROGRESS_9[`${colour} ${size}`] : undefined))
}

export function workOrder(status: WorkOrderStatus, extra: Partial<WorkOrder> = {}): WorkOrder {
  const frozen = status !== 'DRAFT'
  const cells = cellsOf(frozen && status !== 'RELEASED')
  return {
    id: uid('9191', 9),
    number: 'WO-00009',
    batchNumber: frozen && status !== 'CANCELLED' ? 'BA-00049' : null,
    kind: 'SIZE_GRID',
    status,
    version: 7,
    companyId: COMPANY,
    siteId: SITE.id,
    site: SITE,
    style: STYLE,
    revision: { id: uid('7777', 21), revision: 3, status: 'RELEASED' },
    labelTemplate: { id: uid('7777', 31), code: 'LT-DEMO-07', revision: 2, status: 'ACTIVE' },
    dueDate: '2026-11-06',
    daysLate: ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(status) ? 0 : null,
    priority: 8,
    note: null,
    release: frozen ? { at: at(20, 10, 42), byId: DEMO_USER.id, materialOverride: null } : null,
    startedAt: ['IN_PROGRESS', 'COMPLETED', 'CLOSED'].includes(status) ? at(21, 7, 55) : null,
    completedAt: ['COMPLETED', 'CLOSED'].includes(status) ? at(28, 16, 10) : null,
    closedAt: status === 'CLOSED' ? at(29, 9, 0) : null,
    cancelledAt: status === 'CANCELLED' ? at(22, 11, 0) : null,
    cancelReason: status === 'CANCELLED' ? 'The customer moved the order to next season' : null,
    createdAt: at(18, 9),
    updatedAt: at(29, 9, 40),
    nextActions: status === 'DRAFT' ? ['RELEASED', 'CANCELLED'] : status === 'RELEASED' ? ['IN_PROGRESS', 'CANCELLED'] : status === 'IN_PROGRESS' ? ['COMPLETED', 'CANCELLED'] : status === 'COMPLETED' ? ['CLOSED'] : [],
    orders: [ORDERS[0]!],
    cells,
    pieces: cells.reduce((sum, entry) => sum + entry.quantity, 0),
    progress: { counted: frozen },
    spec: { frozen, frozenAt: frozen ? at(20, 10, 42) : null, operations: operations(frozen), materials: MATERIALS, standardMinutes: { perGarment: '79.0', allPieces: '2054.0' } },
    ...extra,
  }
}

// ---- the release check ---------------------------------------------------------------------------------------------------------

const ok = (code: ReleaseCheck['checks'][number]['code']) => ({ code, state: 'OK' as const, problems: [] })
const SHORT_LEATHER: ReleaseCheck['materials'][number] = {
  itemId: uid('1212', 1),
  itemColourId: uid('1313', 2),
  label: 'Pelle nappa demo ROSSO',
  baseUom: 'FT2',
  planned: '288.96',
  issued: '0',
  usable: '120.00',
  committed: '40.00',
  needed: '288.96',
  available: '80.00',
  short: '208.96',
  held: [{ reason: 'CR_VI_PENDING', quantity: '165.00' }],
}

export function releaseCheck(kind: 'blocked' | 'material' | 'ready' | 'noRevision'): ReleaseCheck {
  const draft = workOrder('DRAFT')
  const red52 = draft.cells.find((entry) => entry.colourwayCode === 'RED' && entry.size === '52')!
  const material = { code: 'MATERIAL' as const, state: 'BLOCKED' as const, problems: [{ path: `materials/${SHORT_LEATHER.itemId}/${SHORT_LEATHER.itemColourId}`, message: '' }] }
  const held = (code: ReleaseCheck['checks'][number]['code']) => ({ code, state: 'BLOCKED' as const, problems: [{ path: `checks/${code}`, message: '' }] })
  const checks: ReleaseCheck['checks'] =
    kind === 'noRevision'
      ? [held('REVISION'), held('LABEL_TEMPLATE'), ok('CERTIFICATE'), held('WORK_CENTRES'), held('BOM'), ok('CELLS'), ok('DEPOSIT'), ok('MATERIAL'), ok('BATCH_NUMBER')]
      : kind === 'ready'
      ? [ok('REVISION'), ok('LABEL_TEMPLATE'), ok('CERTIFICATE'), ok('WORK_CENTRES'), ok('BOM'), ok('CELLS'), { code: 'DEPOSIT', state: 'OK', problems: [] }, ok('MATERIAL'), ok('BATCH_NUMBER')]
      : kind === 'material'
        ? [ok('REVISION'), ok('LABEL_TEMPLATE'), ok('CERTIFICATE'), ok('WORK_CENTRES'), ok('BOM'), ok('CELLS'), ok('DEPOSIT'), material, ok('BATCH_NUMBER')]
        : [
            ok('REVISION'),
            ok('LABEL_TEMPLATE'),
            { code: 'CERTIFICATE', state: 'BLOCKED', problems: [{ path: `cells/${red52.id}/certificate`, message: '' }] },
            { code: 'WORK_CENTRES', state: 'BLOCKED', problems: [{ path: 'checks/WORK_CENTRES/FINISHING', message: '' }] },
            ok('BOM'),
            ok('CELLS'),
            { code: 'DEPOSIT', state: 'BLOCKED', problems: [{ path: `orders/${ORDERS[0]!.id}/deposit`, message: '' }] },
            material,
            ok('BATCH_NUMBER'),
          ]
  const blockers = checks.filter((entry) => entry.state === 'BLOCKED').flatMap((entry) => entry.problems)
  return { workOrderId: draft.id, status: 'DRAFT', version: draft.version, frozen: false, releasable: blockers.length === 0, checks, blockers, materials: kind === 'ready' || kind === 'noRevision' ? [] : [SHORT_LEATHER] }
}

// ---- WIP ---------------------------------------------------------------------------------------------------------------------

const flow = (arrived: number, waiting: number, good: number, scrap = 0, rework = 0) => ({ arrived, waiting, good, scrap, rework })
export function wipOf(ready = false): WorkOrderWip {
  const wo = workOrder('IN_PROGRESS')
  const figures: Record<number, ReturnType<typeof flow> & { bundles: { done: number; waiting: number; notReached: number } }> = ready
    ? Object.fromEntries(OPS.map((op) => [op.seq, { ...flow(26, 0, 26), bundles: { done: 6, waiting: 0, notReached: 0 } }]))
    : {
        10: { ...flow(20, 0, 20), bundles: { done: 5, waiting: 0, notReached: 0 } },
        20: { ...flow(20, 4, 16), bundles: { done: 4, waiting: 1, notReached: 0 } },
        30: { ...flow(16, 3, 12, 1), bundles: { done: 3, waiting: 1, notReached: 1 } },
        35: { ...flow(12, 0, 0), bundles: { done: 0, waiting: 0, notReached: 0 } },
        40: { ...flow(12, 5, 6, 0, 1), bundles: { done: 2, waiting: 1, notReached: 2 } },
        50: { ...flow(6, 6, 0), bundles: { done: 0, waiting: 2, notReached: 3 } },
      }
  const cells = wo.cells.map((entry) => ({ workOrderSizeId: entry.id, colourwayCode: entry.colourwayCode, size: entry.size }))
  return {
    workOrder: { id: wo.id, number: wo.number, status: wo.status, siteId: SITE.id },
    operations: OPS.map((op, index) => {
      const f = figures[op.seq]!
      return {
        operationId: uid('4141', index + 1),
        seq: op.seq,
        code: op.code,
        name: op.name,
        scanRequired: op.scan,
        final: op.seq === 50,
        sewn: op.seq === 30,
        workCentreKind: op.kind,
        arrived: f.arrived,
        waiting: f.waiting,
        good: f.good,
        scrap: f.scrap,
        rework: f.rework,
        missing: 0,
        bundles: f.bundles,
        partBundles: { done: 0, waiting: 0, notReached: 0 },
        cells: cells.map((entry) => {
          const quantity = wo.cells.find((c) => c.id === entry.workOrderSizeId)!.quantity
          const p = ready ? { cut: quantity, bundled: quantity, sewn: quantity, finished: quantity } : PROGRESS_9[`${entry.colourwayCode} ${entry.size}`]!
          const good = op.seq <= 20 ? (p.cut ?? 0) : op.seq <= 30 ? (p.sewn ?? 0) : (p.finished ?? 0)
          return { ...entry, ...flow(good, 0, ready ? wo.cells.find((c) => c.id === entry.workOrderSizeId)!.quantity : good), missing: 0 }
        }),
        lines: op.seq === 50 && ready ? [{ lineId: uid('3232', 1), code: 'L1', name: 'Linea giacche', good: 26 }] : op.seq >= 20 && op.seq <= 30 ? [{ lineId: uid('3232', 1), code: 'L1', name: 'Linea giacche', good: f.good }] : [],
      }
    }),
    cells: wo.cells.map((entry) => ({
      workOrderSizeId: entry.id,
      colourwayCode: entry.colourwayCode,
      size: entry.size,
      quantity: entry.quantity,
      bundled: ready ? entry.quantity : (entry.progress.bundled ?? 0),
      sewn: ready ? entry.quantity : entry.progress.sewn,
      finished: ready ? entry.quantity : entry.progress.finished,
      scrapped: 0,
      inRework: 0,
    })),
    finalOperationId: uid('4141', 6),
    sewnOperationId: uid('4141', 3),
    allFinished: ready,
    readyToComplete: ready,
    correctionsWaiting: ready ? 0 : 1,
  }
}

// ---- the cut log --------------------------------------------------------------------------------------------------------------

const BEA = { id: uid('3434', 1), name: 'Bea Esempio' }
const CUT_ST = { id: uid('3535', 1), code: 'CUT-01', name: 'Tavolo taglio 1' }
type Entry = CutLog['entries'][number]
const entry = (n: number, hide: 1 | 2 | 3, minute: number, cells: Array<[number, string, string, number]>, extra: Partial<Entry> = {}): Entry => ({
  id: uid('6161', n),
  hideId: uid('6262', hide),
  hideCode: `HD-${DEMO_TAG}-00${hide}4R-${'KMQ'[hide - 1]}`,
  lotCode: hide === 3 ? 'LOT-DEMO-0042' : 'LOT-DEMO-0041',
  uom: 'FT2',
  baseAreaUsed: '48.1600',
  baseRemnantArea: '0.0000',
  reversalOfId: null,
  reversedById: null,
  live: true,
  closing: false,
  pattern: '48.1600',
  note: null,
  deviceId: uid('3636', 1),
  deviceTime: at(21, 8, minute),
  serverTime: at(21, 8, minute),
  worker: BEA,
  station: CUT_ST,
  pieces: cells.flatMap(([cellN, , , sets]) => ['Corpo', 'Maniche', 'Collo'].map((part) => ({ workOrderSizeId: uid('8181', cellN), part, pieces: sets }))),
  cells: cells.map(([cellN, colour, size]) => ({ workOrderSizeId: uid('8181', cellN), colourwayCode: colour, size })),
  ...extra,
})

export function cutLogOf(kind: 'normal' | 'empty' = 'normal'): CutLog {
  const wo = workOrder('IN_PROGRESS')
  const entries: Entry[] =
    kind === 'empty'
      ? []
      : [
          entry(7, 3, 52, [[5, 'RED', '50', 3]], { baseAreaUsed: '144.4800', pattern: '144.4800' }),
          entry(6, 2, 40, [[4, 'BLK', '54', 2]], { reversalOfId: uid('6161', 5), live: true, baseAreaUsed: '-96.3200', pattern: null, note: 'Corrected by the office: wrong size typed', deviceId: null, worker: null, station: null, pieces: [] }),
          entry(5, 2, 31, [[4, 'BLK', '54', 2]], { reversedById: uid('6161', 6), live: false, baseAreaUsed: '96.3200' }),
          entry(4, 2, 30, [[4, 'BLK', '54', 4]], { baseAreaUsed: '192.6400', baseRemnantArea: '6.2000', closing: true, pattern: '192.6400' }),
          entry(3, 1, 20, [[3, 'BLK', '52', 6]], { baseAreaUsed: '288.9600', pattern: '288.9600' }),
          entry(2, 1, 12, [[2, 'BLK', '50', 6]], { baseAreaUsed: '288.9600', pattern: '288.9600' }),
          entry(1, 1, 5, [[1, 'BLK', '48', 4]], { baseAreaUsed: '192.6400', pattern: '192.6400' }),
        ]
  return {
    workOrder: { id: wo.id, number: wo.number, status: 'IN_PROGRESS', siteId: SITE.id },
    entries,
    hides:
      kind === 'empty'
        ? []
        : [
            { hideId: uid('6262', 1), code: `HD-${DEMO_TAG}-0014R-K`, lotCode: 'LOT-DEMO-0041', state: 'PARTLY_CUT', issued: '880.0000', cut: '770.5600', waste: '0.0000', returned: '0.0000', left: '109.4400' },
            { hideId: uid('6262', 2), code: `HD-${DEMO_TAG}-0024R-M`, lotCode: 'LOT-DEMO-0041', state: 'CONSUMED', issued: '224.0000', cut: '192.6400', waste: '25.1600', returned: '6.2000', left: '0.0000' },
            { hideId: uid('6262', 3), code: `HD-${DEMO_TAG}-0034R-Q`, lotCode: 'LOT-DEMO-0042', state: 'PARTLY_CUT', issued: '160.0000', cut: '144.4800', waste: '0.0000', returned: '0.0000', left: '15.5200' },
          ],
    cells: wo.cells.map((entryCell) => ({
      id: entryCell.id,
      colourwayCode: entryCell.colourwayCode,
      size: entryCell.size,
      quantity: entryCell.quantity,
      cut: entryCell.progress.cut,
      toCut: entryCell.progress.cut === null ? null : entryCell.quantity - entryCell.progress.cut,
      parts: entryCell.progress.cut ? ['Corpo', 'Maniche', 'Collo'].map((part) => ({ part, pieces: entryCell.progress.cut!, planned: true })) : [],
    })),
  }
}

// ---- bundles -------------------------------------------------------------------------------------------------------------------

const bundle = (n: number, cellN: number, colour: string, size: string, quantity: number, doneAt: number[], extra: Partial<BundleRow> = {}): BundleRow => ({
  id: uid('7171', n),
  code: `BN-${DEMO_TAG}-${String(1000 + n)}-${'ABCDEFGHJK'[n % 10]}`,
  replacedCodes: [],
  workOrderSizeId: uid('8181', cellN),
  colourwayCode: colour,
  size,
  part: null,
  quantity,
  status: 'ACTIVE',
  voidedAt: null,
  cutLogIds: [uid('6161', 1)],
  createdAt: at(21, 9, n),
  scans: doneAt.length,
  doneAt,
  lastScan: doneAt.length ? { at: at(29, 8 + doneAt.length, 10 + n), operation: { seq: doneAt[doneAt.length - 1]!, code: OPS.find((op) => op.seq === doneAt[doneAt.length - 1])!.code }, station: { id: uid('3535', 2), code: `ST-${doneAt[doneAt.length - 1]}`, name: 'Postazione demo' } } : null,
  hides: [{ hideId: uid('6262', 1), code: `HD-${DEMO_TAG}-0014R-K`, lotId: uid('6363', 1), lotCode: 'LOT-DEMO-0041' }],
  tickets: [{ jobId: uid('8282', n), printerId: uid('8383', 1), status: 'PRINTED', createdAt: at(21, 9, n) }],
  reprints: [],
  ...extra,
})

export function bundlesOf(kind: 'normal' | 'empty' = 'normal'): WorkOrderBundles {
  const wo = workOrder('IN_PROGRESS')
  return {
    workOrder: { id: wo.id, number: wo.number, status: 'IN_PROGRESS', siteId: SITE.id },
    cells: wo.cells.map((entry) => ({ workOrderSizeId: entry.id, colourwayCode: entry.colourwayCode, size: entry.size, quantity: entry.quantity, cut: entry.progress.cut, bundled: entry.progress.bundled ?? 0, toBundle: Math.max(0, (entry.progress.cut ?? 0) - (entry.progress.bundled ?? 0)), parts: [] })),
    bundles:
      kind === 'empty'
        ? []
        : [
            bundle(1, 1, 'BLK', '48', 4, [10, 20, 30, 40]),
            bundle(2, 2, 'BLK', '50', 2, [10, 20, 30, 40], {
              replacedCodes: [`BN-${DEMO_TAG}-0998-Z`],
              reprints: [{ code: `BN-${DEMO_TAG}-1002-C`, replacedCode: `BN-${DEMO_TAG}-0998-Z`, reason: 'Ticket damaged', printerId: uid('8383', 1), postedBy: 'FLOOR', at: at(27, 14, 5) }],
            }),
            bundle(3, 2, 'BLK', '50', 4, [10, 20, 30]),
            bundle(4, 3, 'BLK', '52', 2, [10, 20, 30, 40]),
            bundle(5, 3, 'BLK', '52', 4, [10, 20, 30]),
            bundle(6, 4, 'BLK', '54', 4, [10, 20]),
            bundle(7, 4, 'BLK', '54', 2, [10], { status: 'VOID', voidedAt: at(22, 10), scans: 0 }),
            bundle(8, 4, 'BLK', '54', 4, [10]),
          ],
  }
}

export const PRINTERS = { printers: [{ id: uid('8383', 1), code: 'LBL-01', name: 'Etichette taglio' }, { id: uid('8383', 2), code: 'LBL-02', name: 'Etichette reparto' }], defaultPrinterId: uid('8383', 1) }
export const NO_PRINTERS = { printers: [], defaultPrinterId: null }

export const BUNDLE_SCANS = [
  { id: uid('9292', 1), kind: 'REPORT' as const, bundleId: uid('7171', 3), operation: { id: uid('4141', 1), seq: 10, code: 'TAGLIO', name: 'Taglio pelle' }, correctsId: null, goodQuantity: 4, scrapQuantity: 0, reworkQuantity: 0, serverTime: at(21, 9, 30), worker: BEA, station: CUT_ST, voidedById: null },
  { id: uid('9292', 2), kind: 'REPORT' as const, bundleId: uid('7171', 3), operation: { id: uid('4141', 2), seq: 20, code: 'ASM-CORPO', name: 'Assemblaggio corpo' }, correctsId: null, goodQuantity: 5, scrapQuantity: 0, reworkQuantity: 0, serverTime: at(24, 11, 2), worker: { id: uid('3434', 2), name: 'Carlo Prova' }, station: { id: uid('3535', 2), code: 'ST-20', name: 'Postazione demo' }, voidedById: uid('9292', 3) },
  { id: uid('9292', 3), kind: 'UNDO' as const, bundleId: uid('7171', 3), operation: { id: uid('4141', 2), seq: 20, code: 'ASM-CORPO', name: 'Assemblaggio corpo' }, correctsId: uid('9292', 2), goodQuantity: 0, scrapQuantity: 0, reworkQuantity: 0, serverTime: at(24, 11, 3), worker: { id: uid('3434', 2), name: 'Carlo Prova' }, station: { id: uid('3535', 2), code: 'ST-20', name: 'Postazione demo' }, voidedById: null },
  { id: uid('9292', 4), kind: 'REPORT' as const, bundleId: uid('7171', 3), operation: { id: uid('4141', 2), seq: 20, code: 'ASM-CORPO', name: 'Assemblaggio corpo' }, correctsId: null, goodQuantity: 4, scrapQuantity: 0, reworkQuantity: 0, serverTime: at(24, 11, 4), worker: { id: uid('3434', 2), name: 'Carlo Prova' }, station: { id: uid('3535', 2), code: 'ST-20', name: 'Postazione demo' }, voidedById: null },
  { id: uid('9292', 5), kind: 'REPORT' as const, bundleId: uid('7171', 3), operation: { id: uid('4141', 3), seq: 30, code: 'CUC-IMP', name: 'Impuntura' }, correctsId: null, goodQuantity: 3, scrapQuantity: 1, reworkQuantity: 0, serverTime: at(28, 15, 40), worker: { id: uid('3434', 3), name: 'Dora Campione' }, station: { id: uid('3535', 3), code: 'ST-30', name: 'Postazione demo' }, voidedById: null },
]

// ---- materials and quality ----------------------------------------------------------------------------------------------------

export const PICK: PickList = {
  workOrder: { id: uid('9191', 9), issuable: true },
  lines: [
    {
      itemId: uid('1212', 1),
      itemCode: 'PEL-NAPPA-NERO',
      itemName: 'Pelle nappa demo',
      tracking: 'HIDE',
      baseUom: 'FT2',
      itemColourId: uid('1313', 1),
      colourCode: 'NERO',
      planned: '1252.16',
      issued: '1104.00',
      toIssue: '148.16',
      over: '0',
      covered: false,
      usable: { onHand: '660.00', candidates: [{ lotCode: 'LOT-DEMO-0041', hideCode: `HD-${DEMO_TAG}-0044R-A`, locationCode: 'MAG-PELLI', onHand: '220.00' }], more: 2 },
      held: [],
      atWorkOrder: [
        { lotCode: 'LOT-DEMO-0041', hideCode: `HD-${DEMO_TAG}-0014R-K`, quantity: '880.00', cut: '770.56', returnable: '109.44' },
        { lotCode: 'LOT-DEMO-0041', hideCode: `HD-${DEMO_TAG}-0024R-M`, quantity: '224.00', cut: '192.64', returnable: '0.00' },
      ],
    },
    {
      itemId: uid('1212', 1),
      itemCode: 'PEL-NAPPA-ROSSO',
      itemName: 'Pelle nappa demo',
      tracking: 'HIDE',
      baseUom: 'FT2',
      itemColourId: uid('1313', 2),
      colourCode: 'ROSSO',
      planned: '288.96',
      issued: '160.00',
      toIssue: '128.96',
      over: '0',
      covered: false,
      usable: { onHand: '0', candidates: [], more: 0 },
      held: [{ reason: 'CR_VI_PENDING', lotCode: 'LOT-DEMO-0043', onHand: '165.00', hides: 3 }],
      atWorkOrder: [{ lotCode: 'LOT-DEMO-0042', hideCode: `HD-${DEMO_TAG}-0034R-Q`, quantity: '160.00', cut: '144.48', returnable: '15.52' }],
    },
    {
      itemId: uid('1212', 2),
      itemCode: 'FOD-RETE',
      itemName: 'Fodera rete demo',
      tracking: 'LOT',
      baseUom: 'M',
      itemColourId: null,
      colourCode: null,
      planned: '49.14',
      issued: '49.14',
      toIssue: '0',
      over: '0',
      covered: true,
      usable: { onHand: '310.00', candidates: [], more: 4 },
      held: [],
      atWorkOrder: [{ lotCode: 'LOT-DEMO-0031', hideCode: null, quantity: '49.14', cut: '0', returnable: '49.14' }],
    },
  ],
}

export const FINAL: FinalState = {
  inspections: [
    { id: uid('9393', 1), inspectionNumber: 'INS-2026-0012', label: 'INS-2026-0012', status: 'PASSED', lotSize: 6, released: 6, overridden: false, decidedAt: at(29, 10, 20) },
    { id: uid('9393', 2), inspectionNumber: null, label: 'WO-00009 · inspection 2', status: 'OPEN', lotSize: 0, released: 0, overridden: false, decidedAt: null },
  ],
  cells: workOrder('IN_PROGRESS').cells.map((entry) => ({ workOrderSizeId: entry.id, colourwayCode: entry.colourwayCode, size: entry.size, pieces: entry.quantity, released: entry.progress.finished ?? 0, labelsPrinted: entry.progress.finished ?? 0, releasable: 0 })),
}

// ---- Floor now ---------------------------------------------------------------------------------------------------------------

function siteRow(n: number, number: string, waiting: number[], good: number[], extra: Partial<SiteWip['workOrders'][number]> = {}): SiteWip['workOrders'][number] {
  return {
    workOrder: { id: uid('9191', n), number, status: 'IN_PROGRESS', siteId: SITE.id },
    siteCode: SITE.code,
    style: { code: STYLE.code, name: STYLE.name },
    dueDate: '2026-11-06',
    daysLate: 0,
    priority: 0,
    pieces: 26,
    finished: good[good.length - 1] ?? 0,
    operations: OPS.map((op, index) => ({
      operationId: uid('4141', n * 10 + index),
      seq: op.seq,
      code: op.code,
      name: op.name,
      scanRequired: op.scan,
      final: op.seq === 50,
      arrived: (waiting[index] ?? 0) + (good[index] ?? 0),
      waiting: waiting[index] ?? 0,
      good: good[index] ?? 0,
      scrap: op.seq === 30 && n === 9 ? 1 : 0,
      rework: 0,
      bundles: { done: Math.ceil((good[index] ?? 0) / 4), waiting: Math.ceil((waiting[index] ?? 0) / 4), notReached: 0 },
      lines: [],
    })),
    allFinished: false,
    ...extra,
  }
}

export const SITE_WIP: SiteWip = {
  workOrders: [
    siteRow(8, 'WO-00008', [0, 0, 6, 0, 6, 6], [30, 30, 24, 0, 18, 12], { dueDate: '2026-10-24', daysLate: 5, pieces: 30, finished: 12, priority: 9 }),
    siteRow(3, 'WO-00003', [0, 4, 6, 0, 8, 0], [40, 36, 30, 0, 22, 22], { dueDate: '2026-10-27', daysLate: 2, pieces: 40, finished: 22 }),
    siteRow(9, 'WO-00009', [0, 4, 3, 0, 5, 6], [20, 16, 12, 0, 6, 0], { finished: 0 }),
    siteRow(7, 'WO-00007', [0, 12, 0, 0, 0, 0], [12, 0, 0, 0, 0, 0], { dueDate: '2026-11-12', pieces: 12, finished: 0 }),
  ],
}

// ---- the record panels on a work order --------------------------------------------------------------------------------------

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

export function panelsModel(): RecordPanelsViewModel {
  const wo = workOrder('IN_PROGRESS')
  return { ...conversation, record: { type: 'WorkOrder', id: wo.id, companyId: COMPANY, siteId: SITE.id }, title: `${wo.number} · ${STYLE.code}`, party: null }
}

export function panels(): ReactNode {
  return createElement(RecordPanelsView, { model: panelsModel() })
}
