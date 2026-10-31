import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { at, COMPANY_ID, day, NOW, PREFIX, uid } from '../../_shared/fixtures'
import type { Complaint, ComplaintCounts, ComplaintPeople, ComplaintRow, PartyOption, SafetyAlert, StyleOption } from '../api'
import { complaintsCan, type ComplaintsCan } from '../model'

/**
 * Made-up data of the Complaints design cases (SCR-113-complaints, SCR-113-complaint): "Demo" customers and styles,
 * example numbers (CMP-DEMO-…), made-up words. Nothing here is a real company, person, garment or complaint. The role
 * cases the Owner reviews: the owner (acknowledges a safety alert), the quality inspector (triages; the acknowledgement
 * held), a sales person (logs; triage held) and a read-only person.
 */

export { NOW, PREFIX }
export const TODAY = day(29)
export const ME = DEMO_USER.id

const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

export const ROLE_PERMISSIONS = {
  owner: [
    'home.view',
    'quality.complaints.view',
    'quality.complaints.log',
    'quality.complaints.manage',
    'quality.complaints.acknowledge',
    'compliance.register.view',
    'compliance.register.manage',
    'quality.ncr.view',
    'quality.ncr.raise',
    // B-W2b-17: unlinking an NCR from a complaint.
    'quality.ncr.manage',
    'sales.repairs.view',
    'sales.repairs.manage',
    'parties.view',
    'orders.view',
    'shipping.view',
    'sales.returns.view',
    'product.styles.view',
    'inventory.locations.view',
    'files.read',
    'files.upload',
    'threads.read',
    'threads.post',
    'quality.inspections.view',
    'money.price',
  ],
  inspector: templatePermissions('quality_inspector'),
  sales: [...templatePermissions('sales'), 'money.price'],
  readOnly: ['home.view', 'quality.complaints.view', 'compliance.register.view', 'quality.ncr.view', 'files.read', 'threads.read'],
  none: ['home.view'],
} as const

export type RoleCase = keyof typeof ROLE_PERMISSIONS
export const canFor = (role: RoleCase): ComplaintsCan => complaintsCan(ROLE_PERMISSIONS[role])

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

// ---- the made-up records -------------------------------------------------------------------------------------------------

export const CUSTOMER = { id: uid('6501', 1), code: 'DEMO-C01', legalName: 'Moto Demo Srl' }
const CUSTOMER_2 = { id: uid('6501', 2), code: 'DEMO-C02', legalName: 'Demo Racing Team' }
export const CUSTOMERS: PartyOption[] = [
  { ...CUSTOMER, tradeName: null },
  { ...CUSTOMER_2, tradeName: null },
]
export const JACKET: StyleOption = { id: uid('6502', 1), code: 'JK-DEMO-100', name: 'Demo touring jacket' }
const PANTS: StyleOption = { id: uid('6502', 2), code: 'PT-DEMO-200', name: 'Demo touring pants' }
export const STYLES: StyleOption[] = [JACKET, PANTS]
export const OWNER = { id: ME, name: 'Alex Demo' }
export const QUALITY = { id: uid('6503', 2), name: 'Bea Demo' }
export const PEOPLE: ComplaintPeople = {
  owners: [OWNER, QUALITY],
  told: [
    { id: OWNER.id, name: OWNER.name, as: 'OWNER' },
    { id: QUALITY.id, name: QUALITY.name, as: 'QUALITY' },
  ],
}

const order = (n: number) => ({ id: uid('6504', n), number: `SO-DEMO-00${n}`, status: 'SHIPPED', currency: 'EUR', netAmount: 182_400 + n * 1_000 })
const shipment = (n: number) => ({ id: uid('6505', n), number: `SH-DEMO-00${n}`, status: 'DELIVERED' })
const none = { state: 'NONE' as const, raisedAt: null, acknowledgedAt: null, acknowledgedById: null }

export const SAFETY_ID = uid('6500', 12)

const row = (over: Partial<ComplaintRow> & Pick<ComplaintRow, 'id' | 'number' | 'status' | 'summary'>): ComplaintRow => ({
  companyId: COMPANY_ID,
  channel: 'EMAIL',
  receivedAt: at(27, 8, 30),
  party: CUSTOMER,
  customerRef: null,
  order: null,
  shipment: null,
  return: null,
  style: null,
  size: null,
  serial: null,
  batchNumber: null,
  category: null,
  severity: null,
  ownerId: null,
  answerDueOn: null,
  answeredAt: null,
  safety: none,
  register: null,
  ncrs: [],
  ...over,
})

export const ROWS: ComplaintRow[] = [
  row({
    id: SAFETY_ID,
    number: 'CMP-DEMO-0012',
    status: 'TRIAGED',
    summary: 'The shoulder protector moved in a fall (made-up)',
    receivedAt: at(28, 9, 5),
    customerRef: 'DEMO-RMA-77',
    order: order(1),
    shipment: shipment(1),
    style: JACKET,
    size: '52',
    batchNumber: 'B-DEMO-0142',
    category: 'SAFETY',
    severity: 'MAJOR',
    ownerId: QUALITY.id,
    answerDueOn: day(30),
    safety: { state: 'RAISED', raisedAt: at(28, 9, 40), acknowledgedAt: null, acknowledgedById: null },
    register: { id: uid('6506', 7), reference: 'REG-DEMO-0007', status: 'OPEN', risk: 'ASSESSING' },
    ncrs: [{ id: uid('6507', 31), number: 'NCR-DEMO-0031', stage: 'OPEN' }],
  }),
  row({ id: uid('6500', 13), number: 'CMP-DEMO-0013', status: 'NEW', summary: 'Zip of the left pocket broke after a week (made-up)', receivedAt: at(29, 8, 10), channel: 'PHONE', style: JACKET, size: '50', serial: 'S-DEMO-000431' }),
  row({ id: uid('6500', 14), number: 'CMP-DEMO-0014', status: 'NEW', summary: 'Colour faded on the sleeve (made-up)', receivedAt: at(29, 9, 20), party: CUSTOMER_2, channel: 'RETURN', return: { id: uid('6508', 3), number: 'RMA-DEMO-0003', status: 'RECEIVED' } }),
  row({
    id: uid('6500', 10),
    number: 'CMP-DEMO-0010',
    status: 'INVESTIGATING',
    summary: 'Seam opened at the knee (made-up)',
    receivedAt: at(22, 14, 0),
    order: order(2),
    shipment: shipment(2),
    style: PANTS,
    size: '48',
    batchNumber: 'B-DEMO-0139',
    category: 'FUNCTION',
    severity: 'MAJOR',
    ownerId: QUALITY.id,
    answerDueOn: day(28),
  }),
  row({ id: uid('6500', 8), number: 'CMP-DEMO-0008', status: 'ANSWERED', summary: 'A mark on the back panel (made-up)', receivedAt: at(14, 10, 0), category: 'COSMETIC', severity: 'MINOR', ownerId: OWNER.id, answerDueOn: day(24), answeredAt: at(20, 11, 0), style: JACKET }),
  row({ id: uid('6500', 5), number: 'CMP-DEMO-0005', status: 'CLOSED', summary: 'Size 54 too tight at the chest (made-up)', receivedAt: at(6, 10, 0), party: CUSTOMER_2, category: 'FIT', severity: 'MINOR', ownerId: OWNER.id, answerDueOn: day(16), answeredAt: at(9, 11, 0), style: JACKET, size: '54' }),
]

export const OPEN_ROWS = ROWS.filter((entry) => entry.status !== 'CLOSED')
export const NEW_IDS = ROWS.filter((entry) => entry.status === 'NEW').map((entry) => entry.id)

export const SAFETY_ALERT: SafetyAlert = {
  id: SAFETY_ID,
  number: 'CMP-DEMO-0012',
  summary: 'The shoulder protector moved in a fall (made-up)',
  style: JACKET,
  batchNumber: 'B-DEMO-0142',
  serial: null,
  raisedAt: at(28, 9, 40),
  version: 3,
}

export const COUNTS: ComplaintCounts = { tiles: { new: 2, safety: 1, dueSoon: 2, open: 5, answeredMonth: 2 }, safetyAlerts: [SAFETY_ALERT], moreSafetyAlerts: 0, asOf: NOW }
export const CALM_COUNTS: ComplaintCounts = { ...COUNTS, safetyAlerts: [] }

const ALL_ACTIONS = ['edit', 'triage', 'startInvestigation', 'markAnswered', 'reopenInvestigation', 'close', 'acknowledge', 'register', 'createNcr', 'makeRepair'] as const

/** A full record from a row, with the steps as the API would hold them for the owner. */
export function complaintOf(base: ComplaintRow, over: Partial<Complaint> = {}): Complaint {
  const closed = base.status === 'CLOSED'
  const held = (action: (typeof ALL_ACTIONS)[number]): Complaint['actions'][number]['held'] => {
    if (closed && action !== 'acknowledge') return 'CLOSED'
    switch (action) {
      case 'startInvestigation':
        return base.status === 'NEW' ? 'NOT_TRIAGED' : base.status === 'INVESTIGATING' ? 'ALREADY_INVESTIGATING' : base.status === 'ANSWERED' ? 'ALREADY_ANSWERED' : null
      case 'markAnswered':
        return base.status === 'NEW' ? 'NOT_TRIAGED' : base.status === 'ANSWERED' ? 'ALREADY_ANSWERED' : null
      case 'reopenInvestigation':
        return base.status === 'ANSWERED' ? null : 'NOT_ANSWERED'
      case 'close':
        return base.safety.state === 'RAISED' ? 'SAFETY_NOT_ACKNOWLEDGED' : null
      case 'acknowledge':
        return base.safety.state === 'NONE' ? 'NO_SAFETY_ALERT' : base.safety.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : null
      case 'register':
        return base.register ? 'IN_REGISTER' : base.style ? null : 'NO_STYLE'
      default:
        return null
    }
  }
  return {
    ...base,
    description: `${base.summary}. The customer writes that it happened on the first ride after the delivery; photos attached.`,
    contact: { id: uid('6509', 1), name: 'Dario Demo', email: 'dario.demo@example.com' },
    style: base.style ? { ...base.style, ppeCategory: 'II' } : null,
    garment: base.batchNumber ? { madeOn: day(2), workOrderNumber: 'WO-DEMO-0142', batchNumber: base.batchNumber, shipment: base.shipment ? { id: base.shipment.id, number: base.shipment.number } : null, forThisCustomer: true } : null,
    triagedAt: base.status === 'NEW' ? null : at(28, 9, 40),
    triagedById: base.status === 'NEW' ? null : QUALITY.id,
    closedAt: closed ? at(12, 9, 0) : null,
    closeReason: closed ? 'Answered and accepted: a size exchange was agreed (made-up).' : null,
    internalNote: null,
    createdAt: base.receivedAt,
    createdById: OWNER.id,
    version: 3,
    repairs: [],
    evidence: base.serial ? { kind: 'serial', subject: base.serial } : base.batchNumber ? { kind: 'batch', subject: base.batchNumber } : null,
    suggestedAnswerDueOn: day(31),
    actions: ALL_ACTIONS.map((action) => {
      const code = held(action)
      return { action, allowed: code === null, held: code }
    }),
    people: [OWNER, QUALITY],
    ...over,
  }
}

/** The same record as a role sees it: a step the role lacks is held NO_PERMISSION (the API's answer). */
export function forRole(complaint: Complaint, role: RoleCase): Complaint {
  const can = canFor(role)
  const may: Record<string, boolean> = {
    edit: complaint.status === 'NEW' ? can.log || can.manage : can.manage,
    triage: can.manage,
    startInvestigation: can.manage,
    markAnswered: can.manage,
    reopenInvestigation: can.manage,
    close: can.manage,
    acknowledge: can.acknowledge,
    register: can.manage && can.registerManage,
    createNcr: can.ncrRaise,
    makeRepair: can.repairsManage,
  }
  return { ...complaint, actions: complaint.actions.map((entry) => (may[entry.action] ? entry : { ...entry, allowed: false, held: 'NO_PERMISSION' })) }
}
