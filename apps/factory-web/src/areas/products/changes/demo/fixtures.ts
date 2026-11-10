import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { OperationMinutesView, OrderList, OrderRow, OrderView, PartyOption, ReleasedList, RequestList, RequestRow, RequestView, RoundOption, SmvWaiting, StyleDetail, StyleDriftView, StyleOption, VersionsCompareView } from '../api'
import { changesCan, type ChangesCan, type ChangesRead } from '../model'

/**
 * Design-only made-up data of Changes & versions (SCR-117 and the change's record): "Demo" styles, operations, customers and
 * people, example numbers (CR-DEMO-…, ECO-DEMO-…). Nothing here is a real company, person, order or result.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
export const NOW = '2026-11-10T09:42:00.000Z'
const OTHER = '0190f0e2-3333-7000-8000-000000000002'
const THIRD = '0190f0e2-3333-7000-8000-000000000003'

/** A made-up uuid in a family. */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The role cases the design names: the production manager (writes, approves, releases), quality (approves), sales (raises), a planner (reads), nobody. */
export const ROLE_PERMISSIONS = {
  owner: [
    ...OWNER_PERMISSIONS,
    ...template('production_manager'),
    'product.changes.view',
    'product.changes.request',
    'product.changes.manage',
    'product.changes.approve',
    'product.routing.view',
    'product.smv.approve',
    'product.bom.view',
    'product.styles.view',
    'parties.view',
    'sales.samples.view',
    'workorders.view',
    'files.upload',
    'threads.read',
  ],
  production: template('production_manager'),
  quality: template('quality_inspector'),
  sales: template('sales'),
  planner: template('planner'),
  warehouse: template('warehouse'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): ChangesCan => changesCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place). */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- styles, parties --------------------------------------------------------------------------------------------------------------

const JACKET = { id: uid('6101', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket' }
const PANTS = { id: uid('6101', 2), code: 'DEMO-PNT-02', name: 'Demo rain trousers' }
const GLOVE = { id: uid('6101', 3), code: 'DEMO-GLV-03', name: 'Demo summer glove' }
const REV = (style: number, revision: number, status: string) => ({ id: uid('6201', style * 10 + revision), revision, status })
const J1 = REV(1, 1, 'OBSOLETE')
const J2 = REV(1, 2, 'RELEASED')
const J3 = REV(1, 3, 'DRAFT')
const P1 = REV(2, 1, 'RELEASED')
const G1 = REV(3, 1, 'OBSOLETE')
const G2 = REV(3, 2, 'RELEASED')

export const STYLE_OPTIONS: StyleOption[] = [
  { ...JACKET, companyId: COMPANY_ID },
  { ...PANTS, companyId: COMPANY_ID },
  { ...GLOVE, companyId: null },
]
export const JACKET_DETAIL: StyleDetail = { ...STYLE_OPTIONS[0]!, revisions: [J1, J2, J3] }

const BRAND = { id: uid('6301', 1), code: 'DEMO-BRAND', name: 'Demo Moto Brand S.r.l.' }
export const CUSTOMERS: PartyOption[] = [{ id: BRAND.id, code: BRAND.code, legalName: BRAND.name, tradeName: 'Demo Moto Brand' }]
export const ROUNDS: RoundOption[] = [{ id: uid('6401', 1), number: 'SR-DEMO-0003', kind: 'FIT', roundNo: 2 }]

// ---- change requests ----------------------------------------------------------------------------------------------------------------

function request(n: number, over: Partial<RequestRow>): RequestRow {
  return {
    id: uid('6501', n),
    number: `CR-DEMO-${String(n).padStart(4, '0')}`,
    companyId: COMPANY_ID,
    siteId: null,
    source: 'OFFICE',
    party: null,
    sampleRound: null,
    style: JACKET,
    revision: { id: J2.id, revision: 2, status: 'RELEASED' },
    workOrder: null,
    title: 'Collar 52: open the neck by 1 cm',
    reason: 'Fit round 2 at the brand: the collar presses on the throat in size 52.',
    priority: 'NORMAL',
    status: 'OPEN',
    changeOrder: null,
    createdById: OTHER,
    createdAt: at(9, 10),
    decidedAt: null,
    decidedById: null,
    decisionNote: null,
    photos: 0,
    version: 1,
    ...over,
  }
}

const ORDER_REF = { id: uid('6601', 1), number: 'ECO-DEMO-0001', status: 'SUBMITTED' as const }

export const REQUESTS: RequestRow[] = [
  request(1, { source: 'FLOOR', number: null, siteId: uid('6701', 1), createdById: null, title: 'Spec problem: wrong measurement', reason: 'Wrong measurement, reported from the floor (operation 30 · Sleeve assembly, work order WO-DEMO-0042, bundle B-DEMO-0007). Sleeve 54 is 1 cm short of the pattern.', priority: 'URGENT', photos: 2, workOrder: { id: uid('6801', 42), number: 'WO-DEMO-0042', status: 'IN_PROGRESS' }, createdAt: at(10, 8, 12) }),
  request(2, { source: 'CUSTOMER', party: { id: BRAND.id, code: BRAND.code, name: BRAND.name }, title: 'Reflective piping on the back yoke', reason: 'The brand asks for reflective piping across the back yoke from the spring order.', priority: 'HIGH', status: 'IN_REVIEW', createdAt: at(8, 15) }),
  request(3, { source: 'SAMPLE', sampleRound: { id: ROUNDS[0]!.id, number: ROUNDS[0]!.number }, title: 'Collar 52: open the neck by 1 cm', status: 'ACCEPTED', decidedAt: at(9, 11), decidedById: ME, changeOrder: ORDER_REF, createdAt: at(7, 16) }),
  request(4, { source: 'OFFICE', createdById: ME, style: PANTS, revision: { id: P1.id, revision: 1, status: 'RELEASED' }, title: 'Zip garage on the hip pocket', reason: 'Customers report the hip pocket zip scratches the tank.', status: 'REJECTED', decidedAt: at(6, 10), decidedById: OTHER, decisionNote: 'The pocket is redesigned in next season’s trousers.', priority: 'LOW', createdAt: at(4, 9) }),
  request(5, { source: 'SUPPLIER', party: { id: uid('6301', 2), code: 'DEMO-TANNERY', name: 'Demo Tannery S.p.A.' }, style: GLOVE, revision: { id: G2.id, revision: 2, status: 'RELEASED' }, title: 'Palm leather 0.9 mm instead of 1.0 mm', reason: 'The 1.0 mm goat skin is out until March; 0.9 mm passes the same abrasion class.', status: 'DONE', decidedAt: at(2, 10), decidedById: OTHER, createdAt: at(1, 9) }),
]

// ---- change orders --------------------------------------------------------------------------------------------------------------

function orderRow(n: number, over: Partial<OrderRow>): OrderRow {
  return {
    id: uid('6601', n),
    number: `ECO-DEMO-${String(n).padStart(4, '0')}`,
    companyId: COMPANY_ID,
    style: JACKET,
    fromRevision: { id: J2.id, revision: 2, status: 'RELEASED' },
    toRevision: { id: J3.id, revision: 3, status: 'DRAFT' },
    title: 'Collar 52 and back yoke piping',
    reason: 'Two accepted requests from the brand’s fit round 2.',
    priority: 'HIGH',
    effect: 'NEXT_ORDER',
    effectiveDate: null,
    status: 'SUBMITTED',
    authorId: OTHER,
    approvals: { approved: 1, required: 2 },
    requests: 2,
    createdAt: at(9, 14),
    submittedAt: at(9, 17),
    decidedAt: null,
    releasedAt: null,
    version: 4,
    ...over,
  }
}

export const ORDERS: OrderRow[] = [
  orderRow(1, {}),
  orderRow(2, { style: PANTS, fromRevision: { id: P1.id, revision: 1, status: 'RELEASED' }, toRevision: null, title: 'Knee armour pocket opening', reason: 'Opening the pocket by 2 cm makes the CE armour easier to put in.', status: 'DRAFT', authorId: ME, approvals: { approved: 0, required: 0 }, requests: 0, priority: 'NORMAL', submittedAt: null, version: 1, createdAt: at(10, 8) }),
  orderRow(3, { style: GLOVE, fromRevision: { id: G1.id, revision: 1, status: 'OBSOLETE' }, toRevision: { id: G2.id, revision: 2, status: 'RELEASED' }, title: 'Palm leather 0.9 mm', reason: 'Supplier change accepted after the abrasion test.', status: 'RELEASED', approvals: { approved: 1, required: 1 }, requests: 1, decidedAt: at(3, 11), releasedAt: at(3, 16), effect: 'AT_ONCE', priority: 'NORMAL', createdAt: at(2, 11) }),
  orderRow(4, { title: 'Sleeve pattern 54', reason: 'Sleeve 54 short: re-grade the sleeve from the base size.', status: 'APPROVED', approvals: { approved: 2, required: 2 }, requests: 0, decidedAt: at(10, 7), effect: 'DATE', effectiveDate: '2026-11-16', priority: 'URGENT', authorId: ME, createdAt: at(8, 9), toRevision: { id: uid('6201', 14), revision: 4, status: 'DRAFT' } }),
]

// ---- SMV changes waiting from Operations ----------------------------------------------------------------------------------------

function smv(n: number, operation: { code: string; name: string; standardMinutes: string }, proposal: { basic: string; pct: [string, string, string]; smv: string; from: string; by: { id: string; name: string } }, mayDecide: boolean): SmvWaiting {
  return {
    operation: { id: uid('6901', n), code: operation.code, name: operation.name, companyId: COMPANY_ID, standardMinutes: operation.standardMinutes },
    proposal: {
      id: uid('6902', n),
      number: 3,
      status: 'PROPOSED',
      basicMinutes: proposal.basic,
      personalPct: proposal.pct[0],
      fatiguePct: proposal.pct[1],
      delayPct: proposal.pct[2],
      standardMinutes: proposal.smv,
      source: 'TIME_STUDY',
      effectiveFrom: proposal.from,
      reason: 'New time study after the twin-needle machine came in.',
      proposedBy: proposal.by,
      proposedAt: at(9, 16),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      inForce: false,
      waiting: false,
      version: 1,
    },
    mayDecide,
  }
}

export const SMV: SmvWaiting[] = [
  smv(1, { code: 'DEMO-SEW-ASM', name: 'Sew sleeve assembly', standardMinutes: '14.200' }, { basic: '11.500', pct: ['5', '4', '3'], smv: '12.880', from: '2026-11-12', by: { id: OTHER, name: 'Bianca Demo' } }, true),
  smv(2, { code: 'DEMO-CUT-LEA', name: 'Cut leather panels', standardMinutes: '8.000' }, { basic: '7.000', pct: ['5', '4', '2'], smv: '7.770', from: '2026-11-16', by: { id: ME, name: DEMO_USER.displayName } }, false),
]

// ---- the read --------------------------------------------------------------------------------------------------------------------

const requestCounts = { TO_TRIAGE: 2, ACCEPTED_FREE: 0, MINE: 1, ALL: REQUESTS.length }
const orderCounts = { MINE_TO_APPROVE: 1, TO_RELEASE: 1, RELEASED_THIS_MONTH: 1, OPEN: 3, ALL: ORDERS.length }

export function readOf(requests: RequestRow[] = REQUESTS, orders: OrderRow[] = ORDERS, waiting: SmvWaiting[] | null = SMV, complete = true): ChangesRead {
  const requestList: RequestList = { rows: requests, counts: requestCounts, complete }
  const orderList: OrderList = { rows: orders, counts: orderCounts, complete }
  return { requests: requestList, orders: orderList, smv: waiting ? { rows: waiting, count: waiting.length } : null, smvFailed: false }
}

export const RELEASED: ReleasedList = {
  rows: [
    { style: GLOVE, revision: { id: G2.id, revision: 2, status: 'RELEASED' }, previous: { id: G1.id, revision: 1 }, releasedAt: at(3, 16), releasedById: OTHER, effectiveFrom: '2026-11-03', changeNote: 'Palm leather 0.9 mm goat (supplier change).', changeOrder: { id: ORDERS[2]!.id, number: ORDERS[2]!.number, title: ORDERS[2]!.title } },
    { style: JACKET, revision: { id: J2.id, revision: 2, status: 'RELEASED' }, previous: { id: J1.id, revision: 1 }, releasedAt: at(1, 11), releasedById: ME, effectiveFrom: '2026-11-01', changeNote: 'Elbow armour pocket moved 1 cm up.', changeOrder: null },
    { style: PANTS, revision: { id: P1.id, revision: 1, status: 'RELEASED' }, previous: null, releasedAt: '2026-10-20T10:00:00.000Z', releasedById: OTHER, effectiveFrom: '2026-10-20', changeNote: null, changeOrder: null },
  ],
  complete: true,
}

// ---- one change order, one request ----------------------------------------------------------------------------------------------

const made = (cut: number, cutPieces: number, worked: number, workedPieces: number) => ({ cut: { bundles: cut, pieces: cutPieces }, worked: { bundles: worked, pieces: workedPieces } })
const ok = { allowed: true, refusal: null }
const no = (code: 'ORDER_NOT_DRAFT' | 'ORDER_MOVE' | 'NOT_APPROVED' | 'OWN_APPROVAL' | 'DRAFT_EXISTS' | 'NOT_YET_EFFECTIVE', message = 'refused') => ({ allowed: false, refusal: { code, message } })

export const ORDER: OrderView = {
  ...ORDERS[0]!,
  description: '10 · DEMO-COLLAR: pattern 52 opened by 1 cm.\n40 · DEMO-PIPING-3M: reflective piping across the back yoke (new line).',
  releasedById: null,
  cancelledAt: null,
  cancelReason: null,
  requestsList: [REQUESTS[2]!, { ...REQUESTS[1]!, status: 'ACCEPTED', changeOrder: ORDER_REF }],
  lines: [],
  workInProgress: [
    { id: uid('6602', 1), seq: 1, workOrder: { id: uid('6801', 42), number: 'WO-DEMO-0042', status: 'IN_PROGRESS', siteId: uid('6701', 1), revision: 2 }, disposition: 'FINISH_OLD', note: null, made: made(6, 48, 3, 24) },
    { id: uid('6602', 2), seq: 2, workOrder: { id: uid('6801', 43), number: 'WO-DEMO-0043', status: 'RELEASED', siteId: uid('6701', 1), revision: 2 }, disposition: 'REWORK', note: null, made: made(2, 16, 0, 0) },
  ],
  approvalsList: [
    { id: uid('6603', 1), stage: 1, approverId: THIRD, approverName: 'Carla Demo', required: true, decision: 'APPROVED', decidedAt: at(9, 18), reason: null },
    { id: uid('6603', 2), stage: 1, approverId: ME, approverName: DEMO_USER.displayName, required: true, decision: null, decidedAt: null, reason: null },
  ],
  openWorkOrders: [{ id: uid('6801', 44), number: 'WO-DEMO-0044', status: 'PLANNED', siteId: uid('6701', 1), revision: 2 }],
  compare: { styleId: JACKET.id, from: J2.id, to: J3.id },
  actions: { edit: no('ORDER_NOT_DRAFT'), startDraft: no('ORDER_NOT_DRAFT'), submit: no('ORDER_MOVE'), decide: ok, cancel: ok, release: no('NOT_APPROVED') },
}

export const DRAFT_ORDER: OrderView = {
  ...ORDERS[1]!,
  description: null,
  releasedById: null,
  cancelledAt: null,
  cancelReason: null,
  requestsList: [],
  lines: [],
  workInProgress: [],
  approvalsList: [],
  openWorkOrders: [{ id: uid('6801', 51), number: 'WO-DEMO-0051', status: 'RELEASED', siteId: uid('6701', 1), revision: 1 }],
  compare: null,
  actions: { edit: ok, startDraft: ok, submit: { allowed: false, refusal: { code: 'NO_DRAFT_REVISION', message: 'x' } }, decide: no('ORDER_MOVE'), cancel: ok, release: no('NOT_APPROVED') },
}

export const APPROVED_ORDER: OrderView = {
  ...ORDER,
  ...ORDERS[3]!,
  description: null,
  requestsList: [],
  approvalsList: [
    { id: uid('6603', 3), stage: 1, approverId: OTHER, approverName: 'Bianca Demo', required: true, decision: 'APPROVED', decidedAt: at(10, 6), reason: null },
    { id: uid('6603', 4), stage: 1, approverId: THIRD, approverName: 'Carla Demo', required: true, decision: 'APPROVED', decidedAt: at(10, 7), reason: null },
  ],
  compare: { styleId: JACKET.id, from: J2.id, to: uid('6201', 14) },
  actions: { edit: no('ORDER_NOT_DRAFT'), startDraft: no('ORDER_NOT_DRAFT'), submit: no('ORDER_MOVE'), decide: no('ORDER_MOVE'), cancel: ok, release: no('NOT_YET_EFFECTIVE') },
}

export const REQUEST: RequestView = {
  ...REQUESTS[0]!,
  photosList: [
    { id: uid('6504', 1), originalName: 'sleeve-54-measure.jpg', contentType: 'image/jpeg', sizeBytes: 812_000, availableAt: at(10, 8, 13) },
    { id: uid('6504', 2), originalName: 'pattern-check.jpg', contentType: 'image/jpeg', sizeBytes: 640_000, availableAt: at(10, 8, 14) },
  ],
  moves: [
    { to: 'IN_REVIEW', allowed: true, refusal: null },
    { to: 'ACCEPTED', allowed: true, refusal: null },
    { to: 'REJECTED', allowed: true, refusal: null },
  ],
  made: made(6, 48, 3, 24),
}

export const REJECTED_REQUEST: RequestView = {
  ...REQUESTS[3]!,
  photosList: [],
  moves: [
    { to: 'IN_REVIEW', allowed: false, refusal: { code: 'REQUEST_MOVE', message: 'x' } },
    { to: 'ACCEPTED', allowed: false, refusal: { code: 'REQUEST_MOVE', message: 'x' } },
    { to: 'REJECTED', allowed: false, refusal: { code: 'REQUEST_MOVE', message: 'x' } },
  ],
  made: null,
}

export const ACCEPTED_REQUEST: RequestView = { ...REQUEST, ...REQUESTS[2]!, changeOrder: null, photosList: [], made: null, moves: REJECTED_REQUEST.moves }

// ---- the redline, the drift, the minutes ------------------------------------------------------------------------------------------

const head = (revision: typeof J2, label: string, note: string) => ({ id: revision.id, revision: revision.revision, status: revision.status as 'DRAFT' | 'RELEASED' | 'OBSOLETE', label, note, changeNote: null, releasedAt: null, effectiveFrom: null, effectiveTo: null })

export const COMPARE: VersionsCompareView = {
  style: { id: JACKET.id, code: JACKET.code, name: JACKET.name, sizes: ['48', '50', '52', '54', '56'] },
  before: head(J2, 'Rev 2', 'RELEASED 2026-11-01'),
  after: head(J3, 'Rev 3', 'DRAFT'),
  sections: [
    { id: 'revision', label: 'Revision', fields: [{ id: 'labelTemplate', label: 'Garment label' }], sizes: [], lines: [{ id: J3.id, label: 'Revision', detail: null, before: { fields: { labelTemplate: 'LBL-DEMO r1' } }, after: { fields: { labelTemplate: 'LBL-DEMO r1' } } }], totals: [], summary: { added: 0, removed: 0, changed: 0, unchanged: 1 } },
    {
      id: 'bom',
      label: 'BOM',
      fields: [
        { id: 'qty', label: 'Quantity' },
        { id: 'uom', label: 'Unit' },
        { id: 'wastagePct', label: 'Wastage %' },
      ],
      sizes: ['48', '50', '52', '54', '56'],
      lines: [
        { id: uid('6205', 1), label: '10 · DEMO-COLLAR', detail: 'Collar', before: { fields: { qty: null, uom: 'PCS', wastagePct: '2' }, sizes: { '52': '1.000', '54': '1.000' } }, after: { fields: { qty: null, uom: 'PCS', wastagePct: '2' }, sizes: { '52': '1.050', '54': '1.050' } } },
        { id: uid('6205', 2), label: '40 · DEMO-PIPING-3M', detail: 'Back yoke', before: null, after: { fields: { qty: '0.45', uom: 'M', wastagePct: '5' } } },
        { id: uid('6205', 3), label: '20 · DEMO-COW-12', detail: 'Body', before: { fields: { qty: '1.20', uom: 'M2', wastagePct: '8' } }, after: { fields: { qty: '1.20', uom: 'M2', wastagePct: '8' } } },
      ],
      totals: [{ id: 'lines', label: 'Lines', before: '11', after: '12' }],
      summary: { added: 1, removed: 0, changed: 1, unchanged: 1 },
    },
    {
      id: 'routing',
      label: 'Routing and minutes',
      fields: [{ id: 'standardMinutes', label: 'Standard minutes' }],
      sizes: [],
      lines: [{ id: uid('6206', 1), label: '35 · DEMO-SEW-PIPE', detail: 'Sew piping', before: null, after: { fields: { standardMinutes: '2.400' } } }],
      totals: [
        { id: 'minutesPerGarment', label: 'Minutes per garment', before: '96.300', after: '98.700' },
        { id: 'steps', label: 'Steps', before: '14', after: '15' },
      ],
      summary: { added: 1, removed: 0, changed: 0, unchanged: 14 },
    },
  ],
  differs: [
    { section: 'bom', label: 'BOM', added: 1, removed: 0, changed: 1 },
    { section: 'routing', label: 'Routing and minutes', added: 1, removed: 0, changed: 0 },
  ],
  words: 'BOM: 1 added, 1 changed · Routing and minutes: 1 added',
}

export const DRIFT: StyleDriftView = {
  style: JACKET,
  current: { id: J2.id, revision: 2, status: 'RELEASED' },
  rows: [
    {
      kind: 'QUOTE',
      documentId: uid('6207', 1),
      number: 'Q-DEMO-0031',
      status: 'SENT',
      lineId: uid('6208', 1),
      seq: 10,
      colourway: 'BLK',
      pieces: 120,
      revision: { id: J1.id, revision: 1, status: 'OBSOLETE' },
      against: { id: J2.id, revision: 2, status: 'RELEASED' },
      state: 'DIFFERENT',
      differs: [{ section: 'bom', label: 'BOM', added: 0, removed: 0, changed: 1 }],
      words: 'BOM: 1 changed',
    },
  ],
  held: ['ORDER'],
}

export const MINUTES: OperationMinutesView = {
  operation: { id: SMV[0]!.operation.id, code: 'DEMO-SEW-ASM', name: 'Sew sleeve assembly', companyId: COMPANY_ID, workCentreKind: 'SEWING', status: 'ACTIVE', version: 3 },
  current: { standardMinutes: '14.200', basicMinutes: '12.680', personalPct: '5', fatiguePct: '4', delayPct: '3' },
  governed: true,
  today: '2026-11-10',
  inForce: { standardMinutes: '14.200', versionId: uid('6902', 9), number: 2, effectiveFrom: '2026-10-01' },
  pendingId: SMV[0]!.proposal.id,
  versions: [SMV[0]!.proposal],
  impact: {
    routings: [
      { style: JACKET, revision: { id: J2.id, revision: 2, status: 'RELEASED' }, stepId: uid('6209', 1), seq: 30, standardMinutes: '14.200', runFrom: 'VERSION', timeVersionNumber: 2 },
      { style: PANTS, revision: { id: P1.id, revision: 1, status: 'RELEASED' }, stepId: uid('6209', 2), seq: 20, standardMinutes: '14.200', runFrom: 'VERSION', timeVersionNumber: 2 },
    ],
    pieceRates: { count: 3, rows: null },
  },
  may: { propose: true, decide: true },
}

export const APPROVER_OPTIONS = { people: [{ id: OTHER, name: 'Bianca Demo' }, { id: THIRD, name: 'Carla Demo' }, { id: uid('3333', 4), name: 'Dario Demo' }], authorId: ME }
