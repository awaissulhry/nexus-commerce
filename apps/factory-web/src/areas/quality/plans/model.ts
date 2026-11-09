import { AQL_VALUES, aqlWords } from '@nexus/factory-domain/quality/aql/sampling'
import { INSPECTION_LEVELS, type InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { CheckBody, CheckView, ChipView, Comparison, EditPlanBody, PlanRecord, PlanRow, Profile, Rule, RuleBody, SamplingBody, SamplingView, SaveVersionBody, VersionView } from './api'
import {
  CATEGORY_CODES,
  CHECK_CODE,
  CHECK_TYPES,
  CHIP_KINDS,
  FREQUENCIES,
  FREQUENCY_TAKES_VALUE,
  MEASURE,
  PLAN_CODE,
  PLAN_LIMITS,
  PLAN_STAGES,
  PROFILE_CODE,
  takesResult,
  VERSION_STATUSES,
  type CheckClass,
  type CheckType,
  type ChipKind,
  type Frequency,
  type PlanStage,
  type TriggerEvent,
  type VersionStatus,
} from './constants'

/**
 * Inspection plans & AQL (SCR-077, the plan record SCR-077-plan, the printable checklist SCR-077-print): the pure rules of
 * the screens — the addresses, what a person may do, the drafts each tab edits (one save model per tab) and what they
 * send, the problems in our words (the domain's rules re-stated, held equal by plans.vitest.test.ts), the counts the
 * EditModeBar shows, the approval's held reasons from facts. No React, no API client.
 */

// ---- words -----------------------------------------------------------------------------------------------------------

/** A message key of the `quality-plans` catalogue with its values. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const words = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })

/** A problem of a draft: where (the API's own path, `checks/2/code`) and what, in our words. */
export interface Problem extends Words {
  readonly path: string
}

const problem = (path: string, key: string, params?: Record<string, string | number>): Problem => (params ? { path, key, params } : { path, key })

// ---- the settings page's address ---------------------------------------------------------------------------------------

export const PAGE_TABS = ['plans', 'aql', 'triggers', 'calculator'] as const
export type PageTab = (typeof PAGE_TABS)[number]

export interface CalcAsk {
  readonly lot: number
  readonly level: InspectionLevel
  readonly profile: string | null
  readonly major: string
  readonly minor: string
}

export const CALC_DEFAULT: CalcAsk = Object.freeze({ lot: 500, level: 'II', profile: null, major: '2.5', minor: '4.0' })

export interface PlansAddress {
  readonly tab: PageTab
  readonly stage: PlanStage | ''
  readonly status: VersionStatus | ''
  readonly q: string
  /** `?new=1` New plan; `?copy=<versionId>` New plan starting from that version. */
  readonly newPlan: boolean
  readonly copy: string | null
  /** `?profile=<id>` the profile's "Where it applies" dialog. */
  readonly profile: string | null
  /** `?rule=<id>|new` the rule's dialog. */
  readonly rule: string | null
  readonly calc: CalcAsk
}

type Params = { get(name: string): string | null } | null | undefined

const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | '' => ((list as readonly string[]).includes(value ?? '') ? (value as T) : '')
const whole = (value: string | null | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}
const aqlOf = (value: string | null | undefined, fallback: string): string => (value && (AQL_VALUES as readonly string[]).includes(value) ? value : fallback)

export function addressOf(params: Params): PlansAddress {
  const get = (name: string) => params?.get(name) ?? null
  const tab = oneOf(PAGE_TABS, get('tab')) || 'plans'
  return {
    tab,
    stage: oneOf(PLAN_STAGES, get('stage')),
    status: oneOf(VERSION_STATUSES, get('status')),
    q: (get('q') ?? '').slice(0, 80),
    newPlan: get('new') === '1' || !!get('copy'),
    copy: get('copy'),
    profile: get('profile'),
    rule: get('rule'),
    calc: {
      lot: whole(get('lot'), CALC_DEFAULT.lot, 1, 10_000_000),
      level: (oneOf(INSPECTION_LEVELS, get('level')) || CALC_DEFAULT.level) as InspectionLevel,
      profile: get('aql'),
      major: aqlOf(get('major'), CALC_DEFAULT.major),
      minor: aqlOf(get('minor'), CALC_DEFAULT.minor),
    },
  }
}

/** The address's terms (`?tab=aql&…`): only what differs from the defaults, in a fixed order. */
export function queryOf(address: PlansAddress): string {
  const terms = new URLSearchParams()
  if (address.tab !== 'plans') terms.set('tab', address.tab)
  if (address.tab === 'plans') {
    if (address.stage) terms.set('stage', address.stage)
    if (address.status) terms.set('status', address.status)
    if (address.q.trim()) terms.set('q', address.q.trim())
    if (address.copy) terms.set('copy', address.copy)
    else if (address.newPlan) terms.set('new', '1')
  }
  if (address.tab === 'aql' && address.profile) terms.set('profile', address.profile)
  if (address.tab === 'triggers' && address.rule) terms.set('rule', address.rule)
  if (address.tab === 'calculator') {
    const calc = address.calc
    if (calc.lot !== CALC_DEFAULT.lot) terms.set('lot', String(calc.lot))
    if (calc.profile) terms.set('aql', calc.profile)
    if (calc.level !== CALC_DEFAULT.level) terms.set('level', calc.level)
    if (calc.major !== CALC_DEFAULT.major) terms.set('major', calc.major)
    if (calc.minor !== CALC_DEFAULT.minor) terms.set('minor', calc.minor)
  }
  const text = terms.toString()
  return text ? `?${text}` : ''
}

export const DEFAULT_ADDRESS: PlansAddress = addressOf(null)

/** The plans' filters are on: a list that matches nothing says "No rows match these filters", not "No plans yet". */
export const filtered = (address: PlansAddress): boolean => !!(address.stage || address.status || address.q.trim())

// ---- the record's address ----------------------------------------------------------------------------------------------

export const RECORD_TABS = ['checks', 'sampling', 'applies', 'versions'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export interface RecordAddress {
  readonly tab: RecordTab
  /** Versions: the version compared (`?version=<id>`). */
  readonly version: string | null
  /** `?approve=1`: the Approve version dialog (a link from Home or a notification). */
  readonly approve: boolean
}

export function recordAddressOf(params: Params): RecordAddress {
  const get = (name: string) => params?.get(name) ?? null
  return { tab: oneOf(RECORD_TABS, get('tab')) || 'checks', version: get('version'), approve: get('approve') === '1' }
}

export function recordQuery(address: RecordAddress): string {
  const terms = new URLSearchParams()
  if (address.tab !== 'checks') terms.set('tab', address.tab)
  if (address.tab === 'versions' && address.version) terms.set('version', address.version)
  if (address.approve) terms.set('approve', '1')
  const text = terms.toString()
  return text ? `?${text}` : ''
}

export const planHref = (prefix: string, planId: string, tab: RecordTab = 'checks'): string => `${prefix}/quality/plans/${encodeURIComponent(planId)}${tab === 'checks' ? '' : `?tab=${tab}`}`

/** The printable checklist in a new tab: one plan (its in-force version, or the one named) or several. */
export function printHref(prefix: string, ask: { plans: readonly string[]; version?: string | null; language?: string | null }): string {
  const terms = new URLSearchParams()
  terms.set('plans', ask.plans.join(','))
  if (ask.version) terms.set('version', ask.version)
  if (ask.language) terms.set('language', ask.language)
  return `${prefix}/quality/plans/print?${terms.toString()}`
}

export interface PrintAsk {
  readonly plans: readonly string[]
  readonly version: string | null
  readonly language: string | null
}

export function printAskOf(params: Params): PrintAsk {
  const get = (name: string) => params?.get(name) ?? null
  const plans = (get('plans') ?? get('plan') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 50)
  const language = get('language')
  return { plans, version: plans.length === 1 ? get('version') : null, language: language && /^[a-z]{2,3}$/.test(language) ? language : null }
}

// ---- what a person may do ----------------------------------------------------------------------------------------------

export const PLANS_PERMISSIONS = {
  view: 'quality.plans.view',
  manage: 'quality.plans.manage',
  approve: 'quality.plans.approve',
  aqlView: 'quality.aql.view',
  aqlManage: 'quality.aql.manage',
  triggersView: 'quality.triggers.view',
  triggersManage: 'quality.triggers.manage',
  styles: 'product.styles.view',
  materials: 'product.materials.view',
  operations: 'product.routing.view',
  parties: 'parties.view',
} as const

export type PlansCan = Readonly<Record<keyof typeof PLANS_PERMISSIONS, boolean>>

export function plansCan(permissions: readonly string[]): PlansCan {
  const held = new Set(permissions)
  return Object.fromEntries(Object.entries(PLANS_PERMISSIONS).map(([name, permission]) => [name, held.has(permission)])) as unknown as PlansCan
}

/** A tab this person may see: Plans and the record need the plans' right, AQL and the calculator the AQL right, rules theirs. */
export function tabAllowed(tab: PageTab, can: PlansCan): boolean {
  if (tab === 'plans') return can.view
  if (tab === 'triggers') return can.triggersView
  return can.aqlView
}

/** Which kinds of chip this person can pick a value for (a category always; a record by its list's right). */
export function chipPickable(kind: ChipKind, can: PlansCan): boolean {
  switch (kind) {
    case 'CATEGORY':
      return true
    case 'STYLE':
      return can.styles
    case 'MATERIAL':
      return can.materials
    case 'OPERATION':
      return can.operations
    default:
      return can.parties
  }
}

// ---- API errors in our words -------------------------------------------------------------------------------------------

export const REFUSALS = [
  'AUTHOR',
  'EDITOR',
  'NOT_DRAFT',
  'NOT_READY',
  'PROFILE_RETIRED',
  'DRAFT_EXISTS',
  'CODE_TAKEN',
  'RULES_USE_PLAN',
  'ALREADY_RETIRED',
  'TOO_MANY',
  'NO_APPROVED_VERSION',
] as const

/** The message key of a failed call: a known refusal by its code, else by the kind (never the API's English). */
export function problemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  for (const entry of error.issues) {
    const path = issuePath(entry)
    if (path.startsWith('refusal/')) {
      const code = path.slice('refusal/'.length)
      if ((REFUSALS as readonly string[]).includes(code)) return `refusal.${code}`
    }
  }
  switch (error.kind) {
    case 'signed_out':
      return 'problem.signedOut'
    case 'forbidden':
      return 'problem.forbidden'
    case 'step_up':
      return 'problem.stepUp'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      // A newer version on the server (core/command StaleVersionError names the path `version`).
      return error.issues.some((entry) => issuePath(entry) === 'version') ? 'problem.stale' : 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'unavailable':
      return 'problem.unavailable'
    case 'contract':
      return 'problem.contract'
    default:
      return 'problem.internal'
  }
}

/** The fields the API named in a refusal (`body/checks/2/code` → `checks/2/code`), to mark them on screen. */
export function refusedPaths(error: unknown): string[] {
  if (!isApiError(error)) return []
  return error.issues.map((entry) => issuePath(entry).replace(/^(body|version|query)\//, '')).filter((path) => path && !path.startsWith('refusal/'))
}

// ---- chips ("Applies to") ---------------------------------------------------------------------------------------------

export interface ChipDraft {
  readonly kind: ChipKind
  readonly value: string
  /** What it names (code · name); a category says its words from the catalogue. */
  readonly label: string
}

export const chipKey = (chip: Pick<ChipDraft, 'kind' | 'value'>): string => `${chip.kind}|${chip.value}`
export const chipsOf = (chips: readonly ChipView[]): ChipDraft[] => chips.map((chip) => ({ kind: chip.kind, value: chip.value, label: chip.label }))
const chipList = (chips: readonly ChipDraft[]) => chips.map((chip) => ({ kind: chip.kind, value: chip.value }))
const sameChips = (a: readonly ChipDraft[], b: readonly ChipDraft[]): boolean => a.length === b.length && a.every((chip, index) => chipKey(chip) === chipKey(b[index]!))

/** Chips in our words: at most 40, a category from the list, each chip once (factory-domain chipsProblems). */
export function chipsProblems(chips: readonly ChipDraft[], path = 'appliesTo'): Problem[] {
  const problems: Problem[] = []
  if (chips.length > PLAN_LIMITS.chips) problems.push(problem(path, 'chips.tooMany', { max: PLAN_LIMITS.chips }))
  const seen = new Set<string>()
  chips.forEach((chip, index) => {
    if (chip.kind === 'CATEGORY' && !CATEGORY_CODES.includes(chip.value)) problems.push(problem(`${path}/${index}/value`, 'chips.categoryUnknown'))
    if (seen.has(chipKey(chip))) problems.push(problem(`${path}/${index}/value`, 'chips.twice'))
    seen.add(chipKey(chip))
  })
  return problems
}

/** The kinds a chip of this stage makes sense for: an incoming plan reads materials and suppliers, the others styles. */
export function chipKindsFor(stage: PlanStage | null): readonly ChipKind[] {
  if (stage === 'INCOMING') return ['CATEGORY', 'MATERIAL', 'SUPPLIER', 'STYLE', 'OPERATION', 'CUSTOMER']
  return CHIP_KINDS
}

/** Where a chip's record opens (a category has no page). */
export function chipHref(prefix: string, chip: Pick<ChipDraft, 'kind' | 'value'>): string | null {
  const id = encodeURIComponent(chip.value)
  switch (chip.kind) {
    case 'STYLE':
      return `${prefix}/products/styles/${id}`
    case 'MATERIAL':
      return `${prefix}/products/materials/${id}`
    case 'OPERATION':
      return `${prefix}/products/operations/${id}`
    case 'SUPPLIER':
      return `${prefix}/purchasing/suppliers/${id}`
    case 'CUSTOMER':
      return `${prefix}/sales/customers/${id}`
    default:
      return null
  }
}

// ---- checks (QHS-009) -------------------------------------------------------------------------------------------------

export interface CheckDraft {
  /** The row's own key in the builder (the stored id, or `new-<n>`). */
  readonly key: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly type: CheckType
  readonly checkClass: CheckClass | null
  readonly mandatory: boolean
  readonly photoRequired: boolean
  readonly nominal: string
  readonly tolerance: string
  readonly uom: string
  readonly choices: readonly string[]
}

export const checkDraftOf = (check: CheckView): CheckDraft => ({
  key: check.id,
  code: check.code,
  labelIt: check.labelIt,
  labelEn: check.labelEn,
  labelI18n: check.labelI18n,
  type: check.type,
  checkClass: check.checkClass,
  mandatory: check.mandatory,
  photoRequired: check.photoRequired,
  nominal: check.nominal ?? '',
  tolerance: check.tolerance ?? '',
  uom: check.uom ?? '',
  choices: check.choices,
})

/** A new check of a type, numbered after the others ("CHECK_3"), mandatory unless an instruction (the domain's default). */
export function newCheck(existing: readonly CheckDraft[], n: number, type: CheckType = 'PASS_FAIL'): CheckDraft {
  const taken = new Set(existing.map((check) => check.code))
  let index = existing.length + 1
  while (taken.has(`CHECK_${index}`)) index += 1
  return {
    key: `new-${n}`,
    code: `CHECK_${index}`,
    labelIt: '',
    labelEn: '',
    labelI18n: {},
    type,
    checkClass: type === 'INSTRUCTION' ? null : 'MAJOR',
    mandatory: type !== 'INSTRUCTION',
    photoRequired: false,
    nominal: '',
    tolerance: '',
    uom: type === 'MEASUREMENT' ? 'CM' : '',
    choices: type === 'CHOICE' ? ['', ''] : [],
  }
}

/** The check after a change of type: what the new type cannot hold is dropped (an instruction is only read). */
export function withType(check: CheckDraft, type: CheckType): CheckDraft {
  const instruction = type === 'INSTRUCTION'
  return {
    ...check,
    type,
    checkClass: instruction ? null : (check.checkClass ?? 'MAJOR'),
    mandatory: instruction ? false : check.type === 'INSTRUCTION' ? true : check.mandatory,
    photoRequired: instruction ? false : check.photoRequired,
    nominal: type === 'MEASUREMENT' ? check.nominal : '',
    tolerance: type === 'MEASUREMENT' ? check.tolerance : '',
    uom: type === 'MEASUREMENT' ? check.uom || 'CM' : '',
    choices: type === 'CHOICE' ? (check.choices.length >= 2 ? check.choices : ['', '']) : [],
  }
}

const blank = (value: string): boolean => value.trim() === ''

/** What the API stores for a check (factory-domain checkContentOf): words trimmed, what the type cannot hold left out. */
export function checkBody(check: CheckDraft): CheckBody {
  const instruction = check.type === 'INSTRUCTION'
  const measured = check.type === 'MEASUREMENT' && !(blank(check.nominal) && blank(check.tolerance))
  return {
    code: check.code.trim(),
    labelIt: check.labelIt.trim(),
    labelEn: check.labelEn.trim(),
    ...(Object.keys(check.labelI18n).length > 0 ? { labelI18n: Object.fromEntries(Object.entries(check.labelI18n).map(([language, text]) => [language, text.trim()])) } : {}),
    type: check.type,
    checkClass: instruction ? null : check.checkClass,
    mandatory: instruction ? false : check.mandatory,
    photoRequired: instruction ? false : check.photoRequired,
    nominal: measured ? check.nominal.trim() || null : null,
    tolerance: measured ? check.tolerance.trim() || null : null,
    uom: measured ? check.uom || 'CM' : null,
    choices: check.type === 'CHOICE' ? check.choices.map((choice) => choice.trim()) : [],
  }
}

/** The checks' problems in our words, at the API's paths (factory-domain checksProblems re-stated). */
export function checksProblems(checks: readonly CheckDraft[]): Problem[] {
  const problems: Problem[] = []
  if (checks.length > PLAN_LIMITS.checks) problems.push(problem('checks', 'checks.tooMany', { max: PLAN_LIMITS.checks }))
  const codes = new Set<string>()
  checks.forEach((draft, index) => {
    const at = `checks/${index}`
    const check = checkBody(draft)
    if (!CHECK_CODE.test(check.code)) problems.push(problem(`${at}/code`, 'checks.codePattern'))
    else if (codes.has(check.code)) problems.push(problem(`${at}/code`, 'checks.codeTwice', { code: check.code }))
    codes.add(check.code)
    if (check.labelIt === '') problems.push(problem(`${at}/labelIt`, 'checks.labelItBlank'))
    else if (check.labelIt.length > PLAN_LIMITS.label) problems.push(problem(`${at}/labelIt`, 'checks.labelLong', { max: PLAN_LIMITS.label }))
    if (check.labelEn === '') problems.push(problem(`${at}/labelEn`, 'checks.labelEnBlank'))
    else if (check.labelEn.length > PLAN_LIMITS.label) problems.push(problem(`${at}/labelEn`, 'checks.labelLong', { max: PLAN_LIMITS.label }))
    if (check.type === 'MEASUREMENT') {
      const parts = [draft.nominal, draft.tolerance].filter((value) => !blank(value)).length
      if (parts === 1) problems.push(problem(`${at}/nominal`, 'checks.measureBoth'))
      if (!blank(draft.nominal) && !MEASURE.test(draft.nominal.trim())) problems.push(problem(`${at}/nominal`, 'checks.nominalBad'))
      if (!blank(draft.tolerance) && !MEASURE.test(draft.tolerance.trim())) problems.push(problem(`${at}/tolerance`, 'checks.toleranceBad'))
    }
    if (check.type === 'CHOICE') {
      const lower = check.choices.map((choice) => choice.toLowerCase())
      if (check.choices.length < 2) problems.push(problem(`${at}/choices`, 'checks.choicesTwo'))
      else if (check.choices.length > PLAN_LIMITS.choices) problems.push(problem(`${at}/choices`, 'checks.choicesMany', { max: PLAN_LIMITS.choices }))
      if (check.choices.some((choice) => choice === '')) problems.push(problem(`${at}/choices`, 'checks.choiceBlank'))
      else if (new Set(lower).size !== lower.length) problems.push(problem(`${at}/choices`, 'checks.choiceTwice'))
      if (check.choices.some((choice) => choice.length > PLAN_LIMITS.choice)) problems.push(problem(`${at}/choices`, 'checks.choiceLong', { max: PLAN_LIMITS.choice }))
    }
  })
  return problems
}

/** How the bench sees the list: checks, those taking a result, mandatory, critical, asking a photo. */
export function checksSummary(checks: readonly CheckDraft[]): { total: number; results: number; mandatory: number; critical: number; photos: number; measures: number } {
  return {
    total: checks.length,
    results: checks.filter((check) => takesResult(check.type)).length,
    mandatory: checks.filter((check) => check.type !== 'INSTRUCTION' && check.mandatory).length,
    critical: checks.filter((check) => check.type !== 'INSTRUCTION' && check.checkClass === 'CRITICAL').length,
    photos: checks.filter((check) => check.type === 'PHOTO' || (check.type !== 'INSTRUCTION' && check.photoRequired)).length,
    measures: checks.filter((check) => check.type === 'MEASUREMENT').length,
  }
}

/** A measurement's spec in words, as the bench reads it: "58 ± 1 cm", or the size chart. */
export function specOf(check: Pick<CheckDraft, 'type' | 'nominal' | 'tolerance' | 'uom'>): Words | null {
  if (check.type !== 'MEASUREMENT') return null
  if (blank(check.nominal) || blank(check.tolerance)) return words('spec.sizeChart')
  const plain = (value: string) => value.trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return words('spec.value', { nominal: plain(check.nominal), tolerance: plain(check.tolerance), unit: (check.uom || 'CM').toLowerCase() })
}

// ---- sampling ---------------------------------------------------------------------------------------------------------

/** Stop early at the reject number, finish the sample, or follow the company's quality setting. */
export type StopRule = 'SETTING' | 'STOP' | 'FINISH'

export interface SamplingDraft {
  readonly method: 'AQL_PROFILE' | 'FIXED'
  /** AQL_PROFILE: the profile named; null: the one that applies when a record opens (style, customer, company default). */
  readonly profileId: string | null
  readonly fixedSize: number | ''
  readonly frequency: Frequency | null
  readonly frequencyValue: number | ''
  readonly stop: StopRule
}

export const samplingDraftOf = (sampling: SamplingView): SamplingDraft => ({
  method: sampling.samplingMethod,
  profileId: sampling.aqlProfileId,
  fixedSize: sampling.fixedSampleSize ?? '',
  frequency: sampling.frequency,
  frequencyValue: sampling.frequencyValue ?? '',
  stop: sampling.stopAtReject === null ? 'SETTING' : sampling.stopAtReject ? 'STOP' : 'FINISH',
})

export function samplingBody(draft: SamplingDraft): SamplingBody {
  const fixed = draft.method === 'FIXED'
  const value = draft.frequency && FREQUENCY_TAKES_VALUE[draft.frequency] && draft.frequencyValue !== '' ? draft.frequencyValue : null
  return {
    samplingMethod: draft.method,
    aqlProfileId: fixed ? null : draft.profileId,
    fixedSampleSize: fixed && draft.fixedSize !== '' ? draft.fixedSize : null,
    frequency: draft.frequency,
    frequencyValue: value,
    stopAtReject: draft.stop === 'SETTING' ? null : draft.stop === 'STOP',
  }
}

/** Sampling's problems in our words, at the API's paths (factory-domain samplingProblems re-stated). */
export function samplingProblems(draft: SamplingDraft): Problem[] {
  const problems: Problem[] = []
  const body = samplingBody(draft)
  if (draft.method === 'FIXED') {
    const size = body.fixedSampleSize
    if (size === null || !Number.isInteger(size) || size < 1 || size > PLAN_LIMITS.fixedSample) problems.push(problem('sampling/fixedSampleSize', 'sampling.fixedProblem', { max: PLAN_LIMITS.fixedSample }))
  }
  if (draft.frequency === 'PERCENT_OF_OPERATIONS') {
    const value = body.frequencyValue
    if (value === null || !Number.isInteger(value) || value < 1 || value > 100) problems.push(problem('sampling/frequencyValue', 'sampling.percent'))
  } else if (draft.frequency === 'EVERY_NTH_BUNDLE') {
    const value = body.frequencyValue
    if (value === null || !Number.isInteger(value) || value < 1 || value > PLAN_LIMITS.everyNth) problems.push(problem('sampling/frequencyValue', 'sampling.everyNth', { max: PLAN_LIMITS.everyNth }))
  }
  return problems
}

/** How often, in words: "Every lot", "10% of operations", "Every 3rd bundle", "First piece"; none: each record a person opens. */
export function frequencyWords(frequency: Frequency | null, value: number | '' | null): Words {
  switch (frequency) {
    case null:
      return words('frequency.none')
    case 'PERCENT_OF_OPERATIONS':
      return value === '' || value === null ? words('frequency.percentAsk') : words('frequency.percent', { value })
    case 'EVERY_NTH_BUNDLE':
      return value === '' || value === null ? words('frequency.nthAsk') : value === 1 ? words('frequency.everyBundle') : words('frequency.nth', { value })
    default:
      return words(`frequency.${frequency}`)
  }
}

// ---- one version's draft (Checks + Sampling: ONE save, the builder's PUT) ----------------------------------------------

export interface VersionDraft {
  readonly checks: readonly CheckDraft[]
  readonly sampling: SamplingDraft
  readonly changeNote: string
}

export const versionDraftOf = (version: VersionView): VersionDraft => ({
  checks: version.checks.map(checkDraftOf),
  sampling: samplingDraftOf(version.sampling),
  changeNote: version.changeNote ?? '',
})

const json = (value: unknown) => JSON.stringify(value)

/** How many changes the builder holds: one per check added, removed, changed or moved, sampling, the note. */
export function versionChanges(version: VersionView, draft: VersionDraft): number {
  const before = version.checks.map(checkDraftOf)
  const byKey = new Map(before.map((check) => [check.key, check]))
  const keys = new Set(draft.checks.map((check) => check.key))
  // Removed, then added or changed, then one for a new order of the checks kept.
  let count = before.filter((check) => !keys.has(check.key)).length
  for (const check of draft.checks) {
    const old = byKey.get(check.key)
    if (!old || json(checkBody(old)) !== json(checkBody(check))) count += 1
  }
  const keptBefore = before.filter((check) => keys.has(check.key)).map((check) => check.key)
  const keptAfter = draft.checks.filter((check) => byKey.has(check.key)).map((check) => check.key)
  if (keptBefore.join(',') !== keptAfter.join(',')) count += 1
  if (json(samplingBody(samplingDraftOf(version.sampling))) !== json(samplingBody(draft.sampling))) count += 1
  if ((version.changeNote ?? '') !== draft.changeNote.trim() && !(version.changeNote === null && draft.changeNote.trim() === '')) count += 1
  return count
}

export const versionProblems = (draft: VersionDraft): Problem[] => [
  ...checksProblems(draft.checks),
  ...samplingProblems(draft.sampling),
  ...(draft.changeNote.trim().length > PLAN_LIMITS.changeNote ? [problem('changeNote', 'note.long', { max: PLAN_LIMITS.changeNote })] : []),
]

export function versionBody(version: VersionView, draft: VersionDraft): SaveVersionBody {
  return {
    version: version.version,
    changeNote: draft.changeNote.trim() || null,
    sampling: samplingBody(draft.sampling),
    checks: draft.checks.map(checkBody),
  }
}

/** Why the version may not be changed here (an approved or retired version, no right, offline); null: it may. */
export function editHeld(record: PlanRecord, can: PlansCan, offline: boolean): Words | null {
  if (!can.manage || !record.may.manage) return words('held.noManage')
  if (record.current.status === 'APPROVED') return words('held.approved', { number: record.current.number, next: record.plan.latestNumber + 1 })
  if (record.current.status === 'RETIRED') return words('held.retired', { number: record.current.number })
  if (offline) return words('held.offline')
  return null
}

// ---- Applies to (the plan's PATCH) ------------------------------------------------------------------------------------

export interface AppliesDraft {
  readonly name: string
  readonly chips: readonly ChipDraft[]
}

export const appliesDraftOf = (plan: PlanRow): AppliesDraft => ({ name: plan.name, chips: chipsOf(plan.appliesTo) })

export function appliesChanges(plan: PlanRow, draft: AppliesDraft): number {
  let count = 0
  if (draft.name.trim() !== plan.name) count += 1
  const before = new Set(plan.appliesTo.map(chipKey))
  const after = new Set(draft.chips.map(chipKey))
  count += [...after].filter((key) => !before.has(key)).length + [...before].filter((key) => !after.has(key)).length
  if (count === 0 && !sameChips(chipsOf(plan.appliesTo), draft.chips)) count = 1
  return count
}

export function appliesProblems(draft: AppliesDraft): Problem[] {
  const problems: Problem[] = []
  if (draft.name.trim() === '') problems.push(problem('name', 'plan.nameBlank'))
  else if (draft.name.trim().length > PLAN_LIMITS.name) problems.push(problem('name', 'plan.nameLong', { max: PLAN_LIMITS.name }))
  return [...problems, ...chipsProblems(draft.chips)]
}

export function appliesBody(plan: PlanRow, draft: AppliesDraft): EditPlanBody {
  return {
    version: plan.version,
    ...(draft.name.trim() !== plan.name ? { name: draft.name.trim() } : {}),
    ...(!sameChips(chipsOf(plan.appliesTo), draft.chips) ? { appliesTo: chipList(draft.chips) } : {}),
  }
}

// ---- the plan's state and the approval (QHS-016) ----------------------------------------------------------------------

/** The plan's state in the grid and the band: Approved vN, Draft, Retired; waiting approval when the draft was submitted. */
export function planState(row: PlanRow): { tone: 'success' | 'info' | 'neutral'; status: Words; waiting: boolean } {
  if (row.status === 'APPROVED') return { tone: 'success', status: words('status.APPROVED'), waiting: !!row.draft?.submitted }
  if (row.status === 'DRAFT') return { tone: 'info', status: words('status.DRAFT'), waiting: !!row.draft?.submitted }
  return { tone: 'neutral', status: words('status.RETIRED'), waiting: false }
}

/** "v2", "v3 draft", "v1 · v2 draft": the versions a row names. */
export function versionWords(row: PlanRow): Words {
  if (row.approved && row.draft) return words('version.both', { approved: row.approved.number, draft: row.draft.number })
  if (row.approved) return words('version.one', { number: row.approved.number })
  if (row.draft) return words('version.draft', { number: row.draft.number })
  return row.latestNumber > 0 ? words('version.retired', { number: row.latestNumber }) : words('version.none')
}

/**
 * Why this person may not approve the draft now, from facts (the API decides again): no draft, no right, its author, a
 * person who saved a change to it, nothing to approve yet (its problems), offline. Null: they may.
 */
export function approveHeld(record: PlanRecord, me: string, can: PlansCan, offline: boolean): Words | null {
  const draft = record.current.status === 'DRAFT' ? record.current : null
  if (!draft) return words('approve.noDraft')
  if (!can.approve || (!record.may.approve && !record.may.approveHeld)) return words('approve.noRight')
  if (draft.author?.id === me) return words('approve.author', { number: draft.number })
  if (record.may.approveHeld) {
    // The API holds it for a reason the facts above do not show: the person saved a change to this draft (an editor).
    return can.approve ? words('approve.editor', { number: draft.number }) : words('approve.noRight')
  }
  if ((draft.problems ?? []).length > 0) return words('approve.notReady', { count: (draft.problems ?? []).length })
  if (offline) return words('held.offline')
  return null
}

/** Why the author may not ask for approval now: nothing to ask (submitted, saved changes waiting), problems, offline. */
export function submitHeld(record: PlanRecord, can: PlansCan, dirty: boolean, offline: boolean): Words | null {
  const draft = record.current.status === 'DRAFT' ? record.current : null
  if (!draft) return words('approve.noDraft')
  if (!can.manage || !record.may.manage) return words('held.noManage')
  if (dirty) return words('submit.saveFirst')
  if (draft.submitted) return words('submit.already')
  if ((draft.problems ?? []).length > 0) return words('approve.notReady', { count: (draft.problems ?? []).length })
  if (offline) return words('held.offline')
  return null
}

/** What the band's primary does for this person now (at most one): approve, ask for approval, or start a new version. */
export type BandPrimary = 'approve' | 'submit' | 'newVersion' | null

export function bandPrimary(record: PlanRecord, me: string, can: PlansCan): BandPrimary {
  const draft = record.current.status === 'DRAFT' ? record.current : null
  if (draft) {
    if (can.approve && draft.author?.id !== me && (draft.submitted || !can.manage)) return 'approve'
    if (can.manage && record.may.manage) return draft.submitted && can.approve && draft.author?.id !== me ? 'approve' : 'submit'
    return can.approve ? 'approve' : null
  }
  return can.manage && record.may.manage ? 'newVersion' : null
}

/** The version in force (new records open on it) and the one the builder shows. */
export const inForce = (record: PlanRecord) => record.versions.find((version) => version.status === 'APPROVED') ?? null

/** Which versions may be retired by this person: a draft, or the approved one while no active rule names the plan. */
export function retireHeld(record: PlanRecord, versionStatus: VersionStatus, can: PlansCan): Words | null {
  if (!can.manage || !record.may.manage) return words('held.noManage')
  if (versionStatus === 'RETIRED') return words('retire.already')
  if (versionStatus === 'APPROVED' && record.rules > 0) return words('retire.rulesUsePlan', { count: record.rules })
  return null
}

export const reasonProblem = (reason: string): Words | null => (reason.trim().length < 3 ? words('retire.reasonShort') : reason.trim().length > PLAN_LIMITS.reason ? words('note.long', { max: PLAN_LIMITS.reason }) : null)

// ---- the comparison (ChangeReview) ------------------------------------------------------------------------------------

export interface ReviewLine {
  readonly id: string
  readonly change: 'added' | 'removed' | 'changed' | 'moved' | 'sampling'
  /** The check's code, or the sampling field. */
  readonly subject: string
  /** Italian and English words of the check, for the label in the page's language. */
  readonly labelIt: string | null
  readonly labelEn: string | null
  readonly fields: readonly { readonly field: string; readonly before: string; readonly after: string }[]
}

const said = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(String).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** The comparison as review lines: added, removed, changed field by field, moved, then sampling. */
export function reviewLines(comparison: Comparison, version: VersionView | null): ReviewLine[] {
  const label = (code: string) => version?.checks.find((check) => check.code === code) ?? null
  return [
    ...comparison.added.map((entry) => ({ id: `added-${entry.code}`, change: 'added' as const, subject: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, fields: [] })),
    ...comparison.removed.map((entry) => ({ id: `removed-${entry.code}`, change: 'removed' as const, subject: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn, fields: [] })),
    ...comparison.changed.map((entry) => ({
      id: `changed-${entry.code}`,
      change: 'changed' as const,
      subject: entry.code,
      labelIt: label(entry.code)?.labelIt ?? null,
      labelEn: label(entry.code)?.labelEn ?? null,
      fields: entry.changes.map((change) => ({ field: change.field, before: said(change.before), after: said(change.after) })),
    })),
    ...comparison.moved.map((code) => ({ id: `moved-${code}`, change: 'moved' as const, subject: code, labelIt: label(code)?.labelIt ?? null, labelEn: label(code)?.labelEn ?? null, fields: [] })),
    ...(comparison.sampling.length > 0
      ? [{ id: 'sampling', change: 'sampling' as const, subject: 'sampling', labelIt: null, labelEn: null, fields: comparison.sampling.map((change) => ({ field: change.field, before: said(change.before), after: said(change.after) })) }]
      : []),
  ]
}

// ---- New plan (pl-new) ------------------------------------------------------------------------------------------------

export interface NewPlanDraft {
  readonly stage: PlanStage
  readonly code: string
  readonly name: string
  readonly start: 'BLANK' | 'STARTER' | 'COPY'
  readonly starterCode: string
  readonly copyVersionId: string
  readonly owner: 'ME' | 'NOBODY'
}

export const NEW_PLAN: NewPlanDraft = Object.freeze({ stage: 'FINAL', code: '', name: '', start: 'BLANK', starterCode: '', copyVersionId: '', owner: 'ME' })

/** A code as the API keeps it: upper case, spaces as -. */
export const codeOf = (text: string): string => text.toUpperCase().replace(/\s+/g, '-')

export function newPlanProblems(draft: NewPlanDraft, taken: ReadonlySet<string>): Problem[] {
  const problems: Problem[] = []
  const code = codeOf(draft.code.trim())
  if (!PLAN_CODE.test(code)) problems.push(problem('code', 'plan.code'))
  else if (taken.has(code)) problems.push(problem('code', 'plan.codeTaken', { code }))
  if (draft.name.trim() === '') problems.push(problem('name', 'plan.nameBlank'))
  else if (draft.name.trim().length > PLAN_LIMITS.name) problems.push(problem('name', 'plan.nameLong', { max: PLAN_LIMITS.name }))
  if (draft.start === 'STARTER' && !draft.starterCode) problems.push(problem('startFrom', 'plan.pickStarter'))
  if (draft.start === 'COPY' && !draft.copyVersionId) problems.push(problem('startFrom', 'plan.pickCopy'))
  return problems
}

/** The copies a new plan may start from: every plan's version in force, else its draft (same stage first). */
export function copyChoices(rows: readonly PlanRow[], stage: PlanStage): { versionId: string; planCode: string; planName: string; number: number; stage: PlanStage; status: 'APPROVED' | 'DRAFT' }[] {
  const choices = rows.flatMap((row) => {
    const version = row.approved ? { id: row.approved.id, number: row.approved.number, status: 'APPROVED' as const } : row.draft ? { id: row.draft.id, number: row.draft.number, status: 'DRAFT' as const } : null
    return version ? [{ versionId: version.id, planCode: row.code, planName: row.name, number: version.number, stage: row.stage, status: version.status }] : []
  })
  return choices.sort((a, b) => Number(b.stage === stage) - Number(a.stage === stage) || a.planCode.localeCompare(b.planCode))
}

// ---- AQL profiles (pl-aql) --------------------------------------------------------------------------------------------

export interface ProfileDraft {
  readonly key: string
  /** Null: a new profile. */
  readonly id: string | null
  readonly code: string
  readonly name: string
  readonly level: InspectionLevel
  readonly major: string
  readonly minor: string
  readonly note: string
  readonly active: boolean
  readonly isDefault: boolean
}

/** As Table 2-A prints it: "2.500" → "2.5". */
export const aqlText = (value: string): string => (value === '0' || Number(value) === 0 ? '0' : aqlWords(value))

export const profileDraftOf = (profile: Profile): ProfileDraft => ({
  key: profile.id,
  id: profile.id,
  code: profile.code,
  name: profile.name,
  level: profile.inspectionLevel,
  major: aqlText(profile.aqlMajor),
  minor: aqlText(profile.aqlMinor),
  note: profile.note ?? '',
  active: profile.active,
  isDefault: profile.isDefault,
})

export const newProfile = (n: number, first: boolean): ProfileDraft => ({ key: `new-${n}`, id: null, code: '', name: '', level: 'II', major: '2.5', minor: '4.0', note: '', active: true, isDefault: first })

export interface ProfilePlan {
  readonly creates: readonly ProfileDraft[]
  readonly edits: readonly { readonly profile: Profile; readonly draft: ProfileDraft }[]
  /** The profile that becomes the default (an existing id, or the key of a new one). */
  readonly defaultTo: string | null
}

const changedFields = (profile: Profile, draft: ProfileDraft): string[] => {
  const before = profileDraftOf(profile)
  return (['name', 'level', 'major', 'minor', 'note', 'active'] as const).filter((field) => (typeof before[field] === 'string' ? (before[field] as string).trim() !== (draft[field] as string).trim() : before[field] !== draft[field]))
}

export function profilePlan(profiles: readonly Profile[], drafts: readonly ProfileDraft[]): ProfilePlan {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]))
  const creates = drafts.filter((draft) => draft.id === null)
  const edits = drafts.flatMap((draft) => {
    const profile = draft.id ? byId.get(draft.id) : undefined
    return profile && changedFields(profile, draft).length > 0 ? [{ profile, draft }] : []
  })
  const wasDefault = profiles.find((profile) => profile.isDefault)?.id ?? null
  const nowDefault = drafts.find((draft) => draft.isDefault)
  const defaultTo = nowDefault && (nowDefault.id ?? nowDefault.key) !== wasDefault ? (nowDefault.id ?? nowDefault.key) : null
  return { creates, edits, defaultTo }
}

export const profileChanges = (plan: ProfilePlan): number => plan.creates.length + plan.edits.length + (plan.defaultTo && !plan.creates.some((draft) => draft.key === plan.defaultTo) ? 1 : 0)

export function editProfileBody(profile: Profile, draft: ProfileDraft): Record<string, unknown> {
  const fields = changedFields(profile, draft)
  return {
    version: profile.version,
    ...(fields.includes('name') ? { name: draft.name.trim() } : {}),
    ...(fields.includes('level') ? { inspectionLevel: draft.level } : {}),
    ...(fields.includes('major') ? { aqlMajor: draft.major } : {}),
    ...(fields.includes('minor') ? { aqlMinor: draft.minor } : {}),
    ...(fields.includes('note') ? { note: draft.note.trim() || null } : {}),
    ...(fields.includes('active') ? { active: draft.active } : {}),
  }
}

export function profilesProblems(drafts: readonly ProfileDraft[]): Problem[] {
  const problems: Problem[] = []
  const codes = new Map<string, number>()
  drafts.forEach((draft, index) => {
    const at = `profiles/${index}`
    if (draft.id === null) {
      const code = draft.code.trim().toUpperCase()
      if (!PROFILE_CODE.test(code)) problems.push(problem(`${at}/code`, 'profiles.code'))
      else if (codes.has(code)) problems.push(problem(`${at}/code`, 'profiles.codeTaken', { code }))
    }
    codes.set(draft.code.trim().toUpperCase(), index)
    if (draft.name.trim() === '') problems.push(problem(`${at}/name`, 'profiles.name'))
    else if (draft.name.trim().length > 100) problems.push(problem(`${at}/name`, 'profiles.nameLong', { max: 100 }))
    for (const field of ['major', 'minor'] as const) if (!(AQL_VALUES as readonly string[]).includes(draft[field])) problems.push(problem(`${at}/${field}`, 'profiles.aql'))
    if (draft.isDefault && !draft.active) problems.push(problem(`${at}/active`, 'profiles.defaultRetired'))
  })
  if (drafts.length > 0 && !drafts.some((draft) => draft.isDefault && draft.active)) problems.push(problem('profiles', 'profiles.noDefault'))
  return problems
}

/** Why a profile may not be retired from here: the default, or still used (the API refuses it too). */
export function retireProfileHeld(profile: Profile | null, draft: ProfileDraft): Words | null {
  if (!draft.active) return null
  if (draft.isDefault) return words('profiles.heldDefault')
  if (profile && profile.usedBy.customers + profile.usedBy.styles + profile.usedBy.pairs > 0) return words('profiles.heldUsed')
  return null
}

// ---- When inspections are created (pl-triggers) -----------------------------------------------------------------------

export interface RuleDraft {
  readonly key: string
  /** Null: a new rule. */
  readonly id: string | null
  readonly event: TriggerEvent
  readonly planId: string
  readonly chips: readonly ChipDraft[]
  readonly frequency: Frequency
  readonly frequencyValue: number | ''
  /** B-W2b-213: within how many hours what it opens is due ('' : no due time). */
  readonly dueHours: number | ''
  readonly active: boolean
}

/** B-W2b-213 (factory-domain dueHoursProblem): due within 1 to 720 hours, or none. */
export const DUE_HOURS_MAX = 720

export const ruleDraftOf = (rule: Rule): RuleDraft => ({
  key: rule.id,
  id: rule.id,
  event: rule.event,
  planId: rule.plan.id,
  chips: chipsOf(rule.appliesTo),
  frequency: rule.frequency,
  frequencyValue: rule.frequencyValue ?? '',
  dueHours: rule.dueHours ?? '',
  active: rule.active,
})

export const newRule = (n: number, event: TriggerEvent, planId: string): RuleDraft => ({ key: `new-${n}`, id: null, event, planId, chips: [], frequency: 'EVERY_LOT', frequencyValue: '', dueHours: '', active: true })

export function ruleBody(draft: RuleDraft): RuleBody {
  return {
    event: draft.event,
    planId: draft.planId,
    appliesTo: chipList(draft.chips),
    frequency: draft.frequency,
    frequencyValue: FREQUENCY_TAKES_VALUE[draft.frequency] && draft.frequencyValue !== '' ? draft.frequencyValue : null,
    dueHours: draft.dueHours === '' ? null : draft.dueHours,
    active: draft.active,
  }
}

export interface RulesPlan {
  readonly creates: readonly RuleDraft[]
  readonly edits: readonly { readonly rule: Rule; readonly draft: RuleDraft }[]
  readonly deletes: readonly Rule[]
  readonly reordered: boolean
}

export function rulesPlan(rules: readonly Rule[], drafts: readonly RuleDraft[]): RulesPlan {
  const kept = new Set(drafts.map((draft) => draft.id).filter((id): id is string => id !== null))
  const byId = new Map(rules.map((rule) => [rule.id, rule]))
  const edits = drafts.flatMap((draft) => {
    const rule = draft.id ? byId.get(draft.id) : undefined
    return rule && json(ruleBody(ruleDraftOf(rule))) !== json(ruleBody(draft)) ? [{ rule, draft }] : []
  })
  const before = rules.map((rule) => rule.id).filter((id) => kept.has(id))
  const after = drafts.filter((draft) => draft.id !== null).map((draft) => draft.id!)
  const newAt = drafts.findIndex((draft) => draft.id === null)
  const reordered = before.join(',') !== after.join(',') || (newAt !== -1 && drafts.slice(newAt).some((draft) => draft.id !== null))
  return { creates: drafts.filter((draft) => draft.id === null), edits, deletes: rules.filter((rule) => !kept.has(rule.id)), reordered }
}

export const rulesChanges = (plan: RulesPlan): number => plan.creates.length + plan.edits.length + plan.deletes.length + (plan.reordered ? 1 : 0)

export interface RulePlanFacts {
  readonly id: string
  readonly stage: PlanStage
  readonly approved: boolean
}

export interface EventFacts {
  readonly event: TriggerEvent
  readonly available: boolean
  readonly stages: readonly PlanStage[]
  readonly frequencies: readonly Frequency[]
  readonly chipKinds: readonly ChipKind[]
}

/** A rule's problems in our words (factory-domain ruleProblems re-stated; the API decides again). */
export function ruleProblems(draft: RuleDraft, events: readonly EventFacts[], plans: readonly RulePlanFacts[], path = ''): Problem[] {
  const at = (field: string) => (path ? `${path}/${field}` : field)
  const problems: Problem[] = []
  const event = events.find((entry) => entry.event === draft.event)
  if (!event || !event.available) return [problem(at('event'), 'rules.eventHeld')]
  const plan = plans.find((entry) => entry.id === draft.planId)
  if (!plan) problems.push(problem(at('planId'), 'rules.pickPlan'))
  else if (!event.stages.includes(plan.stage)) problems.push(problem(at('planId'), 'rules.planStage'))
  else if (draft.active && !plan.approved) problems.push(problem(at('planId'), 'rules.noApproved'))
  if (!event.frequencies.includes(draft.frequency)) problems.push(problem(at('frequency'), 'rules.frequency'))
  else if (draft.frequency === 'FIRST_PIECE' && plan && plan.stage !== 'IN_LINE') problems.push(problem(at('frequency'), 'rules.firstPieceInLine'))
  if (draft.frequency === 'PERCENT_OF_OPERATIONS' && (draft.frequencyValue === '' || draft.frequencyValue < 1 || draft.frequencyValue > 100)) problems.push(problem(at('frequencyValue'), 'sampling.percent'))
  if (draft.frequency === 'EVERY_NTH_BUNDLE' && (draft.frequencyValue === '' || draft.frequencyValue < 1 || draft.frequencyValue > PLAN_LIMITS.everyNth)) problems.push(problem(at('frequencyValue'), 'sampling.everyNth', { max: PLAN_LIMITS.everyNth }))
  if (draft.dueHours !== '' && (!Number.isInteger(draft.dueHours) || draft.dueHours < 1 || draft.dueHours > DUE_HOURS_MAX)) problems.push(problem(at('dueHours'), 'rules.dueHoursRange', { max: DUE_HOURS_MAX }))
  draft.chips.forEach((chip, index) => {
    if (!event.chipKinds.includes(chip.kind)) problems.push(problem(at(`appliesTo/${index}/kind`), 'rules.chipKind'))
  })
  return [...problems, ...chipsProblems(draft.chips, at('appliesTo'))]
}

export const FREQUENCY_ORDER: readonly Frequency[] = FREQUENCIES

// ---- the calculator --------------------------------------------------------------------------------------------------

export const isCheckType = (value: string): value is CheckType => (CHECK_TYPES as readonly string[]).includes(value)
