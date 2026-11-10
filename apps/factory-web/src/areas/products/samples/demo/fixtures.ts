import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { ApprovalView, FitView, PartyOption, RoundList, RoundRow, RoundView, StyleDetail, StyleOption, WorkOrderOptions } from '../api'
import { samplesCan, type SamplesCan } from '../model'

/**
 * Design-only made-up data of Samples & prototypes (SCR-110 and the round's record): "Demo" styles, brands and people,
 * example numbers (SR-DEMO-…), made-up measures. Nothing here is a real company, person, order or result.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
export const TODAY = '2026-11-10'
export const NOW = '2026-11-10T09:42:00.000Z'
const OTHER = '0190f0e2-3333-7000-8000-000000000002'

/** A made-up uuid in a family. */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The role cases the design names: sales (asks, decides, ships), the production manager (makes, measures), a reader, nobody. */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...template('sales'), ...template('production_manager'), 'sales.samples.view', 'sales.samples.manage', 'sales.samples.decide', 'sales.samples.measure', 'money.price', 'workorders.manage', 'workorders.view', 'compliance.certificates.manage', 'product.styles.view', 'parties.view', 'threads.read'],
  sales: template('sales'),
  production: template('production_manager'),
  planner: template('planner'),
  inspector: template('quality_inspector'),
  warehouse: template('warehouse'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): SamplesCan => samplesCan(ROLE_PERMISSIONS[role])

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

// ---- styles, customers --------------------------------------------------------------------------------------------------

const JACKET = { id: uid('5101', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket' }
const PANTS = { id: uid('5101', 2), code: 'DEMO-PNT-02', name: 'Demo rain trousers' }
const GLOVE = { id: uid('5101', 3), code: 'DEMO-GLV-03', name: 'Demo summer glove' }
const BRAND = { id: uid('5201', 1), code: 'DEMO-BRAND', name: 'Demo Moto Brand' }
const SHOP = { id: uid('5201', 2), code: 'DEMO-SHOP', name: 'Demo Rider Shop' }
const BLACK = uid('5301', 1)
const SAND = uid('5301', 2)
const REV = (style: number, revision: number, status: string) => ({ id: uid('5401', style * 10 + revision), revision, status })

export const CUSTOMERS: PartyOption[] = [
  { id: BRAND.id, code: BRAND.code, legalName: 'Demo Moto Brand S.r.l.', tradeName: BRAND.name },
  { id: SHOP.id, code: SHOP.code, legalName: 'Demo Rider Shop', tradeName: null },
]

export const STYLE_OPTIONS: StyleOption[] = [
  { id: JACKET.id, code: JACKET.code, name: JACKET.name, companyId: COMPANY_ID, sizes: ['48', '50', '52', '54', '56'], baseSize: '52', status: 'ACTIVE' },
  { id: PANTS.id, code: PANTS.code, name: PANTS.name, companyId: COMPANY_ID, sizes: ['S', 'M', 'L', 'XL'], baseSize: 'M', status: 'ACTIVE' },
  { id: GLOVE.id, code: GLOVE.code, name: GLOVE.name, companyId: null, sizes: ['8', '9', '10', '11'], baseSize: '9', status: 'ACTIVE' },
]

export const JACKET_DETAIL: StyleDetail = {
  ...STYLE_OPTIONS[0]!,
  brand: BRAND,
  revisions: [REV(1, 1, 'RELEASED'), REV(1, 2, 'DRAFT')],
  colourways: [
    { id: BLACK, code: 'BLK', name: 'Black', status: 'ACTIVE', offeredSizes: ['48', '50', '52', '54', '56'] },
    { id: SAND, code: 'SND', name: 'Sand', status: 'ACTIVE', offeredSizes: ['50', '52', '54'] },
  ],
}

// ---- rounds ------------------------------------------------------------------------------------------------------------------

type Charge = RoundRow['chargeAmountMinor']
const charge = (minor: number | null): Charge => minor as Charge

function row(n: number, over: Partial<RoundRow>): RoundRow {
  const kind = over.kind ?? 'FIT'
  const roundNo = over.roundNo ?? 1
  const cells = over.cells ?? [
    { colourwayId: BLACK, colourwayCode: 'BLK', size: '52', quantity: 2 },
    { colourwayId: BLACK, colourwayCode: 'BLK', size: '54', quantity: 1 },
  ]
  return {
    id: uid('5501', n),
    number: `SR-DEMO-${String(n).padStart(4, '0')}`,
    companyId: COMPANY_ID,
    style: JACKET,
    revision: REV(1, 1, 'RELEASED'),
    kind,
    roundNo,
    label: `${kind} · round ${roundNo}`,
    party: BRAND,
    cells,
    pieces: cells.reduce((sum, cell) => sum + cell.quantity, 0),
    dueDate: '2026-11-14',
    daysLate: null,
    stage: 'REQUESTED',
    decision: null,
    decidedAt: null,
    createdById: ME,
    createdAt: at(2),
    openComments: 0,
    workOrders: 0,
    shipments: 0,
    chargeAmountMinor: charge(null),
    chargeCurrency: null,
    version: 3,
    ...over,
  }
}

export const ROWS: RoundRow[] = [
  row(1, { kind: 'PROTO', roundNo: 1, style: PANTS, revision: REV(2, 1, 'DRAFT'), party: null, stage: 'REQUESTED', dueDate: '2026-11-12', createdById: OTHER, cells: [{ colourwayId: null, colourwayCode: null, size: 'M', quantity: 1 }] }),
  row(2, { kind: 'SALESMAN', roundNo: 1, stage: 'IN_MAKING', dueDate: '2026-11-07', daysLate: 3, workOrders: 1, chargeAmountMinor: charge(42000), chargeCurrency: 'EUR' }),
  row(3, { kind: 'FIT', roundNo: 2, stage: 'UNDER_REVIEW', dueDate: '2026-11-11', openComments: 2, workOrders: 1, shipments: 1, chargeAmountMinor: charge(9500), chargeCurrency: 'EUR' }),
  row(4, { kind: 'PRE_PRODUCTION', roundNo: 1, stage: 'SENT', party: SHOP, dueDate: '2026-11-13', workOrders: 1, shipments: 1, createdById: OTHER }),
  row(5, { kind: 'CERTIFICATION', roundNo: 1, style: GLOVE, revision: REV(3, 1, 'RELEASED'), party: null, stage: 'SENT', dueDate: '2026-11-20', cells: [{ colourwayId: null, colourwayCode: null, size: '9', quantity: 4 }], shipments: 1 }),
  row(6, { kind: 'FIT', roundNo: 1, stage: 'DECIDED', decision: 'REJECTED', decidedAt: at(3), dueDate: '2026-11-04', workOrders: 1, shipments: 1 }),
  row(7, { kind: 'PROTO', roundNo: 2, style: PANTS, revision: REV(2, 1, 'DRAFT'), party: null, stage: 'DECIDED', decision: 'APPROVED', decidedAt: at(5), dueDate: '2026-11-06', createdById: OTHER }),
  row(8, { kind: 'BRAND', roundNo: 1, stage: 'CANCELLED', dueDate: null, createdById: OTHER }),
]

const lanes = (rows: readonly RoundRow[]): RoundList['lanes'] =>
  (['REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW', 'DECIDED'] as const).map((stage) => ({ stage, count: rows.filter((one) => one.stage === stage).length }))

export function listOf(rows: readonly RoundRow[] = ROWS, complete = true): RoundList {
  return {
    rows: [...rows],
    counts: { OPEN: 5, DUE_THIS_WEEK: 3, LATE: 1, WAITING_DECISION: 1, REJECTED_THIS_MONTH: 1, ALL: ROWS.length },
    lanes: lanes(rows),
    complete,
  }
}

// ---- one round: SR-DEMO-0003, Fit · round 2, under review -------------------------------------------------------------------

const allowed = { allowed: true, refusal: null }
const refused = (code: 'ROUND_CLOSED' | 'REVISION_FROZEN' | 'NO_WORK_ORDER', message: string) => ({ allowed: false, refusal: { code, message } })

export const ROUND: RoundView = {
  ...ROWS[2]!,
  style: { ...JACKET, lifecycle: 'IN_DEVELOPMENT', status: 'ACTIVE', brandPartyId: BRAND.id },
  releasedRevision: null,
  instructions: 'Sleeve shortened by 1 cm after round 1; check the elbow armour pocket with the CE protector in.',
  createdBy: { id: ME, name: 'Alex Demo' },
  decisionComments: null,
  decidedVia: null,
  decidedById: null,
  approvalRequestId: null,
  testZones: null,
  testResult: null,
  certificate: null,
  cancelledAt: null,
  cancelReason: null,
  workOrdersList: [{ id: uid('5601', 1), number: 'WO-DEMO-0042', status: 'COMPLETED', site: { id: uid('5701', 1), code: 'DEMO-PLANT' }, pieces: 3, dueDate: '2026-11-08', releasedAt: at(3, 8), startedAt: at(4, 7), completedAt: at(6, 15) }],
  workOrdersHeld: 0,
  shipmentsList: [
    {
      id: uid('5801', 1),
      roundId: uid('5501', 3),
      direction: 'OUTBOUND',
      party: BRAND,
      shipToAddress: { id: uid('5901', 1), name: 'Demo Moto Brand — design office', line1: 'Via Esempio 1', postalCode: '00100', city: 'Roma', country: 'IT' },
      carrierName: 'Demo Courier',
      trackingNumber: 'DEMO123456',
      trackingUrl: 'https://tracking.example.com/DEMO123456',
      sentAt: at(7, 10),
      receivedAt: at(8, 11),
      note: null,
      removable: false,
      createdAt: at(7, 9),
      version: 3,
    },
  ],
  measurements: 6,
  swatches: 1,
  moves: [
    { to: 'REQUESTED', allowed: true, refusal: null },
    { to: 'IN_MAKING', allowed: true, refusal: null },
    { to: 'SENT', allowed: true, refusal: null },
    { to: 'UNDER_REVIEW', allowed: false, refusal: { code: 'SAME_STAGE', message: 'Already under review.' } },
  ],
  actions: { edit: allowed, changeRevision: refused('REVISION_FROZEN', 'Pinned.'), cancel: allowed, makeWorkOrder: allowed, addShipment: allowed },
}

export const REQUESTED_ROUND: RoundView = {
  ...ROUND,
  ...ROWS[0]!,
  style: { ...PANTS, lifecycle: 'IN_DEVELOPMENT', status: 'ACTIVE', brandPartyId: null },
  instructions: null,
  workOrdersList: [],
  shipmentsList: [],
  measurements: 0,
  swatches: 0,
  createdBy: { id: OTHER, name: 'Sam Demo' },
  moves: ROUND.moves.map((move) => (move.to === 'REQUESTED' ? { to: move.to, allowed: false, refusal: { code: 'SAME_STAGE', message: 'Already requested.' } } : { ...move, allowed: true, refusal: null })),
  actions: { edit: allowed, changeRevision: allowed, cancel: allowed, makeWorkOrder: allowed, addShipment: allowed },
}

export const DECIDED_ROUND: RoundView = {
  ...ROUND,
  ...ROWS[5]!,
  style: ROUND.style,
  decisionComments: 'Collar too tight in 52; sleeve still 1 cm long.',
  decidedVia: 'LINK',
  decidedById: null,
  createdBy: { id: ME, name: 'Alex Demo' },
  instructions: ROUND.instructions,
  moves: ROUND.moves.map((move) => ({ ...move, allowed: false, refusal: { code: 'ROUND_CLOSED', message: 'Decided.' } })),
  actions: { edit: refused('ROUND_CLOSED', 'Decided.'), changeRevision: refused('ROUND_CLOSED', 'Decided.'), cancel: refused('ROUND_CLOSED', 'Decided.'), makeWorkOrder: refused('NO_WORK_ORDER', 'Decided.'), addShipment: allowed },
}

export const CE_ROUND: RoundView = {
  ...ROUND,
  ...ROWS[4]!,
  style: { ...GLOVE, lifecycle: 'IN_DEVELOPMENT', status: 'ACTIVE', brandPartyId: null },
  createdBy: { id: ME, name: 'Alex Demo' },
  testZones: 'Size 9: palm and knuckle zones (EN 13594 impact and abrasion).',
  instructions: null,
  workOrdersList: [],
  shipmentsList: [{ ...ROUND.shipmentsList[0]!, id: uid('5801', 2), roundId: uid('5501', 5), party: { id: uid('5201', 9), code: 'DEMO-NB', name: 'Demo Notified Body' }, shipToAddress: null, receivedAt: null, removable: false }],
}

const ROUND_ACTION = { allowed: true, refusal: null, needs: null }
const DECIDE_HELD = { allowed: false, refusal: { code: 'NOTHING_MADE' as const, message: 'Nothing made.' }, needs: null }

export const APPROVAL: ApprovalView = {
  round: { id: ROUND.id, number: ROUND.number, kind: ROUND.kind, roundNo: ROUND.roundNo, stage: ROUND.stage, partyId: BRAND.id, styleId: JACKET.id, revision: ROUND.revision, version: ROUND.version },
  decision: null,
  request: null,
  swatches: [
    {
      id: uid('6001', 1),
      styleId: JACKET.id,
      style: { code: JACKET.code, name: JACKET.name },
      roundId: ROUND.id,
      roundNumber: ROUND.number,
      party: BRAND,
      kind: 'LEATHER',
      item: { id: uid('6101', 1), code: 'DEMO-COW-12', name: 'Demo cowhide 1.2 mm', kind: 'LEATHER' },
      itemColour: { id: uid('6201', 1), code: 'BLK', name: 'Black' },
      lot: null,
      note: null,
      sentAt: at(7, 10),
      approvalRequestId: null,
      decision: null,
      decisionComments: null,
      decidedAt: null,
      decidedVia: null,
      decidedBy: null,
      signedAs: null,
      waiting: null,
      companyId: COMPANY_ID,
      actions: { edit: ROUND_ACTION, send: { allowed: false, refusal: { code: 'SENT_ONCE', message: 'Sent.' }, needs: null }, remove: ROUND_ACTION, decide: ROUND_ACTION, ask: ROUND_ACTION },
      createdAt: at(6),
      version: 2,
    },
  ],
  certification: null,
  changeRequests: [],
  actions: { decide: ROUND_ACTION, askBrand: ROUND_ACTION, nextRound: { allowed: false, refusal: { code: 'NOT_REJECTED', message: 'Not rejected.' }, needs: null }, testResult: { allowed: false, refusal: { code: 'CERTIFICATION_ONLY', message: 'CE only.' }, needs: null }, raiseChangeRequest: ROUND_ACTION },
}

export const APPROVAL_ASKED: ApprovalView = {
  ...APPROVAL,
  request: { id: uid('6301', 1), status: 'OPEN', dueAt: at(14, 17), answeredAt: null, createdAt: at(8, 12), version: 1 },
  actions: { ...APPROVAL.actions, decide: { allowed: false, refusal: { code: 'BRAND_ASKED', message: 'Asked.' }, needs: null }, askBrand: { allowed: false, refusal: { code: 'BRAND_ASKED', message: 'Asked.' }, needs: null } },
}

export const APPROVAL_REJECTED: ApprovalView = {
  ...APPROVAL,
  round: { ...APPROVAL.round, id: DECIDED_ROUND.id, number: DECIDED_ROUND.number, roundNo: 1, stage: 'DECIDED' },
  decision: { decision: 'REJECTED', comments: DECIDED_ROUND.decisionComments, at: at(3, 16), via: 'LINK', by: null, signedAs: 'Anna Demo', revision: 1 },
  request: { id: uid('6301', 2), status: 'REFUSED', dueAt: at(5, 17), answeredAt: at(3, 16), createdAt: at(1, 9), version: 2 },
  swatches: [],
  changeRequests: [{ id: uid('6401', 1), number: 'CR-DEMO-0007', status: 'OPEN', title: 'Collar 52: open the neck by 1 cm' }],
  actions: { ...APPROVAL.actions, decide: { allowed: false, refusal: { code: 'ROUND_CLOSED', message: 'Decided.' }, needs: null }, askBrand: { allowed: false, refusal: { code: 'ROUND_CLOSED', message: 'Decided.' }, needs: null }, nextRound: ROUND_ACTION },
}

export const APPROVAL_CE: ApprovalView = {
  ...APPROVAL,
  round: { ...APPROVAL.round, id: CE_ROUND.id, number: CE_ROUND.number, kind: 'CERTIFICATION', roundNo: 1, stage: 'SENT', partyId: null },
  swatches: [],
  certification: { sentTo: [{ id: uid('5201', 9), code: 'DEMO-NB', name: 'Demo Notified Body', sentAt: at(7, 10), receivedAt: null }], testZones: CE_ROUND.testZones, testResult: 'PASSED', certificate: { id: uid('6501', 1), number: 'CERT-DEMO-0003', standard: 'EN 13594:2015', notifiedBodyNumber: '0000', validTo: '2031-11-01', status: 'VALID' } },
  actions: { ...APPROVAL.actions, askBrand: { allowed: false, refusal: { code: 'INTERNAL_ROUND', message: 'Internal.' }, needs: null }, testResult: { allowed: false, refusal: { code: 'RESULT_ONCE', message: 'Once.' }, needs: null } },
}

export const APPROVAL_SALES_READER: ApprovalView = { ...APPROVAL, actions: { ...APPROVAL.actions, decide: { allowed: false, refusal: null, needs: 'sales.samples.decide' }, askBrand: { allowed: false, refusal: null, needs: 'sales.samples.decide' }, raiseChangeRequest: { allowed: false, refusal: null, needs: 'product.changes.request' } } }
export const APPROVAL_REQUESTED: ApprovalView = { ...APPROVAL, round: { ...APPROVAL.round, stage: 'REQUESTED' }, swatches: [], actions: { ...APPROVAL.actions, decide: DECIDE_HELD, askBrand: DECIDE_HELD } }

// ---- the fit ------------------------------------------------------------------------------------------------------------------

const point = (n: number, code: string, name: string) => ({ pointOfMeasureId: uid('6601', n), code, name, uom: 'cm', inSpec: true })
const spec = (nominal: string, tolerance: string) => ({ nominal, toleranceMinus: tolerance, tolerancePlus: tolerance })
const measured = (n: number, nominal: string, tolerance: string, value: string | null, difference: string | null, pass: boolean | null) => ({ id: uid('6701', n), nominal, toleranceMinus: tolerance, tolerancePlus: tolerance, measured: value, difference, pass, measuredAt: value ? at(9, 10) : null, note: null, version: 1 })

export const FIT: FitView = {
  round: { id: ROUND.id, number: ROUND.number, stage: ROUND.stage, revision: ROUND.revision, companyId: COMPANY_ID, version: ROUND.version },
  spec: { id: uid('6801', 1), status: 'APPROVED', baseSize: '52' },
  sizes: ['52', '54'],
  points: [
    { ...point(1, 'CHEST_W', 'Chest ½'), cells: [{ size: '52', spec: spec('56', '1'), measurement: measured(1, '56', '1', '56.5', '+0.5', true) }, { size: '54', spec: spec('58', '1'), measurement: measured(2, '58', '1', '58', '0', true) }] },
    { ...point(2, 'SLEEVE_LEN', 'Sleeve length'), cells: [{ size: '52', spec: spec('64', '1'), measurement: measured(3, '64', '1', '66', '+2', false) }, { size: '54', spec: spec('65', '1'), measurement: measured(4, '65', '1', '65.5', '+0.5', true) }] },
    { ...point(3, 'BACK_LEN', 'Back length'), cells: [{ size: '52', spec: spec('71', '1'), measurement: measured(5, '71', '1', '70.5', '-0.5', true) }, { size: '54', spec: spec('72', '1'), measurement: null }] },
    { ...point(4, 'COLLAR', 'Collar circumference'), cells: [{ size: '52', spec: spec('42', '0.5'), measurement: measured(6, '42', '0.5', '41.2', '-0.8', false) }, { size: '54', spec: spec('43', '0.5'), measurement: null }] },
  ],
  outside: [
    { pomCode: 'SLEEVE_LEN', size: '52', measured: '66', nominal: '64', difference: '+2', words: '' },
    { pomCode: 'COLLAR', size: '52', measured: '41.2', nominal: '42', difference: '-0.8', words: '' },
  ],
  measuredCount: 6,
  comments: [
    { id: uid('6901', 1), pointOfMeasureId: uid('6601', 4), pomCode: 'COLLAR', bodyArea: null, text: 'Collar presses on the throat when the jacket is closed.', resolved: false, resolvedAt: null, resolvedBy: null, createdBy: { id: OTHER, name: 'Sam Demo' }, createdAt: at(9, 10, 20), photos: [{ id: uid('7001', 1), originalName: 'collar-demo.jpg', contentType: 'image/jpeg' }], version: 1 },
    { id: uid('6901', 2), pointOfMeasureId: null, pomCode: null, bodyArea: 'Left elbow', text: 'Armour pocket sits 2 cm low with the protector in.', resolved: false, resolvedAt: null, resolvedBy: null, createdBy: { id: ME, name: 'Alex Demo' }, createdAt: at(9, 10, 32), photos: [], version: 1 },
    { id: uid('6901', 3), pointOfMeasureId: uid('6601', 1), pomCode: 'CHEST_W', bodyArea: null, text: 'Chest fine after round 1.', resolved: true, resolvedAt: at(9, 11), resolvedBy: { id: ME, name: 'Alex Demo' }, createdBy: { id: ME, name: 'Alex Demo' }, createdAt: at(9, 10, 5), photos: [], version: 2 },
  ],
  openComments: 2,
  editable: true,
  refusal: null,
}

export const FIT_CLOSED: FitView = { ...FIT, editable: false, refusal: { code: 'FIT_CLOSED', message: 'Closed.' } }
export const FIT_NO_SPEC: FitView = { ...FIT, spec: null, points: [], outside: [], measuredCount: 0, comments: [], openComments: 0 }

// ---- Make sample work order ------------------------------------------------------------------------------------------------

export const WO_OPTIONS: WorkOrderOptions = {
  round: { id: REQUESTED_ROUND.id, number: REQUESTED_ROUND.number, stage: 'REQUESTED', version: 3, revision: REQUESTED_ROUND.revision, partyId: null },
  lines: [
    { id: uid('7101', 1), orderId: uid('7201', 1), orderNumber: 'SO-DEMO-0012', seq: 10, partyId: SHOP.id, colourwayId: BLACK, colourwayCode: 'BLK', styleRevisionId: null, siteId: uid('5701', 1), open: [{ size: 'M', ordered: 20, onWorkOrders: 5, open: 15 }], proposed: [{ size: 'M', quantity: 1 }] },
  ],
  sites: [{ id: uid('5701', 1), code: 'DEMO-PLANT', name: 'Demo plant' }],
  blockers: [],
  warnings: ['Draft revision'],
}
export const WO_OPTIONS_NONE: WorkOrderOptions = { ...WO_OPTIONS, lines: [], blockers: ['No line'], warnings: [] }
