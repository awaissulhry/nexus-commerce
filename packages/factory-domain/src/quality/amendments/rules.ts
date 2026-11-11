import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import type { Issue } from '../../core/errors'
import { isUuid } from '../../core/ids'
import { Dec } from '../../tax/decimal'
import { GARMENT_ZONES, isGarmentZone } from '../defects/rules'
import { decimalWords, measurementPass, type Band } from '../final/plan'
import type { CheckType } from '../plans/rules'

/**
 * Locked results with amendments (B-W2b-123; QHS-145; design quality.inspections ins-amend "Field, new value, reason
 * (required), preview from → to, second signature (another inspector or the quality manager)" and dec-amend "Rows: field,
 * from → to, reason, signed by, second signature by, time"), pure.
 *
 * A signed final inspection (PASSED, FAILED), a DECIDED incoming inspection and a DECIDED in-process check never change:
 * the database freezes the record and its results, measurements and defects. A correction is an InspectionAmendment
 * REQUEST (the field, the value before and after, the reason, signed by who asked), then ONE answer by another person:
 * SIGNED (it stands) or REFUSED (with the reason). What is correct now is the record with its SIGNED corrections applied,
 * oldest first (`currentValue`).
 *
 * What a correction may change (FIELD_RULES): how a fact was written, never a verdict.
 *
 *   record          its note (every kind); a W1 checklist line's note (`checklist.<CODE>.note`, a final inspection with
 *                   no plan)
 *   result          a plan check's recorded value (by the check's type: a decimal, a whole number, one of the choices,
 *                   words) and its note
 *   measurement     the measured value
 *   defect          a final inspection's defect line: its zone on the garment, its description, its note, its cause
 *   hide            an incoming hide's note
 *
 * A correction that would change whether a line passes is refused (`refusal/VERDICT`): a measured value or a measurement
 * check's value whose new number falls on the other side of nominal ± tolerance. Outcomes, defect classes and
 * quantities, sample and lot sizes, hide grades and decisions are verdicts: a wrong verdict is a release reversal and a
 * new inspection, never an amendment (W1's rule "a new release needs a new inspection").
 */

export interface Words {
  readonly it: string
  readonly en: string
}
const w = (it: string, en: string): Words => Object.freeze({ it, en })

/** The records a correction is of (InspectionAmendment names exactly one). */
export const AMENDED_RECORDS = ['Inspection', 'IncomingInspection', 'InProcessCheck'] as const
export type AmendedRecord = (typeof AMENDED_RECORDS)[number]

/** The rows of a record a correction may be on (InspectionAmendment.recordType); none: the record itself. */
export const AMENDED_ROWS = ['InspectionCheckResult', 'InspectionMeasurement', 'InspectionDefect', 'IncomingHideResult'] as const
export type AmendedRow = (typeof AMENDED_ROWS)[number]

export const AMENDMENT_KINDS = ['REQUEST', 'SIGNED', 'REFUSED'] as const
export type AmendmentKind = (typeof AMENDMENT_KINDS)[number]

/** Where a request stands: waiting for the second signature, signed (it stands), refused. */
export const AMENDMENT_STATES = ['WAITING', 'SIGNED', 'REFUSED'] as const
export type AmendmentState = (typeof AMENDMENT_STATES)[number]

/** The states of each record kind in which it is signed (the database's rule for an amendment). */
export const SIGNED_STATES: Readonly<Record<AmendedRecord, readonly string[]>> = Object.freeze({
  Inspection: ['PASSED', 'FAILED'],
  IncomingInspection: ['DECIDED'],
  InProcessCheck: ['DECIDED'],
})

export const AMEND_LIMITS = Object.freeze({ note: 500, text: 200, reason: 500, reasonMin: 3, list: 200 })

export const RECORD_WORDS: Readonly<Record<AmendedRecord, Words>> = Object.freeze({
  Inspection: w('Ispezione finale', 'Final inspection'),
  IncomingInspection: w('Ispezione in accettazione', 'Incoming inspection'),
  InProcessCheck: w('Controllo in linea', 'In-process check'),
})

export const STATE_WORDS: Readonly<Record<AmendmentState, Words>> = Object.freeze({
  WAITING: w('In attesa della seconda firma', 'Waiting for the second signature'),
  SIGNED: w('Firmata', 'Signed'),
  REFUSED: w('Rifiutata', 'Refused'),
})

/** What a field holds: words (null clears them), a check's value by its type, a decimal, a garment zone, a cause code id. */
export type FieldKind = 'note' | 'text' | 'value' | 'decimal' | 'zone' | 'cause'

export interface FieldRule {
  readonly field: string
  /** The row it is on; null: the record itself. */
  readonly row: AmendedRow | null
  readonly records: readonly AmendedRecord[]
  readonly kind: FieldKind
  /** It may be cleared (after null). */
  readonly nullable: boolean
  readonly words: Words
}

const rule = (spec: FieldRule): FieldRule => Object.freeze({ ...spec, records: Object.freeze([...spec.records]) })

/** Every correction a signed record takes (see the file's comment). A W1 checklist line's note is `checklist.<CODE>.note`. */
export const FIELD_RULES: readonly FieldRule[] = Object.freeze([
  rule({ field: 'note', row: null, records: AMENDED_RECORDS, kind: 'note', nullable: true, words: w('Nota', 'Note') }),
  rule({ field: 'value', row: 'InspectionCheckResult', records: AMENDED_RECORDS, kind: 'value', nullable: false, words: w('Valore registrato', 'Recorded value') }),
  rule({ field: 'note', row: 'InspectionCheckResult', records: AMENDED_RECORDS, kind: 'note', nullable: true, words: w('Nota del controllo', 'Check note') }),
  rule({ field: 'measured', row: 'InspectionMeasurement', records: AMENDED_RECORDS, kind: 'decimal', nullable: false, words: w('Valore misurato', 'Measured value') }),
  rule({ field: 'zone', row: 'InspectionDefect', records: ['Inspection'], kind: 'zone', nullable: true, words: w('Zona del capo', 'Garment zone') }),
  rule({ field: 'description', row: 'InspectionDefect', records: ['Inspection'], kind: 'text', nullable: true, words: w('Descrizione del difetto', 'Defect description') }),
  rule({ field: 'note', row: 'InspectionDefect', records: ['Inspection'], kind: 'note', nullable: true, words: w('Nota del difetto', 'Defect note') }),
  rule({ field: 'causeCodeId', row: 'InspectionDefect', records: ['Inspection'], kind: 'cause', nullable: true, words: w('Causa', 'Cause') }),
  rule({ field: 'note', row: 'IncomingHideResult', records: ['IncomingInspection'], kind: 'note', nullable: true, words: w('Nota della pelle', 'Hide note') }),
])

const CHECKLIST_FIELD = /^checklist\.([A-Z0-9][A-Z0-9_]{0,39})\.note$/
const CHECKLIST_RULE = rule({ field: 'checklist.<CODE>.note', row: null, records: ['Inspection'], kind: 'note', nullable: true, words: w('Nota della lista di controllo', 'Checklist note') })

/** The checklist code of a `checklist.<CODE>.note` field, or null. */
export const checklistCodeOf = (field: string): string | null => CHECKLIST_FIELD.exec(field)?.[1] ?? null

/** The rule of a field on a record (and row), or null when it is not one a correction takes. */
export function fieldRuleOf(record: AmendedRecord, field: string, row: AmendedRow | null): FieldRule | null {
  if (row === null && checklistCodeOf(field) !== null) return record === 'Inspection' ? CHECKLIST_RULE : null
  return FIELD_RULES.find((entry) => entry.field === field && entry.row === row && entry.records.includes(record)) ?? null
}

/** The fields a correction of this record and row may take (the dialog's Field list). */
export const fieldsOf = (record: AmendedRecord, row: AmendedRow | null): FieldRule[] => FIELD_RULES.filter((entry) => entry.row === row && entry.records.includes(record))

/** A field in words, in the language asked ("Measured value", "Checklist note CE_MARK"). */
export function fieldWords(record: AmendedRecord, field: string, row: AmendedRow | null, language: 'it' | 'en'): string {
  const code = row === null ? checklistCodeOf(field) : null
  const found = fieldRuleOf(record, field, row)
  if (!found) return field
  return code ? `${found.words[language]} ${code}` : found.words[language]
}

// ---- values ---------------------------------------------------------------------------------------------------------------

/** A value of a field: words, a decimal or a whole number as text, a zone or cause id; null: cleared / none. */
export type AmendValue = string | null

/** A value as the record shows it, normalised the way a correction stores it (text trimmed, empty = none). */
export function normalValue(kind: FieldKind, value: unknown): AmendValue {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  if (kind === 'decimal') return isDecimal(text) ? new Dec(text).toFixed(3) : text
  return text
}

const DECIMAL = /^-?\d{1,9}(\.\d{1,3})?$/
const WHOLE = /^\d{1,9}$/
const isDecimal = (text: string): boolean => DECIMAL.test(text)

/** What the checks of a value need to know of the row it is on. */
export interface RowFacts {
  /** A result: its check's type, nominal ± tolerance (a measurement check), choices, and the recorded outcome. */
  readonly check?: { readonly type: CheckType; readonly code: string; readonly nominal: string | null; readonly tolerance: string | null; readonly choices: readonly string[] }
  readonly outcome?: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'
  /** A measurement: its nominal ± tolerance and whether it passed (the database's `pass`). */
  readonly measurement?: { readonly pointCode: string; readonly nominal: string; readonly tolerance: string; readonly pass: boolean; /** B-W2b-283: a spec band under and over (the database's `pass` reads it). */ readonly band?: Band | null }
  /** A cause: the active cause codes by id (the API reads them). */
  readonly activeCauses?: ReadonlySet<string>
}

const issue = (path: string, message: string): Issue => ({ path, message })

/**
 * What is wrong with a correction (paths `body/after`, `body/reason`, `refusal/VERDICT`), in words: the value of the
 * field's kind, a change at all, and never a verdict. `before` is the value as it stands now (with the signed corrections).
 */
export function correctionProblems(input: { readonly rule: FieldRule; readonly facts: RowFacts; readonly before: AmendValue; readonly after: AmendValue; readonly reason: string }): Issue[] {
  const { rule: field, facts, before, after } = input
  const problems: Issue[] = []
  const reason = input.reason.trim()
  if (reason.length < AMEND_LIMITS.reasonMin) problems.push(issue('body/reason', `Say why, in at least ${AMEND_LIMITS.reasonMin} characters.`))
  else if (reason.length > AMEND_LIMITS.reason) problems.push(issue('body/reason', `At most ${AMEND_LIMITS.reason} characters.`))
  if (after === null && !field.nullable) problems.push(issue('body/after', 'Give the new value: this field cannot be left empty.'))
  if (after !== null) {
    const problem = valueProblem(field.kind, facts, after)
    if (problem) problems.push(issue('body/after', problem))
  }
  if (problems.some((entry) => entry.path === 'body/after')) return problems
  if (sameValue(field.kind, before, after)) problems.push(issue('body/after', 'This is the value it has now: nothing to correct.'))
  const verdict = verdictProblem(field, facts, after)
  if (verdict) problems.push(issue('refusal/VERDICT', verdict))
  return problems
}

const sameValue = (kind: FieldKind, a: AmendValue, b: AmendValue): boolean => {
  if (a === null || b === null) return a === b
  if (kind === 'decimal' && isDecimal(a) && isDecimal(b)) return new Dec(a).equals(new Dec(b))
  return a === b
}

/** Why a value does not fit the field (null: it does). */
function valueProblem(kind: FieldKind, facts: RowFacts, value: string): string | null {
  switch (kind) {
    case 'note':
      return value.length > AMEND_LIMITS.note ? `At most ${AMEND_LIMITS.note} characters.` : null
    case 'text':
      return value.length > AMEND_LIMITS.text ? `At most ${AMEND_LIMITS.text} characters.` : null
    case 'decimal':
      return isDecimal(value) ? null : 'A number with at most 3 decimals, like 58.4.'
    case 'zone':
      return isGarmentZone(value) ? null : `Not a zone of the garment map (${GARMENT_ZONES.slice(0, 4).map((zone) => zone.id).join(', ')} …).`
    case 'cause':
      if (!isUuid(value)) return 'Not a cause code.'
      return facts.activeCauses && !facts.activeCauses.has(value) ? 'Not an active cause code of the list.' : null
    case 'value':
      return checkValueProblem(facts, value)
  }
}

/** A check result's value by its check's type (the database's InspectionCheckResult rule). */
function checkValueProblem(facts: RowFacts, value: string): string | null {
  const check = facts.check
  if (!check) return 'Not a result of a plan check.'
  if (facts.outcome === 'NOT_APPLICABLE') return `${check.code} was recorded not applicable: it has no value to correct.`
  switch (check.type) {
    case 'MEASUREMENT':
      return isDecimal(value) ? null : 'A number with at most 3 decimals, like 58.4.'
    case 'COUNT':
      return WHOLE.test(value) ? null : 'A whole number from 0.'
    case 'CHOICE':
      return check.choices.includes(value) ? null : `One of the check's choices: ${check.choices.join(', ')}.`
    case 'FREE_TEXT':
      return value.length > AMEND_LIMITS.text ? `At most ${AMEND_LIMITS.text} characters.` : null
    default:
      return `${check.code} takes no value (${check.type.toLowerCase().replace('_', ' ')}): its outcome is a verdict, corrected by a new inspection.`
  }
}

/**
 * Why a correction would change a verdict (null: it does not): a measured value, or a measurement check's value, that
 * falls on the other side of nominal ± tolerance. SAFETY: an amendment never turns a FAIL into a PASS, nor a PASS into a
 * FAIL; that is a new inspection.
 */
export function verdictProblem(field: FieldRule, facts: RowFacts, after: AmendValue): string | null {
  if (after === null) return null
  if (field.kind === 'decimal' && facts.measurement && isDecimal(after)) {
    const { pointCode, nominal, tolerance, pass, band = null } = facts.measurement
    if (measurementPass(after, nominal, tolerance, band) !== pass) return crossing(pointCode, after, nominal, tolerance, pass, band)
  }
  if (field.kind === 'value' && facts.check?.type === 'MEASUREMENT' && facts.check.nominal !== null && facts.check.tolerance !== null && isDecimal(after) && facts.outcome) {
    const passed = facts.outcome === 'PASS'
    if (measurementPass(after, facts.check.nominal, facts.check.tolerance) !== passed) return crossing(facts.check.code, after, facts.check.nominal, facts.check.tolerance, passed)
  }
  return null
}

const crossing = (code: string, after: string, nominal: string, tolerance: string, passed: boolean, band: Band | null = null): string =>
  `${code} ${decimalWords(after)} is ${passed ? 'outside' : 'within'} ${band ? `${decimalWords(nominal)} −${decimalWords(band.minus)}/+${decimalWords(band.plus)}` : `${decimalWords(nominal)} ± ${decimalWords(tolerance)}`}: it would turn a ${passed ? 'pass into a fail' : 'fail into a pass'}. A signed result never changes its verdict: reverse the release and inspect again.`

// ---- what stands now ------------------------------------------------------------------------------------------------------

export interface AmendmentRow {
  readonly id: string
  readonly kind: AmendmentKind
  readonly requestId: string | null
  readonly field: string | null
  readonly recordType: string | null
  readonly recordId: string | null
  readonly before: unknown
  readonly after: unknown
  readonly reason: string | null
  readonly signedById: string
  readonly signedAt: Date
  readonly signatureSha256: string
}

export interface Correction {
  readonly request: AmendmentRow
  readonly answer: AmendmentRow | null
  readonly state: AmendmentState
}

/** The requests of a record with their answers, oldest first. */
export function correctionsOf(rows: readonly AmendmentRow[]): Correction[] {
  const answers = new Map(rows.filter((row) => row.kind !== 'REQUEST' && row.requestId).map((row) => [row.requestId!, row]))
  return rows
    .filter((row) => row.kind === 'REQUEST')
    .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime() || a.id.localeCompare(b.id))
    .map((request) => {
      const answer = answers.get(request.id) ?? null
      return { request, answer, state: answer === null ? 'WAITING' : answer.kind === 'SIGNED' ? 'SIGNED' : 'REFUSED' }
    })
}

/** The key of a field on a record (the field and the row it is on). */
export const targetKey = (field: string, row: { readonly type: string; readonly id: string } | null): string => (row ? `${row.type}:${row.id}:${field}` : `record:${field}`)

const keyOf = (request: AmendmentRow): string => targetKey(request.field ?? '', request.recordType && request.recordId ? { type: request.recordType, id: request.recordId } : null)

/** A stored value back as text (or null): the JSON of a REQUEST's `before` / `after`. */
export const storedValue = (value: unknown): AmendValue => (value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value))

/**
 * What stands now for each corrected field: the newest SIGNED correction's value, by target key (see targetKey). A field
 * no signed correction names keeps the record's own value.
 */
export function standing(corrections: readonly Correction[]): Map<string, { readonly value: AmendValue; readonly requestId: string; readonly order: number }> {
  const out = new Map<string, { value: AmendValue; requestId: string; order: number }>()
  let order = 0
  const signed = corrections.filter((entry) => entry.state === 'SIGNED').sort((a, b) => a.answer!.signedAt.getTime() - b.answer!.signedAt.getTime() || a.answer!.id.localeCompare(b.answer!.id))
  for (const entry of signed) out.set(keyOf(entry.request), { value: storedValue(entry.request.after), requestId: entry.request.id, order: ++order })
  return out
}

/** The value of a field now: its newest signed correction, else the record's own. */
export const currentValue = (own: AmendValue, now: ReturnType<typeof standing>, key: string): AmendValue => (now.has(key) ? now.get(key)!.value : own)

/** A request still waiting on the same field (one at a time: a second is refused until it is answered). */
export const waitingOn = (corrections: readonly Correction[], key: string): Correction | null => corrections.find((entry) => entry.state === 'WAITING' && keyOf(entry.request) === key) ?? null

// ---- the signatures -------------------------------------------------------------------------------------------------------

export interface RequestStatement {
  readonly recordType: AmendedRecord
  readonly recordId: string
  readonly recordSignature: string | null
  readonly field: string
  readonly row: { readonly type: AmendedRow; readonly id: string } | null
  readonly before: AmendValue
  readonly after: AmendValue
  readonly reason: string
  readonly signedById: string
  readonly at: string
}

export interface AnswerStatement {
  readonly requestId: string
  readonly requestSignature: string
  readonly answer: 'SIGNED' | 'REFUSED'
  readonly reason: string | null
  readonly signedById: string
  readonly at: string
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** What who asks signs (canonical JSON): the record and its own signature, the field, before → after, the reason. */
export const requestSha256 = (statement: RequestStatement): string => sha256(canonicalJson({ signs: 'amendment request', ...statement }))
/** What the second person signs: the request (by its signature) and the answer. */
export const answerSha256 = (statement: AnswerStatement): string => sha256(canonicalJson({ signs: 'amendment answer', ...statement }))

// ---- words ----------------------------------------------------------------------------------------------------------------

/** A value in words for a list or the report: "(empty)" for none, a decimal without trailing zeros, a zone by name. */
export function valueWords(kind: FieldKind, value: AmendValue, language: 'it' | 'en', causes?: ReadonlyMap<string, string>): string {
  if (value === null) return language === 'it' ? '(vuoto)' : '(empty)'
  if (kind === 'decimal' && isDecimal(value)) return decimalWords(value)
  if (kind === 'zone') return GARMENT_ZONES.find((zone) => zone.id === value)?.[language] ?? value
  if (kind === 'cause') return causes?.get(value) ?? value
  return value
}

/** "Waiting for the second signature: a person other than who asked signs it (a fresh code)." */
export function waitingWords(language: 'it' | 'en'): string {
  return language === 'it'
    ? 'In attesa della seconda firma: la firma una persona diversa da chi l\'ha chiesta (con un codice nuovo).'
    : 'Waiting for the second signature: a person other than who asked signs it (with a fresh code).'
}

/** "Signed results cannot be edited; a correction is an amendment with a second signature." (design ins-sign) */
export const LOCKED_WORDS: Words = w(
  'I risultati firmati non si modificano: una correzione è un emendamento con una seconda firma.',
  'Signed results cannot be edited; a correction is an amendment with a second signature.',
)
