import { KINDS, type AlertChannel, type AlertSeverity, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { cooldownWords } from '@nexus/factory-domain/alerts/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import type { AlertRule, RuleBody, RuleChoices, RuleKindInfo, Threshold } from './api'

/**
 * The exception rules as the screens edit them (B-W2a-78; design home.alerts "Rules" + popup rule, admin.automation
 * "Reminders & timers" + popup rule; the RuleSentence part), pure: which numbers each kind takes and their bounds (the
 * same as factory-domain alerts/kinds, held equal by a test), a rule's DRAFT while the dialog is open and what a save
 * sends (only what changed, with the version read), the place and recipient choices, a rule's numbers and recipients in
 * words, how often in words (factory-domain's own words in both languages) and a refused save in words. A rule names a
 * ROLE, never a person; nothing here counts a person.
 */

export const NAMESPACE = 'rules'

/** A number a kind's rule takes, with its bounds and unit. */
export interface NumberField {
  readonly key: string
  readonly min: number
  readonly max: number
  readonly unit: 'hours' | 'days'
}

/** The numbers of each kind (bounds as factory-domain alerts/kinds checks them); `workingDays`: the days may be working days. */
export const THRESHOLD_FIELDS: Readonly<Record<RuleKind, { readonly numbers: readonly NumberField[]; readonly workingDays: boolean }>> = Object.freeze({
  ORDER_LATE_RISK: { numbers: [{ key: 'daysBeforePromise', min: 0, max: 30, unit: 'days' }], workingDays: false },
  HOLD_TOO_LONG: { numbers: [{ key: 'hours', min: 1, max: 720, unit: 'hours' }], workingDays: false },
  MATERIAL_SHORT: { numbers: [], workingDays: false },
  APPROVAL_OVERDUE: { numbers: [{ key: 'hours', min: 1, max: 720, unit: 'hours' }], workingDays: false },
  PO_NOT_CONFIRMED: { numbers: [{ key: 'days', min: 1, max: 30, unit: 'days' }], workingDays: false },
  CERTIFICATE_EXPIRING: { numbers: [{ key: 'daysBefore', min: 1, max: 365, unit: 'days' }], workingDays: true },
  INVOICE_DEADLINE: { numbers: [{ key: 'daysBefore', min: 0, max: 15, unit: 'days' }], workingDays: true },
  // B-W2b-24: no call of a connection worked for this many hours.
  INTEGRATION_FAILING: { numbers: [{ key: 'hours', min: 1, max: 168, unit: 'hours' }], workingDays: false },
})

/** The kind's one number edited in the rules list itself (inline), or null (none, as "Material short"). */
export const mainNumber = (kind: RuleKind): NumberField | null => THRESHOLD_FIELDS[kind].numbers[0] ?? null

/** How often at most: the choices offered (minutes). A rule's own other value is offered too. */
export const COOLDOWNS: readonly number[] = Object.freeze([0, 60, 240, 1440, 4320, 10_080])
export const COOLDOWN_MAX = 43_200

export function cooldownOptions(current: number): number[] {
  return [...new Set([...COOLDOWNS, current])].filter((minutes) => minutes >= 0 && minutes <= COOLDOWN_MAX).sort((a, b) => a - b)
}

/** How often in words, in the reader's language (factory-domain's own words, the same as the API's sentence). */
export const howOften = (minutes: number, locale: Locale): string => cooldownWords(minutes, locale)

export const SEVERITIES: readonly AlertSeverity[] = Object.freeze(['INFO', 'WARNING', 'CRITICAL'])

// ---- the place --------------------------------------------------------------------------------------------------------

/** A place as one select value: '' everywhere, `c:<company>`, `s:<company>:<site>`. */
export function placeValue(place: { readonly companyId: string | null; readonly siteId: string | null }): string {
  if (place.companyId === null) return ''
  return place.siteId === null ? `c:${place.companyId}` : `s:${place.companyId}:${place.siteId}`
}

export function placeOf(value: string): { companyId: string | null; siteId: string | null } {
  const [kind, company, site] = value.split(':')
  if (kind === 'c' && company) return { companyId: company, siteId: null }
  if (kind === 's' && company && site) return { companyId: company, siteId: site }
  return { companyId: null, siteId: null }
}

export interface PlaceOption {
  readonly value: string
  /** The place's name (null: everywhere). */
  readonly name: string | null
  readonly kind: 'everywhere' | 'company' | 'site'
  /** A site: its company's name (unknown for a rule's own place the reader cannot choose). */
  readonly company?: string
}

/**
 * The places the reader may keep rules for (GET /alerts/rules/choices), in order: everywhere, then each company and its
 * sites. The rule's own place is kept even when the reader could not choose it (it was set by someone else).
 */
export function placeOptions(choices: RuleChoices | null, current: { readonly value: string; readonly label: string | null } | null): PlaceOption[] {
  const options: PlaceOption[] = []
  if (choices?.everywhere) options.push({ value: '', name: null, kind: 'everywhere' })
  for (const company of choices?.companies ?? []) {
    if (company.wholeCompany) options.push({ value: `c:${company.id}`, name: company.name, kind: 'company' })
    for (const site of company.sites) options.push({ value: `s:${company.id}:${site.id}`, name: site.name, kind: 'site', company: company.name })
  }
  if (current && !options.some((option) => option.value === current.value)) {
    const kind = current.value === '' ? 'everywhere' : current.value.startsWith('s:') ? 'site' : 'company'
    options.unshift({ value: current.value, name: kind === 'everywhere' ? null : (current.label ?? '…'), kind })
  }
  return options
}

// ---- the draft ------------------------------------------------------------------------------------------------------------

/** A rule while the dialog edits it: numbers as typed (text), the rest as chosen. */
export interface RuleDraft {
  readonly ruleKind: RuleKind
  readonly numbers: Readonly<Record<string, string>>
  readonly workingDays: boolean
  readonly severity: AlertSeverity
  /** placeValue(): '' everywhere, `c:…`, `s:…:…`. */
  readonly place: string
  readonly recipientRoleId: string | null
  /** E-mail as well as the bell (the bell is always on: an alert rule tells through it). */
  readonly email: boolean
  readonly cooldownMinutes: number
  readonly enabled: boolean
}

const numbersOf = (kind: RuleKind, threshold: Threshold): Record<string, string> =>
  Object.fromEntries(THRESHOLD_FIELDS[kind].numbers.map((field) => [field.key, String(threshold[field.key] ?? '')]))

export function draftOf(rule: AlertRule): RuleDraft {
  return {
    ruleKind: rule.ruleKind,
    numbers: numbersOf(rule.ruleKind, rule.threshold),
    workingDays: rule.threshold.workingDays === true,
    severity: rule.severity,
    place: placeValue(rule.place),
    recipientRoleId: rule.recipient?.roleId ?? null,
    email: rule.channels.includes('EMAIL'),
    cooldownMinutes: rule.cooldownMinutes,
    enabled: rule.enabled,
  }
}

/**
 * Whom a new rule of a kind tells by default: the role its built-in rule tells (when one is visible and tells someone),
 * else the kind's own system role (factory-domain KINDS[kind].builtIn.recipientRole) among the roles offered, else nobody.
 */
export function defaultRecipient(kind: RuleKind, rules: readonly AlertRule[], roles: readonly { readonly id: string; readonly key?: string }[]): string | null {
  const told = rules.find((rule) => rule.ruleKind === kind && rule.builtIn && rule.recipient) ?? rules.find((rule) => rule.ruleKind === kind && rule.recipient)
  return told?.recipient?.roleId ?? roles.find((role) => role.key === KINDS[kind].builtIn.recipientRole)?.id ?? null
}

/**
 * A new rule of a kind: the kind's built-in numbers, severity and cooldown; told to `defaultRecipient`; the first place the
 * reader may keep rules for.
 */
export function newDraft(kind: RuleKindInfo, rules: readonly AlertRule[], places: readonly PlaceOption[], roles: readonly { readonly id: string; readonly key?: string }[] = []): RuleDraft {
  return {
    ruleKind: kind.kind,
    numbers: numbersOf(kind.kind, kind.defaults),
    workingDays: kind.defaults.workingDays === true,
    severity: KINDS[kind.kind].builtIn.severity,
    place: places[0]?.value ?? '',
    recipientRoleId: defaultRecipient(kind.kind, rules, roles),
    email: false,
    cooldownMinutes: KINDS[kind.kind].builtIn.cooldownMinutes,
    enabled: true,
  }
}

/** A number as typed, read: a whole number, or null when the text is not one. */
export function wholeOf(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,4}$/.test(trimmed)) return null
  return Number(trimmed)
}

export interface DraftProblem {
  readonly key: string
  readonly min: number
  readonly max: number
}

/** The numbers out of their bounds (each with its bounds), or none. */
export function draftProblems(draft: RuleDraft): DraftProblem[] {
  return THRESHOLD_FIELDS[draft.ruleKind].numbers.flatMap((field) => {
    const value = wholeOf(draft.numbers[field.key] ?? '')
    return value === null || value < field.min || value > field.max ? [{ key: field.key, min: field.min, max: field.max }] : []
  })
}

/** The draft's numbers as the API takes them (only when draftProblems is empty). */
export function thresholdOf(draft: RuleDraft): Threshold {
  const threshold: Threshold = {}
  for (const field of THRESHOLD_FIELDS[draft.ruleKind].numbers) threshold[field.key] = wholeOf(draft.numbers[field.key] ?? '') ?? 0
  if (THRESHOLD_FIELDS[draft.ruleKind].workingDays) threshold.workingDays = draft.workingDays
  return threshold
}

const channelsOf = (draft: RuleDraft): AlertChannel[] => (draft.email ? ['IN_APP', 'EMAIL'] : ['IN_APP'])

/** What a save of a changed rule sends: only the fields that differ from the rule as read. */
export function changesOf(rule: AlertRule, draft: RuleDraft): RuleBody {
  const before = draftOf(rule)
  const body: RuleBody = {}
  const numbersChanged = THRESHOLD_FIELDS[draft.ruleKind].numbers.some((field) => wholeOf(draft.numbers[field.key] ?? '') !== wholeOf(before.numbers[field.key] ?? ''))
  if (numbersChanged || draft.workingDays !== before.workingDays) body.threshold = thresholdOf(draft)
  if (draft.severity !== before.severity) body.severity = draft.severity
  if (draft.place !== before.place) {
    const place = placeOf(draft.place)
    body.companyId = place.companyId
    body.siteId = place.siteId
  }
  if (draft.recipientRoleId !== before.recipientRoleId) body.recipientRoleId = draft.recipientRoleId
  if (draft.email !== before.email) body.channels = channelsOf(draft)
  if (draft.cooldownMinutes !== before.cooldownMinutes) body.cooldownMinutes = draft.cooldownMinutes
  if (draft.enabled !== before.enabled) body.enabled = draft.enabled
  return body
}

/** How many things a save would change ("2 changes not saved"): the numbers count once, the place once. */
export function changeCount(body: RuleBody): number {
  return ['threshold', 'severity', 'companyId', 'recipientRoleId', 'channels', 'cooldownMinutes', 'enabled'].filter((key) => key in body).length
}

/** What a new rule sends. */
export function createBodyOf(draft: RuleDraft): RuleBody & { ruleKind: RuleKind } {
  const place = placeOf(draft.place)
  return { ruleKind: draft.ruleKind, threshold: thresholdOf(draft), severity: draft.severity, companyId: place.companyId, siteId: place.siteId, recipientRoleId: draft.recipientRoleId, channels: channelsOf(draft), cooldownMinutes: draft.cooldownMinutes, enabled: draft.enabled }
}

/** What a dry run tries: the draft's numbers and place (on any visible rule of the kind: the test reads only those). */
export function testBodyOf(draft: RuleDraft): { threshold: Threshold; companyId: string | null; siteId: string | null } {
  return { threshold: thresholdOf(draft), ...placeOf(draft.place) }
}

// ---- words ----------------------------------------------------------------------------------------------------------------

/** A rule's numbers in words ("24 h", "3 days", "30 working days"); "—" for a kind without numbers. */
export function numbersWords(kind: RuleKind, threshold: Threshold, t: Translate): string {
  const fields = THRESHOLD_FIELDS[kind]
  if (fields.numbers.length === 0) return '—'
  return fields.numbers
    .map((field) => {
      const count = Number(threshold[field.key] ?? 0)
      if (field.unit === 'hours') return t('unit.hoursShort', { count })
      return t(fields.workingDays && threshold.workingDays === true ? 'unit.workingDays' : 'unit.days', { count })
    })
    .join(' · ')
}

/** Whom a rule tells, and where: "Quality inspector at Plant 1", "Planner, everywhere", "nobody by role". */
export function goesToWords(rule: Pick<AlertRule, 'recipient' | 'place'>, t: Translate): string {
  const role = rule.recipient ? rule.recipient.name : t('recipient.none')
  return rule.place.companyId === null ? t('goesTo.everywhere', { role }) : t('goesTo.at', { role, place: rule.place.label ?? '…' })
}

/** The sentence of a rule in the reader's language (the API makes both). */
export const sentenceOf = (rule: Pick<AlertRule, 'sentence'>, locale: Locale): string => (locale === 'it' ? rule.sentence.it : rule.sentence.en)

/** Why the rule cannot be changed here (a key of `rules`), or null. */
export function changeHeld(state: { readonly canChange: boolean; readonly offline: boolean; readonly busy: boolean }): string | null {
  if (!state.canChange) return 'held.readOnly'
  if (state.offline) return 'held.offline'
  if (state.busy) return 'held.busy'
  return null
}

/** A refused save in words (a key of `rules`): changed meanwhile, nothing changed, the bell, the place, the numbers, no right. */
export function refusalOf(error: unknown): string {
  if (!isApiError(error)) return 'refusal.failed'
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') {
    if (paths.includes('body/channels')) return 'refusal.noBell'
    if (paths.includes('body/siteId')) return 'refusal.siteNeedsCompany'
    if (paths.includes('rule/UNCHANGED')) return 'refusal.unchanged'
    return 'refusal.changed'
  }
  if (error.kind === 'invalid') {
    if (paths.some((path) => path.startsWith('body/threshold'))) return 'refusal.numbers'
    if (paths.includes('body/recipientRoleId')) return 'refusal.role'
    if (paths.includes('body/companyId') || paths.includes('body/siteId')) return 'refusal.place'
    return 'refusal.invalid'
  }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'refusal.forbidden'
  if (error.kind === 'not_found') return 'refusal.gone'
  if (error.kind === 'unavailable') return 'refusal.offline'
  return 'refusal.failed'
}

/** A failed read in words (a key of `rules`). */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.gone'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.failed'
}
