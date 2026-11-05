import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import type { BodyChoice, CalendarAnswer, CheckPlan, CheckResult, CheckType, Chip, CountsAnswer, MachineChoice, OwnerChoice, PlanRecord, ResultRecord, TypeBrief } from '../api'

/**
 * Made-up data for SCR-266's design cases, its register print and its report window (B-W2b-142): an invented company
 * ("Officina Demo"), two invented sites, made-up machines (DEMO-CP-01 …), an invented outside body ("Ente Verifiche Demo
 * S.r.l."), made-up people ("Anna Esempio", "Marco Prova"), made-up check types with their law in words, results, files and
 * job numbers. Nothing here is a real company, person, body or record. Design-only (only fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e3-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-03'
export const NOW = '2026-11-03T08:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const PATH = `${PREFIX}/plant/preventive`

const COMPANY = DEMO_COMPANIES[0]
export const SITE_N = { id: uid('8101', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('8101', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
export const SITES = [SITE_N, SITE_S]
const COMPANY_ID = uid('8100', 1)

export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: null })

// ---- roles -------------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The roles the design names: maintenance (keeps the checks, makes the jobs, locks), the production manager (the same),
 * the safety officer (reads: the checks reach the safety calendar), read-only (reads, changes nothing), a role that keeps
 * the checks only (no jobs, no lock: both offers held with their right) and sales (no plant.view: the page says so).
 */
export const PREVENTIVE_ROLES_DEMO = {
  maintenance: template('maintenance'),
  production: template('production_manager'),
  safety: template('safety_officer'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  checksOnly: ['plant.view', 'plant.checks.manage', 'files.read', 'home.view'],
  sales: template('sales'),
} as const
export type PreventiveRoleDemo = keyof typeof PREVENTIVE_ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inPreventiveShell(path: string, page: ReactNode, role: PreventiveRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...PREVENTIVE_ROLES_DEMO[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((site) => ({ id: site.id, name: site.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- people, bodies, machines, types --------------------------------------------------------------------------------------------

const ANNA = { id: uid('8201', 1), name: 'Anna Esempio' }
const MARCO = { id: uid('8201', 2), name: 'Marco Prova' }
export const BODY = { id: uid('8301', 1), name: 'Ente Verifiche Demo S.r.l.' }

export const OWNERS: OwnerChoice[] = [
  { kind: 'USER', id: ANNA.id, name: ANNA.name, me: true },
  { kind: 'USER', id: MARCO.id, name: MARCO.name, me: false },
]
export const BODIES: BodyChoice[] = [
  { id: BODY.id, code: 'ENTE-DEMO', legalName: BODY.name, tradeName: null },
  { id: uid('8301', 2), code: 'LAB-DEMO', legalName: 'Laboratorio Prove Demo S.p.A.', tradeName: 'LabDemo' },
]

const CLASSES = {
  press: { id: uid('8401', 1), code: 'CLICKING_PRESS', labelIt: 'Pressa fustellatrice', labelEn: 'Clicking press' },
  compressor: { id: uid('8401', 2), code: 'COMPRESSOR', labelIt: 'Compressore', labelEn: 'Compressor' },
  forklift: { id: uid('8401', 3), code: 'FORKLIFT', labelIt: 'Carrello elevatore', labelEn: 'Forklift' },
  sewing: { id: uid('8401', 4), code: 'LOCKSTITCH', labelIt: 'Macchina lineare', labelEn: 'Lockstitch machine' },
}

const machine = (n: number, asset: string, klass: (typeof CLASSES)[keyof typeof CLASSES], site = SITE_N, extra: Partial<MachineChoice> = {}): MachineChoice => ({
  id: uid('8501', n),
  companyId: COMPANY_ID,
  siteId: site.id,
  siteCode: site.code,
  assetNumber: asset,
  class: klass,
  make: 'Demo Macchine',
  modelName: `Modello ${n}`,
  status: 'RUNNING',
  locked: false,
  ...extra,
})

export const MACHINES: MachineChoice[] = [
  machine(1, 'DEMO-CP-01', CLASSES.press),
  machine(2, 'DEMO-CMP-01', CLASSES.compressor),
  machine(3, 'DEMO-FLT-01', CLASSES.forklift, SITE_N, { status: 'DO_NOT_USE', locked: true }),
  machine(4, 'DEMO-SEW-S-02', CLASSES.sewing, SITE_S),
]
const [PRESS, COMPRESSOR, FORKLIFT, SEWING] = MACHINES as [MachineChoice, MachineChoice, MachineChoice, MachineChoice]

const type = (n: number, code: string, labelIt: string, labelEn: string, legalBasis: string, klass: { id: string; code: string; labelIt: string; labelEn: string } | null, interval: number, unit: CheckType['defaultIntervalUnit'], outsideBody: boolean, keptYears: number): CheckType => ({
  id: uid('8601', n),
  code,
  labelIt,
  labelEn,
  legalBasis,
  machineClass: klass,
  defaultInterval: interval,
  defaultIntervalUnit: unit,
  outsideBody,
  keptYears,
  active: true,
})

export const TYPES: CheckType[] = [
  type(1, 'PRESS_GUARDS', 'Ripari e comandi a due mani della pressa', 'Press guards and two-hand controls', 'D.Lgs. 81/2008 art. 71 c. 4 (esempio)', CLASSES.press, 1, 'MONTH', false, 3),
  type(2, 'PRESSURE_VESSEL', 'Verifica periodica del recipiente a pressione', 'Pressure vessel periodic check', 'D.Lgs. 81/2008 art. 71 c. 11 (esempio)', CLASSES.compressor, 1, 'YEAR', true, 5),
  type(3, 'EARTHING', 'Verifica dell’impianto di messa a terra', 'Earthing system check', 'D.P.R. 462/2001 (esempio)', null, 2, 'YEAR', true, 5),
  type(4, 'LIFTING', 'Verifica periodica del carrello elevatore', 'Forklift periodic check', 'D.Lgs. 81/2008 art. 71 c. 11 (esempio)', CLASSES.forklift, 1, 'YEAR', true, 5),
]
const [GUARDS, VESSEL, EARTHING, LIFTING] = TYPES as [CheckType, CheckType, CheckType, CheckType]

const brief = (entry: CheckType): TypeBrief => ({ id: entry.id, code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, legalBasis: entry.legalBasis, outsideBody: entry.outsideBody, keptYears: entry.keptYears, active: entry.active })
const site = (entry: { id: string; code: string; name: string }) => ({ id: entry.id, code: entry.code, name: entry.name })
const machineBrief = (entry: MachineChoice) => ({ id: entry.id, assetNumber: entry.assetNumber, make: entry.make, modelName: entry.modelName, status: entry.status, classId: entry.class.id, siteId: entry.siteId })
const siteOf = (entry: MachineChoice) => (entry.siteId === SITE_S.id ? SITE_S : SITE_N)

// ---- plans -------------------------------------------------------------------------------------------------------------------

export const PLAN_IDS = { guards: uid('8701', 1), vessel: uid('8701', 2), earthing: uid('8701', 3), lifting: uid('8701', 4), sewingEarth: uid('8701', 5), oldGuards: uid('8701', 6) }

const plan = (id: string, m: MachineChoice, t: CheckType, over: Partial<CheckPlan>): CheckPlan => ({
  id,
  companyId: COMPANY_ID,
  site: site(siteOf(m)),
  machine: { ...machineBrief(m), locked: m.locked },
  checkType: brief(t),
  interval: t.defaultInterval,
  intervalUnit: t.defaultIntervalUnit,
  outsideBody: t.outsideBody ? BODY : null,
  owner: ANNA,
  firstDueOn: '2024-01-15',
  nextDueOn: '2027-01-15',
  reminderDays: 30,
  reminderFrom: '2026-12-16',
  lastRemindedAt: null,
  lastDone: null,
  due: { state: 'PLANNED', days: 73 },
  status: 'ACTIVE',
  endedAt: null,
  endedReason: null,
  note: null,
  version: 3,
  ...over,
})

export const PLANS: CheckPlan[] = [
  plan(PLAN_IDS.guards, PRESS, GUARDS, { outsideBody: null, firstDueOn: '2026-07-28', nextDueOn: '2026-10-28', reminderDays: 7, reminderFrom: '2026-10-21', lastRemindedAt: '2026-10-21T05:07:00.000Z', lastDone: { resultId: uid('8801', 1), performedOn: '2026-09-28', outcome: 'PASSED' }, due: { state: 'OVERDUE', days: -6 } }),
  plan(PLAN_IDS.vessel, COMPRESSOR, VESSEL, { firstDueOn: '2024-11-20', nextDueOn: '2026-11-20', reminderFrom: '2026-10-21', lastRemindedAt: '2026-10-21T05:07:00.000Z', lastDone: { resultId: uid('8801', 2), performedOn: '2025-11-18', outcome: 'PASSED_WITH_REMARKS' }, due: { state: 'DUE_SOON', days: 17 }, note: 'Il verbale arriva per PEC dall’ente.' }),
  plan(PLAN_IDS.lifting, FORKLIFT, LIFTING, { owner: MARCO, firstDueOn: '2025-10-30', nextDueOn: '2026-12-15', reminderDays: 14, reminderFrom: '2026-12-01', lastDone: { resultId: uid('8801', 4), performedOn: '2026-10-30', outcome: 'FAILED' }, due: { state: 'PLANNED', days: 42 } }),
  plan(PLAN_IDS.earthing, PRESS, EARTHING, { firstDueOn: '2025-03-15', nextDueOn: '2027-03-15', reminderDays: 60, reminderFrom: '2027-01-14', lastDone: { resultId: uid('8801', 3), performedOn: '2025-03-15', outcome: 'PASSED' }, due: { state: 'PLANNED', days: 132 } }),
  plan(PLAN_IDS.sewingEarth, SEWING, EARTHING, { owner: null, firstDueOn: '2026-11-25', nextDueOn: '2026-11-25', reminderFrom: '2026-10-26', due: { state: 'DUE_SOON', days: 22 } }),
]
export const ENDED_PLAN: CheckPlan = plan(PLAN_IDS.oldGuards, PRESS, GUARDS, { outsideBody: null, interval: 2, firstDueOn: '2025-01-28', nextDueOn: '2026-07-28', status: 'ENDED', endedAt: '2026-06-30T09:12:00.000Z', endedReason: 'Sostituito dal piano mensile', due: { state: 'ENDED', days: -98 }, version: 5 })

// ---- results -----------------------------------------------------------------------------------------------------------------

export const RESULT_IDS = { guards: uid('8801', 1), vessel: uid('8801', 2), earthing: uid('8801', 3), lifting: uid('8801', 4), wrongDay: uid('8801', 5), rightDay: uid('8801', 6) }

const file = (n: number, name: string, at: string) => ({ id: uid('8901', n), originalName: name, contentType: 'application/pdf', sizeBytes: 184_320 + n * 1024, availableAt: at })

const result = (id: string, m: MachineChoice, t: CheckType, planId: string | null, over: Partial<CheckResult>): CheckResult => ({
  id,
  companyId: COMPANY_ID,
  site: site(siteOf(m)),
  machine: machineBrief(m),
  checkType: brief(t),
  planId,
  performedOn: '2026-09-28',
  outcome: 'PASSED',
  remarks: null,
  performedBy: 'Manutenzione interna',
  outsideBody: null,
  nextDueOn: null,
  keptUntil: '2029-09-28',
  corrects: null,
  correctionReason: null,
  correctedBy: null,
  inForce: true,
  reports: [],
  reportOnFile: false,
  jobs: [],
  recordedAt: '2026-09-28T14:10:00.000Z',
  recordedBy: ANNA,
  ...over,
})

export const RESULTS: CheckResult[] = [
  result(RESULT_IDS.lifting, FORKLIFT, LIFTING, PLAN_IDS.lifting, {
    performedOn: '2026-10-30',
    outcome: 'FAILED',
    remarks: 'Catena di sollevamento usurata oltre il limite (dato di esempio).',
    performedBy: BODY.name,
    outsideBody: BODY,
    nextDueOn: '2026-12-15',
    keptUntil: '2031-10-30',
    jobs: [{ id: uid('8951', 12), number: 'MJ-D-0012', status: 'NEW' }],
    recordedAt: '2026-10-30T16:02:00.000Z',
    recordedBy: MARCO,
  }),
  result(RESULT_IDS.guards, PRESS, GUARDS, PLAN_IDS.guards, { reports: [file(1, 'verbale-ripari-2026-09.pdf', '2026-09-28T14:12:00.000Z')], reportOnFile: true }),
  result(RESULT_IDS.wrongDay, PRESS, GUARDS, PLAN_IDS.guards, { performedOn: '2026-04-28', keptUntil: '2029-04-28', correctedBy: { id: RESULT_IDS.rightDay, performedOn: '2026-04-27' }, inForce: false, reports: [file(2, 'verbale-ripari-2026-04.pdf', '2026-04-28T15:00:00.000Z')], reportOnFile: true, recordedAt: '2026-04-28T15:00:00.000Z' }),
  result(RESULT_IDS.rightDay, PRESS, GUARDS, PLAN_IDS.guards, { performedOn: '2026-04-27', keptUntil: '2029-04-27', corrects: { id: RESULT_IDS.wrongDay, performedOn: '2026-04-28' }, correctionReason: 'Data della verifica sbagliata', reportOnFile: true, recordedAt: '2026-05-02T09:00:00.000Z' }),
  result(RESULT_IDS.vessel, COMPRESSOR, VESSEL, PLAN_IDS.vessel, {
    performedOn: '2025-11-18',
    outcome: 'PASSED_WITH_REMARKS',
    remarks: 'Manometro da sostituire entro sei mesi (dato di esempio).',
    performedBy: BODY.name,
    outsideBody: BODY,
    keptUntil: '2030-11-18',
    reports: [file(3, 'verbale-recipiente-2025.pdf', '2025-11-20T10:00:00.000Z')],
    reportOnFile: true,
    jobs: [{ id: uid('8951', 7), number: 'MJ-D-0007', status: 'CLOSED' }],
    recordedAt: '2025-11-18T17:30:00.000Z',
  }),
  result(RESULT_IDS.earthing, PRESS, EARTHING, PLAN_IDS.earthing, { performedOn: '2025-03-15', performedBy: BODY.name, outsideBody: BODY, keptUntil: '2030-03-15', recordedAt: '2025-03-16T08:00:00.000Z' }),
]

export const COUNTS: CountsAnswer = { tiles: { OVERDUE: 1, DUE_SOON: 2, REPORTS_MISSING: 2 }, today: TODAY }

// ---- the calendar ------------------------------------------------------------------------------------------------------------

const chipOf = (p: CheckPlan, kind: Chip['kind'], date: string, state: Chip['state']): Chip => ({
  kind,
  date,
  state,
  planId: p.id,
  resultId: null,
  site: p.site,
  machine: { id: p.machine.id, assetNumber: p.machine.assetNumber, status: p.machine.status, locked: p.machine.locked },
  checkType: p.checkType,
  outsideBody: p.outsideBody?.name ?? null,
  outcome: null,
})
const doneChip = (r: CheckResult, locked = false): Chip => ({
  kind: 'DONE',
  date: r.performedOn,
  state: 'DONE',
  planId: r.planId,
  resultId: r.id,
  site: r.site,
  machine: { id: r.machine.id, assetNumber: r.machine.assetNumber, status: r.machine.status, locked },
  checkType: r.checkType,
  outsideBody: r.outsideBody?.name ?? null,
  outcome: r.outcome,
})

const [GUARDS_PLAN, VESSEL_PLAN, LIFTING_PLAN, , SEWING_PLAN] = PLANS as [CheckPlan, CheckPlan, CheckPlan, CheckPlan, CheckPlan]

export const CHIPS: Chip[] = [
  doneChip(RESULTS[0]!, true),
  chipOf(GUARDS_PLAN, 'DUE', '2026-10-28', 'OVERDUE'),
  chipOf(GUARDS_PLAN, 'PROJECTED', '2026-11-28', 'DUE_SOON'),
  chipOf(GUARDS_PLAN, 'PROJECTED', '2026-12-28', 'PLANNED'),
  chipOf(VESSEL_PLAN, 'DUE', '2026-11-20', 'DUE_SOON'),
  chipOf(SEWING_PLAN, 'DUE', '2026-11-25', 'DUE_SOON'),
  chipOf(LIFTING_PLAN, 'DUE', '2026-12-15', 'PLANNED'),
]

export const calendarAnswer = (over: Partial<CalendarAnswer> = {}, scope: OfficeScope = SCOPE_ONE): CalendarAnswer => ({
  from: '2026-10-01',
  to: '2026-12-31',
  today: TODAY,
  chips: scope.allSites ? CHIPS : CHIPS.filter((chip) => chip.site.id === SITE_N.id),
  canManage: true,
  ...over,
})

// ---- the windows' records ----------------------------------------------------------------------------------------------------

export const planRecord = (p: CheckPlan = GUARDS_PLAN, over: Partial<PlanRecord> = {}): PlanRecord => ({ plan: p, results: RESULTS.filter((r) => r.planId === p.id), canManage: true, canRecord: true, ...over })

export const resultRecord = (r: CheckResult = RESULTS[0]!, over: Partial<ResultRecord> = {}): ResultRecord => ({
  result: r,
  plan: PLANS.find((p) => p.id === r.planId) ?? null,
  corrections: [],
  machine: { id: r.machine.id, assetNumber: r.machine.assetNumber, status: r.machine.status, locked: MACHINES.find((m) => m.id === r.machine.id)?.locked ?? false },
  canCorrect: r.inForce,
  canMakeJob: r.outcome !== 'PASSED' && r.jobs.every((job) => job.status === 'CLOSED' || job.status === 'CANCELLED'),
  canLock: r.outcome === 'FAILED' && !(MACHINES.find((m) => m.id === r.machine.id)?.locked ?? false),
  canAddReport: true,
  ...over,
})

export { GUARDS, VESSEL, EARTHING, LIFTING, PRESS, COMPRESSOR, FORKLIFT, SEWING, GUARDS_PLAN, VESSEL_PLAN, LIFTING_PLAN, ANNA, MARCO, COMPANY_ID }

/** A one-page PDF that says it is made-up (built here so the design index needs no API). */
export function demoPdf(title: string): Uint8Array {
  const text = `BT /F1 20 Tf 72 770 Td (${title}) Tj 0 -28 Td /F1 11 Tf (Made-up design data) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

export const DEMO_SHA = 'a3f1c2d4e5b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'
