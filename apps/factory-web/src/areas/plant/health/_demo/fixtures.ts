import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { AUTOMATIC_WORDS, HEALTH_LAW, LIVE_USE_WORDS, PRIVACY_WORDS, PROTECTED_HEALTH_LAW, TASK_LIMITS_HINT } from '@nexus/factory-domain/safety/health/rules'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { DoctorChoice, HealthFrame, HealthPlan, HealthPerson, Judgement, JudgementRow, PickedPerson, PrintRow, Proposal, ShownJudgement, ViewsAnswer, Visit, VisitRow } from '../api'

/**
 * Made-up data for SCR-212's design cases and its two tabs (B-W2b-148): an invented company with two invented sites, invented
 * role sheets ("Tagliatore Demo"), invented people ("Giulia Esempio"), invented visits, judgements and task limits, an invented
 * occupational doctor. Nothing here is a real person, a real judgement or a real document. Design-only (only fixtures and
 * tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-05'
export const NOW = '2026-11-05T08:42:00.000Z'
export const PREFIX = '/w/DEMO'

const COMPANY = DEMO_COMPANIES[0]
export const SITE_N = { id: uid('9101', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('9101', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
const SITES = [SITE_N, SITE_S]
export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: null })

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The roles the design reads (factory-domain's templates): HR and the occupational doctor keep the visits and judgements (HR also
 * reads who looked); the safety officer keeps the plans only; the production manager and the read-only role see nothing here.
 */
export const HEALTH_ROLES_DEMO = {
  hr: template('hr'),
  doctor: template('company_doctor'),
  safety: template('safety_officer'),
  production: template('production_manager'),
  readOnly: template('read_only'),
} as const
export type HealthRoleDemo = keyof typeof HEALTH_ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inHealthShell(path: string, page: ReactNode, role: HealthRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...HEALTH_ROLES_DEMO[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((site) => ({ id: site.id, name: site.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- the frame ------------------------------------------------------------------------------------------------------------

export const FRAME: HealthFrame = {
  today: TODAY,
  privacy: { words: { ...PRIVACY_WORDS }, law: PROTECTED_HEALTH_LAW, viewLog: true },
  liveUse: { ...LIVE_USE_WORDS },
  automatic: { ...AUTOMATIC_WORDS },
  hint: { ...TASK_LIMITS_HINT },
  tiles: { overdue: 1, dueIn30: 2, beforeTask: 2, returnVisits: 1, unfitEnding: 1 },
  can: { manage: true, plans: false, views: true },
  law: HEALTH_LAW,
}

export const frameFor = (role: HealthRoleDemo): HealthFrame => ({
  ...FRAME,
  privacy: { ...FRAME.privacy, viewLog: role === 'hr' },
  can: { manage: role === 'hr' || role === 'doctor', plans: role === 'doctor' || role === 'safety', views: role === 'hr' },
})

// ---- people, roles ------------------------------------------------------------------------------------------------------------

const person = (n: number, name: string, code: string, site = SITE_N): HealthPerson => ({ id: uid('9201', n), name, employeeCode: code, siteId: site.id, site: { code: site.code, name: site.name } })
export const GIULIA = person(1, 'Giulia Esempio', 'D-0101')
export const MARCO = person(2, 'Marco Prova', 'D-0102')
export const SARA = person(3, 'Sara Campione', 'D-0103')
export const LUCA = person(4, 'Luca Modello', 'D-0104')
export const ELENA = person(5, 'Elena Fittizia', 'D-0201', SITE_S)

export const ROLE_CUT = { id: uid('9301', 1), code: 'TAG', name: 'Tagliatore Demo' }
export const ROLE_SEW = { id: uid('9301', 2), code: 'CUC', name: 'Cucitrice Demo' }
export const ROLE_FIN = { id: uid('9301', 3), code: 'FIN', name: 'Finissaggio Demo' }

// ---- visits ---------------------------------------------------------------------------------------------------------------------

const visitRow = (n: number, over: Partial<VisitRow>): VisitRow => ({
  id: uid('9401', n),
  companyId: COMPANY.id,
  employee: GIULIA,
  role: ROLE_CUT,
  type: 'PERIODIC',
  dueOn: '2026-11-25',
  status: 'DUE',
  state: 'DUE_SOON',
  booked: null,
  doneOn: null,
  version: 1,
  ...over,
})

export const RETURN_VISIT = visitRow(1, { employee: MARCO, role: ROLE_SEW, type: 'RETURN_AFTER_ABSENCE', dueOn: '2026-11-02', state: 'OVERDUE' })
export const PERIODIC_VISIT = visitRow(2, {})
export const BOOKED_VISIT = visitRow(3, { employee: SARA, role: ROLE_SEW, dueOn: '2026-11-20', status: 'BOOKED', state: 'BOOKED', booked: { on: '2026-11-17', place: 'Ambulatorio Demo, via Esempio 1' }, version: 2 })
export const STARTER_VISIT = visitRow(4, { employee: LUCA, role: ROLE_FIN, type: 'PREVENTIVE', dueOn: '2026-11-10', state: 'DUE_SOON' })
export const LATER_VISIT = visitRow(5, { employee: ELENA, role: ROLE_CUT, type: 'CHANGE_OF_TASK', dueOn: '2026-12-28', state: 'PLANNED' })
export const DONE_VISIT = visitRow(6, { employee: SARA, role: ROLE_SEW, type: 'ON_REQUEST', dueOn: '2026-10-15', status: 'DONE', state: 'DONE', doneOn: '2026-10-16', version: 3 })
export const CANCELLED_VISIT = visitRow(7, { employee: LUCA, role: ROLE_FIN, dueOn: '2026-09-30', status: 'CANCELLED', state: 'CANCELLED', version: 2 })

export const VISITS: readonly VisitRow[] = [RETURN_VISIT, STARTER_VISIT, BOOKED_VISIT, PERIODIC_VISIT]
export const VISITS_ALL_SITES: readonly VisitRow[] = [...VISITS, LATER_VISIT]
export const VISITS_ALL_STATES: readonly VisitRow[] = [...VISITS, DONE_VISIT, CANCELLED_VISIT]

export const visitOf = (row: VisitRow, over: Partial<Visit> = {}): Visit => ({
  ...row,
  planId: uid('9601', 2),
  absenceDays: row.type === 'RETURN_AFTER_ABSENCE' ? 75 : null,
  booked: row.booked ? { ...row.booked, at: '2026-11-03T10:15:00.000Z', by: { id: uid('9901', 1), name: 'Anna Demo (HR)' } } : null,
  cancelled: row.status === 'CANCELLED' ? { at: '2026-09-28T09:00:00.000Z', by: { id: uid('9901', 1), name: 'Anna Demo (HR)' }, reason: 'LEFT' } : null,
  judgementId: row.status === 'DONE' ? uid('9501', 3) : null,
  risks: ['Movimentazione manuale dei carichi (demo)', 'Rumore (demo)'],
  ...over,
})

// ---- judgements ------------------------------------------------------------------------------------------------------------

const judgementRow = (n: number, over: Partial<JudgementRow>): JudgementRow => ({ id: uid('9501', n), companyId: COMPANY.id, judgedOn: '2025-11-20', expiresOn: '2026-11-20', state: 'EXPIRING', fromVisit: true, hasCopy: true, version: 1, ...over })

export const LIMITS_JUDGEMENT = judgementRow(1, {})
export const UNFIT_JUDGEMENT = judgementRow(2, { judgedOn: '2026-10-22', expiresOn: null, state: 'IN_FORCE', hasCopy: false })
export const FIT_JUDGEMENT = judgementRow(3, { judgedOn: '2026-10-16', expiresOn: '2028-10-16', state: 'IN_FORCE' })
export const OLD_JUDGEMENT = judgementRow(4, { judgedOn: '2024-03-12', expiresOn: '2025-03-12', state: 'SUPERSEDED', fromVisit: false })
export const VOIDED_JUDGEMENT = judgementRow(5, { judgedOn: '2026-10-15', expiresOn: '2027-10-15', state: 'VOIDED', hasCopy: false })

export const JUDGEMENTS: readonly JudgementRow[] = [LIMITS_JUDGEMENT, UNFIT_JUDGEMENT, FIT_JUDGEMENT]
export const JUDGEMENTS_ALL: readonly JudgementRow[] = [...JUDGEMENTS, OLD_JUDGEMENT, VOIDED_JUDGEMENT]

/** The task limit of the made-up judgement: the limit for the task only. */
export const DEMO_LIMIT = 'Niente sollevamento oltre 15 kg; pause di 10 minuti ogni 2 ore al taglio.'

export const SHOWN: Readonly<Record<string, ShownJudgement>> = {
  [LIMITS_JUDGEMENT.id]: { ...LIMITS_JUDGEMENT, employee: GIULIA, outcome: 'FIT_WITH_LIMITS', taskLimits: DEMO_LIMIT, unfitUntil: null },
  [UNFIT_JUDGEMENT.id]: { ...UNFIT_JUDGEMENT, employee: MARCO, outcome: 'TEMPORARILY_UNFIT', taskLimits: null, unfitUntil: '2026-11-15' },
  [FIT_JUDGEMENT.id]: { ...FIT_JUDGEMENT, employee: SARA, outcome: 'FIT', taskLimits: null, unfitUntil: null },
}

export const judgementOf = (over: Partial<Judgement> = {}): Judgement => ({
  ...SHOWN[LIMITS_JUDGEMENT.id]!,
  visit: { id: uid('9401', 9), type: 'PERIODIC', doneOn: '2025-11-20' },
  doctor: { id: uid('9701', 1), name: 'Dott.ssa Demo Medico' },
  voided: null,
  copies: [{ fileId: uid('9801', 1), name: 'giudizio-demo.pdf', availableAt: '2025-11-21T09:00:00.000Z' }],
  recordedAt: '2025-11-21T08:55:00.000Z',
  ...over,
})

// ---- plans ------------------------------------------------------------------------------------------------------------------

const plan = (n: number, over: Partial<HealthPlan>): HealthPlan => ({
  id: uid('9601', n),
  companyId: COMPANY.id,
  siteId: SITE_N.id,
  site: { code: SITE_N.code, name: SITE_N.name },
  role: ROLE_CUT,
  needed: true,
  frequencyMonths: 12,
  endOfEmploymentVisit: false,
  setOn: '2026-09-15',
  doctor: { id: uid('9701', 1), name: 'Dott.ssa Demo Medico' },
  doctorSet: true,
  risks: ['Movimentazione manuale dei carichi (demo)', 'Rumore (demo)'],
  people: 6,
  status: 'ACTIVE',
  version: 2,
  canEdit: true,
  ...over,
})

export const PLAN_CUT = plan(1, {})
export const PLAN_SEW = plan(2, { role: ROLE_SEW, frequencyMonths: 24, doctor: null, doctorSet: false, risks: ['Movimenti ripetuti degli arti superiori (demo)'], people: 9, endOfEmploymentVisit: true })
export const PLAN_FIN = plan(3, { role: ROLE_FIN, needed: false, frequencyMonths: null, risks: [], people: 3, doctor: null, doctorSet: false })
export const PLAN_SOUTH = plan(4, { siteId: SITE_S.id, site: { code: SITE_S.code, name: SITE_S.name }, people: 4 })
export const PLANS: readonly HealthPlan[] = [PLAN_CUT, PLAN_SEW, PLAN_FIN]
export const plansFor = (role: HealthRoleDemo, rows: readonly HealthPlan[] = PLANS): HealthPlan[] => rows.map((row) => ({ ...row, canEdit: role === 'doctor' || role === 'safety' }))

export const DOCTORS: readonly DoctorChoice[] = [
  { id: uid('9701', 1), name: 'Dott.ssa Demo Medico', fromDate: '2026-01-01', untilDate: null, inForce: true },
  { id: uid('9701', 2), name: 'Dott. Esempio Sostituto', fromDate: '2026-12-01', untilDate: null, inForce: false },
]

// ---- Plan visits, pickers, Who looked, the print ----------------------------------------------------------------------------------

export const PROPOSALS: readonly Proposal[] = [
  { employee: LUCA, role: ROLE_FIN, planId: PLAN_FIN.id, type: 'PREVENTIVE', dueOn: '2026-11-10', why: 'STARTER', doctorSet: true },
  { employee: GIULIA, role: ROLE_CUT, planId: PLAN_CUT.id, type: 'PERIODIC', dueOn: '2026-11-20', why: 'JUDGEMENT_EXPIRES', doctorSet: true },
  { employee: person(6, 'Paolo Inventato', 'D-0106'), role: ROLE_SEW, planId: PLAN_SEW.id, type: 'CHANGE_OF_TASK', dueOn: '2026-11-03', why: 'ROLE_CHANGED', doctorSet: false },
]

export const PEOPLE: readonly PickedPerson[] = [
  { id: GIULIA.id, name: GIULIA.name, employeeCode: GIULIA.employeeCode, site: SITE_N },
  { id: MARCO.id, name: MARCO.name, employeeCode: MARCO.employeeCode, site: SITE_N },
  { id: ELENA.id, name: ELENA.name, employeeCode: ELENA.employeeCode, site: SITE_S },
]

export const VIEWS: ViewsAnswer = {
  views: [
    { id: uid('9902', 1), viewer: { id: uid('9901', 1), name: 'Anna Demo (HR)' }, viewedAt: '2026-11-05T08:40:00.000Z', recordType: 'HEALTH_VISIT_LIST', recordId: null, what: 'LIST', employee: null },
    { id: uid('9902', 2), viewer: { id: uid('9901', 2), name: 'Dott.ssa Demo Medico' }, viewedAt: '2026-11-04T16:12:00.000Z', recordType: 'HEALTH_VISIT_LIST', recordId: null, what: 'PRINT', employee: null },
    { id: uid('9902', 3), viewer: { id: uid('9901', 1), name: 'Anna Demo (HR)' }, viewedAt: '2026-11-03T11:02:00.000Z', recordType: 'HEALTH_VISIT_LIST', recordId: null, what: 'LIST', employee: null },
  ],
  fitnessChecks: [],
  law: PROTECTED_HEALTH_LAW,
}

export const PRINT_ROWS: readonly PrintRow[] = VISITS.map((row) => ({ ...row, risks: row.role?.id === ROLE_SEW.id ? ['Movimenti ripetuti degli arti superiori (demo)'] : ['Movimentazione manuale dei carichi (demo)', 'Rumore (demo)'] }))

/** A made-up one-page PDF (the design's copy). */
export const DEMO_PDF = samplePdf(['GIUDIZIO DI IDONEITA ALLA MANSIONE (esempio)', 'Lavoratore: Giulia Esempio (dati inventati)', 'Mansione: Tagliatore Demo', 'Giudizio: idonea con limitazioni', 'Limitazioni: niente sollevamento oltre 15 kg'])
