import { createElement } from 'react'
import { DEFAULT_ATTENDANCE_SETTINGS } from '@nexus/factory-domain/people/attendance/rules'
import { STANDARD_ABSENCE_CODES } from '@nexus/factory-domain/people/attendance/absences'
import { LAW_VALUES } from '@nexus/factory-domain/people/limits/rules'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANY, inShell, PEOPLE_ROLES, PREFIX, SCOPE_ALL, SCOPE_ONE, SITE_N, SITE_S, type PeopleRole } from '../_shared/fixtures'
import type { AbsenceCode, CompanyPrivacy, Gate, LimitEntry, Limits, PayrollSettings, PurposeView, ReviewRule, RuleKind, SitePrivacy } from './api'
import { blankCode, blankConsultant, codeDraftOf, limitDraftOf, LIMIT_ORDER, payrollDraftOf, settingsCan } from './model'
import type { GateDialog } from './view/PrivacyCard'
import { SettingsView, type SettingsModel } from './view/SettingsView'

/**
 * SCR-265 — People settings with made-up data only (the id is the plan's new one): rounding with its worked example, a card in
 * edit, absence codes and the Absence code dialog, limits with the law beside each, privacy with the legal gates off,
 * ready and on, widening and narrowing, Unsaved changes, someone else's change, each section's own loading and failure, and
 * the roles (the Owner keeps the gates; HR keeps the rest; the production manager reads; read-only). B-W2b-89: Payroll and
 * statements (the labour consultant, the payroll code, the printer of statements; New consultant) and Standard review.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

const code = (n: number, over: Partial<AbsenceCode> & Pick<AbsenceCode, 'code' | 'category'>): AbsenceCode => ({ id: uid('5001', n), companyId: COMPANY, labelI18n: { it: over.code, en: over.code }, lulCode: null, paid: true, documentRequired: false, status: 'ACTIVE', inUse: 0, version: 1, ...over })
const CODES: AbsenceCode[] = STANDARD_ABSENCE_CODES.slice(0, 6).map((entry, index) => code(index + 1, { code: entry.code, category: entry.category, labelI18n: { it: entry.it, en: entry.en }, paid: entry.paid, documentRequired: entry.documentRequired, lulCode: index < 2 ? `L${index + 1}` : null, inUse: index === 0 ? 42 : 0 }))
const ARCHIVED = code(20, { code: 'VECCHIO', category: 'OTHER', labelI18n: { it: 'Codice vecchio' }, status: 'ARCHIVED', inUse: 3 })

const entry = (kind: RuleKind, over: Partial<LimitEntry> = {}): LimitEntry => {
  const law = LAW_VALUES[kind]
  return { kind, inForce: null, own: null, law: { limitMinutes: law.limitMinutes, breakMinutes: law.breakMinutes, referenceMonths: law.referenceMonths, legalReference: law.legalReference }, ...over }
}
const OVERTIME_RULE = { id: uid('5002', 1), companyId: COMPANY, siteId: SITE_N.id, kind: 'OVERTIME_YEARLY_CAP' as const, limitMinutes: 12000, breakMinutes: null, referenceMonths: null, action: 'BLOCK' as const, alertRoles: ['admin'], source: 'CCNL' as const, legalReference: 'CCNL Demo art. 12', status: 'ACTIVE' as const, version: 2 }
const LIMITS: Limits = {
  companyId: COMPANY,
  siteId: SITE_N.id,
  limits: LIMIT_ORDER.map((kind) => (kind === 'OVERTIME_YEARLY_CAP' ? entry(kind, { inForce: OVERTIME_RULE, own: OVERTIME_RULE }) : entry(kind))),
  roles: [
    { key: 'admin', name: 'Amministratore' },
    { key: 'production_manager', name: 'Responsabile produzione' },
    { key: 'floor_supervisor', name: 'Capo reparto' },
  ],
  canManage: true,
}
const drafts = (limits: Limits) => Object.fromEntries(limits.limits.map((row) => [row.kind, limitDraftOf(row)]))

const COMPANY_PRIVACY: CompanyPrivacy = {
  company: { id: COMPANY, code: 'DEMO', name: 'Officina Demo' },
  settings: { minimumGroupSize: 3, figureRoleKeys: ['admin'], version: 2 },
  named: [{ key: 'admin', name: 'Amministratore' }],
  roles: LIMITS.roles.map((role) => ({ ...role, system: true })),
}

const DPIA = { id: uid('5003', 1), versionNo: 2, status: 'STORED', signedByName: 'Consulente Demo', signedOn: '2026-10-01', reviewDueOn: '2027-10-01' }
const siteRef = (site: { id: string; code: string; name: string }) => ({ ...site, companyId: COMPANY })
const gate = (purpose: Gate['purpose'], over: Partial<Gate> = {}): Gate => ({ id: uid('5004', purpose === 'ATTENDANCE' ? 1 : 2), purpose, basis: { kind: 'NOT_REQUIRED', reference: 'Parere Demo 2026/1' }, basisCoversLeads: false, leadsSeeFigures: false, notice: { id: uid('5005', 1), label: 'Informativa v2', status: 'PUBLISHED' }, dpia: DPIA, switchedOnAt: '2026-10-05T08:00:00.000Z', switchedOnByName: 'Anna Esempio', switchedOffAt: null, switchedOffByName: null, switchOffReason: null, version: 1, ...over })
const off = (purpose: Gate['purpose'], missing: PurposeView['readiness']['missing'] = []): PurposeView => ({ purpose, open: false, gate: null, readiness: { canSwitchOn: missing.length === 0, missing, notes: [] }, notes: [] })
const on = (row: Gate, notes: string[] = []): PurposeView => ({ purpose: row.purpose, open: true, gate: row, readiness: { canSwitchOn: true, missing: [], notes: [] }, notes })

const site = (over: Partial<SitePrivacy> = {}): SitePrivacy => ({ site: siteRef(SITE_N), scanSubject: 'WORKER', siteBasis: { kind: 'UNION_AGREEMENT', reference: 'Accordo RSU 2026/4' }, workerNotice: { id: uid('5005', 1), label: 'Informativa v2' }, dpia: DPIA, purposes: [off('ATTENDANCE'), off('PERFORMANCE')], history: [], ...over })
const SITE_READY = site()
const SITE_ON = site({ purposes: [on(gate('ATTENDANCE')), on(gate('PERFORMANCE', { basis: { kind: 'UNION_AGREEMENT', reference: 'Accordo RSU 2026/4' }, basisCoversLeads: true }))] })
const SITE_MISSING = site({ site: siteRef(SITE_S), scanSubject: 'STATION', siteBasis: null, workerNotice: null, dpia: null, purposes: [off('ATTENDANCE', [{ code: 'WORKER_NOTICE' }, { code: 'DPIA' }]), { ...off('PERFORMANCE', [{ code: 'WORKER_NOTICE' }, { code: 'DPIA' }, { code: 'SITE_BASIS' }]), readiness: { canSwitchOn: false, missing: [{ code: 'WORKER_NOTICE' }, { code: 'DPIA' }, { code: 'SITE_BASIS' }], notes: ["This site's floor records name the station only: no work figure about one person is recorded here."] } }] })
const SITE_DRIFT = site({ purposes: [on(gate('ATTENDANCE'), ['The worker notice changed since this purpose was switched on: switch it off and on again to record the notice in force now.']), on(gate('PERFORMANCE'))] })

const CONSULTANT = { id: uid('5006', 1), code: 'STUDIO-DEMO', name: 'Studio Paghe Demo', email: 'studio@example.com', companyWide: false }
const GROUP_CONSULTANT = { id: uid('5006', 2), code: 'PAGHE-GRUPPO', name: 'Paghe Gruppo Demo', email: null, companyWide: true }
const OFFICE_PRINTER = { id: uid('5007', 1), code: 'A4-UFF', name: 'Ufficio personale', site: SITE_N }
const SOUTH_PRINTER = { id: uid('5007', 2), code: 'A4-SUD', name: 'Ufficio sud', site: SITE_S }
const PAYROLL: PayrollSettings = {
  companyId: COMPANY,
  version: 3,
  company: { code: 'DEMO', legalName: 'Officina Demo S.r.l.' },
  payrollCode: '000123',
  consultant: { partyId: CONSULTANT.id, code: CONSULTANT.code, name: CONSULTANT.name, email: CONSULTANT.email, problem: null },
  statementPrinter: { id: OFFICE_PRINTER.id, code: OFFICE_PRINTER.code, name: OFFICE_PRINTER.name, site: OFFICE_PRINTER.site, problem: null },
  choices: { consultants: [CONSULTANT, GROUP_CONSULTANT], printers: [OFFICE_PRINTER, SOUTH_PRINTER] },
  canManage: true,
}
const PAYROLL_NONE: PayrollSettings = { ...PAYROLL, payrollCode: null, consultant: null, statementPrinter: null }
const PAYROLL_STALE: PayrollSettings = {
  ...PAYROLL,
  consultant: { ...PAYROLL.consultant!, problem: 'NOT_ACTIVE' },
  statementPrinter: { ...PAYROLL.statementPrinter!, problem: 'NOT_ACTIVE' },
  choices: { consultants: [GROUP_CONSULTANT], printers: [SOUTH_PRINTER] },
}
const REVIEW: ReviewRule = { companyId: COMPANY, version: 3, tolerancePercent: 10, minBundles: 5, windowDays: 60, canManage: true }

interface SettingsCase {
  role: PeopleRole
  page: SettingsModel
}

const OWNER_CAN = settingsCan([...PEOPLE_ROLES.hr, 'people.privacy.manage', 'audit.read', 'people.efficiency.view', 'people.efficiency.review', 'parties.manage'])
const STEP_SHUT = { open: false, busy: false, sentence: '', problem: null }

function page(role: PeopleRole, over: Partial<SettingsModel> = {}): SettingsCase {
  return {
    role,
    page: {
      prefix: PREFIX,
      scope: SCOPE_ONE,
      can: role === 'hr' ? OWNER_CAN : settingsCan(PEOPLE_ROLES[role]),
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      changedElsewhere: false,
      done: null,
      rounding: { read: { status: 'ready', value: { version: 3, values: DEFAULT_ATTENDANCE_SETTINGS } }, draft: null, busy: false, problem: null },
      absence: { read: { status: 'ready', value: { codes: CODES, standardMissing: ['CIG', 'L104'] } }, showArchived: false, dialog: null, busy: false, problem: null },
      limits: { read: { status: 'ready', value: LIMITS }, drafts: drafts(LIMITS), busy: false, problem: null, scopeName: SITE_N.name, waitingScope: false },
      privacy: { company: { status: 'ready', value: COMPANY_PRIVACY }, draft: null, busy: false, problem: null, sites: { status: 'ready', value: [SITE_READY] }, dialog: null, stepUp: STEP_SHUT },
      payroll: { read: { status: 'ready', value: role === 'hr' ? PAYROLL : { ...PAYROLL, canManage: false } }, draft: null, busy: false, problem: null, dialog: null },
      review: { read: { status: 'ready', value: role === 'hr' || role === 'production' ? REVIEW : { ...REVIEW, canManage: false } }, draft: null, busy: false, problem: null },
      leaving: null,
      ...over,
    },
  }
}

const base = page('hr').page
const privacy = (over: Partial<SettingsModel['privacy']>) => ({ privacy: { ...base.privacy, ...over } })
const absence = (over: Partial<SettingsModel['absence']>) => ({ absence: { ...base.absence, ...over } })
const limits = (over: Partial<SettingsModel['limits']>) => ({ limits: { ...base.limits, ...over } })
const rounding = (over: Partial<SettingsModel['rounding']>) => ({ rounding: { ...base.rounding, ...over } })
const payroll = (over: Partial<SettingsModel['payroll']>) => ({ payroll: { ...base.payroll, ...over } })
const review = (over: Partial<SettingsModel['review']>) => ({ review: { ...base.review, ...over } })
const dialog = (value: GateDialog) => privacy({ dialog: value })
const common = { busy: false, problem: null }
const siteA = SITE_READY.site

function SettingsDesign({ model }: { model: SettingsCase }) {
  return inShell('/people/settings', createElement(SettingsView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<SettingsCase>({
  screen: 'SCR-265',
  title: 'People settings',
  view: SettingsDesign,
  holdsPage: true,
  cases: [
    { id: 'owner', label: 'Owner: every section; the gates ready to switch on', model: page('hr'), note: 'Each section reads on its own. ⌘S saves a card.' },
    { id: 'rounding-edit', label: 'Rounding in edit: the example updates as you type', model: page('hr', rounding({ draft: { ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5, roundingMinutes: 5, autoClockOutAfterMinutes: 30, earlyClockInFromShiftStart: false } })) },
    { id: 'rounding-refused', label: 'Rounding refused: someone changed it first', model: page('hr', rounding({ draft: { ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5 }, problem: { ns: 'people', words: { key: 'problem.conflict' } } })) },
    { id: 'all-sites', label: 'All sites: the limits of the company, every site\'s gates', model: page('hr', { scope: SCOPE_ALL, ...limits({ scopeName: null }), ...privacy({ sites: { status: 'ready', value: [SITE_READY, SITE_MISSING] } }) }) },
    { id: 'limits-edit', label: 'A limit from a CCNL, block, who is alerted', model: page('hr', limits({ drafts: { ...drafts(LIMITS), DAILY_REST: { ...limitDraftOf(LIMITS.limits[0]!), hours: 10, source: 'CCNL', legalReference: 'CCNL Demo art. 7', action: 'BLOCK', alertRoles: ['admin', 'floor_supervisor'] } } })) },
    { id: 'limits-looser', label: 'Looser than the law with no CCNL: held at the field', model: page('hr', limits({ drafts: { ...drafts(LIMITS), DAILY_REST: { ...limitDraftOf(LIMITS.limits[0]!), hours: 9 } } })) },
    { id: 'limits-waiting', label: 'The top bar moved while the card has edits', model: page('hr', limits({ waitingScope: true, drafts: { ...drafts(LIMITS), DAILY_REST: { ...limitDraftOf(LIMITS.limits[0]!), action: 'BLOCK' } } })) },
    { id: 'archived', label: 'Archived codes shown', model: page('hr', absence({ showArchived: true, read: { status: 'ready', value: { codes: [...CODES, ARCHIVED], standardMissing: [] } } })) },
    { id: 'code-empty', label: 'No codes yet: Start from the standard list', model: page('hr', absence({ read: { status: 'ready', value: { codes: [], standardMissing: STANDARD_ABSENCE_CODES.map((row) => row.code) } } })) },
    { id: 'code-new', label: 'Absence code: new', model: page('hr', absence({ dialog: { draft: { ...blankCode(), code: 'ASS', nameIt: 'Assenza demo' }, ...common } })) },
    { id: 'code-edit', label: 'Absence code: sickness keeps a number, never a diagnosis', model: page('hr', absence({ dialog: { draft: codeDraftOf(CODES[4]!), ...common } })) },
    { id: 'code-taken', label: 'Absence code refused: the code exists', model: page('hr', absence({ dialog: { draft: { ...blankCode(), code: 'FER', nameIt: 'Ferie' }, busy: false, problem: { ns: 'settings', words: { key: 'field.codeTaken' } } } })) },
    { id: 'gate-missing', label: 'A gate held: the missing items in words, the links to record them', model: page('hr', privacy({ sites: { status: 'ready', value: [SITE_MISSING] } })) },
    { id: 'gate-on', label: 'Both gates on: folded; who sees one person\'s figures', model: page('hr', privacy({ sites: { status: 'ready', value: [SITE_ON] } })) },
    { id: 'gate-drift', label: 'A newer notice since it was switched on: a note, never a block', model: page('hr', privacy({ sites: { status: 'ready', value: [SITE_DRIFT] } })) },
    { id: 'switch-on-attendance', label: 'Switch on attendance: the basis and the reason', model: page('hr', dialog({ kind: 'on', site: siteA, purpose: 'ATTENDANCE', siteBasis: SITE_READY.siteBasis, basisKind: 'NOT_REQUIRED', reference: 'Parere Demo 2026/1', coversLeads: false, leads: false, reason: 'Nota e valutazione pronte', ...common })) },
    { id: 'switch-on-performance', label: 'Switch on one person\'s figures: the site\'s basis, leads', model: page('hr', dialog({ kind: 'on', site: siteA, purpose: 'PERFORMANCE', siteBasis: SITE_READY.siteBasis, basisKind: '', reference: '', coversLeads: true, leads: false, reason: '', ...common })) },
    { id: 'switch-on-code', label: 'Switching on asks a fresh code', model: page('hr', privacy({ dialog: { kind: 'on', site: siteA, purpose: 'ATTENDANCE', siteBasis: null, basisKind: 'NOT_REQUIRED', reference: 'Parere Demo 2026/1', coversLeads: false, leads: false, reason: 'Nota e valutazione pronte', busy: true, problem: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.switchOn', problem: null } })) },
    { id: 'switch-off', label: 'Switch off: a reason, never a code', model: page('hr', { ...dialog({ kind: 'off', site: siteA, purpose: 'ATTENDANCE', version: 1, reason: '', ...common }) }) },
    { id: 'leads', label: 'Leads see figures: a reason and a code', model: page('hr', { ...dialog({ kind: 'leads', site: siteA, version: 1, reason: '', ...common }) }) },
    { id: 'widen', label: 'Group size lowered? Naming a role widens: reason and code', model: page('hr', privacy({ draft: { minimumGroupSize: 3, figureRoleKeys: ['admin', 'production_manager'], reason: '' } })) },
    { id: 'narrow', label: 'Group size raised: narrowing never asks', model: page('hr', privacy({ draft: { minimumGroupSize: 5, figureRoleKeys: ['admin'], reason: '' } })) },
    { id: 'payroll-none', label: 'Payroll and statements: nothing named yet, the company code prints', model: page('hr', payroll({ read: { status: 'ready', value: PAYROLL_NONE } })) },
    { id: 'payroll-edit', label: 'Payroll and statements in edit: another consultant, a new code, the printer of the south site', model: page('hr', payroll({ draft: { ...payrollDraftOf(PAYROLL), consultantPartyId: GROUP_CONSULTANT.id, payrollCode: '000777', statementPrinterId: SOUTH_PRINTER.id } })) },
    { id: 'payroll-long', label: 'A payroll code too long: held at the field', model: page('hr', payroll({ draft: { ...payrollDraftOf(PAYROLL), payrollCode: '0001234567890123456789' } })) },
    { id: 'payroll-stale', label: 'The consultant blocked and the printer archived since: still named, said; statements held', model: page('hr', payroll({ read: { status: 'ready', value: PAYROLL_STALE } })) },
    { id: 'payroll-refused', label: 'Refused: the party is no consultant', model: page('hr', payroll({ draft: { ...payrollDraftOf(PAYROLL), consultantPartyId: GROUP_CONSULTANT.id }, problem: { ns: 'settings', words: { key: 'refusal.NOT_CONSULTANT' } } })) },
    { id: 'consultant-new', label: 'New consultant: name, party code, the address the file goes to', model: page('hr', payroll({ dialog: { draft: { name: 'Studio Rossi Demo', code: 'STUDIO-ROSSI-DEMO', email: 'paghe@example.com' }, ...common } })) },
    { id: 'consultant-held', label: 'New consultant held: the address is not one', model: page('hr', payroll({ dialog: { draft: { ...blankConsultant(), name: 'Studio Demo', code: 'STUDIO-DEMO', email: 'paghe@' }, ...common } })) },
    { id: 'consultant-no-parties', label: 'HR without parties.manage: New consultant held, with why', model: { ...page('hr'), page: { ...page('hr').page, can: { ...OWNER_CAN, addParty: false } } } },
    { id: 'review-edit', label: 'Standard review in edit: the rule in words as you type', model: page('hr', review({ draft: { tolerancePercent: 15, minBundles: 8 } })) },
    { id: 'review-refused', label: 'Standard review refused: someone changed these settings first', model: page('hr', review({ draft: { tolerancePercent: 15, minBundles: 8 }, problem: { ns: 'people', words: { key: 'problem.conflict' } } })) },
    { id: 'leave', label: 'Unsaved changes: Save · Discard · Stay', model: page('hr', { leaving: { busy: false }, ...rounding({ draft: { ...DEFAULT_ATTENDANCE_SETTINGS, lateGraceMinutes: 5 } }) }) },
    { id: 'changed', label: 'Someone else changed these settings', model: page('hr', { changedElsewhere: true }) },
    { id: 'saved', label: 'Saved', model: page('hr', { done: { key: 'done.rounding' } }) },
    { id: 'production', label: 'Production manager: reads; sets the standard review limits', model: page('production') },
    { id: 'read-only', label: 'Read-only: sees, every control held', model: page('readOnly', { ...limits({ read: { status: 'ready', value: { ...LIMITS, canManage: false } } }) }) },
    { id: 'no-right', label: 'Sales: no right', model: page('sales') },
    { id: 'loading', label: 'Every section loading on its own', model: page('hr', { asOf: null, live: 'connecting', rounding: { ...base.rounding, read: { status: 'loading' } }, absence: { ...base.absence, read: { status: 'loading' } }, limits: { ...base.limits, read: { status: 'loading' } }, privacy: { ...base.privacy, company: { status: 'loading' }, sites: { status: 'loading' } }, payroll: { ...base.payroll, read: { status: 'loading' } }, review: { ...base.review, read: { status: 'loading' } } }) },
    { id: 'error', label: 'One section failed, the others keep working', model: page('hr', { limits: { ...base.limits, read: { status: 'error', problem: 'problem.unavailable' } } }) },
    { id: 'error-all', label: 'Every section failed: never drawn as empty', model: page('hr', { rounding: { ...base.rounding, read: { status: 'error', problem: 'problem.unavailable' } }, absence: { ...base.absence, read: { status: 'error', problem: 'problem.unavailable' } }, limits: { ...base.limits, read: { status: 'error', problem: 'problem.unavailable' } }, privacy: { ...base.privacy, company: { status: 'error', problem: 'problem.unavailable' }, sites: { status: 'error', problem: 'problem.unavailable' } }, payroll: { ...base.payroll, read: { status: 'error', problem: 'problem.unavailable' } }, review: { ...base.review, read: { status: 'error', problem: 'problem.unavailable' } } }) },
  ],
})
