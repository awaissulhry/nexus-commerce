import { createElement } from 'react'
import { defaultSectionLayout } from '@nexus/ui/patterns'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../quality/_shared/fixtures'
import type { Cr6, Expiries, Gaps, Kpis, Register } from './api'
import { reportsAddressOf, reportsCan, sectionSpecs } from './model'
import { ReportsView, type Read, type ReportsModel } from './view/ReportsView'

/**
 * SCR-261 — Compliance reports with made-up styles, brands, certificates, suppliers, lots and register entries only (invented
 * numbers; "Demo" names, DEMO- codes): the owner's whole report, each panel's states (loading as skeletons, two panels failed
 * while the others stand, a period with nothing recorded said "—"), one brand, a partial read of the matrix, the roles
 * (production manager, a register reader, no right), Arrange, the keys, offline.
 */

const COMPANY = { id: uid('7201', 1), code: 'DEMO', name: 'Officina Demo' }
const BRAND_A = { id: uid('7202', 1), code: 'DEMO-B1', name: 'Marchio Demo Uno' }
const BRAND_B = { id: uid('7202', 2), code: 'DEMO-B2', name: 'Marchio Demo Due' }
const CONCERIA = { id: uid('7203', 1), code: 'DEMO-S1', name: 'Conceria Demo Srl' }
const PELLI = { id: uid('7203', 2), code: 'DEMO-S2', name: 'Pelli Esempio Spa' }
const FROM = '2025-11-11'
const TO = '2026-11-10'
const NOW = '2026-11-10T09:42:00.000Z'
const MARKETS = [
  { code: 'IT', name: 'Italia' },
  { code: 'DE', name: 'Germania' },
  { code: 'FR', name: 'Francia' },
  { code: 'ES', name: 'Spagna' },
]
const head = { company: COMPANY, brand: null, from: FROM, to: TO, today: TO, asOf: NOW }
const SIGHT_ALL = { certificates: true, register: true, lots: true, shipments: true }
const SIGHT_NONE = { certificates: false, register: false, lots: false, shipments: false }
const STYLES = { read: 14, more: false, markets: MARKETS }

const KPIS: Kpis = {
  ...head,
  sight: SIGHT_ALL,
  styles: STYLES,
  brands: [BRAND_A, BRAND_B],
  kpis: {
    coverage: { covered: 44, needing: 48, expiring: 3, pct: '91.7', cells: 56 },
    shipped: { pairs: 19, needing: 17, covered: 15, unknown: 1, pct: '88.2', shipments: 42 },
    gaps: { count: 23, crViCounted: true },
    refusals: { count: 6, overridden: 1, byGate: [{ gate: 'WORK_ORDER_RELEASE', count: 2 }, { gate: 'LABEL_PRINT', count: 1 }, { gate: 'FINAL_RELEASE', count: 0 }, { gate: 'SHIPMENT', count: 3 }] },
    registerOpen: { count: 5, risk: 1 },
    crViLots: { lots: 37, withEvidence: 36, pct: '97.3' },
  },
}

const GAPS: Gaps = {
  ...head,
  from: TO,
  sight: SIGHT_ALL,
  styles: STYLES,
  rows: [
    { type: 'certificate', count: 4, styles: 2, markets: 4, blocking: 4, requirements: ['CERT-COVERAGE'] },
    { type: 'docLanguage', count: 12, styles: 5, markets: 3, blocking: 2, requirements: ['DOC-LANGUAGE', 'USER-INFO-LANGUAGE', 'USER-INFO-DE'] },
    { type: 'label', count: 3, styles: 3, markets: 1, blocking: 3, requirements: ['LABEL-LANGUAGE'] },
    { type: 'crVi', count: 2, styles: null, markets: null, blocking: null, requirements: [] },
    { type: 'operator', count: 2, styles: 2, markets: 1, blocking: 2, requirements: ['EU-OPERATOR'] },
    { type: 'other', count: 0, styles: 0, markets: 0, blocking: 0, requirements: [] },
  ],
}

const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10']
const cert = (n: number, validTo: string, over: Partial<Expiries['months'][number]['items'][number]> = {}): Expiries['months'][number]['items'][number] => ({
  recordType: 'Certificate',
  recordId: uid('7204', n),
  label: `DEMO-CERT-${String(n).padStart(4, '0')}`,
  validTo,
  status: 'VALID',
  detail: 'EN 17092-3:2020',
  party: null,
  endsWithBase: false,
  ...over,
})
const EXPIRY_ITEMS: Record<string, Expiries['months'][number]['items']> = {
  '2026-12': [cert(1, '2026-12-14', { detail: 'EN 1621-1:2012' })],
  '2027-02': [cert(2, '2027-02-28', { status: 'SUSPENDED' }), cert(3, '2027-02-28', { endsWithBase: true, detail: 'EN 17092-3:2020' })],
  '2027-05': [{ recordType: 'SupplierDeclarationRequest', recordId: uid('7205', 1), label: 'SD-DEMO-0004', validTo: '2027-05-31', status: 'ACCEPTED', detail: 'REACH_SVHC', party: CONCERIA.name, endsWithBase: false }],
  '2027-09': [cert(4, '2027-09-30', { detail: 'EN 13594:2015' }), { recordType: 'SupplierDeclarationRequest', recordId: uid('7205', 2), label: 'SD-DEMO-0007', validTo: '2027-09-15', status: 'ACCEPTED', detail: 'CR6', party: PELLI.name, endsWithBase: false }],
}
const EXPIRIES: Expiries = {
  ...head,
  from: TO,
  to: '2027-11-10',
  sight: SIGHT_ALL,
  months: MONTHS.map((month) => ({ month, count: EXPIRY_ITEMS[month]?.length ?? 0, items: EXPIRY_ITEMS[month] ?? [] })),
  count: Object.values(EXPIRY_ITEMS).reduce((sum, items) => sum + items.length, 0),
}

const CR6: Cr6 = {
  ...head,
  sight: SIGHT_ALL,
  unit: 'mg/kg',
  results: 41,
  suppliers: [
    { party: PELLI, lots: 9, results: 10, measured: 9, belowDetection: 1, median: '1.6', highest: '3.4', fails: 1, limit: '3', lotReports: 10, supplierReports: 0 },
    { party: CONCERIA, lots: 28, results: 30, measured: 22, belowDetection: 8, median: '0.9', highest: '2.1', fails: 0, limit: '3', lotReports: 18, supplierReports: 12 },
    { party: null, lots: 1, results: 1, measured: 0, belowDetection: 1, median: null, highest: null, fails: 0, limit: '3', lotReports: 1, supplierReports: 0 },
  ],
}

const REGISTER_MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
const trend = (values: readonly number[]) => REGISTER_MONTHS.map((_, index) => values[index] ?? 0)
const REGISTER: Register = {
  ...head,
  sight: SIGHT_ALL,
  months: REGISTER_MONTHS,
  kinds: [
    { kind: 'COMPLAINT', opened: 14, closed: 12, openAtEnd: 3, medianDaysToClose: '9.5', months: trend([1, 2, 0, 1, 1, 2, 1, 0, 1, 2, 1, 1, 1]) },
    { kind: 'NON_CONFORMITY', opened: 6, closed: 5, openAtEnd: 1, medianDaysToClose: '14.0', months: trend([0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0]) },
    { kind: 'RECALL', opened: 1, closed: 0, openAtEnd: 1, medianDaysToClose: null, months: trend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) },
    { kind: 'WITHDRAWAL', opened: 1, closed: 1, openAtEnd: 0, medianDaysToClose: '21.0', months: trend([0, 0, 0, 0, 0, 1]) },
    { kind: 'AUTHORITY_REQUEST', opened: 2, closed: 2, openAtEnd: 0, medianDaysToClose: '6.0', months: trend([0, 0, 0, 1, 0, 0, 0, 0, 1]) },
  ],
  all: { opened: 24, closed: 20, openAtEnd: 5, medianDaysToClose: '10.0', months: trend([1, 3, 0, 2, 2, 4, 1, 1, 2, 3, 1, 2, 2]) },
  notices: { sent: 1, drafts: 1 },
  recalls: { active: 1, closed: 1, unitsStillOut: 37 },
  requests: { received: 2, answered: 2, onTime: 2, onTimePct: '100.0', open: 0, overdue: 0 },
}

export { KPIS, GAPS, EXPIRIES, CR6, REGISTER }

const ready = <T>(value: T): Read<T> => ({ status: 'ready', value })
const failed = <T>(): Read<T> => ({ status: 'error', problem: 'problem.unavailable' })
const loading = <T>(): Read<T> => ({ status: 'loading' })
const specs = sectionSpecs((id) => id)

function model(over: Partial<ReportsModel> = {}, role: RoleCase = 'owner', address = ''): ReportsModel {
  return {
    prefix: PREFIX,
    can: reportsCan([...ROLE_PERMISSIONS[role], 'compliance.reports.view', 'shipping.view', 'parties.view']),
    address: reportsAddressOf(new URLSearchParams(address)),
    companyName: COMPANY.name,
    range: { from: FROM, to: TO },
    today: TO,
    kpis: ready(KPIS),
    gaps: ready(GAPS),
    expiries: ready(EXPIRIES),
    cr6: ready(CR6),
    register: ready(REGISTER),
    live: 'live',
    asOf: NOW,
    layout: defaultSectionLayout(specs),
    specs,
    arranging: false,
    ...over,
  }
}

const EMPTY_KPIS: Kpis = {
  ...KPIS,
  kpis: {
    coverage: { covered: 0, needing: 0, expiring: 0, pct: null, cells: 0 },
    shipped: { pairs: 0, needing: 0, covered: 0, unknown: 0, pct: null, shipments: 0 },
    gaps: { count: 0, crViCounted: true },
    refusals: { count: 0, overridden: 0, byGate: KPIS.kpis.refusals!.byGate.map((entry) => ({ ...entry, count: 0 })) },
    registerOpen: { count: 0, risk: 0 },
    crViLots: { lots: 0, withEvidence: 0, pct: null },
  },
}
const EMPTY_REGISTER: Register = {
  ...REGISTER,
  kinds: REGISTER.kinds.map((row) => ({ ...row, opened: 0, closed: 0, openAtEnd: 0, medianDaysToClose: null, months: trend([]) })),
  all: { opened: 0, closed: 0, openAtEnd: 0, medianDaysToClose: null, months: trend([]) },
  notices: { sent: 0, drafts: 0 },
  recalls: { active: 0, closed: 0, unitsStillOut: 0 },
  requests: { received: 0, answered: 0, onTime: 0, onTimePct: null, open: 0, overdue: 0 },
}
const BRAND_KPIS: Kpis = { ...KPIS, brand: BRAND_A, styles: { ...STYLES, read: 5 }, kpis: { ...KPIS.kpis, coverage: { covered: 18, needing: 20, expiring: 1, pct: '90.0', cells: 20 }, shipped: { pairs: 7, needing: 7, covered: 7, unknown: 0, pct: '100.0', shipments: 12 }, gaps: { count: 9, crViCounted: true } } }
const registerOnly = (value: Kpis): Kpis => ({ ...value, sight: { ...SIGHT_NONE, register: true }, styles: null, brands: [], kpis: { coverage: null, shipped: null, gaps: null, refusals: null, registerOpen: value.kpis.registerOpen, crViLots: null } })

function ReportsDesign({ model: value }: { model: ReportsModel }) {
  return inShell('/compliance/reports', createElement(ReportsView, { model: value }))
}

export const designScreen = defineDesignScreen<ReportsModel>({
  screen: 'SCR-261',
  title: 'Compliance reports (Compliance)',
  view: ReportsDesign,
  holdsPage: true,
  cases: [
    { id: 'report', label: 'The report (owner)', model: model(), note: 'Certificate coverage (ANA-025) and the main gaps, the gaps by type, 12 months of expiries, chromium VI per supplier against the limit, the register summary.' },
    { id: 'loading', label: 'Loading (skeletons)', model: model({ kpis: loading(), gaps: loading(), expiries: loading(), cr6: loading(), register: loading(), asOf: null }) },
    { id: 'error', label: 'Two panels failed, three stand', model: model({ kpis: failed(), cr6: failed() }), note: 'Each panel says what failed and Try again; the rest of the page stays usable.' },
    {
      id: 'empty',
      label: 'Nothing recorded in the period',
      model: model({ kpis: ready(EMPTY_KPIS), gaps: ready({ ...GAPS, rows: GAPS.rows.map((row) => ({ ...row, count: 0, styles: 0, markets: 0, blocking: row.blocking === null ? null : 0, requirements: [] })) }), expiries: ready({ ...EXPIRIES, months: EXPIRIES.months.map((month) => ({ ...month, count: 0, items: [] })), count: 0 }), cr6: ready({ ...CR6, results: 0, suppliers: [] }), register: ready(EMPTY_REGISTER) }),
      note: '"—", never 0 %.',
    },
    { id: 'brand', label: 'One brand', model: model({ kpis: ready(BRAND_KPIS) }, 'owner', `brand=${BRAND_A.id}`), note: 'The style figures of one brand; the calendar keeps the declarations (per material).' },
    { id: 'partial', label: 'More styles than the board reads', model: model({ kpis: ready({ ...KPIS, styles: { ...STYLES, read: 200, more: true } }), gaps: ready({ ...GAPS, styles: { ...STYLES, read: 200, more: true } }) }), note: 'A partial read says so.' },
    { id: 'arrange', label: 'Arrange panels', model: model({ arranging: true }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: model({ keysOpen: true }) },
    { id: 'offline', label: 'Offline (live off)', model: model({ live: 'offline' }) },
    { id: 'role-production', label: 'Production manager', model: model({}, 'production'), note: 'Reads the certificates, the register and the lots; changes nothing here.' },
    {
      id: 'role-register',
      label: 'A register reader only',
      model: model({ kpis: ready(registerOnly(KPIS)), gaps: ready({ ...GAPS, sight: { ...SIGHT_NONE, register: true }, styles: null, rows: [] }), expiries: ready({ ...EXPIRIES, sight: { ...SIGHT_NONE, register: true }, months: EXPIRIES.months.map((month) => ({ ...month, count: 0, items: [] })), count: 0 }), cr6: ready({ ...CR6, sight: { ...SIGHT_NONE, register: true }, results: 0, suppliers: [] }) }, 'readOnly'),
      note: 'Every other figure says "Not in your role".',
    },
    { id: 'no-permission', label: 'No right (sales)', model: { ...model({}, 'sales'), can: reportsCan(ROLE_PERMISSIONS.sales) } },
  ],
})
