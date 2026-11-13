import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { caseActions, CASE_ACTIONS, type CaseAction as DomainAction } from '@nexus/factory-domain/sales/service/rules'
import { permissionCheck } from '../../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { CaseCounts, CasePreview, CaseRecord, CaseRow, ContactOption, LinkCandidate, PartyOption, Person, ReasonOption, WarrantyCheck } from '../api'
import { serviceCan, type ServiceCan } from '../model'

/**
 * Design-only made-up data of Sales › Warranty & service (SCR-217 and the case SCR-413): "Demo" customers and riders, people at
 * example.com, example numbers (SVC-DEMO-…, DEMO-SN-…), made-up dates. Nothing here is a real company, person, garment or case.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
export const NOW = '2026-11-12T09:42:00.000Z'
export const TODAY = '2026-11-12'
const OTHER = '0190f0e2-3333-7000-8000-000000000002'

/** A made-up uuid in a family. */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()

/** A role's permissions as a session holds them: its permissions and a `money.<grain>` per grain. */
const template = (key: string): string[] => {
  const role = templateOf(key)
  return [...(role?.permissions ?? []), ...(role?.grains ?? []).map((grain) => `money.${grain}`), 'home.view']
}

/** The role cases the design names: sales (decides), quality (follows up, no decision), production and a reader (read), the warehouse (no page). */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...template('sales'), 'sales.service.view', 'sales.service.manage', 'sales.service.decide', 'sales.repairs.manage', 'sales.returns.manage', 'parties.view', 'threads.read', 'files.read'],
  sales: template('sales'),
  inspector: template('quality_inspector'),
  production: template('production_manager'),
  reader: template('read_only'),
  warehouse: template('warehouse'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): ServiceCan => serviceCan(ROLE_PERMISSIONS[role])

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

// ---- customers, people, contacts --------------------------------------------------------------------------------------------

const RIDER = { id: uid('5401', 1), code: 'DEMO-P01', legalName: 'Demo Rider Uno' }
const SHOP = { id: uid('5401', 2), code: 'DEMO-SHOP', legalName: 'Demo Moto Shop' }
const TEAM = { id: uid('5401', 3), code: 'DEMO-TEAM', legalName: 'Demo Racing Team' }

export const CUSTOMERS: PartyOption[] = [
  { id: RIDER.id, code: RIDER.code, legalName: RIDER.legalName, tradeName: null },
  { id: SHOP.id, code: SHOP.code, legalName: SHOP.legalName, tradeName: 'Demo Shop' },
  { id: TEAM.id, code: TEAM.code, legalName: TEAM.legalName, tradeName: null },
]
export const CONTACTS: ContactOption[] = [
  { id: uid('5402', 1), name: 'Demo Contact', email: 'contact@example.com', status: 'ACTIVE' },
  { id: uid('5402', 2), name: 'Demo Workshop', email: null, status: 'ACTIVE' },
]
export const PEOPLE: Person[] = [
  { id: ME, name: DEMO_USER.displayName },
  { id: OTHER, name: 'Demo Colleague' },
]
export const REASONS: ReasonOption[] = [
  { code: 'DEFECT', labelIt: 'Difetto', labelEn: 'Defect', needsDetail: false },
  { code: 'WRONG_SIZE', labelIt: 'Taglia sbagliata', labelEn: 'Wrong size', needsDetail: false },
]

// ---- the warranty checks ----------------------------------------------------------------------------------------------------

const reading = (state: WarrantyCheck['legal']['state'], endsOn: string | null, daysLeft: number | null) => ({ state, endsOn, daysLeft, words: '' })
export const CHECK_CONSUMER: WarrantyCheck = {
  buyer: 'CONSUMER',
  deliveredOn: '2026-03-10',
  legal: reading('RUNS', '2028-03-10', 484),
  factory: reading('NONE', null, null),
  presumption: { applies: true, until: '2027-03-10', words: '' },
  suggested: 'LEGAL_GUARANTEE',
  state: 'LEGAL_GUARANTEE',
  remedies: '',
  liable: '',
  words: [],
}
export const CHECK_BUSINESS: WarrantyCheck = {
  buyer: 'BUSINESS',
  deliveredOn: '2025-09-02',
  legal: reading('NONE', null, null),
  factory: reading('RUNS', '2027-09-02', 659),
  presumption: null,
  suggested: 'FACTORY_GUARANTEE',
  state: 'FACTORY_GUARANTEE',
  remedies: '',
  liable: '',
  words: [],
}
export const CHECK_RIDER: WarrantyCheck = { ...CHECK_BUSINESS, buyer: 'NOT_NAMED', deliveredOn: null, factory: reading('NONE', null, null), suggested: null, state: 'UNKNOWN' }
export const CHECK_ENDED: WarrantyCheck = { ...CHECK_CONSUMER, deliveredOn: '2023-05-02', legal: reading('ENDED', '2025-05-02', -560), presumption: { applies: false, until: '2024-05-02', words: '' }, suggested: 'NONE', state: 'OUT_OF_COVER' }

// ---- the rows ---------------------------------------------------------------------------------------------------------------

const style = { id: uid('5403', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket' }
const row = (n: number, over: Partial<CaseRow>): CaseRow => ({
  id: uid('5404', n),
  number: `SVC-DEMO-${String(n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  kind: 'WARRANTY',
  channel: 'PHONE',
  status: 'OPEN',
  priority: 'NORMAL',
  party: RIDER,
  serial: `DEMO-SN-${String(n).padStart(4, '0')}`,
  garmentSerial: `DEMO-SN-${String(n).padStart(4, '0')}`,
  batchNumber: 'DEMO-BT-0001',
  garmentBatch: 'DEMO-BT-0001',
  style,
  size: '52',
  customerWants: 'REPAIR',
  cover: { state: 'LEGAL_GUARANTEE', decided: false, decision: null },
  openedAt: at(10, 9),
  ownerId: ME,
  notifyCustomer: true,
  links: 0,
  summary: 'The zip of the left pocket came off after two rides.',
  version: 3,
  ...over,
})

export const ROWS: CaseRow[] = [
  row(1, {}),
  row(2, { status: 'NEW', party: SHOP, kind: 'COMPLAINT', serial: null, garmentSerial: null, cover: { state: 'FACTORY_GUARANTEE', decided: true, decision: 'COVERED' }, ownerId: OTHER, links: 1, summary: 'Seams open on three jackets of the same batch.', openedAt: at(11, 14), notifyCustomer: false, priority: 'HIGH' }),
  row(3, { status: 'WAITING_CUSTOMER', party: null, garmentSerial: null, serial: 'XX-8841', garmentBatch: null, batchNumber: null, style: null, size: null, cover: { state: 'UNKNOWN', decided: false, decision: null }, summary: 'A rider asks whether a 2023 jacket is still covered.', openedAt: at(9, 11), notifyCustomer: false, kind: 'QUESTION', customerWants: 'ANSWER' }),
  row(4, { status: 'WAITING_PART', party: TEAM, cover: { state: 'FACTORY_GUARANTEE', decided: true, decision: 'PARTLY' }, links: 2, summary: 'Knee armour pocket torn: a new pocket is ordered.', openedAt: at(4, 10), priority: 'URGENT' }),
  row(5, { status: 'RESOLVED', cover: { state: 'OUT_OF_COVER', decided: true, decision: 'NOT_COVERED' }, summary: 'Worn elbow after four seasons: a paid repair was offered.', openedAt: at(2, 15), links: 1 }),
  row(6, { status: 'CLOSED', cover: { state: 'LEGAL_GUARANTEE', decided: true, decision: 'COVERED' }, summary: 'Velcro tab replaced under the legal guarantee.', openedAt: at(1, 8), links: 1, version: 7 }),
]
export const OPEN_ROWS = ROWS.filter((one) => one.status !== 'CLOSED')
export const COUNTS: CaseCounts = { tiles: { new: 1, waitingCustomer: 1, waitingPart: 1 }, rows: { open: 5, mine: 4, waiting: 2, closed: 1, all: 6 }, asOf: NOW }

// ---- the case (the record) ----------------------------------------------------------------------------------------------------

/** The record's actions as the API would answer for a role: factory-domain's own rule over the role's rights. */
export function actionsFor(role: RoleCase, record: Pick<CaseRecord, 'status' | 'kind' | 'warranty' | 'party' | 'contact' | 'notifyCustomer'>): CaseRecord['actions'] {
  const can = canFor(role)
  const may = Object.fromEntries(CASE_ACTIONS.map((action) => [action, action === 'decideCover' ? can.decide : action === 'makeRepair' ? can.manage && can.repairs : action === 'makeReturn' ? can.manage && can.returns : can.manage])) as Record<DomainAction, boolean>
  return caseActions({ status: record.status, kind: record.kind, coverDecided: !!record.warranty.decided, hasParty: !!record.party, hasContactEmail: !!record.contact?.email, notifyCustomer: record.notifyCustomer, may })
}

const garment = (serial: string, shipped = true): CaseRecord['garment'] => ({
  serial: { serial, madeOn: '2026-02-20', workOrderNumber: 'DEMO-WO-0007', batchNumber: 'DEMO-BT-0001', madeForPartyId: RIDER.id, salesOrderId: uid('5405', 1), shipment: shipped ? { id: uid('5406', 1), number: 'DEMO-SH-0003', partyId: RIDER.id, day: '2026-03-08', delivered: true } : null },
  batch: null,
})

export function recordOf(base: CaseRow, over: Partial<CaseRecord> = {}, role: RoleCase = 'owner'): CaseRecord {
  const record: CaseRecord = {
    ...base,
    party: base.party ? { ...base.party, kind: base.party.id === RIDER.id ? 'PERSON' : 'ORGANISATION' } : null,
    contact: base.party ? { id: CONTACTS[0]!.id, name: CONTACTS[0]!.name, email: CONTACTS[0]!.email, language: 'it' } : null,
    style: base.style ? { ...base.style, ppeCategory: 'II' } : null,
    colourway: base.style ? { id: uid('5407', 1), code: 'BLK', name: 'Black' } : null,
    problem: `${base.summary}\nThe customer sent two photos on the thread.`,
    garment: base.garmentSerial ? garment(base.garmentSerial) : { serial: null, batch: null },
    warranty: { deliveredOn: CHECK_CONSUMER.deliveredOn, legalGuaranteeEndsOn: CHECK_CONSUMER.legal.endsOn, factoryGuaranteeEndsOn: null, suggestedDeliveredOn: '2026-03-10', check: CHECK_CONSUMER, decided: null },
    resolution: null,
    closed: null,
    internalNote: 'Customer is a regular: offer a quick turnaround.',
    createdAt: base.openedAt,
    createdById: ME,
    links: [],
    mails: [],
    actions: [],
    people: PEOPLE,
    ...over,
  }
  return { ...record, actions: over.actions ?? actionsFor(role, record) }
}

export const LINKS: CaseRecord['links'] = [
  { id: uid('5408', 1), recordType: 'RepairOrder', recordId: uid('5409', 1), note: 'Repair DEMO-REP-0002 opened from the case.', createdAt: at(10, 11), createdById: ME, record: { label: 'DEMO-REP-0002', status: 'AWAITING_GOODS' } },
  { id: uid('5408', 2), recordType: 'SalesOrder', recordId: uid('5405', 1), note: 'The order the jacket came with', createdAt: at(10, 10), createdById: ME, record: { label: 'DEMO-SO-0012', status: 'SHIPPED' } },
  { id: uid('5408', 3), recordType: 'Invoice', recordId: uid('5410', 1), note: null, createdAt: at(10, 10), createdById: OTHER, record: null },
]
export const MAILS: CaseRecord['mails'] = [
  { id: uid('5411', 1), subject: 'SVC-DEMO-0001: your case is open', status: 'DELIVERED', to: ['contact@example.com'], queuedAt: at(10, 9, 5), sentAt: at(10, 9, 6), deliveredAt: at(10, 9, 7), failedAt: null, sentById: ME },
  { id: uid('5411', 2), subject: 'SVC-DEMO-0001: we wait for a part', status: 'QUEUED', to: ['contact@example.com'], queuedAt: at(12, 9, 30), sentAt: null, deliveredAt: null, failedAt: null, sentById: ME },
]

export const CONSUMER_CASE = recordOf(ROWS[0]!)
export const BUSINESS_CASE = recordOf(ROWS[3]!, {
  party: { ...TEAM, kind: 'ORGANISATION' },
  warranty: { deliveredOn: CHECK_BUSINESS.deliveredOn, legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: '2027-09-02', suggestedDeliveredOn: null, check: CHECK_BUSINESS, decided: { cover: 'FACTORY_GUARANTEE', decision: 'PARTLY', note: 'The pocket is covered; the scuffs on the sleeve are wear.', at: at(5, 10), byId: OTHER, remedies: '' } },
  links: LINKS.slice(0, 2),
})
export const RIDER_CASE = recordOf(ROWS[2]!, { warranty: { deliveredOn: null, legalGuaranteeEndsOn: null, factoryGuaranteeEndsOn: null, suggestedDeliveredOn: null, check: CHECK_RIDER, decided: null }, internalNote: null })
export const CLOSED_CASE = recordOf(ROWS[5]!, {
  warranty: { ...CONSUMER_CASE.warranty, decided: { cover: 'LEGAL_GUARANTEE', decision: 'COVERED', note: 'A defect within the first year: replaced free.', at: at(2, 9), byId: ME, remedies: '' } },
  resolution: { at: at(3, 12), words: 'Velcro tab replaced; the jacket went back by courier.' },
  closed: { at: at(4, 9), byId: ME, reason: null },
  links: LINKS.slice(0, 1),
  mails: MAILS.slice(0, 1),
})

// ---- New case's preview, the records to link -----------------------------------------------------------------------------------

export const PREVIEW: CasePreview = {
  ok: true,
  problems: [],
  warnings: [{ path: 'body/serial', message: 'x' }],
  draft: { styleId: style.id, colourwayId: uid('5407', 1), size: '52', batchNumber: 'DEMO-BT-0001', garmentSerial: 'DEMO-SN-0001', garmentBatch: 'DEMO-BT-0001', partyId: RIDER.id, deliveredOn: '2026-03-10', legalGuaranteeEndsOn: '2028-03-10', factoryGuaranteeEndsOn: null },
  garment: garment('DEMO-SN-0001'),
  warranty: CHECK_CONSUMER,
  others: [{ id: ROWS[0]!.id, number: ROWS[0]!.number, status: 'OPEN', kind: 'WARRANTY', openedAt: ROWS[0]!.openedAt }],
}
export const RIDER_PREVIEW: CasePreview = { ...PREVIEW, warnings: [], draft: { ...PREVIEW.draft, partyId: null, deliveredOn: null, legalGuaranteeEndsOn: null }, garment: { serial: null, batch: null }, warranty: CHECK_RIDER, others: [] }

export const LINK_FOUND: LinkCandidate[] = [
  { recordType: 'SalesOrder', recordId: uid('5405', 1), number: 'DEMO-SO-0012', title: RIDER.legalName },
  { recordType: 'SalesOrder', recordId: uid('5405', 2), number: 'DEMO-SO-0019', title: RIDER.legalName },
]

// ---- the record panels of the Activity tab (the panels' own made-up case) ------------------------------------------------------

const panelsCase = (id: string): RecordPanelsViewModel => (panelsScreen.cases.find((one) => one.id === id) ?? panelsScreen.cases[0]!).model
export const panelsOf = (record: CaseRecord): RecordPanelsViewModel => ({
  ...panelsCase('conversation'),
  record: { type: 'ServiceCase', id: record.id, companyId: record.companyId, siteId: null },
  title: record.number,
})
