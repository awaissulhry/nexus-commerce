import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * Skills, levels, trainees and machine authorisations (B-W2b-39; MES-241, MES-244, MES-246; design people.skills
 * "Matrix", "Sign off a trainee", "Authorise a machine"; people.employees › Skills & training). Pure: the API
 * (apps/factory-api modules/people/skills) reads the facts in its command and writes the rows; the …_people_w2b_guards
 * triggers stay the last word for every login.
 *
 *   skill          an operation of the library, a class of machine or a general skill; of the group (tenant-wide) or of
 *                  one company; a code that never changes; archived, never deleted
 *   level          the level one person holds in one skill (Learning / Can do / Expert / Trainer): a person's judgement,
 *                  never computed (MES-281), so every level names who assessed it and when; one in force per person and
 *                  skill; removed (when, who, why), never deleted
 *   trainee        a trainee period on a level (MES-244: a guaranteed rate, left out of line efficiency) until a person
 *                  signs the trainee off, with the trainer; the sign-off is set once
 *   authorisation  a person may operate a class of machine (MES-246) from a day, until a day or open; one in force per
 *                  person and class; its end moves while it is in force; revoked (when, who, why), never deleted
 *
 * A level is a qualification, never a performance score: nothing here ranks people or sums a person's skills into a
 * figure (Statuto dei Lavoratori art. 4; AI Act Annex III 4(b); design "no column sums people into a score").
 */

export const SKILL_KINDS = ['OPERATION', 'MACHINE', 'GENERAL'] as const
export type SkillKind = (typeof SKILL_KINDS)[number]

export const SKILL_LEVELS = ['LEARNING', 'CAN_DO', 'EXPERT', 'TRAINER'] as const
export type SkillLevel = (typeof SKILL_LEVELS)[number]

export const SKILL_STATUSES = ['ACTIVE', 'ARCHIVED'] as const

export const SKILL_LIMITS = { code: 40, name: 120, reason: 300, note: 300, sortOrder: { min: 0, max: 9999 } } as const

/** A skill's code: capitals, digits and . _ -, no spaces (it heads the matrix's column and never changes). */
export const SKILL_CODE = /^[A-Z0-9][A-Z0-9._-]*$/

/** A code as stored: trimmed and in capitals. */
export const cleanSkillCode = (value: string): string => value.trim().toUpperCase()

/** The level's words in the API's answers (the screens have their own per language). */
export const LEVEL_LABELS: Readonly<Record<SkillLevel, string>> = Object.freeze({ LEARNING: 'Learning', CAN_DO: 'Can do', EXPERT: 'Expert', TRAINER: 'Trainer' })

/** The refusals of the skills routes (409 `refusal/<CODE>`; the web has the words of each code). */
export const SKILL_REFUSALS = [
  'CODE_TAKEN',
  'OPERATION_OTHER_COMPANY',
  'CLASS_INACTIVE',
  'SKILL_ARCHIVED',
  'SKILL_OTHER_COMPANY',
  'EMPLOYEE_LEFT',
  'SELF_DECISION',
  'SINCE_IN_FUTURE',
  'TRAINEE_OPEN',
  'SIGNED_OFF',
  'NOT_A_TRAINEE',
  'SIGN_OFF_BEFORE_START',
  'SIGN_OFF_IN_FUTURE',
  'TRAINER_IS_TRAINEE',
  'TRAINER_OTHER_COMPANY',
  'TRAINER_LEFT',
  'TRAINER_NOT_TRAINER',
  'LEVEL_REMOVED',
  'AUTHORISATION_OPEN',
  'AUTHORISATION_REVOKED',
] as const
export type SkillRefusal = (typeof SKILL_REFUSALS)[number]

const LOCALE = /^[a-z]{2,3}$/

/** Days compare as text (YYYY-MM-DD). */
const before = (a: BusinessDate, b: BusinessDate): boolean => a < b

// ---- skills -------------------------------------------------------------------------------------------------------------

export interface SkillDraft {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | undefined
  readonly kind?: SkillKind | undefined
  readonly operationId?: string | null | undefined
  readonly machineClassId?: string | null | undefined
  readonly sortOrder?: number | undefined
}

/** A skill's code (stored in capitals), name, words per language, what it is about and its place in the matrix. */
export function skillProblems(draft: SkillDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.code !== undefined) {
    const code = cleanSkillCode(draft.code)
    if (code.length === 0) problems.push({ path: 'code', message: 'Required.' })
    else if (code.length > SKILL_LIMITS.code) problems.push({ path: 'code', message: `At most ${SKILL_LIMITS.code} characters.` })
    else if (!SKILL_CODE.test(code)) problems.push({ path: 'code', message: 'Capitals, digits and . _ - only, no spaces.' })
  }
  if (draft.name !== undefined) {
    const name = draft.name.trim()
    if (name.length === 0) problems.push({ path: 'name', message: 'Required.' })
    else if (name.length > SKILL_LIMITS.name) problems.push({ path: 'name', message: `At most ${SKILL_LIMITS.name} characters.` })
  }
  for (const [locale, words] of Object.entries(draft.nameI18n ?? {})) {
    if (!LOCALE.test(locale)) problems.push({ path: `nameI18n/${locale}`, message: 'A language code of two or three small letters.' })
    else if (words.trim().length === 0 || words.trim().length > SKILL_LIMITS.name) problems.push({ path: `nameI18n/${locale}`, message: `From 1 to ${SKILL_LIMITS.name} characters.` })
  }
  if (draft.kind !== undefined) {
    const operation = draft.operationId ?? null
    const machineClass = draft.machineClassId ?? null
    if (draft.kind === 'OPERATION' && operation === null) problems.push({ path: 'operationId', message: 'An operation skill names the operation of the library it is about.' })
    if (draft.kind !== 'OPERATION' && operation !== null) problems.push({ path: 'operationId', message: 'Only an operation skill names an operation.' })
    if (draft.kind === 'MACHINE' && machineClass === null) problems.push({ path: 'machineClassId', message: 'A machine skill names the class of machine it is about.' })
    if (draft.kind !== 'MACHINE' && machineClass !== null) problems.push({ path: 'machineClassId', message: 'Only a machine skill names a class of machine.' })
  }
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < SKILL_LIMITS.sortOrder.min || draft.sortOrder > SKILL_LIMITS.sortOrder.max)) {
    problems.push({ path: 'sortOrder', message: `A whole number from ${SKILL_LIMITS.sortOrder.min} to ${SKILL_LIMITS.sortOrder.max}.` })
  }
  return problems
}

// ---- levels and trainees ------------------------------------------------------------------------------------------------

/** A level as the rules read it (days as YYYY-MM-DD). */
export interface LevelFacts {
  readonly level: SkillLevel
  readonly since: BusinessDate
  readonly traineeUntil: BusinessDate | null
  readonly signedOffOn: BusinessDate | null
}

export const TRAINEE_STATES = ['NONE', 'TRAINEE', 'OVERDUE', 'SIGNED_OFF'] as const
export type TraineeState = (typeof TRAINEE_STATES)[number]

/**
 * The trainee state of a level (MES-244: trainee status until signed off). TRAINEE: a trainee period and no sign-off;
 * OVERDUE: the same, past its planned end (the tile "Trainees not signed off" counts both); SIGNED_OFF: no longer a
 * trainee; NONE: never was.
 */
export function traineeStateOf(row: Pick<LevelFacts, 'traineeUntil' | 'signedOffOn'>, today: BusinessDate): TraineeState {
  if (row.traineeUntil === null) return 'NONE'
  if (row.signedOffOn !== null) return 'SIGNED_OFF'
  return before(row.traineeUntil, today) ? 'OVERDUE' : 'TRAINEE'
}

/** A trainee now: a trainee period not signed off. */
export const isTrainee = (row: Pick<LevelFacts, 'traineeUntil' | 'signedOffOn'>): boolean => row.traineeUntil !== null && row.signedOffOn === null

/**
 * Was the person a trainee on this skill on that day (for efficiency and pay, B-W2b-43/-44): from the level's start, with
 * a trainee period, and not yet signed off on that day (the sign-off day is the first day of normal rules).
 */
export function traineeOn(row: Pick<LevelFacts, 'since' | 'traineeUntil' | 'signedOffOn'>, day: BusinessDate): boolean {
  if (row.traineeUntil === null || before(day, row.since)) return false
  return row.signedOffOn === null || before(day, row.signedOffOn)
}

export interface LevelRequest {
  readonly level: SkillLevel
  /** The day held from (default today); never later than today. */
  readonly since?: BusinessDate | undefined
  /** A trainee until this day; null: none; undefined: as it is. */
  readonly traineeUntil?: BusinessDate | null | undefined
}

export type LevelPlan =
  | { readonly kind: 'INSERT'; readonly level: SkillLevel; readonly since: BusinessDate; readonly traineeUntil: BusinessDate | null }
  | {
      readonly kind: 'UPDATE'
      /** The fields that change (only those). `assessed` when the level changes: who and when are set again (MES-281). */
      readonly changes: { readonly level?: SkillLevel; readonly since?: BusinessDate; readonly traineeUntil?: BusinessDate | null }
      readonly assessed: boolean
    }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'REFUSED'; readonly refusal: SkillRefusal; readonly field: string; readonly message: string }

/**
 * What setting a level does to the level in force (null: none yet). A changed level is assessed again (who and when: the
 * person setting it); the day held from moves with it (default today), except on a level with a trainee period, which
 * keeps the training's first day unless another is given. A trainee period is given, moved or kept until
 * the trainee is signed off; clearing an open one is refused (sign the trainee off instead); after the sign-off it no
 * longer moves.
 */
export function levelPlan(current: LevelFacts | null, request: LevelRequest, today: BusinessDate): LevelPlan {
  if (request.since !== undefined && (!isBusinessDate(request.since) || before(today, request.since))) {
    return { kind: 'REFUSED', refusal: 'SINCE_IN_FUTURE', field: 'since', message: 'A level is held from today or an earlier day.' }
  }
  if (current === null) {
    const since = request.since ?? today
    const traineeUntil = request.traineeUntil ?? null
    if (traineeUntil !== null && before(traineeUntil, since)) return { kind: 'REFUSED', refusal: 'TRAINEE_OPEN', field: 'traineeUntil', message: 'The trainee period ends on or after the day the level is held from.' }
    return { kind: 'INSERT', level: request.level, since, traineeUntil }
  }
  const changes: { level?: SkillLevel; since?: BusinessDate; traineeUntil?: BusinessDate | null } = {}
  const assessed = request.level !== current.level
  if (assessed) {
    changes.level = request.level
    // A level with a trainee period keeps its start (the training's first day; the sign-off is on or after it).
    const since = request.since ?? (current.traineeUntil === null ? today : current.since)
    if (since !== current.since) changes.since = since
  } else if (request.since !== undefined && request.since !== current.since) {
    changes.since = request.since
  }
  if (request.traineeUntil !== undefined && request.traineeUntil !== current.traineeUntil) {
    if (current.signedOffOn !== null) return { kind: 'REFUSED', refusal: 'SIGNED_OFF', field: 'traineeUntil', message: `The trainee was signed off on ${current.signedOffOn}: the trainee period no longer changes.` }
    if (request.traineeUntil === null) return { kind: 'REFUSED', refusal: 'TRAINEE_OPEN', field: 'traineeUntil', message: 'A trainee stays a trainee until a person signs them off: sign the trainee off instead.' }
    changes.traineeUntil = request.traineeUntil
  }
  const since = changes.since ?? current.since
  const traineeUntil = changes.traineeUntil === undefined ? current.traineeUntil : changes.traineeUntil
  if (traineeUntil !== null && before(traineeUntil, since)) return { kind: 'REFUSED', refusal: 'TRAINEE_OPEN', field: 'traineeUntil', message: 'The trainee period ends on or after the day the level is held from.' }
  if (current.signedOffOn !== null && changes.since !== undefined && before(current.signedOffOn, changes.since)) {
    return { kind: 'REFUSED', refusal: 'SIGNED_OFF', field: 'since', message: `The trainee was signed off on ${current.signedOffOn}: the level is held from that day or earlier.` }
  }
  return Object.keys(changes).length === 0 ? { kind: 'NONE' } : { kind: 'UPDATE', changes, assessed }
}

/** Why a trainee cannot be signed off now (null: they can). */
export function signOffRefusal(row: LevelFacts, signedOffOn: BusinessDate, today: BusinessDate): { readonly refusal: SkillRefusal; readonly field: string; readonly message: string } | null {
  if (row.traineeUntil === null) return { refusal: 'NOT_A_TRAINEE', field: 'levelId', message: 'This level has no trainee period: there is nobody to sign off.' }
  if (row.signedOffOn !== null) return { refusal: 'SIGNED_OFF', field: 'levelId', message: `The trainee was signed off on ${row.signedOffOn} already.` }
  if (before(signedOffOn, row.since)) return { refusal: 'SIGN_OFF_BEFORE_START', field: 'signedOffOn', message: `The level is held from ${row.since}: the sign-off is on that day or later.` }
  if (before(today, signedOffOn)) return { refusal: 'SIGN_OFF_IN_FUTURE', field: 'signedOffOn', message: 'A trainee is signed off today or on an earlier day, never ahead.' }
  return null
}

/** The trainer named on a sign-off, as the rules read them. */
export interface TrainerFacts {
  readonly employeeId: string
  readonly companyId: string
  readonly active: boolean
  /** Their level in force in the same skill (null: none), and whether they are still a trainee in it. */
  readonly level: SkillLevel | null
  readonly trainee: boolean
}

/** A trainer is another active person of the trainee's company who holds the skill at Trainer level (not as a trainee). */
export function trainerRefusal(trainer: TrainerFacts, trainee: { readonly employeeId: string; readonly companyId: string }): { readonly refusal: SkillRefusal; readonly message: string } | null {
  if (trainer.employeeId === trainee.employeeId) return { refusal: 'TRAINER_IS_TRAINEE', message: 'The trainer is another person than the trainee.' }
  if (trainer.companyId !== trainee.companyId) return { refusal: 'TRAINER_OTHER_COMPANY', message: "The trainer works for the trainee's company." }
  if (!trainer.active) return { refusal: 'TRAINER_LEFT', message: 'The trainer has left.' }
  if (trainer.level !== 'TRAINER' || trainer.trainee) return { refusal: 'TRAINER_NOT_TRAINER', message: 'The trainer holds this skill at Trainer level (signed off).' }
  return null
}

// ---- machine authorisations ---------------------------------------------------------------------------------------------

export interface AuthorisationFacts {
  readonly authorisedOn: BusinessDate
  readonly validUntil: BusinessDate | null
  readonly revoked: boolean
}

export const AUTHORISATION_STATES = ['AUTHORISED', 'NOT_YET', 'EXPIRED', 'REVOKED'] as const
export type AuthorisationState = (typeof AUTHORISATION_STATES)[number]

/** An authorisation today: in force (AUTHORISED), starting later (NOT_YET), ended (EXPIRED: past its last day) or REVOKED. */
export function authorisationStateOf(row: AuthorisationFacts, today: BusinessDate): AuthorisationState {
  if (row.revoked) return 'REVOKED'
  if (before(today, row.authorisedOn)) return 'NOT_YET'
  if (row.validUntil !== null && before(row.validUntil, today)) return 'EXPIRED'
  return 'AUTHORISED'
}

/** An authorisation's days: it ends on or after it starts. */
export function authorisationProblems(draft: { readonly authorisedOn: BusinessDate; readonly validUntil: BusinessDate | null }): Issue[] {
  return draft.validUntil !== null && before(draft.validUntil, draft.authorisedOn) ? [{ path: 'validUntil', message: `The authorisation ends on or after it starts (${draft.authorisedOn}).` }] : []
}

/** An authorisation ending within `days` (the tile "Authorisations ending"): in force, with a last day from today to today + days. */
export function endsWithin(row: AuthorisationFacts, today: BusinessDate, untilDay: BusinessDate): boolean {
  return authorisationStateOf(row, today) === 'AUTHORISED' && row.validUntil !== null && !before(untilDay, row.validUntil)
}
