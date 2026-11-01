import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import { RecordPanelsView } from '../../../record-panels/view/RecordPanelsView'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { Assignment, CompanyWithSites, Device, Line, PermissionCatalogue, Printer, Role, Site, Station, User, Worker, WorkCentre } from './api'

/**
 * Made-up data the Admin screens' design fixtures share (B-W0-27): "Demo" companies and sites, example.com people,
 * invented codes and numbers. Design-only (a fixtures file: only fixtures and tests import it); it exports no
 * `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
export const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const NOW = at(29, 9, 42)
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

/** The Office shell around an Admin page at this address (the owner's navigation). */
export function inShell(path: string, page: ReactNode, permissions: readonly string[] = OWNER_PERMISSIONS): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- companies and sites ----

const counts = (lines: number, stations: number, devices = 0, printers = 0, workCentres = 4) => ({ lines, stations, workCentres, devices, printers })
export const SITES: Site[] = [
  { id: uid('2222', 1), companyId: DEMO_COMPANIES[0].id, code: 'DN1', name: 'Stabilimento Demo Nord', kind: 'PLANT', address: { line1: 'Via Esempio 11', postalCode: '00000', city: 'Demoville', province: 'MI', country: 'IT' }, timezone: 'Europe/Rome', status: 'ACTIVE', counts: counts(2, 7, 3, 2), version: 4, createdAt: at(1, 8), updatedAt: at(27, 10) },
  { id: uid('2222', 2), companyId: DEMO_COMPANIES[0].id, code: 'DS1', name: 'Magazzino Demo Sud', kind: 'WAREHOUSE', address: { line1: 'Via Prova 4', postalCode: '00000', city: 'Demoville', country: 'IT' }, timezone: 'Europe/Rome', status: 'ACTIVE', counts: counts(0, 0, 0, 1, 0), version: 2, createdAt: at(2, 8), updatedAt: at(20, 10) },
  { id: uid('2222', 3), companyId: DEMO_COMPANIES[1].id, code: 'EP1', name: 'Laboratorio Esempio', kind: 'PLANT', address: null, timezone: 'Europe/Rome', status: 'ACTIVE', counts: counts(0, 0, 0, 0, 0), version: 1, createdAt: at(26, 8), updatedAt: at(26, 8) },
]

const company = (index: 0 | 1, extra: Partial<CompanyWithSites>): CompanyWithSites => ({
  id: DEMO_COMPANIES[index].id,
  code: DEMO_COMPANIES[index].code,
  legalName: DEMO_COMPANIES[index].name,
  tradeName: index === 0 ? 'Officina Demo' : null,
  vatNumber: index === 0 ? 'IT00000000000' : null,
  fiscalCode: index === 0 ? '00000000000' : null,
  regimeFiscale: index === 0 ? 'RF01' : null,
  reaOffice: index === 0 ? 'MI' : null,
  reaNumber: index === 0 ? '0000000' : null,
  shareCapital: index === 0 ? '10000.00' : null,
  soleShareholder: index === 0,
  inLiquidation: false,
  address: index === 0 ? { line1: 'Via Esempio 1', postalCode: '00000', city: 'Demoville', province: 'MI', country: 'IT' } : null,
  pec: index === 0 ? 'officina-demo@pec.example.com' : null,
  sdiReceiverCode: index === 0 ? 'ABC1234' : null,
  country: 'IT',
  currency: 'EUR',
  timezone: 'Europe/Rome',
  locale: 'it',
  fiscalYearStartMonth: 1,
  documentFooter: index === 0 ? 'Officina Demo S.r.l. · capitale sociale € 10.000 i.v. · dati di prova' : null,
  status: 'ACTIVE',
  invoicing:
    index === 0
      ? { ready: true, issues: [] }
      : {
          ready: false,
          issues: [
            { path: 'company/vatNumber', message: '' },
            { path: 'company/regimeFiscale', message: '' },
            { path: 'company/address', message: '' },
            { path: 'company/pec', message: '' },
          ],
        },
  version: index === 0 ? 7 : 1,
  createdAt: at(1, 8),
  updatedAt: at(28, 16),
  sites: SITES.filter((site) => site.companyId === DEMO_COMPANIES[index].id),
  ...extra,
})
export const COMPANIES: CompanyWithSites[] = [company(0, {}), company(1, {})]

export const LINES: Line[] = [
  { id: uid('2323', 1), siteId: SITES[0].id, code: 'L1', name: 'Linea cucito 1', status: 'ACTIVE', version: 1 },
  { id: uid('2323', 2), siteId: SITES[0].id, code: 'L2', name: 'Linea cucito 2', status: 'ACTIVE', version: 1 },
]
export const CENTRES: WorkCentre[] = [
  { id: uid('2424', 1), siteId: SITES[0].id, code: 'CUT', name: 'Taglio', kind: 'CUTTING', status: 'ACTIVE', version: 1 },
  { id: uid('2424', 2), siteId: SITES[0].id, code: 'SEW', name: 'Cucito', kind: 'SEWING', status: 'ACTIVE', version: 1 },
  { id: uid('2424', 3), siteId: SITES[0].id, code: 'QC', name: 'Collaudo finale', kind: 'INSPECTION', status: 'ACTIVE', version: 1 },
  { id: uid('2424', 4), siteId: SITES[0].id, code: 'PACK', name: 'Imballo', kind: 'PACKING', status: 'ACTIVE', version: 1 },
]
const station = (n: number, code: string, name: string, centre: number, line: number | null, devices = 0): Station => ({
  id: uid('2525', n),
  siteId: SITES[0].id,
  lineId: line === null ? null : LINES[line]!.id,
  workCentreId: CENTRES[centre]!.id,
  code,
  name,
  status: 'ACTIVE',
  devices,
  version: 1,
})
export const STATIONS: Station[] = [
  station(1, 'CUT-01', 'Tavolo di taglio 1', 0, null, 1),
  station(2, 'CUT-02', 'Tavolo di taglio 2', 0, null, 1),
  station(3, 'SEW-01', 'Postazione cucito 1', 1, 0),
  station(4, 'SEW-02', 'Postazione cucito 2', 1, 0, 1),
  station(5, 'SEW-03', 'Postazione cucito 3', 1, 1),
  station(6, 'QC-01', 'Banco collaudo 1', 2, null),
  station(7, 'PACK-01', 'Banco imballo 1', 3, null),
]

// ---- devices and printers ----

const device = (n: number, name: string, extra: Partial<Device>): Device => ({
  id: uid('2626', n),
  siteId: SITES[0].id,
  stationId: null,
  name,
  kind: 'TABLET',
  status: 'ACTIVE',
  enrolledAt: at(10, 8),
  lastSeenAt: at(29, 9, 30),
  appVersion: '1.4.0',
  revokedAt: null,
  inUse: false,
  version: 2,
  ...extra,
})
export const DEVICES: Device[] = [
  device(1, 'Tablet taglio 1', { stationId: STATIONS[0]!.id, inUse: true }),
  device(2, 'Tablet taglio 2', { stationId: STATIONS[1]!.id, lastSeenAt: at(26, 17, 5) }),
  device(3, 'Tablet cucito 2', { stationId: STATIONS[3]!.id, appVersion: '1.3.2' }),
  device(4, 'Lettore magazzino', { siteId: SITES[1]!.id, kind: 'HANDHELD', status: 'PENDING', enrolledAt: null, lastSeenAt: null, appVersion: null }),
  device(5, 'Tablet vecchio', { status: 'REVOKED', revokedAt: at(18, 12), lastSeenAt: at(17, 18) }),
]
export const PRINTERS: Printer[] = [
  { id: uid('2727', 1), companyId: DEMO_COMPANIES[0].id, siteId: SITES[0].id, code: 'LBL-CUT', name: 'Etichette taglio', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'label-printer-1:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 50, status: 'ACTIVE', version: 1, createdAt: at(10, 9), updatedAt: at(10, 9) },
  { id: uid('2727', 2), companyId: DEMO_COMPANIES[0].id, siteId: SITES[0].id, code: 'A4-UFF', name: 'Stampante ufficio', kind: 'A4_PDF', relay: 'FAKE', relayTarget: 'office-printer', dpi: null, labelWidthMm: null, labelHeightMm: null, status: 'PAUSED', version: 3, createdAt: at(10, 9), updatedAt: at(22, 9) },
  { id: uid('2727', 3), companyId: DEMO_COMPANIES[0].id, siteId: SITES[1].id, code: 'LBL-MAG', name: 'Etichette magazzino', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'label-printer-2:9100', dpi: 300, labelWidthMm: 100, labelHeightMm: 150, status: 'ACTIVE', version: 1, createdAt: at(12, 9), updatedAt: at(12, 9) },
]

// ---- roles and people ----

const perms = (...names: string[]) => names
export const CATALOGUE: PermissionCatalogue = {
  templates: [],
  grains: [
    { grain: 'price', description: 'Selling and purchase prices.' },
    { grain: 'cost', description: 'Costs.' },
    { grain: 'margin', description: 'Margins.' },
    { grain: 'wages', description: 'Wages.' },
  ],
  permissions: [
    ['companies.view', 'read'],
    ['companies.manage', 'write'],
    ['sites.view', 'read'],
    ['sites.manage', 'write'],
    ['users.view', 'read'],
    ['users.invite', 'stepUp'],
    ['users.suspend', 'stepUp'],
    ['users.deactivate', 'stepUp'],
    ['roles.view', 'read'],
    ['roles.assign', 'stepUp'],
    ['devices.view', 'read'],
    ['devices.manage', 'write'],
    ['workers.view', 'read'],
    ['workers.credentials', 'stepUp'],
    ['quotes.view', 'read'],
    ['quotes.manage', 'write'],
    ['quotes.approve', 'write'],
    ['orders.view', 'read'],
    ['workorders.view', 'read'],
    ['workorders.manage', 'write'],
    ['workorders.release', 'write'],
    ['invoices.view', 'read'],
    ['invoices.issue', 'stepUp'],
    ['floor.work', 'write'],
    ['floor.lead', 'write'],
  ].map(([name, risk]) => ({ name: name!, area: name!.split('.')[0]!, description: `${name} (catalogue sentence)`, risk: risk as 'read' | 'write' | 'stepUp' })),
}

const role = (n: number, key: string, name: string, extra: Partial<Role>): Role => ({
  id: uid('2828', n),
  key,
  name,
  description: null,
  requireMfa: false,
  requireMfaSince: null,
  permissions: [],
  grains: [],
  system: true,
  basedOn: null,
  audience: 'office',
  version: 1,
  holders: 0,
  outdated: false,
  templateAdds: { permissionsAdded: [], grainsAdded: [] },
  ...extra,
})
export const ROLES: Role[] = [
  role(1, 'owner', 'Owner', { description: 'Everything, in every company, including every money figure.', requireMfa: true, requireMfaSince: '2026-09-01T07:30:00.000Z', grains: ['price', 'cost', 'margin', 'wages'], permissions: CATALOGUE.permissions.filter((p) => p.area !== 'floor').map((p) => p.name), holders: 1 }),
  role(2, 'admin', 'Administrator', { description: 'People, roles and the audit log; sees no money.', requireMfa: true, permissions: perms('companies.view', 'companies.manage', 'sites.view', 'sites.manage', 'users.view', 'users.invite', 'users.suspend', 'users.deactivate', 'roles.view', 'roles.assign', 'devices.view', 'devices.manage', 'workers.view', 'workers.credentials'), holders: 1 }),
  role(3, 'sales', 'Sales', { description: 'Customers, quotes and orders; sees selling prices, not costs or margins.', grains: ['price'], permissions: perms('quotes.view', 'quotes.manage', 'orders.view'), holders: 3 }),
  role(4, 'planner', 'Planner', { description: 'Plans work orders and capacity; sees no money.', permissions: perms('orders.view', 'workorders.view', 'workorders.manage', 'workorders.release'), holders: 2 }),
  role(5, 'finance', 'Finance', { description: 'Invoices, payments and number series; sees prices, costs, margins and wages.', requireMfa: true, grains: ['price', 'cost', 'margin', 'wages'], permissions: perms('invoices.view', 'invoices.issue', 'orders.view', 'quotes.view', 'quotes.approve'), holders: 1, outdated: true }),
  role(6, 'custom.sales_lead', 'Sales lead (copy)', { system: false, basedOn: 'sales', description: 'Sales, and approves quotes.', grains: ['price', 'margin'], requireMfa: true, permissions: perms('quotes.view', 'quotes.manage', 'quotes.approve', 'orders.view'), holders: 1, templateAdds: { permissionsAdded: ['invoices.view'], grainsAdded: [] } }),
  role(7, 'operator', 'Operator', { audience: 'floor', description: 'Works at a station: scans, counts, finishes bundles.', permissions: perms('floor.work'), holders: 18 }),
  role(8, 'cutting_operator', 'Cutting operator', { audience: 'floor', description: 'Cuts hides at the cutting table.', permissions: perms('floor.work'), holders: 4 }),
  role(9, 'floor_inspector', 'Floor inspector', { audience: 'floor', description: 'Inspects at the bench.', permissions: perms('floor.work'), holders: 2 }),
  role(10, 'team_leader', 'Team leader', { audience: 'floor', description: 'Leads a crew on the floor.', permissions: perms('floor.work', 'floor.lead'), grains: ['wages'], holders: 2 }),
]

const assignmentOf = (roleIndex: number, scope: { all?: boolean; companies?: string[]; sites?: string[] } = { all: true }, validTo: string | null = null) => ({
  assignmentId: uid('2929', roleIndex * 10 + (scope.companies?.length ?? 0)),
  roleId: ROLES[roleIndex]!.id,
  roleKey: ROLES[roleIndex]!.key,
  roleName: ROLES[roleIndex]!.name,
  allCompanies: scope.all ?? false,
  companyIds: scope.companies ?? [],
  siteIds: scope.sites ?? [],
  partyIds: [],
  validTo,
})
const user = (n: number, displayName: string, email: string, extra: Partial<User>): User => ({
  id: n === 1 ? DEMO_USER.id : uid('3333', n),
  email,
  displayName,
  locale: 'it',
  status: 'ACTIVE',
  roles: [],
  mfaEnabled: true,
  lastSignInAt: at(29, 7, 58),
  invitationExpiresAt: null,
  version: 3,
  ...extra,
})
export const USERS: User[] = [
  user(1, DEMO_USER.displayName, DEMO_USER.email, { locale: 'en', roles: [assignmentOf(0)] }),
  user(2, 'Bea Esempio', 'bea.esempio@example.com', { roles: [assignmentOf(1)] }),
  user(3, 'Carlo Prova', 'carlo.prova@example.com', { roles: [assignmentOf(2, { companies: [DEMO_COMPANIES[0].id] })], mfaEnabled: false }),
  user(4, 'Dora Campione', 'dora.campione@example.com', { roles: [assignmentOf(3, { companies: [DEMO_COMPANIES[0].id], sites: [SITES[0].id] }), assignmentOf(4, { all: true })] }),
  user(5, 'Elio Saggio', 'elio.saggio@example.com', { status: 'INVITED', roles: [assignmentOf(2, { companies: [DEMO_COMPANIES[1].id] })], mfaEnabled: false, lastSignInAt: null, invitationExpiresAt: '2026-11-04T09:00:00.000Z' }),
  user(6, 'Fabia Modello', 'fabia.modello@example.com', { status: 'SUSPENDED', roles: [assignmentOf(5, { companies: [DEMO_COMPANIES[0].id] })], lastSignInAt: at(12, 15) }),
  user(7, 'Gino Bozza', 'gino.bozza@example.com', { status: 'DEACTIVATED', roles: [], mfaEnabled: false, lastSignInAt: at(2, 11) }),
]

export const ASSIGNMENTS: Assignment[] = [
  { id: uid('2929', 31), userId: USERS[3]!.id, roleId: ROLES[3]!.id, roleKey: 'planner', roleName: 'Planner', allCompanies: false, companyIds: [DEMO_COMPANIES[0].id], siteIds: [SITES[0].id], partyIds: [], validFrom: at(3, 8), validTo: null, endedAt: null, live: true, version: 1 },
  { id: uid('2929', 40), userId: USERS[3]!.id, roleId: ROLES[4]!.id, roleKey: 'finance', roleName: 'Finance', allCompanies: true, companyIds: [], siteIds: [], partyIds: [], validFrom: at(3, 8), validTo: null, endedAt: null, live: true, version: 1 },
  { id: uid('2929', 21), userId: USERS[3]!.id, roleId: ROLES[2]!.id, roleKey: 'sales', roleName: 'Sales', allCompanies: false, companyIds: [DEMO_COMPANIES[0].id], siteIds: [], partyIds: [], validFrom: at(1, 8), validTo: at(3, 8), endedAt: at(3, 8), live: false, version: 2 },
]

const worker = (n: number, displayName: string, extra: Partial<Worker>): Worker => ({
  id: uid('3434', n),
  siteId: SITES[0].id,
  displayName,
  locale: 'it',
  employeeCode: `M-${String(100 + n)}`,
  userId: null,
  status: 'ACTIVE',
  hasPin: true,
  pinMustChange: false,
  locked: false,
  badge: { id: uid('3535', n), hint: String(4810 + n * 7).slice(-4), issuedAt: at(5, 8) },
  roles: [{ workerRoleId: uid('3636', n), roleId: ROLES[6]!.id, key: 'operator', name: 'Operator' }],
  version: 2,
  ...extra,
})
export const WORKERS: Worker[] = [
  worker(1, 'Anna Demo', {}),
  worker(2, 'Bruno Esempio', { roles: [{ workerRoleId: uid('3636', 20), roleId: ROLES[7]!.id, key: 'cutting_operator', name: 'Cutting operator' }] }),
  worker(3, 'Chiara Prova', { locked: true, roles: [{ workerRoleId: uid('3636', 30), roleId: ROLES[9]!.id, key: 'team_leader', name: 'Team leader' }] }),
  worker(4, 'Dario Campione', { hasPin: false, badge: null, employeeCode: null, locale: 'ro' }),
  worker(5, 'Ennio Bozza', { pinMustChange: true }),
  worker(6, 'Flavia Modello', { status: 'INACTIVE', badge: null }),
]

// ---- the record panels on an Admin record ----

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel
const historyCase = panelsScreen.cases.find((item) => item.id === 'history-changes')!.model as RecordPanelsViewModel

/** The record panels as an Admin record mounts them (internal notes only: an Admin record has no party). */
export function panels(record: { type: string; id: string; companyId: string | null; siteId?: string | null }, title: string, tab: 'thread' | 'history' = 'thread'): ReactNode {
  const base = tab === 'history' ? historyCase : conversation
  const model: RecordPanelsViewModel = {
    ...base,
    record,
    title,
    party: null,
    can: { ...base.can, email: false },
    messages: { ...base.messages, items: (base.messages.items ?? []).filter((message) => message.direction === 'INTERNAL_NOTE').slice(0, 3) },
    tab,
  }
  return createElement(RecordPanelsView, { model })
}
