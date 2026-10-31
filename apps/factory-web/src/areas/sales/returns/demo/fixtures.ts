import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { CreditNotes, PartyOption, Person, ReasonOption, Repair, RepairCounts, RepairRow, ReturnableLine, ReturnCounts, ReturnLine, ReturnRow, Rma } from '../api'
import { returnsCan, type ReturnsCan } from '../model'

/**
 * Made-up data of the Returns & repairs design cases (SCR-111, SCR-112): "Demo" customers, styles and people, example
 * numbers (RMA-DEMO-…, REP-DEMO-…), made-up words. Nothing here is a real company, person, garment, price or return. The
 * role cases the Owner reviews: the owner, a sales person (opens returns, decides, sees prices), the warehouse (receives,
 * grades, sends back), the quality inspector (grades, signs the safety check), finance (reads; credit notes) and a
 * read-only person.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
export const TODAY = '2026-10-31'
export const NOW = '2026-10-31T09:42:00.000Z'
const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

const templatePermissions = (key: string, grains: readonly string[] = []): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view', ...grains.map((grain) => `money.${grain}`)]

export const ROLE_PERMISSIONS = {
  owner: [
    'home.view',
    'sales.returns.view',
    'sales.returns.manage',
    'sales.returns.receive',
    'sales.returns.inspect',
    'sales.returns.decide',
    'sales.repairs.view',
    'sales.repairs.manage',
    'sales.repairs.receive',
    'sales.repairs.check',
    'sales.repairs.ship',
    'shipping.ddt.issue',
    'orders.manage',
    'orders.view',
    'invoices.view',
    'invoices.manage',
    'workorders.view',
    'workorders.manage',
    'parties.view',
    'files.read',
    'files.upload',
    'threads.read',
    'tasks.manage',
    'quotes.view',
    'sales.settings.manage',
    'numbering.view',
    'reasons.view',
    'reasons.manage',
    'money.price',
    'money.margin',
  ],
  sales: templatePermissions('sales', ['price', 'margin']),
  warehouse: templatePermissions('warehouse'),
  inspector: templatePermissions('quality_inspector'),
  finance: templatePermissions('finance', ['price', 'cost', 'margin']),
  readOnly: ['home.view', 'sales.returns.view', 'sales.repairs.view', 'quotes.view', 'files.read', 'threads.read'],
  none: ['home.view'],
} as const

export type RoleCase = keyof typeof ROLE_PERMISSIONS
export const canFor = (role: RoleCase): ReturnsCan => returnsCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
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

// ---- made-up parties, people, reasons -------------------------------------------------------------------------------------

export const CUSTOMER = { id: uid('7701', 1), code: 'DEMO-C01', legalName: 'Moto Demo Srl' }
const CUSTOMER_2 = { id: uid('7701', 2), code: 'DEMO-C02', legalName: 'Demo Racing Team' }
export const CUSTOMERS: PartyOption[] = [
  { ...CUSTOMER, tradeName: null },
  { ...CUSTOMER_2, tradeName: null },
]
export const PEOPLE: Person[] = [
  { id: ME, name: 'Alex Demo' },
  { id: uid('7702', 2), name: 'Bea Demo' },
  { id: uid('7702', 3), name: 'Carlo Demo' },
]
export const REASONS: ReasonOption[] = [
  { code: 'DEFECT', labelIt: 'Difetto', labelEn: 'Defect', needsDetail: false },
  { code: 'WRONG_SIZE', labelIt: 'Taglia sbagliata', labelEn: 'Wrong size', needsDetail: false },
  { code: 'NOT_AS_ORDERED', labelIt: 'Non come ordinato', labelEn: 'Not as ordered', needsDetail: false },
  { code: 'DAMAGED_TRANSIT', labelIt: 'Danneggiato nel trasporto', labelEn: 'Damaged in transit', needsDetail: false },
]
const SITE = { id: uid('7703', 1), code: 'A1', name: 'Demo plant' }
const JACKET = { id: uid('7704', 1), code: 'JK-DEMO-100', name: 'Demo touring jacket' }
const PANTS = { id: uid('7704', 2), code: 'PT-DEMO-200', name: 'Demo touring pants' }
const RED = { id: uid('7705', 1), code: 'RED', name: 'Red' }
const BLACK = { id: uid('7705', 2), code: 'BLK', name: 'Black' }

// ---- the list ------------------------------------------------------------------------------------------------------------

const returnRow = (n: number, over: Partial<ReturnRow>): ReturnRow => ({
  id: uid('7710', n),
  number: `RMA-DEMO-000${n}`,
  companyId: COMPANY_ID,
  siteId: SITE.id,
  site: { id: SITE.id, code: SITE.code },
  partyId: CUSTOMER.id,
  party: CUSTOMER,
  customerRef: null,
  salesOrder: { id: uid('7711', n), number: `SO-DEMO-00${n}` },
  invoiceNumbers: [`FT-DEMO-00${n}`],
  units: 2,
  receivedUnits: 0,
  reasonCodes: ['DEFECT'],
  reason: { code: 'DEFECT', labelIt: 'Difetto', labelEn: 'Defect' },
  status: 'AUTHORISED',
  dispositions: [],
  receivedAt: null,
  goodsDueBy: '2026-11-14',
  late: false,
  currency: 'EUR',
  creditTotal: 0,
  replacementOrder: null,
  ownerId: ME,
  requestedAt: at(30 - n),
  updatedAt: at(30 - n),
  ...over,
})

export const RETURN_ROWS: ReturnRow[] = [
  returnRow(1, {}),
  returnRow(2, { status: 'RECEIVED', units: 1, receivedUnits: 1, receivedAt: at(28, 15), party: CUSTOMER_2, partyId: CUSTOMER_2.id, customerRef: 'RET-DEMO-7', reasonCodes: ['WRONG_SIZE'], reason: { code: 'WRONG_SIZE', labelIt: 'Taglia sbagliata', labelEn: 'Wrong size' }, ownerId: PEOPLE[1]!.id }),
  returnRow(3, { status: 'INSPECTED', units: 3, receivedUnits: 3, receivedAt: at(25), dispositions: ['CREDIT_ONLY', 'REPLACE'], creditTotal: 25000, reasonCodes: ['DEFECT', 'NOT_AS_ORDERED'] }),
  returnRow(4, { status: 'AUTHORISED', goodsDueBy: '2026-10-20', late: true, ownerId: null }),
]
export const CLOSED_RETURN = returnRow(5, { status: 'CLOSED', units: 1, receivedUnits: 1, receivedAt: at(10), dispositions: ['CREDIT_ONLY'], creditTotal: 12000, goodsDueBy: '2026-10-15' })

const repairRow = (n: number, over: Partial<RepairRow>): RepairRow => ({
  id: uid('7720', n),
  number: `REP-DEMO-000${n}`,
  kind: 'REPAIR',
  stage: 'RECEIVED',
  companyId: COMPANY_ID,
  siteId: SITE.id,
  siteCode: SITE.code,
  party: CUSTOMER,
  serial: `S-DEMO-00043${n}`,
  style: JACKET,
  size: '52',
  problem: 'The left elbow seam opened after a slide (made-up).',
  source: 'HAND',
  returnNumber: null,
  complaintNumber: null,
  receivedAt: at(29),
  repairedAt: null,
  shippedAt: null,
  safety: 'NOT_CHECKED',
  workOrder: null,
  ownerId: ME,
  createdAt: at(29 - n, 11),
  ...over,
})

export const REPAIR_ROWS: RepairRow[] = [
  repairRow(1, {}),
  repairRow(2, { stage: 'IN_REPAIR', source: 'RETURN', returnNumber: 'RMA-DEMO-0003', workOrder: { id: uid('7730', 1), number: 'WO-DEMO-0201', status: 'IN_PROGRESS' }, ownerId: PEOPLE[2]!.id }),
  repairRow(3, { stage: 'REPAIRED', repairedAt: at(30, 16), safety: 'NOT_CHECKED', source: 'COMPLAINT', complaintNumber: 'CMP-DEMO-0012' }),
  repairRow(4, { kind: 'ALTERATION', stage: 'AWAITING_GOODS', receivedAt: null, style: PANTS, size: '50', problem: 'Shorten the legs by 3 cm (made-up).', safety: 'NOT_REQUIRED' }),
]

export const RETURN_COUNTS: ReturnCounts = { waiting: 2, late: 1, toInspect: 1, toDecide: 1, replacement: 1, open: 4 }
export const REPAIR_COUNTS: RepairCounts = { awaiting: 1, received: 1, inRepair: 1, toCheck: 1, toShip: 0, open: 4 }

// ---- an RMA --------------------------------------------------------------------------------------------------------------

const line = (n: number, over: Partial<ReturnLine>): ReturnLine => ({
  id: uid('7740', n),
  seq: n * 10,
  salesOrderLineId: uid('7741', n),
  size: '52',
  invoiceLineId: uid('7742', n),
  order: { id: uid('7711', 3), number: 'SO-DEMO-003', lineSeq: n * 10 },
  invoice: { id: uid('7743', 3), number: 'FT-DEMO-003', issueDate: '2026-10-05', lineSeq: n },
  style: JACKET,
  colourway: RED,
  ppe: true,
  safety: false,
  description: 'Demo touring jacket, Red, size 52',
  serial: null,
  batchNumber: 'B-DEMO-0142',
  quantity: 1,
  reasonCode: 'DEFECT',
  reason: { code: 'DEFECT', labelIt: 'Difetto', labelEn: 'Defect', active: true },
  reasonNote: 'Zip of the left pocket broke (made-up).',
  currency: 'EUR',
  unitPrice: '250.00',
  discountPct: '0',
  receivedQuantity: 0,
  receivedAt: null,
  receiptId: null,
  receivedValue: null,
  grade: null,
  cause: null,
  conditionNote: null,
  inspectedAt: null,
  photos: 0,
  suggestedOutcome: null,
  restockHeld: null,
  disposition: null,
  goodsOutcome: null,
  decidedAt: null,
  creditAmount: null,
  followUp: null,
  stock: [],
  replacementLineId: null,
  version: 1,
  ...over,
})

const ACTIONS_AUTHORISED: Rma['actions'] = [
  { action: 'editLines', allowed: true },
  { action: 'receive', allowed: true },
  { action: 'inspect', allowed: false },
  { action: 'decide', allowed: false },
  { action: 'makeReplacement', allowed: false },
  { action: 'issueReturnDdt', allowed: false },
  { action: 'cancel', allowed: true },
  { action: 'close', allowed: true },
]

export const RMA_AUTHORISED: Rma = {
  id: uid('7710', 1),
  number: 'RMA-DEMO-0001',
  companyId: COMPANY_ID,
  company: { id: COMPANY_ID, code: 'DEMO', name: 'Demo company' },
  siteId: SITE.id,
  site: SITE,
  partyId: CUSTOMER.id,
  party: CUSTOMER,
  contactId: null,
  customerRef: 'RET-DEMO-3',
  salesOrder: { id: uid('7711', 3), number: 'SO-DEMO-003' },
  status: 'AUTHORISED',
  requestedAt: at(29, 10),
  authorisedAt: at(29, 10),
  goodsDueBy: '2026-11-14',
  late: false,
  receivedAt: null,
  inspectedAt: null,
  closedAt: null,
  statusReason: null,
  ownerId: ME,
  internalNote: null,
  replacementOrder: null,
  currency: 'EUR',
  creditTotal: 0,
  lines: [line(1, {}), line(2, { style: PANTS, colourway: BLACK, description: 'Demo touring pants, Black, size 50', size: '50', quantity: 2, reasonCode: 'WRONG_SIZE', reason: { code: 'WRONG_SIZE', labelIt: 'Taglia sbagliata', labelEn: 'Wrong size', active: true }, reasonNote: null, unitPrice: '180.00', discountPct: '10', ppe: false })],
  receipts: [],
  ddts: { live: [], cancelled: [] },
  tracking: [
    { step: 'REQUESTED', state: 'DONE', at: at(29, 10) },
    { step: 'AUTHORISED', state: 'DONE', at: at(29, 10) },
    { step: 'GOODS_BACK', state: 'CURRENT', at: null },
    { step: 'INSPECTED', state: 'WAITING', at: null },
    { step: 'OUTCOME', state: 'WAITING', at: null },
  ],
  actions: ACTIONS_AUTHORISED,
  closeWarnings: [],
  policy: { windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: 'Unworn, with labels (made-up).', freightPaidByNow: null },
  version: 3,
  createdAt: at(29, 10),
  updatedAt: at(29, 10),
}

export const RMA_RECEIVED: Rma = {
  ...RMA_AUTHORISED,
  status: 'RECEIVED',
  receivedAt: at(30, 14),
  lines: [
    line(1, { receivedQuantity: 1, receivedAt: at(30, 14), receiptId: uid('7750', 1), receivedValue: 25000, grade: 'DAMAGED', cause: 'OUR_DEFECT', conditionNote: 'Pocket zip torn out (made-up).', photos: 2, suggestedOutcome: 'QUARANTINE', restockHeld: 'safety', safety: true, inspectedAt: at(30, 15) }),
    line(2, { style: PANTS, colourway: BLACK, description: 'Demo touring pants, Black, size 50', size: '50', quantity: 2, receivedQuantity: 2, receivedAt: at(30, 14), receiptId: uid('7750', 1), receivedValue: 32400, grade: null, ppe: false, unitPrice: '180.00', discountPct: '10' }),
  ],
  receipts: [{ id: uid('7750', 1), receivedAt: at(30, 14), parcels: 1, parcelCondition: 'INTACT', carrierName: 'Demo courier', trackingNumber: 'TRK-DEMO-1', customerDdtNumber: 'C-DDT-DEMO-9', customerDdtDate: '2026-10-28', note: null, photos: 1, lineIds: [uid('7740', 1), uid('7740', 2)] }],
  tracking: [
    { step: 'REQUESTED', state: 'DONE', at: at(29, 10) },
    { step: 'AUTHORISED', state: 'DONE', at: at(29, 10) },
    { step: 'GOODS_BACK', state: 'DONE', at: at(30, 14) },
    { step: 'INSPECTED', state: 'CURRENT', at: null },
    { step: 'OUTCOME', state: 'WAITING', at: null },
  ],
  actions: [
    { action: 'editLines', allowed: false },
    { action: 'receive', allowed: false },
    { action: 'inspect', allowed: true },
    { action: 'decide', allowed: true },
    { action: 'makeReplacement', allowed: false },
    { action: 'issueReturnDdt', allowed: false },
    { action: 'cancel', allowed: false },
    { action: 'close', allowed: false },
  ],
  policy: { ...RMA_AUTHORISED.policy, freightPaidByNow: 'COMPANY' },
  version: 6,
}

export const RMA_INSPECTED: Rma = {
  ...RMA_RECEIVED,
  status: 'INSPECTED',
  inspectedAt: at(31, 8),
  creditTotal: 32400,
  replacementOrder: null,
  lines: [
    { ...RMA_RECEIVED.lines[0]!, disposition: 'REPLACE', goodsOutcome: 'QUARANTINE', decidedAt: at(31, 8), creditAmount: 0, followUp: 'REPLACEMENT_ORDER', stock: [{ moveId: uid('7760', 1), locationId: uid('7761', 1), locationCode: 'A1-QUA', quantity: '1' }] },
    { ...RMA_RECEIVED.lines[1]!, grade: 'LIKE_NEW', cause: 'NO_FAULT', disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', decidedAt: at(31, 8), creditAmount: 32400, followUp: 'CREDIT_NOTE', stock: [{ moveId: uid('7760', 2), locationId: uid('7761', 2), locationCode: 'A1-FG', quantity: '2' }] },
  ],
  tracking: [
    { step: 'REQUESTED', state: 'DONE', at: at(29, 10) },
    { step: 'AUTHORISED', state: 'DONE', at: at(29, 10) },
    { step: 'GOODS_BACK', state: 'DONE', at: at(30, 14) },
    { step: 'INSPECTED', state: 'DONE', at: at(31, 8) },
    { step: 'OUTCOME', state: 'CURRENT', at: null },
  ],
  actions: [
    { action: 'editLines', allowed: false },
    { action: 'receive', allowed: false },
    { action: 'inspect', allowed: true },
    { action: 'decide', allowed: false },
    { action: 'makeReplacement', allowed: true },
    { action: 'issueReturnDdt', allowed: false },
    { action: 'cancel', allowed: false },
    { action: 'close', allowed: true },
  ],
  version: 8,
}

export const CREDIT_NOTES: CreditNotes = {
  creditDecidedAmount: 32400,
  creditNotedAmount: 32400,
  creditNotes: [{ id: uid('7770', 1), number: null, status: 'DRAFT', issueDate: null, currency: 'EUR', netTotal: 32400, grossTotal: 39528, creditOfNumber: 'FT-DEMO-003', lines: [{ returnLineId: uid('7740', 2), seq: 1, quantity: '2' }], refunds: [] }],
  toCredit: [],
  notCredited: [{ lineId: uid('7740', 1), seq: 10, code: 'NO_CREDIT' }],
}

export const RETURNABLE: ReturnableLine[] = [
  { kind: 'INVOICED', invoiceLineId: uid('7742', 1), salesOrderLineId: uid('7741', 1), size: '52', description: 'Demo touring jacket, Red, size 52', order: { id: uid('7711', 3), number: 'SO-DEMO-003', lineSeq: 10 }, invoice: { id: uid('7743', 3), number: 'FT-DEMO-003', issueDate: '2026-10-05', lineSeq: 1 }, style: JACKET, colourway: RED, ppe: true, sold: 2, taken: 1, shippedLeft: null, left: 1, currency: 'EUR', unitPrice: '250.00', discountPct: '0', pieceValue: 25000, deliveredOn: '2026-10-06', batchNumbers: ['B-DEMO-0142'], siteId: SITE.id, warning: null },
  { kind: 'INVOICED', invoiceLineId: uid('7742', 2), salesOrderLineId: uid('7741', 2), size: '50', description: 'Demo touring pants, Black, size 50', order: { id: uid('7711', 3), number: 'SO-DEMO-003', lineSeq: 20 }, invoice: { id: uid('7743', 3), number: 'FT-DEMO-003', issueDate: '2026-10-05', lineSeq: 2 }, style: PANTS, colourway: BLACK, ppe: false, sold: 4, taken: 0, shippedLeft: null, left: 4, currency: 'EUR', unitPrice: '180.00', discountPct: '10', pieceValue: 16200, deliveredOn: '2026-09-15', batchNumbers: [], siteId: SITE.id, warning: null },
  { kind: 'SHIPPED', invoiceLineId: null, salesOrderLineId: uid('7741', 3), size: '54', description: 'Demo touring jacket, Black, size 54', order: { id: uid('7711', 4), number: 'SO-DEMO-004', lineSeq: 10 }, invoice: null, style: JACKET, colourway: BLACK, ppe: true, sold: 1, taken: 1, shippedLeft: 0, left: 0, currency: 'EUR', unitPrice: '250.00', discountPct: '0', pieceValue: 25000, deliveredOn: '2026-10-25', batchNumbers: ['B-DEMO-0150'], siteId: SITE.id, warning: null },
]

// ---- a repair ------------------------------------------------------------------------------------------------------------

const REPAIR_ACTIONS_RECEIVED: Repair['actions'] = [
  { action: 'edit', allowed: true },
  { action: 'receive', allowed: false },
  { action: 'estimate', allowed: true },
  { action: 'approve', allowed: false },
  { action: 'makeWorkOrder', allowed: true },
  { action: 'startRepair', allowed: false },
  { action: 'finishRepair', allowed: false },
  { action: 'reopenRepair', allowed: false },
  { action: 'safetyCheck', allowed: false },
  { action: 'ship', allowed: true },
  { action: 'cancel', allowed: false },
]

export const REPAIR_RECEIVED: Repair = {
  id: uid('7720', 1),
  number: 'REP-DEMO-0001',
  companyId: COMPANY_ID,
  site: SITE,
  party: CUSTOMER,
  kind: 'REPAIR',
  stage: 'RECEIVED',
  problem: 'The left elbow seam opened after a slide (made-up).',
  garment: { serial: 'S-DEMO-000431', style: { ...JACKET, ppeCategory: 'CAT_II' }, colourway: RED, size: '52', found: { madeOn: '2026-09-02', workOrderNumber: 'WO-DEMO-0142', batchNumber: 'B-DEMO-0142', forThisCustomer: true } },
  source: { returnLine: null, complaint: null },
  receivedAt: at(29, 11),
  inboundDdt: { number: 'C-DDT-DEMO-12', date: '2026-10-28' },
  workOrder: null,
  earlierWorkOrders: [],
  reworkRound: false,
  repairedAt: null,
  safety: { required: true, state: 'NOT_CHECKED', result: null, checklist: null, failures: [], checkedAt: null, checkedById: null },
  shippedAt: null,
  cancelledAt: null,
  cancelReason: null,
  ownerId: ME,
  internalNote: null,
  createdAt: at(29, 11),
  version: 2,
  stages: [{ id: uid('7780', 1), from: null, to: 'RECEIVED', at: at(29, 11), note: null, byId: ME }],
  steps: [
    { stage: 'RECEIVED', state: 'CURRENT', at: at(29, 11) },
    { stage: 'ESTIMATED', state: 'WAITING', at: null },
    { stage: 'APPROVED', state: 'WAITING', at: null },
    { stage: 'IN_REPAIR', state: 'WAITING', at: null },
    { stage: 'REPAIRED', state: 'WAITING', at: null },
    { stage: 'SHIPPED', state: 'WAITING', at: null },
  ],
  ddts: [],
  history: [{ id: uid('7720', 9), number: 'REP-DEMO-0009', kind: 'REPAIR', stage: 'SHIPPED', problem: 'Replace the back protector (made-up).', createdAt: at(2) }],
  ncrs: [],
  actions: REPAIR_ACTIONS_RECEIVED,
  people: PEOPLE,
}

export const REPAIR_REPAIRED: Repair = {
  ...REPAIR_RECEIVED,
  stage: 'REPAIRED',
  repairedAt: at(30, 16),
  workOrder: { id: uid('7730', 1), number: 'WO-DEMO-0201', status: 'COMPLETED' },
  stages: [
    ...REPAIR_RECEIVED.stages,
    { id: uid('7780', 2), from: 'RECEIVED', to: 'ESTIMATED', at: at(29, 14), note: 'New elbow seam and abrasion patch, told by phone (made-up).', byId: ME },
    { id: uid('7780', 3), from: 'ESTIMATED', to: 'APPROVED', at: at(29, 17), note: 'Approved by e-mail (made-up).', byId: ME },
    { id: uid('7780', 4), from: 'APPROVED', to: 'IN_REPAIR', at: at(30, 8), note: null, byId: PEOPLE[2]!.id },
    { id: uid('7780', 5), from: 'IN_REPAIR', to: 'REPAIRED', at: at(30, 16), note: null, byId: PEOPLE[2]!.id },
  ],
  steps: [
    { stage: 'RECEIVED', state: 'DONE', at: at(29, 11) },
    { stage: 'ESTIMATED', state: 'DONE', at: at(29, 14) },
    { stage: 'APPROVED', state: 'DONE', at: at(29, 17) },
    { stage: 'IN_REPAIR', state: 'DONE', at: at(30, 8) },
    { stage: 'REPAIRED', state: 'CURRENT', at: at(30, 16) },
    { stage: 'SHIPPED', state: 'WAITING', at: null },
  ],
  actions: [
    { action: 'edit', allowed: true },
    { action: 'receive', allowed: false },
    { action: 'estimate', allowed: false },
    { action: 'approve', allowed: false },
    { action: 'makeWorkOrder', allowed: false },
    { action: 'startRepair', allowed: false },
    { action: 'finishRepair', allowed: false },
    { action: 'reopenRepair', allowed: true },
    { action: 'safetyCheck', allowed: true },
    { action: 'ship', allowed: false },
    { action: 'cancel', allowed: false },
  ],
  version: 8,
}

export const REPAIR_PASSED: Repair = {
  ...REPAIR_REPAIRED,
  safety: {
    required: true,
    state: 'PASSED',
    result: 'PASS',
    checklist: { seams: 'PASS', abrasionZones: 'PASS', closures: 'NOT_APPLICABLE', protectors: { result: 'PASS', replaced: true, lot: 'PRT-DEMO-07', level: '2' }, certificateCovers: true, note: null },
    failures: [],
    checkedAt: at(31, 9),
    checkedById: PEOPLE[1]!.id,
  },
  actions: REPAIR_REPAIRED.actions.map((entry) => (entry.action === 'ship' ? { ...entry, allowed: true } : entry)),
  version: 9,
}

export const REPAIR_SHIPPED: Repair = {
  ...REPAIR_PASSED,
  stage: 'SHIPPED',
  shippedAt: at(31, 11),
  ddts: [{ id: uid('7790', 1), number: '146/2026', documentDate: '2026-10-31', reason: 'REPAIR', startAt: at(31, 11), live: true }],
  steps: REPAIR_PASSED.steps.map((step) => (step.stage === 'REPAIRED' ? { ...step, state: 'DONE' as const } : step.stage === 'SHIPPED' ? { ...step, state: 'CURRENT' as const, at: at(31, 11) } : step)),
  actions: REPAIR_PASSED.actions.map((entry) => ({ ...entry, allowed: false })),
  version: 10,
}

/** B-W2b-16: back into repair after a failed check — the first work order is done, a new one for the rework may follow. */
export const REPAIR_REWORK: Repair = {
  ...REPAIR_REPAIRED,
  stage: 'IN_REPAIR',
  repairedAt: null,
  reworkRound: true,
  safety: { required: true, state: 'OUTDATED', result: 'FAIL', checklist: { seams: 'FAIL', abrasionZones: 'PASS', closures: 'NOT_APPLICABLE', protectors: { result: 'PASS', replaced: false, lot: null, level: null }, certificateCovers: true, note: 'The new seam pulls at the elbow (made-up).' }, failures: ['the seams'], checkedAt: at(31, 9), checkedById: PEOPLE[1]!.id },
  stages: [...REPAIR_REPAIRED.stages, { id: uid('7780', 6), from: 'REPAIRED', to: 'IN_REPAIR', at: at(31, 10), note: 'Open the seam and sew it again (made-up).', byId: ME }],
  steps: REPAIR_REPAIRED.steps.map((step) => (step.stage === 'IN_REPAIR' ? { ...step, state: 'CURRENT' as const, at: at(31, 10) } : step.stage === 'REPAIRED' ? { ...step, state: 'WAITING' as const } : step)),
  actions: REPAIR_REPAIRED.actions.map((entry) => (entry.action === 'makeWorkOrder' || entry.action === 'finishRepair' ? { ...entry, allowed: true } : entry.action === 'reopenRepair' || entry.action === 'safetyCheck' ? { ...entry, allowed: false } : entry)),
  version: 10,
}

/** B-W2b-16: the rework's own work order made: the first one is listed among the earlier ones. */
export const REPAIR_REWORK_ORDERED: Repair = {
  ...REPAIR_REWORK,
  workOrder: { id: uid('7730', 2), number: 'WO-DEMO-0207', status: 'RELEASED' },
  earlierWorkOrders: [{ id: uid('7730', 1), number: 'WO-DEMO-0201', status: 'COMPLETED' }],
  actions: REPAIR_REWORK.actions.map((entry) => (entry.action === 'makeWorkOrder' || entry.action === 'finishRepair' ? { ...entry, allowed: false } : entry)),
  version: 12,
}
