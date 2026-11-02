import { absenceCodeProblems, ABSENCE_CATEGORIES, SENSITIVE_CATEGORIES } from '@nexus/factory-domain/people/attendance/absences'
import { DEFAULT_ATTENDANCE_SETTINGS, ROUNDING_CHOICES, roundMinute, settingsProblems, type AttendanceSettings } from '@nexus/factory-domain/people/attendance/rules'
import { LAW_VALUES, RULE_KINDS, ruleProblems } from '@nexus/factory-domain/people/limits/rules'
import { CHECKED_LIMITS } from '@nexus/factory-domain/people/limits/checks'
import { GATE_REASON_MIN, LEADS_BASES } from '@nexus/factory-domain/people/privacy/gate'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { fieldOf, problemOf, type Words } from '../_shared/model'
import type { AbsenceCode, AbsenceCategory, CodeFields, CompanyPrivacy, LimitBody, LimitEntry, LimitRule, MonitoringBasis, Rounding, RuleAction, RuleKind, RuleSource } from './api'

/**
 * The pure rules of People › People settings (SCR-265; B-W2b-65): who may do what, the worked example in words as you type,
 * what a card's edit changes, what still holds a save, which privacy change widens who sees figures (a reason and a fresh
 * code) and which narrows (never asks), and every API sentence said in our words.
 */

export const SETTINGS_NAMESPACES = ['people-settings', 'people', 'lists', 'admin'] as const
export const TIME_ZONE = 'Europe/Rome'
export { ABSENCE_CATEGORIES, ROUNDING_CHOICES, RULE_KINDS, SENSITIVE_CATEGORIES }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface SettingsCan {
  privacy: boolean
  managePrivacy: boolean
  /** people.attendance.view or .settings: rounding and absence codes read. */
  attendance: boolean
  manageAttendance: boolean
  /** people.limits.manage, attendance.view or shifts.view: the limits read. */
  limits: boolean
  manageLimits: boolean
  audit: boolean
}

export function settingsCan(permissions: readonly string[]): SettingsCan {
  const held = new Set(permissions)
  const attendance = held.has('people.attendance.view') || held.has('people.attendance.settings')
  return {
    privacy: held.has('people.privacy.view'),
    managePrivacy: held.has('people.privacy.manage'),
    attendance,
    manageAttendance: held.has('people.attendance.settings'),
    limits: attendance || held.has('people.limits.manage') || held.has('people.shifts.view'),
    manageLimits: held.has('people.limits.manage'),
    audit: held.has('audit.read'),
  }
}

// ---- rounding: the worked example ---------------------------------------------------------------------------------------------

const clock = (minute: number): string => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** What each rule does with a 06:00–14:00 shift, in words, as you type (the domain's `workedExample` in our languages). */
export function exampleOf(settings: AttendanceSettings): Words[] {
  const start = 6 * 60
  const round = settings.roundingMinutes
  const late = start + settings.lateGraceMinutes + 1
  const unit = settings.overtimeUnitMinutes
  return [
    settings.earlyClockInFromShiftStart ? { key: 'example.earlyOn' } : { key: 'example.earlyOff', params: { time: clock(roundMinute(start - 8, round)) } },
    settings.lateGraceMinutes > 0 ? { key: 'example.graceOn', params: { until: clock(start + settings.lateGraceMinutes), after: clock(late), counted: clock(roundMinute(late, round)) } } : { key: round > 0 ? 'example.graceNoneRounded' : 'example.graceNone' },
    round > 0 ? { key: 'example.roundOn', params: { unit: round, a: clock(roundMinute(13 * 60 + 52, round)), b: clock(roundMinute(13 * 60 + 53, round)) } } : { key: 'example.roundOff' },
    { key: unit > 5 ? 'example.overtimeLong' : 'example.overtime', params: { unit, after: unit + 5, less: unit - 1 } },
    settings.autoClockOutAfterMinutes === null ? { key: 'example.autoNever' } : { key: 'example.autoAfter', params: { minutes: settings.autoClockOutAfterMinutes } },
    { key: settings.fixedBreaks ? 'example.breaksFixed' : 'example.breaksClocked' },
  ]
}

export const roundingDraft = (value: Rounding): AttendanceSettings => ({
  earlyClockInFromShiftStart: value.earlyClockInFromShiftStart,
  lateGraceMinutes: value.lateGraceMinutes,
  overtimeUnitMinutes: value.overtimeUnitMinutes,
  roundingMinutes: value.roundingMinutes,
  autoClockOutAfterMinutes: value.autoClockOutAfterMinutes,
  fixedBreaks: value.fixedBreaks,
})

const ROUNDING_KEYS = Object.keys(DEFAULT_ATTENDANCE_SETTINGS) as (keyof AttendanceSettings)[]
export const roundingChanges = (from: AttendanceSettings, to: AttendanceSettings): number => ROUNDING_KEYS.filter((key) => from[key] !== to[key]).length

/** The first problem of the values typed, as a message key (the fields are the domain's). */
export function roundingHeld(draft: AttendanceSettings): string | null {
  const field = settingsProblems(draft)[0]?.path
  return field ? `rounding.problem.${field}` : null
}

// ---- absence codes -----------------------------------------------------------------------------------------------------------

export interface CodeDraft {
  id: string | null
  version: number | null
  code: string
  nameIt: string
  nameEn: string
  category: AbsenceCategory
  lulCode: string
  paid: boolean
  documentRequired: boolean
  group: boolean
}

export const blankCode = (): CodeDraft => ({ id: null, version: null, code: '', nameIt: '', nameEn: '', category: 'HOLIDAY', lulCode: '', paid: true, documentRequired: false, group: false })

export const codeDraftOf = (row: AbsenceCode): CodeDraft => ({
  id: row.id,
  version: row.version,
  code: row.code,
  nameIt: row.labelI18n.it ?? '',
  nameEn: row.labelI18n.en ?? '',
  category: row.category,
  lulCode: row.lulCode ?? '',
  paid: row.paid,
  documentRequired: row.documentRequired,
  group: row.companyId === null,
})

export const codeFieldsOf = (draft: CodeDraft): CodeFields => ({
  labelI18n: { it: draft.nameIt.trim(), ...(draft.nameEn.trim() ? { en: draft.nameEn.trim() } : {}) },
  category: draft.category,
  lulCode: draft.lulCode.trim() || null,
  paid: draft.paid,
  documentRequired: draft.documentRequired,
})

/** Why Save code is held, as a message key; null: it may go. */
export function codeHeld(draft: CodeDraft): string | null {
  const creating = draft.id === null
  const field = absenceCodeProblems({ ...(creating ? { code: draft.code.trim() } : {}), ...codeFieldsOf(draft) }, creating)[0]?.path
  return field ? `code.problem.${field}` : null
}


// ---- working-time limits -----------------------------------------------------------------------------------------------------

export interface LimitDraft {
  kind: RuleKind
  /** Hours as typed (the API keeps minutes). */
  hours: number
  breakMinutes: number | null
  referenceMonths: number | null
  action: RuleAction
  alertRoles: string[]
  source: RuleSource
  legalReference: string
}

export const LIMIT_ORDER: readonly RuleKind[] = ['DAILY_REST', 'WEEKLY_AVERAGE', 'OVERTIME_YEARLY_CAP', 'NIGHT_AVERAGE', 'WEEKLY_REST', 'BREAK_AFTER']

/** The limits something checks today; the rest are kept, and said so on the screen. */
export const isChecked = (kind: RuleKind): boolean => kind === 'BREAK_AFTER' || (CHECKED_LIMITS as readonly string[]).includes(kind)

export function limitDraftOf(entry: LimitEntry): LimitDraft {
  const rule: LimitRule | null = entry.inForce
  return {
    kind: entry.kind,
    hours: (rule?.limitMinutes ?? entry.law.limitMinutes) / 60,
    breakMinutes: rule?.breakMinutes ?? entry.law.breakMinutes,
    referenceMonths: rule?.referenceMonths ?? entry.law.referenceMonths,
    action: rule?.action ?? 'WARN',
    alertRoles: rule?.alertRoles ?? [],
    source: rule?.source ?? 'LAW',
    legalReference: rule?.legalReference ?? entry.law.legalReference,
  }
}

const same = (a: LimitDraft, b: LimitDraft): boolean => JSON.stringify({ ...a, alertRoles: [...a.alertRoles].sort() }) === JSON.stringify({ ...b, alertRoles: [...b.alertRoles].sort() })

/** The limits whose values differ from what was read. */
export const limitsChanged = (entries: readonly LimitEntry[], drafts: Readonly<Record<string, LimitDraft>>): LimitDraft[] =>
  entries.flatMap((entry) => {
    const draft = drafts[entry.kind]
    return draft && !same(limitDraftOf(entry), draft) ? [draft] : []
  })

export const limitBodyOf = (draft: LimitDraft, entry: LimitEntry, scope: { companyId: string | null; siteId: string | null }): LimitBody => ({
  companyId: scope.companyId,
  siteId: scope.siteId,
  kind: draft.kind,
  version: entry.own?.version ?? null,
  limitMinutes: Math.round(draft.hours * 60),
  breakMinutes: draft.kind === 'BREAK_AFTER' ? draft.breakMinutes : null,
  referenceMonths: draft.kind === 'WEEKLY_AVERAGE' ? draft.referenceMonths : null,
  action: draft.action,
  alertRoles: draft.alertRoles,
  source: draft.source,
  legalReference: draft.legalReference.trim(),
})

/** Why a limit may not be saved, as a message key at its field; null: it may go. The law's checks are the domain's. */
export function limitHeld(draft: LimitDraft): string | null {
  const problem = ruleProblems({ kind: draft.kind, limitMinutes: Math.round(draft.hours * 60), breakMinutes: draft.kind === 'BREAK_AFTER' ? draft.breakMinutes : null, referenceMonths: draft.kind === 'WEEKLY_AVERAGE' ? draft.referenceMonths : null, action: draft.action, alertRoles: draft.alertRoles, source: draft.source, legalReference: draft.legalReference })[0]
  return problem ? `limits.problem.${problem.path}` : null
}

export const lawHours = (kind: RuleKind): number => LAW_VALUES[kind].limitMinutes / 60

// ---- privacy -----------------------------------------------------------------------------------------------------------------

export interface PrivacyDraft {
  minimumGroupSize: number
  figureRoleKeys: string[]
  reason: string
}

export const privacyDraftOf = (value: CompanyPrivacy): PrivacyDraft => ({ minimumGroupSize: value.settings.minimumGroupSize, figureRoleKeys: [...value.settings.figureRoleKeys], reason: '' })

export const privacyDirty = (value: CompanyPrivacy, draft: PrivacyDraft): boolean => value.settings.minimumGroupSize !== draft.minimumGroupSize || [...value.settings.figureRoleKeys].sort().join() !== [...draft.figureRoleKeys].sort().join()

/** Lowering the group size or naming a new role widens who sees people's figures: a reason and a fresh code. Narrowing never asks. */
export const privacyWidens = (value: CompanyPrivacy, draft: PrivacyDraft): boolean => draft.minimumGroupSize < value.settings.minimumGroupSize || draft.figureRoleKeys.some((key) => !value.settings.figureRoleKeys.includes(key))

export const MIN_GROUP = 3
export const MAX_GROUP = 50

export function privacyHeld(value: CompanyPrivacy, draft: PrivacyDraft): string | null {
  if (draft.minimumGroupSize < MIN_GROUP || draft.minimumGroupSize > MAX_GROUP) return 'privacy.problem.size'
  return privacyWidens(value, draft) && draft.reason.trim().length < GATE_REASON_MIN ? 'privacy.problem.reason' : null
}

export const basisCanCoverLeads = (kind: MonitoringBasis | null | undefined): boolean => Boolean(kind) && (LEADS_BASES as readonly string[]).includes(kind as string)
export const gateReasonHeld = (reason: string): string | null => (reason.trim().length < GATE_REASON_MIN ? 'gate.problem.reason' : null)

/** The API's sentences about a gate have no code: each is said in our words (a test holds them against the domain's). */
const NOTE_RULES: readonly (readonly [RegExp, string, readonly string[]])[] = [
  [/^The impact assessment \(version (\d+)\) was due for review on (\d{4}-\d{2}-\d{2})/, 'note.dpiaReview', ['version', 'day']],
  [/^This site's floor records name the station only/, 'note.stationOnly', []],
  [/^The worker notice changed since/, 'note.noticeChanged', []],
  [/^The impact assessment changed since/, 'note.dpiaChanged', []],
  [/^The site's legal basis in Production/, 'note.basisChanged', []],
]

export function noteWords(text: string): Words {
  for (const [rule, key, names] of NOTE_RULES) {
    const match = rule.exec(text)
    if (match) return { key, params: Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? ''])) }
  }
  return { key: 'note.other' }
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

/** The words of a failed call: a field of a body by its name, else the People words every page shares. */
export function settingsProblem(error: unknown): { ns: 'settings' | 'people'; words: Words } {
  if (isApiError(error) && error.issues.some((issue) => issuePath(issue) === 'refusal/CODE_TAKEN')) return { ns: 'settings', words: { key: 'field.codeTaken' } }
  if (isApiError(error) && (error.kind === 'invalid' || error.kind === 'conflict')) {
    const field = fieldOf(error)
    if (field && ['code', 'labelI18n', 'lulCode', 'limitMinutes', 'breakMinutes', 'referenceMonths', 'legalReference', 'reason', 'basis', 'basisCoversLeads', 'leadsSeeFigures', 'minimumGroupSize', 'figureRoleKeys'].includes(field)) return { ns: 'settings', words: { key: `field.${field}` } }
  }
  return { ns: 'people', words: problemOf(error) }
}
