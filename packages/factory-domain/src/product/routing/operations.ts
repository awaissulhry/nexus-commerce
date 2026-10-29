import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { LOCALES } from '../../email/rules'
import { defineMachine } from '../../state/machine'
import type { LocalisedNames } from '../materials/rules'
import { decimalOf, decimalText, roundTo, type Rounding } from '../units/units'

/**
 * The operation library's rules (plan A1 §2.4 B; features PRD-109, PRD-111), pure. An operation (factory-db `Operation`)
 * is one thing done to a garment: its code, its name per language (the floor languages included), the KIND of work
 * centre it runs at (the department: a work order maps it to a work centre of that kind on its site), the machine and
 * skill it needs, how it is done, and its standard minutes per garment (SMV). A routing step copies it (./rules), so a
 * later change here leaves every routing as it is; the routing screens show where a routing's minutes differ.
 *
 * Standard minutes are kept to MINUTES_SCALE (3) decimals, Decimal(10,3): a typed value with more decimals is rounded
 * half up to 3, once, here (`minutesOf`), and must stay above 0. A used operation is archived, never deleted (no role
 * holds a DELETE grant on it); its code is copied into every step made from it, so it changes only while no routing
 * uses it.
 */

/** The kinds of work centre (factory-db enum WorkCentreKind): the departments of a routing, in floor order. */
export const WORK_CENTRE_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const
export type WorkCentreKind = (typeof WORK_CENTRE_KINDS)[number]

export const OPERATION_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type OperationStatus = (typeof OPERATION_STATUSES)[number]

/** Archive (no new routing step names it) and reactivate. */
export const operationMachine = defineMachine({ name: 'operation', states: OPERATION_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] } })

/** Like a material code: what the traveller and the floor screen print. */
export const OPERATION_CODE = /^[A-Z0-9](?:[A-Z0-9._/-]{0,38}[A-Z0-9])?$/
export const OPERATION_CODE_RULE = '1 to 40 capital letters or digits, with . _ - / inside'
export const normaliseOperationCode = (value: string): string => value.trim().toUpperCase()

/** Standard minutes: Decimal(10,3) in the schema. */
export const MINUTES_PRECISION = 10
export const MINUTES_SCALE = 3
/** A typed value may carry up to this many decimals; it is rounded to MINUTES_SCALE. */
export const MINUTES_INPUT_SCALE = 6

const PLAIN = /^\d+(?:\.\d+)?$/

export type MinutesOutcome = { readonly ok: true; readonly minutes: string } | { readonly ok: false; readonly message: string }

/**
 * Typed standard minutes as stored: rounded to 3 decimals (half up unless the caller says otherwise), above 0, at most
 * 7 digits before the point. "4.2" stays "4.2"; "0.16667" becomes "0.167"; "0.0004" rounds to 0 and is refused.
 */
export function minutesOf(value: string, rounding: Rounding = 'HALF_UP'): MinutesOutcome {
  if (!PLAIN.test(value) || !fitsDecimal(value, MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, MINUTES_INPUT_SCALE)) {
    return { ok: false, message: `Expected minutes above 0 with at most ${MINUTES_PRECISION - MINUTES_SCALE} digits and ${MINUTES_INPUT_SCALE} decimals.` }
  }
  const rounded = roundTo(value, { scale: MINUTES_SCALE, rounding })
  if (rounded.lte(0)) return { ok: false, message: `Standard minutes are above 0 (at ${MINUTES_SCALE} decimals).` }
  const text = decimalText(rounded)
  if (!fitsDecimal(text, MINUTES_PRECISION, MINUTES_SCALE)) return { ok: false, message: `At most ${MINUTES_PRECISION - MINUTES_SCALE} digits before the point.` }
  return { ok: true, minutes: text }
}

/** Two minute values are the same number ("4.200" is "4.2"). */
export const sameMinutes = (a: string, b: string): boolean => decimalOf(a, 'standardMinutes').eq(decimalOf(b, 'standardMinutes'))

/** What a library operation holds but its company, status and bookkeeping: what the rules look at. */
export interface OperationFields {
  readonly code: string
  readonly name: string
  /** The name per locale (it, en): the floor screen shows the worker's language. */
  readonly nameI18n: LocalisedNames | null
  readonly workCentreKind: WorkCentreKind
  /** Flat-bed, post-bed, twin-needle, skiving, press, laser … */
  readonly machineType: string | null
  readonly skill: string | null
  /** Standard minutes per garment, as stored (3 decimals at most). */
  readonly standardMinutes: string
  /** How it is done, for the traveller and the floor screen. */
  readonly instructions: string | null
}

export type OperationField = keyof OperationFields
export const OPERATION_FIELDS: readonly OperationField[] = Object.freeze(['code', 'name', 'nameI18n', 'workCentreKind', 'machineType', 'skill', 'standardMinutes', 'instructions'])

export const MAX_INSTRUCTIONS = 4000

function textProblem(value: string | null, max: number): string | null {
  if (value === null) return null
  if (value.trim() !== value || value === '') return 'Expected text without leading or trailing spaces.'
  return value.length > max ? `At most ${max} characters.` : null
}

export function namesProblems(names: LocalisedNames | null, at = 'nameI18n'): Issue[] {
  const issues: Issue[] = []
  for (const [locale, name] of Object.entries(names ?? {})) {
    if (!(LOCALES as readonly string[]).includes(locale)) issues.push({ path: `${at}/${locale}`, message: `Names are kept in ${LOCALES.join(' and ')}.` })
    else if (name !== undefined) {
      const problem = textProblem(name, 200)
      if (problem) issues.push({ path: `${at}/${locale}`, message: problem })
    }
  }
  return issues
}

/** Every rule an operation breaks, with the field each one is about. */
export function operationProblems(operation: OperationFields): Issue[] {
  const issues: Issue[] = []
  const add = (path: string, message: string | null) => {
    if (message) issues.push({ path, message })
  }
  if (!OPERATION_CODE.test(operation.code)) add('code', `Expected ${OPERATION_CODE_RULE}.`)
  add('name', operation.name.trim() === '' ? 'Name the operation.' : textProblem(operation.name, 200))
  issues.push(...namesProblems(operation.nameI18n))
  if (!(WORK_CENTRE_KINDS as readonly string[]).includes(operation.workCentreKind)) add('workCentreKind', `Expected one of ${WORK_CENTRE_KINDS.join(', ')}.`)
  add('machineType', textProblem(operation.machineType, 60))
  add('skill', textProblem(operation.skill, 60))
  add('instructions', textProblem(operation.instructions, MAX_INSTRUCTIONS))
  const minutes = minutesOf(operation.standardMinutes)
  if (!minutes.ok) add('standardMinutes', minutes.message)
  return issues
}

export type OperationInput = Pick<OperationFields, 'code' | 'name' | 'workCentreKind' | 'standardMinutes'> & {
  readonly nameI18n?: LocalisedNames | null | undefined
  readonly machineType?: string | null | undefined
  readonly skill?: string | null | undefined
  readonly instructions?: string | null | undefined
}

export type OperationOutcome = { readonly ok: true; readonly operation: OperationFields } | { readonly ok: false; readonly issues: readonly Issue[] }

function checked(operation: OperationFields): OperationOutcome {
  const issues = operationProblems(operation)
  if (issues.length > 0) return { ok: false, issues }
  const minutes = minutesOf(operation.standardMinutes)
  return { ok: true, operation: { ...operation, standardMinutes: minutes.ok ? minutes.minutes : operation.standardMinutes } }
}

/** A new library operation: the code in capitals, the minutes rounded to 3 decimals, every rule checked. */
export function newOperation(input: OperationInput): OperationOutcome {
  return checked({
    code: normaliseOperationCode(input.code),
    name: input.name.trim(),
    nameI18n: input.nameI18n ?? null,
    workCentreKind: input.workCentreKind,
    machineType: input.machineType ?? null,
    skill: input.skill ?? null,
    standardMinutes: input.standardMinutes,
    instructions: input.instructions ?? null,
  })
}

export type OperationPatch = { readonly [Field in OperationField]?: OperationFields[Field] | undefined }

export type OperationChange =
  | { readonly ok: true; readonly operation: OperationFields; readonly changed: readonly OperationField[] }
  | { readonly ok: false; readonly issues: readonly Issue[] }

const same = (field: OperationField, a: OperationFields, b: OperationFields): boolean =>
  field === 'standardMinutes' ? sameMinutes(a.standardMinutes, b.standardMinutes) : JSON.stringify(a[field]) === JSON.stringify(b[field])

/**
 * A change to an operation: the fields sent (null clears an optional one), every rule checked on the result, and the
 * fields that really changed. `usedInRoutings`: its code is copied into routing steps, so it no longer changes.
 */
export function changeOperation(current: OperationFields, patch: OperationPatch, usedInRoutings: boolean): OperationChange {
  const merged: OperationFields = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    ...(patch.code === undefined ? {} : { code: normaliseOperationCode(patch.code) }),
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
  }
  const outcome = checked(merged)
  if (!outcome.ok) return outcome
  const changed = OPERATION_FIELDS.filter((field) => !same(field, current, outcome.operation))
  if (changed.includes('code') && usedInRoutings) {
    return { ok: false, issues: [{ path: 'code', message: `Routings copied the code ${current.code}: it no longer changes. Make a new operation instead.` }] }
  }
  return { ok: true, operation: outcome.operation, changed }
}

/** Why a step cannot be made from this operation now, or null: an archived operation is in no new routing step. */
export function operationUseRefusal(operation: { readonly code: string; readonly status: OperationStatus }): string | null {
  return operation.status === 'ACTIVE' ? null : `Operation ${operation.code} is archived: reactivate it, or choose another.`
}
