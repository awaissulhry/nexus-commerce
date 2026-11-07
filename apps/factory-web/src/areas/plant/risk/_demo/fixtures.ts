import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { Assessment, AssessmentRecord, AssessmentsAnswer, Catalogue, CountsAnswer, DvrVersion, Measure, MeasuresAnswer, Owner, RoleSheet, SheetPreview, SheetRow, SheetsAnswer, Signer, VersionBrief } from '../api'
import { LAW } from '../model'

/**
 * Made-up data for SCR-209's design cases and its tabs (B-W2b-144): an invented company ("Officina Demo"), two invented
 * sites, invented assessments, versions and signers ("Studio Esempio", invented people), invented role sheets, PPE items and
 * courses, invented measures and a made-up one-page PDF. Nothing here is a real person, company or document. Design-only
 * (only fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e3-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-05'
export const NOW = '2026-11-05T08:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const DEMO_PDF = samplePdf(['Documento di valutazione dei rischi — Stabilimento Demo Nord', 'Rev. 2 · documento inventato per le prove'])

const COMPANY = DEMO_COMPANIES[0]
const company = { code: COMPANY.code, name: COMPANY.name }
export const SITE_N = { id: uid('9101', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('9101', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
const SITES = [SITE_N, SITE_S]
export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: null })
const COMPANY_ID = COMPANY.id

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The roles the design reads: the safety officer keeps the assessment, the plan and the sheets (and signs as RSPP); with the
 * cost grain the measures' cost shows; the occupational doctor signs and reads; the production manager reads and moves the
 * measures they own; read-only reads; sales has no safety.view.
 */
export const RISK_ROLES_DEMO = {
  safety: template('safety_officer'),
  safetyCost: [...template('safety_officer'), 'money.cost'],
  doctor: template('company_doctor'),
  production: template('production_manager'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type RiskRoleDemo = keyof typeof RISK_ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inRiskShell(path: string, page: ReactNode, role: RiskRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...RISK_ROLES_DEMO[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((site) => ({ id: site.id, name: site.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- people of the safety organisation (invented) --------------------------------------------------------------------------

export const PEOPLE = {
  employer: 'Giulia Esempio',
  rspp: 'Marco Demo',
  rls: 'Sara Prova',
  doctor: 'Dott.ssa Anna Fittizia',
  consultant: 'Studio Esempio Sicurezza',
  officer: 'Marco Demo',
  manager: 'Luca Campione',
}

const brief = (over: Partial<VersionBrief> & Pick<VersionBrief, 'id' | 'versionNo'>): VersionBrief => ({
  label: '',
  status: 'SIGNED',
  effectiveOn: '2025-03-01',
  certainDateOn: '2025-03-12',
  authorKind: 'CONSULTANT',
  authorName: PEOPLE.consultant,
  signers: [
    { role: 'EMPLOYER', signedOn: '2025-03-04' },
    { role: 'RSPP', signedOn: '2025-03-04' },
    { role: 'RLS', signedOn: '2025-03-10' },
    { role: 'DOCTOR', signedOn: '2025-03-12' },
  ],
  ...over,
})

export const V2_ID = uid('9201', 2)
export const V3_ID = uid('9201', 3)
export const V1_ID = uid('9201', 1)
const V3_BRIEF = brief({ id: V3_ID, versionNo: 3, label: 'Rev. 3', status: 'AWAITING_SIGNATURES', effectiveOn: '2026-11-01', certainDateOn: null, signers: [{ role: 'EMPLOYER', signedOn: '2026-11-03' }, { role: 'RSPP', signedOn: '2026-11-03' }, { role: 'RLS', signedOn: null }, { role: 'DOCTOR', signedOn: null }] })
const V2_BRIEF = brief({ id: V2_ID, versionNo: 2, label: 'Rev. 2', certainDateOn: '2025-03-12' })

export const NORTH: Assessment = {
  id: uid('9301', 1),
  companyId: COMPANY_ID,
  company,
  siteId: SITE_N.id,
  site: { code: SITE_N.code, name: SITE_N.name },
  name: 'Stabilimento Demo Nord',
  status: 'ACTIVE',
  nextReviewOn: '2026-11-20',
  reviewState: 'DUE_SOON',
  note: null,
  inForce: V2_BRIEF,
  waiting: V3_BRIEF,
  openMeasures: 4,
  overdueMeasures: 1,
  roles: 4,
  version: 3,
  canManage: true,
}

export const SOUTH: Assessment = {
  ...NORTH,
  id: uid('9301', 2),
  siteId: SITE_S.id,
  site: { code: SITE_S.code, name: SITE_S.name },
  name: 'Stabilimento Demo Sud',
  nextReviewOn: '2027-06-30',
  reviewState: 'PLANNED',
  inForce: brief({ id: uid('9201', 11), versionNo: 1, effectiveOn: '2026-02-01', certainDateOn: '2026-02-09', authorKind: 'IN_HOUSE', authorName: PEOPLE.officer, signers: [{ role: 'EMPLOYER', signedOn: '2026-02-05' }, { role: 'RSPP', signedOn: '2026-02-05' }, { role: 'RLST', signedOn: '2026-02-09' }] }),
  waiting: null,
  openMeasures: 1,
  overdueMeasures: 0,
  roles: 1,
  version: 1,
}

export const assessmentsAnswer = (over: Partial<AssessmentsAnswer> = {}): AssessmentsAnswer => ({ assessments: [NORTH], canManage: true, law: LAW.dvr, today: TODAY, ...over })

export const COUNTS: CountsAnswer = { measuresOverdue: 1, measuresDueSoon: 2, reviewsDue: 1, rolesWithoutKitOrTraining: 1, signaturesMissing: 2, assessments: 1, withoutVersion: 0, today: TODAY }

// ---- measures ------------------------------------------------------------------------------------------------------------

export const ROLE_REFS = [
  { id: uid('9401', 1), code: 'TAG', name: 'Tagliatore' },
  { id: uid('9401', 2), code: 'CUC', name: 'Cucitrice' },
  { id: uid('9401', 3), code: 'FIN', name: 'Addetto finissaggio' },
  { id: uid('9401', 4), code: 'MAG', name: 'Magazziniere' },
]

const measure = (n: number, over: Partial<Measure>): Measure => ({
  id: uid('9501', n),
  assessmentId: NORTH.id,
  assessment: NORTH.name,
  companyId: COMPANY_ID,
  company,
  siteId: SITE_N.id,
  site: { code: SITE_N.code, name: SITE_N.name },
  title: '',
  risk: null,
  roleSheets: [],
  ownerId: uid('9601', 1),
  owner: PEOPLE.manager,
  mine: false,
  dueOn: null,
  dueState: null,
  currency: 'EUR',
  status: 'PLANNED',
  source: 'DVR',
  sourceVersion: { id: V2_ID, versionNo: 2, label: 'Rev. 2' },
  sourceRecord: null,
  doneAt: null,
  doneBy: null,
  evidenceNote: null,
  evidence: [],
  verifiedAt: null,
  verifiedBy: null,
  cancelledAt: null,
  cancelReason: null,
  note: null,
  version: 1,
  canManage: true,
  canMove: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  ...over,
})

export const MEASURES: Measure[] = [
  measure(1, { title: 'Protezione sulla fustellatrice', risk: 'Schiacciamento delle mani', roleSheets: [ROLE_REFS[0]!], dueOn: '2026-10-20', dueState: 'OVERDUE', cost: 180000 }),
  measure(2, { title: 'Aspirazione colle al banco finissaggio', risk: 'Vapori di solventi', roleSheets: [ROLE_REFS[2]!], dueOn: '2026-11-25', dueState: 'DUE_SOON', status: 'IN_PROGRESS', cost: 420000, canMove: ['PLANNED', 'DONE', 'CANCELLED'] }),
  measure(3, { title: 'Tappetini antifatica alle macchine da cucire', risk: 'Postura in piedi', roleSheets: [ROLE_REFS[1]!], dueOn: '2026-12-01', dueState: 'DUE_SOON', cost: 90000, source: 'MEETING', sourceVersion: null }),
  measure(4, { title: 'Segnaletica dei percorsi in magazzino', risk: 'Urti con i carrelli', roleSheets: [ROLE_REFS[3]!], dueOn: '2027-03-31', dueState: 'PLANNED', owner: null, ownerId: null, cost: null, source: 'INSPECTION', sourceVersion: null }),
]
export const DONE_MEASURE = measure(5, { title: 'Corso carrellisti per il magazzino', risk: 'Carrelli elevatori', status: 'DONE', dueOn: '2026-09-30', dueState: 'DONE', doneAt: '2026-09-28T14:00:00.000Z', doneBy: PEOPLE.manager, evidenceNote: 'Attestati nel registro formazione.', evidence: [{ fileId: uid('9701', 1), name: 'attestati-demo.pdf' }], canMove: ['VERIFIED', 'IN_PROGRESS'] })

/** The measures without the cost key, as the API answers a reader without the cost grain. */
export const withoutCost = (rows: readonly Measure[]): Measure[] => rows.map(({ cost: _cost, ...rest }) => rest as Measure)

export const measuresAnswer = (rows: readonly Measure[] = MEASURES, cost = false): MeasuresAnswer => ({ measures: cost ? [...rows] : withoutCost(rows), complete: true, law: LAW.plan, today: TODAY })

export const OWNERS: Owner[] = [
  { id: uid('9601', 1), name: PEOPLE.manager, me: false },
  { id: uid('9601', 2), name: PEOPLE.officer, me: true },
]

// ---- role sheets ------------------------------------------------------------------------------------------------------------

const row = (n: number, over: Partial<SheetRow>): SheetRow => ({
  id: ROLE_REFS[n - 1]?.id ?? uid('9401', n),
  companyId: COMPANY_ID,
  company,
  siteId: SITE_N.id,
  site: { code: SITE_N.code, name: SITE_N.name },
  code: ROLE_REFS[n - 1]?.code ?? `R${n}`,
  name: ROLE_REFS[n - 1]?.name ?? `Mansione ${n}`,
  nameI18n: null,
  status: 'ACTIVE',
  people: 2,
  risks: 2,
  surveillanceNeeds: 0,
  ppeItems: 2,
  courses: 2,
  surveillance: { needed: false, frequencyMonths: null },
  updatedAt: '2026-10-14T09:30:00.000Z',
  version: 2,
  canManage: true,
  ...over,
})

export const SHEET_ROWS: SheetRow[] = [
  row(1, { nameI18n: { it: 'Tagliatore', en: 'Cutter' }, people: 3, risks: 3, surveillanceNeeds: 1, ppeItems: 3, courses: 2, surveillance: { needed: true, frequencyMonths: 12 } }),
  row(2, { nameI18n: { it: 'Cucitrice', en: 'Machinist' }, people: 6, risks: 2, surveillanceNeeds: 1, ppeItems: 1, courses: 2, surveillance: { needed: true, frequencyMonths: 24 } }),
  row(3, { nameI18n: { it: 'Addetto finissaggio', en: 'Finisher' }, people: 2, risks: 2, ppeItems: 2, courses: 1, surveillance: { needed: null, frequencyMonths: null } }),
  row(4, { nameI18n: { it: 'Magazziniere', en: 'Warehouse operator' }, people: 1, risks: 1, ppeItems: 0, courses: 1 }),
]
export const SOUTH_ROW = row(5, { id: uid('9401', 5), code: 'CUC-S', name: 'Cucitrice', siteId: SITE_S.id, site: { code: SITE_S.code, name: SITE_S.name }, people: 4 })

export const sheetsAnswer = (rows: readonly SheetRow[] = SHEET_ROWS, canAdd = true): SheetsAnswer => ({
  roleSheets: [...rows],
  complete: true,
  canAdd,
  law: { roleSheet: LAW.roleSheet, kit: LAW.kit, training: LAW.training, surveillance: LAW.surveillance, yearlyVisit: 'D.Lgs. 81/2008 art. 41 c.2 b' },
  today: TODAY,
})

export const CATALOGUE: Catalogue = {
  ppeItems: [
    { id: uid('9801', 1), code: 'GUA-TAG', name: 'Guanti antitaglio', nameI18n: { it: 'Guanti antitaglio', en: 'Cut-resistant gloves' }, category: 'HAND', standard: 'EN 388', sizes: ['8', '9', '10'] },
    { id: uid('9801', 2), code: 'CUF', name: 'Cuffie antirumore', nameI18n: { it: 'Cuffie antirumore', en: 'Ear defenders' }, category: 'HEARING', standard: 'EN 352-1', sizes: [] },
    { id: uid('9801', 3), code: 'SCA-S3', name: 'Scarpe antinfortunistiche S3', nameI18n: { it: 'Scarpe antinfortunistiche S3', en: 'Safety shoes S3' }, category: 'FOOT', standard: 'EN ISO 20345', sizes: ['38', '40', '42', '44'] },
    { id: uid('9801', 4), code: 'MAS-A1', name: 'Semimaschera A1', nameI18n: { it: 'Semimaschera A1', en: 'Half mask A1' }, category: 'RESPIRATORY', standard: 'EN 140', sizes: [] },
  ],
  courses: [
    { id: uid('9802', 1), code: 'GEN', name: 'Formazione generale', nameI18n: { it: 'Formazione generale', en: 'General training' }, type: 'GENERAL', hours: '4', refresherMonths: null },
    { id: uid('9802', 2), code: 'SPEC-A', name: 'Formazione specifica rischio alto', nameI18n: { it: 'Formazione specifica rischio alto', en: 'Specific training (high risk)' }, type: 'SPECIFIC', hours: '12', refresherMonths: 60 },
    { id: uid('9802', 3), code: 'CAR', name: 'Carrellisti', nameI18n: { it: 'Carrellisti', en: 'Forklift drivers' }, type: 'EQUIPMENT', hours: '12', refresherMonths: 60 },
  ],
}

export const CUTTER: RoleSheet = {
  ...SHEET_ROWS[0]!,
  description: 'Taglia pelle e tessuto al banco e alla fustellatrice.',
  createdAt: '2026-01-20T10:00:00.000Z',
  items: [
    { id: uid('9901', 1), seq: 1, kind: 'RISK', title: 'Tagli e abrasioni alle mani', note: 'Coltello e fustella' },
    { id: uid('9901', 2), seq: 2, kind: 'RISK', title: 'Schiacciamento alla fustellatrice', note: null },
    { id: uid('9901', 3), seq: 3, kind: 'RISK', title: 'Rumore della fustellatrice', note: null },
    { id: uid('9901', 4), seq: 4, kind: 'SURVEILLANCE', title: 'Esposizione al rumore', note: 'Sopra 80 dB(A) nelle ore di taglio' },
  ],
  kit: [
    { id: uid('9902', 1), seq: 1, ppeItemId: CATALOGUE.ppeItems[0]!.id, item: { ...CATALOGUE.ppeItems[0]!, status: 'ACTIVE' }, quantity: 2, whenToWear: 'Sempre al banco di taglio', note: null },
    { id: uid('9902', 2), seq: 2, ppeItemId: CATALOGUE.ppeItems[1]!.id, item: { ...CATALOGUE.ppeItems[1]!, status: 'ACTIVE' }, quantity: 1, whenToWear: 'Alla fustellatrice', note: null },
    { id: uid('9902', 3), seq: 3, ppeItemId: CATALOGUE.ppeItems[2]!.id, item: { ...CATALOGUE.ppeItems[2]!, status: 'ACTIVE' }, quantity: 1, whenToWear: 'Sempre in reparto', note: null },
  ],
  requirements: [
    { id: uid('9903', 1), courseId: CATALOGUE.courses[0]!.id, course: { ...CATALOGUE.courses[0]!, status: 'ACTIVE' }, withinDays: null, note: null },
    { id: uid('9903', 2), courseId: CATALOGUE.courses[1]!.id, course: { ...CATALOGUE.courses[1]!, status: 'ACTIVE' }, withinDays: 60, note: null },
  ],
  plan: { needed: true, frequencyMonths: 12, endOfEmploymentVisit: true, setOn: '2026-01-20' },
  peopleInRole: [
    { employeeId: uid('9904', 1), name: 'Paolo Esempio' },
    { employeeId: uid('9904', 2), name: 'Rita Demo' },
    { employeeId: uid('9904', 3), name: 'Ivan Prova' },
  ],
}

export const CUTTER_PREVIEW: SheetPreview = {
  changes: {
    header: [],
    risks: { added: ['Polveri di pelle al banco'], removed: [] },
    surveillanceNeeds: { added: [], removed: [] },
    kit: { added: [CATALOGUE.ppeItems[3]!.id], removed: [], changed: [{ ppeItemId: CATALOGUE.ppeItems[0]!.id, quantity: { from: 2, to: 3 }, whenToWear: null }] },
    courses: { added: [], removed: [], changed: [{ courseId: CATALOGUE.courses[1]!.id, withinDays: { from: 60, to: 30 } }] },
    surveillance: null,
    nothing: false,
  },
  impact: [
    { kind: 'COURSE_DEADLINE', courseId: CATALOGUE.courses[1]!.id, ppeItemId: null, people: 2, already: 0, names: [CUTTER.peopleInRole[1]!, CUTTER.peopleInRole[2]!], withinDays: { from: 60, to: 30 }, quantity: null, frequencyMonths: null },
    { kind: 'KIT_TO_ISSUE', courseId: null, ppeItemId: CATALOGUE.ppeItems[3]!.id, people: 3, already: 0, names: CUTTER.peopleInRole, withinDays: null, quantity: 1, frequencyMonths: null },
    { kind: 'KIT_TO_ISSUE', courseId: null, ppeItemId: CATALOGUE.ppeItems[0]!.id, people: 2, already: 1, names: [CUTTER.peopleInRole[0]!, CUTTER.peopleInRole[2]!], withinDays: null, quantity: 3, frequencyMonths: null },
  ],
  people: 3,
  refs: {
    courses: CATALOGUE.courses.map((course) => ({ id: course.id, code: course.code, name: course.name, nameI18n: course.nameI18n, type: course.type })),
    ppeItems: CATALOGUE.ppeItems.map((item) => ({ id: item.id, code: item.code, name: item.name, nameI18n: item.nameI18n, category: item.category })),
  },
  fingerprint: 'a'.repeat(64),
  today: TODAY,
}

/** "What this changes" of a visits change (counts only, no names): "4 people get a yearly visit". */
export const VISITS_PREVIEW: SheetPreview = {
  ...CUTTER_PREVIEW,
  changes: { ...CUTTER_PREVIEW.changes, risks: { added: [], removed: [] }, kit: { added: [], removed: [], changed: [] }, courses: { added: [CATALOGUE.courses[1]!.id], removed: [], changed: [] }, surveillance: { from: false, to: true }, surveillanceNeeds: { added: ['Movimenti ripetuti degli arti superiori'], removed: [] } },
  impact: [
    { kind: 'COURSE_NEEDED', courseId: CATALOGUE.courses[1]!.id, ppeItemId: null, people: 3, already: 1, names: [CUTTER.peopleInRole[0]!, CUTTER.peopleInRole[1]!, CUTTER.peopleInRole[2]!], withinDays: null, quantity: null, frequencyMonths: null },
    { kind: 'VISITS_NEEDED', courseId: null, ppeItemId: null, people: 4, already: 0, names: null, withinDays: null, quantity: null, frequencyMonths: 12 },
  ],
}

// ---- versions of the north assessment ---------------------------------------------------------------------------------------

const SHA = {
  v1: '3f1c2b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a',
  v2: '9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
  v3: 'c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3',
}

const signer = (role: Signer['role'], n: number, name: string, signedOn: string | null, method: 'OFFICE' | 'PAPER' = 'PAPER', mine = false): Signer => ({
  role,
  signatureId: uid('9a01', n),
  holder: { appointmentId: uid('9a02', n), name },
  signature: signedOn ? { id: uid('9a01', n), signerName: name, signedOn, signedAt: `${signedOn}T10:00:00.000Z`, method, appointmentId: uid('9a02', n), recordedBy: method === 'PAPER' ? PEOPLE.officer : name, scan: method === 'PAPER' ? { fileId: uid('9a03', n), name: `firma-${role.toLowerCase()}-demo.pdf` } : null } : null,
  mine,
})

const version = (n: 1 | 2 | 3, over: Partial<DvrVersion>): DvrVersion => ({
  id: n === 1 ? V1_ID : n === 2 ? V2_ID : V3_ID,
  assessmentId: NORTH.id,
  versionNo: n,
  label: `Rev. ${n}`,
  effectiveOn: '2025-03-01',
  authorKind: 'CONSULTANT',
  authorName: PEOPLE.consultant,
  changeSummary: null,
  status: 'SIGNED',
  inForce: false,
  superseded: true,
  file: { fileId: uid('9b01', n), name: `DVR-demo-rev${n}.pdf`, sizeBytes: 1_840_000, contentType: 'application/pdf' },
  sha256: SHA[`v${n}`],
  frozenAt: '2025-03-02T09:12:00.000Z',
  frozenBy: PEOPLE.officer,
  certainDateOn: null,
  signedAt: null,
  withdrawnAt: null,
  withdrawnReason: null,
  signers: [],
  missing: [],
  sealed: null,
  measures: 0,
  version: 2,
  ...over,
})

export const V3 = (mine: 'RSPP' | 'DOCTOR' | null = null): DvrVersion =>
  version(3, {
    status: 'AWAITING_SIGNATURES',
    inForce: false,
    superseded: false,
    effectiveOn: '2026-11-01',
    frozenAt: '2026-11-02T15:40:00.000Z',
    changeSummary: 'Nuovo reparto finissaggio con banco colle e aspirazione.',
    signers: [signer('EMPLOYER', 31, PEOPLE.employer, '2026-11-03'), signer('RSPP', 32, PEOPLE.rspp, '2026-11-03', 'OFFICE'), signer('RLS', 33, PEOPLE.rls, null), signer('DOCTOR', 34, PEOPLE.doctor, null, 'OFFICE', mine === 'DOCTOR')],
    missing: ['RLS', 'DOCTOR'],
    version: 3,
  })

export const V2: DvrVersion = version(2, {
  inForce: true,
  superseded: false,
  certainDateOn: '2025-03-12',
  signedAt: '2025-03-12T11:00:00.000Z',
  changeSummary: 'Revisione dopo il nuovo impianto di aspirazione al taglio.',
  signers: [signer('EMPLOYER', 21, PEOPLE.employer, '2025-03-04'), signer('RSPP', 22, PEOPLE.rspp, '2025-03-04'), signer('RLS', 23, PEOPLE.rls, '2025-03-10'), signer('DOCTOR', 24, PEOPLE.doctor, '2025-03-12', 'OFFICE')],
  sealed: { documentId: uid('9c01', 2), version: 1, language: 'it', fileId: uid('9c02', 2), createdAt: '2025-03-12T11:00:05.000Z' },
  measures: 3,
})

export const V1: DvrVersion = version(1, {
  effectiveOn: '2023-01-15',
  frozenAt: '2023-01-16T08:00:00.000Z',
  certainDateOn: '2023-01-27',
  signedAt: '2023-01-27T09:00:00.000Z',
  signers: [signer('EMPLOYER', 11, PEOPLE.employer, '2023-01-20'), signer('RSPP', 12, PEOPLE.rspp, '2023-01-20'), signer('RLS', 13, PEOPLE.rls, '2023-01-27')],
  sealed: null,
})

const burn = (): { on: string; open: number }[] => {
  const points: { on: string; open: number }[] = []
  for (let week = 52; week >= 0; week -= 1) {
    const on = new Date(Date.parse(`${TODAY}T12:00:00Z`) - week * 7 * 86_400_000).toISOString().slice(0, 10)
    points.push({ on, open: week > 40 ? 7 : week > 30 ? 6 : week > 20 ? 5 : week > 8 ? 5 : 4 })
  }
  return points
}

export function northRecord(over: Partial<AssessmentRecord> = {}, mine: 'RSPP' | 'DOCTOR' | null = null): AssessmentRecord {
  return {
    assessment: NORTH,
    versions: [V3(mine), V2, V1],
    next: { signers: [{ role: 'EMPLOYER', appointmentId: uid('9a02', 31), name: PEOPLE.employer }, { role: 'RSPP', appointmentId: uid('9a02', 32), name: PEOPLE.rspp }, { role: 'RLS', appointmentId: uid('9a02', 33), name: PEOPLE.rls }, { role: 'DOCTOR', appointmentId: uid('9a02', 34), name: PEOPLE.doctor }], sameAs: [], missingEmployer: false },
    plan: { open: 4, overdue: 1, dueSoon: 2, done: 1, verified: 2, cancelled: 0, burn: burn() },
    may: { manage: true, sign: true, upload: true },
    law: { dvr: LAW.dvr, versions: LAW.versions, plan: LAW.plan, review: LAW.review },
    today: TODAY,
    ...over,
  }
}

/** A site's first assessment, no version yet ("Add the current DVR"). */
export const EMPTY_SOUTH: Assessment = { ...SOUTH, inForce: null, waiting: null, openMeasures: 0, overdueMeasures: 0, nextReviewOn: null, reviewState: null }
