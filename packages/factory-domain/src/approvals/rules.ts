import { createHash } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { canonicalJson } from '../accounting/manifest'
import type { Grain } from '../auth/grains/grains'

/**
 * One approval engine (B-W2b-282; PLT-042, PLT-086, PLT-091, PLT-093, PLT-104, PLT-105; design home.approvals with its
 * popups review, sign and reject, admin.automation "Approval rules" with its popup rule). Pure: the kinds, the RuleBuilder's
 * condition checked and evaluated against the facts a kind exposes, which rules ask and in what order, the fingerprint of
 * the change as it will be written, who may never decide a request (the person who asked it, whoever wrote it, the office
 * account of the floor worker who asked: Owner answer 11-10, Q3 = A, the Owner included), and every refusal in words.
 * apps/factory-api's platform/approvals runs it inside command(); the database (…_approvals_w2b_guards) is the last word.
 *
 *   ask       the active rules of the kind in force for the subject's company are read in order (sequence, then the oldest);
 *             every rule whose condition matches the subject's facts asked (ruleIds), the FIRST names the approver (a role
 *             or a person), the meaning of the signature, the step-up and the hours to decide. No rule: no approval (as
 *             today). A named approver who is the person asking is skipped for the next rule that names someone else.
 *   decide    once: a yes (an optional comment; the step-up where the request asks one) or a no (a reason code of the
 *             APPROVAL_REJECT list and words), never by the person who asked; the yes re-reads the subject first: a
 *             fingerprint that differs makes the request STALE ("it changed since you looked"), never approved.
 */

export const APPROVAL_TASK_KINDS = [
  'PURCHASE_ORDER',
  'PURCHASE_ORDER_CHANGE',
  'SALES_ORDER',
  'SALES_ORDER_CHANGE',
  'PRICE_CHANGE',
  'STOCK_ADJUSTMENT',
  'COUNT_VARIANCE',
  'MATERIAL_SUBSTITUTION',
  'CREDIT_OVERRIDE',
  'CREDIT_WITHOUT_RETURN',
  'SUPPLIER_BANK_CHANGE',
  'PURCHASE_REQUEST',
  // B-W2b-377 (B-W2b-363's database values): a purchase order sent without a valid document; a receipt line beyond its tolerance.
  'PURCHASE_ORDER_COMPLIANCE',
  'RECEIPT_OVER_TOLERANCE',
  // B-W2b-420 (B-W2b-378's database value): a cost sheet version, approved and locked before prices are released from it.
  'COST_SHEET',
] as const
export type ApprovalTaskKind = (typeof APPROVAL_TASK_KINDS)[number]
export const isApprovalTaskKind = (value: unknown): value is ApprovalTaskKind => typeof value === 'string' && (APPROVAL_TASK_KINDS as readonly string[]).includes(value)

/**
 * B-W2b-377: every kind in words (it, en), so a kind no step registered yet is never said in English to an Italian reader
 * (B-W2b-361's gap: the API's fallback was the code). A kind's file keeps its own label; this is the fallback.
 */
export const APPROVAL_KIND_WORDS: Readonly<Record<ApprovalTaskKind, Words>> = Object.freeze({
  PURCHASE_ORDER: { en: 'Purchase order', it: "Ordine d'acquisto" },
  PURCHASE_ORDER_CHANGE: { en: 'Purchase order change', it: "Modifica di un ordine d'acquisto" },
  SALES_ORDER: { en: 'Sales order', it: 'Ordine di vendita' },
  SALES_ORDER_CHANGE: { en: 'Sales order change', it: 'Modifica di un ordine di vendita' },
  PRICE_CHANGE: { en: 'Price change', it: 'Modifica di prezzo' },
  STOCK_ADJUSTMENT: { en: 'Stock adjustment', it: 'Rettifica di magazzino' },
  COUNT_VARIANCE: { en: 'Count difference', it: 'Differenza di inventario' },
  MATERIAL_SUBSTITUTION: { en: 'Material substitution', it: 'Sostituzione di materiale' },
  CREDIT_OVERRIDE: { en: 'Credit override', it: 'Sblocco del fido' },
  CREDIT_WITHOUT_RETURN: { en: 'Credit without a return', it: 'Accredito senza reso' },
  SUPPLIER_BANK_CHANGE: { en: "Supplier's bank details change", it: 'Modifica delle coordinate bancarie di un fornitore' },
  PURCHASE_REQUEST: { en: 'Purchase request', it: "Richiesta d'acquisto" },
  PURCHASE_ORDER_COMPLIANCE: { en: 'Send without a valid document', it: 'Invio senza un documento valido' },
  RECEIPT_OVER_TOLERANCE: { en: 'Receipt beyond its tolerance', it: 'Ricevimento oltre la tolleranza' },
  COST_SHEET: { en: 'Cost sheet', it: 'Scheda costo' },
})

/** What a signature means (PLT-105). */
export const APPROVAL_MEANINGS = ['REVIEWED', 'APPROVED', 'RELEASED', 'VERIFIED'] as const
export type ApprovalMeaning = (typeof APPROVAL_MEANINGS)[number]

export const APPROVAL_TASK_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE'] as const
export type ApprovalTaskStatus = (typeof APPROVAL_TASK_STATUSES)[number]

export const APPROVAL_EVENT_ACTIONS = ['REQUESTED', 'COMMENTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'STALE', 'SIGNED'] as const
export type ApprovalEventAction = (typeof APPROVAL_EVENT_ACTIONS)[number]

/** The inbox's tiles (design home.approvals "tiles"). */
export const APPROVAL_TILES = ['WAITING_FOR_ME', 'OVERDUE', 'ASKED_BY_ME', 'DECIDED_7_DAYS'] as const
export type ApprovalTile = (typeof APPROVAL_TILES)[number]

/** The database's limits (…_approvals_w2b_guards), checked here first so a refusal is in words. */
export const APPROVAL_LIMITS = Object.freeze({
  ruleName: 120,
  conditionRows: 50,
  rowValue: 500,
  rowValues: 100,
  summary: 500,
  note: 4000,
  comment: 2000,
  rejectReason: 2000,
  sequenceMin: 1,
  sequenceMax: 9999,
  dueHoursMax: 2160,
  ruleIds: 20,
  /** The step-up the yes records: at most this long before it. */
  stepUpWindowMs: 15 * 60_000,
  /** How many recent records a rule's test reads (design "Would have asked for 4 of the last 50 quotes"). */
  testRecords: 50,
})

export interface Words {
  readonly it: string
  readonly en: string
}
export type Locale = 'it' | 'en'

// ---- the facts a kind exposes, and the RuleBuilder's condition -----------------------------------------------------------

/** How a fact compares (packages/ui RuleBuilder's field kinds). */
export const FIELD_KINDS = ['number', 'text', 'choice', 'yesNo'] as const
export type FieldKind = (typeof FIELD_KINDS)[number]

export const RULE_COMBINATORS = ['and', 'or'] as const
export type RuleCombinator = (typeof RULE_COMBINATORS)[number]

export const RULE_OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'contains', 'isTrue', 'isFalse'] as const
export type RuleOperator = (typeof RULE_OPERATORS)[number]

/** The ways each kind of fact may compare (the RuleBuilder's defaults). */
export const OPERATORS_BY_KIND: Readonly<Record<FieldKind, readonly RuleOperator[]>> = Object.freeze({
  number: ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'],
  text: ['eq', 'ne', 'contains'],
  choice: ['eq', 'ne', 'in', 'notIn'],
  yesNo: ['isTrue', 'isFalse'],
})

/** One fact a kind exposes to its rules: "amount", "margin", "supplier status". */
export interface ApprovalField {
  /** The fact's key in the condition (`^[a-z][A-Za-z0-9_.]{0,79}$`). */
  readonly id: string
  readonly label: Words
  readonly kind: FieldKind
  /** A number's unit, written after it ("%", "pcs"); a money fact names its grain instead. */
  readonly unit?: string | null
  /** The money grain of the fact: its value (and a rule's threshold on it) only with the grain. */
  readonly grain?: Grain | null
  /** A choice's options. */
  readonly options?: readonly { readonly value: string; readonly label: Words }[]
  readonly min?: number
  readonly max?: number
}

export interface ConditionRow {
  readonly id?: string
  readonly field: string
  readonly operator: RuleOperator
  /** One text; a list of texts for in / notIn; null for isTrue / isFalse. */
  readonly value: string | readonly string[] | null
}

export interface RuleCondition {
  readonly combinator: RuleCombinator
  readonly rows: readonly ConditionRow[]
}

/** A fact's value on a subject: a number (as a number or a decimal text), a text, a choice's value, yes / no, or unknown. */
export type FactValue = string | number | boolean | null
export type Facts = Readonly<Record<string, FactValue>>

export const FIELD_ID = /^[a-z][A-Za-z0-9_.]{0,79}$/
const ONE_LINE = /^[^\r\n]+$/

/** A number as a rule keeps it ("20", "12,5", "-3"): the plain decimal, or undefined. */
export function ruleNumber(text: string): string | undefined {
  const compact = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(compact)) return undefined
  return compact.replace(/\.$/, '')
}

const textOk = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= APPROVAL_LIMITS.rowValue && ONE_LINE.test(value)

export interface ConditionProblem {
  /** `condition/rows/<i>/<field|operator|value>` or `condition/rows`. */
  readonly path: string
  readonly message: string
}

/**
 * What is wrong with a condition for a kind's facts, each in words (empty: it may be saved). Its shape is the database's
 * (at most 50 rows, each value as its way to compare needs); here also: every row names a fact of the kind, compares it the
 * way its kind allows, and a number is a number within the fact's bounds, a choice one of its options. `heldFields` are
 * facts the writer may not use (a money fact without its grain).
 */
export function conditionProblems(condition: RuleCondition, fields: readonly ApprovalField[], heldFields: ReadonlySet<string> = new Set()): ConditionProblem[] {
  const problems: ConditionProblem[] = []
  if (!(RULE_COMBINATORS as readonly string[]).includes(condition.combinator)) problems.push({ path: 'condition/combinator', message: 'Join the conditions with "and" or "or".' })
  if (condition.rows.length > APPROVAL_LIMITS.conditionRows) problems.push({ path: 'condition/rows', message: `At most ${APPROVAL_LIMITS.conditionRows} conditions.` })
  condition.rows.forEach((row, index) => {
    const at = (part: string) => `condition/rows/${index}/${part}`
    const place = `Condition ${index + 1}`
    const field = fields.find((entry) => entry.id === row.field)
    if (!field) {
      problems.push({ path: at('field'), message: `${place}: pick one of the facts this kind of request has.` })
      return
    }
    if (heldFields.has(field.id)) {
      problems.push({ path: at('field'), message: `${place}: ${field.label.en} is a money figure your roles do not show; someone who sees it writes this condition.` })
      return
    }
    const allowed = OPERATORS_BY_KIND[field.kind]
    if (!allowed.includes(row.operator)) {
      problems.push({ path: at('operator'), message: `${place}: ${field.label.en} compares only as ${allowed.join(', ')}.` })
      return
    }
    const value = row.value
    if (row.operator === 'isTrue' || row.operator === 'isFalse') {
      if (value !== null) problems.push({ path: at('value'), message: `${place}: yes or no takes no value.` })
      return
    }
    if (row.operator === 'in' || row.operator === 'notIn') {
      if (!Array.isArray(value) || value.length === 0 || value.length > APPROVAL_LIMITS.rowValues || !value.every(textOk)) {
        problems.push({ path: at('value'), message: `${place}: pick 1 to ${APPROVAL_LIMITS.rowValues} options.` })
        return
      }
      if (field.options && !value.every((entry) => field.options!.some((option) => option.value === entry))) problems.push({ path: at('value'), message: `${place}: pick only options of ${field.label.en}.` })
      return
    }
    if (!textOk(value)) {
      problems.push({ path: at('value'), message: `${place}: enter a value (one line, at most ${APPROVAL_LIMITS.rowValue} characters).` })
      return
    }
    if (field.kind === 'number') {
      const number = ruleNumber(value)
      if (number === undefined) {
        problems.push({ path: at('value'), message: `${place}: ${field.label.en} needs a number.` })
        return
      }
      const n = Number(number)
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
        problems.push({ path: at('value'), message: `${place}: ${field.label.en} is between ${field.min ?? '…'} and ${field.max ?? '…'}.` })
      }
    }
    if (field.kind === 'choice' && field.options && !field.options.some((option) => option.value === value)) problems.push({ path: at('value'), message: `${place}: pick one of the options of ${field.label.en}.` })
  })
  return problems
}

/** The condition as the database keeps it: numbers in their plain decimal form, no undefined keys. */
export function storedCondition(condition: RuleCondition, fields: readonly ApprovalField[]): { combinator: RuleCombinator; rows: Array<{ id?: string; field: string; operator: RuleOperator; value: string | string[] | null }> } {
  return {
    combinator: condition.combinator,
    rows: condition.rows.map((row) => {
      const field = fields.find((entry) => entry.id === row.field)
      const value = Array.isArray(row.value) ? [...row.value] : row.value === null ? null : field?.kind === 'number' ? (ruleNumber(row.value as string) ?? (row.value as string)) : (row.value as string).trim()
      return { ...(row.id ? { id: row.id } : {}), field: row.field, operator: row.operator, value }
    }),
  }
}

/** A stored condition read back (JSON), or null when it is not one this code understands (it then never matches). */
export function parseCondition(json: unknown): RuleCondition | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const raw = json as { combinator?: unknown; rows?: unknown }
  if (raw.combinator !== 'and' && raw.combinator !== 'or') return null
  if (!Array.isArray(raw.rows)) return null
  const rows: ConditionRow[] = []
  for (const entry of raw.rows as unknown[]) {
    if (!entry || typeof entry !== 'object') return null
    const row = entry as { id?: unknown; field?: unknown; operator?: unknown; value?: unknown }
    if (typeof row.field !== 'string' || !(RULE_OPERATORS as readonly unknown[]).includes(row.operator)) return null
    const value = row.value === undefined || row.value === null ? null : Array.isArray(row.value) ? row.value.map(String) : String(row.value)
    rows.push({ ...(typeof row.id === 'string' ? { id: row.id } : {}), field: row.field, operator: row.operator as RuleOperator, value })
  }
  return { combinator: raw.combinator, rows }
}

const decimalOf = (value: FactValue | string): Decimal | null => {
  if (value === null || typeof value === 'boolean') return null
  try {
    const text = typeof value === 'number' ? String(value) : ruleNumber(value)
    return text === undefined ? null : new Decimal(text)
  } catch {
    return null
  }
}

/**
 * Whether one row holds for a fact's value. An unknown fact (null, or a fact the kind did not give) never holds: a rule
 * on a figure the subject does not have does not ask. Texts compare without regard to case; choices exactly.
 */
export function rowHolds(row: ConditionRow, field: ApprovalField | undefined, fact: FactValue | undefined): boolean {
  if (!field || fact === undefined || fact === null) return false
  switch (row.operator) {
    case 'isTrue':
      return fact === true
    case 'isFalse':
      return fact === false
    case 'in':
    case 'notIn': {
      const list = Array.isArray(row.value) ? row.value : []
      const found = list.includes(String(fact))
      return row.operator === 'in' ? found : !found
    }
    default:
      break
  }
  const value = typeof row.value === 'string' ? row.value : null
  if (value === null) return false
  if (field.kind === 'number') {
    const a = decimalOf(fact)
    const b = decimalOf(value)
    if (!a || !b) return false
    const order = a.comparedTo(b)
    switch (row.operator) {
      case 'lt':
        return order < 0
      case 'lte':
        return order <= 0
      case 'gt':
        return order > 0
      case 'gte':
        return order >= 0
      case 'eq':
        return order === 0
      case 'ne':
        return order !== 0
      default:
        return false
    }
  }
  const left = field.kind === 'choice' ? String(fact) : String(fact).toLocaleLowerCase('en')
  const right = field.kind === 'choice' ? value : value.trim().toLocaleLowerCase('en')
  switch (row.operator) {
    case 'eq':
      return left === right
    case 'ne':
      return left !== right
    case 'contains':
      return field.kind === 'text' && left.includes(right)
    default:
      return false
  }
}

/** Whether a condition holds for the facts: no row holds for every request of the kind; "and" all rows, "or" any. */
export function conditionHolds(condition: RuleCondition, fields: readonly ApprovalField[], facts: Facts): boolean {
  if (condition.rows.length === 0) return true
  const results = condition.rows.map((row) => rowHolds(row, fields.find((field) => field.id === row.field), facts[row.field]))
  return condition.combinator === 'and' ? results.every(Boolean) : results.some(Boolean)
}

// ---- which rules ask ---------------------------------------------------------------------------------------------------

export interface RuleCandidate {
  readonly id: string
  readonly companyId: string | null
  readonly sequence: number
  readonly createdAt: Date
  readonly active: boolean
  readonly effectiveFrom: Date | null
  readonly condition: unknown
  readonly approverRoleId: string | null
  readonly approverUserId: string | null
}

/** A rule in force now for a company: switched on, past its start, of that company or of every company. */
export const inForce = (rule: Pick<RuleCandidate, 'active' | 'effectiveFrom' | 'companyId'>, companyId: string, now: Date): boolean =>
  rule.active && (rule.effectiveFrom === null || rule.effectiveFrom.getTime() <= now.getTime()) && (rule.companyId === null || rule.companyId === companyId)

/** The kind's order: sequence, then the oldest, then the id (UUIDv7: the order of creation). */
export const ruleOrder = (a: Pick<RuleCandidate, 'sequence' | 'createdAt' | 'id'>, b: Pick<RuleCandidate, 'sequence' | 'createdAt' | 'id'>): number =>
  a.sequence - b.sequence || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export interface RuleChoice<Rule extends RuleCandidate> {
  /** Every rule in force whose condition holds, in order (at most 20: the request's ruleIds). */
  readonly matched: readonly Rule[]
  /** The first of them whose approver is not the person asking: it names the approver, the meaning, the step-up, the time. */
  readonly deciding: Rule | null
  /** Rules that matched but name the asking person, skipped for the next. */
  readonly skippedSelf: readonly Rule[]
}

/**
 * Which rules ask for this subject (PLT-086): the kind's rules in force for the company, in order; those whose condition
 * holds asked; the first that names someone other than the person asking decides. None matched: no approval (as today).
 */
export function chooseRules<Rule extends RuleCandidate>(rules: readonly Rule[], subject: { readonly companyId: string; readonly facts: Facts; readonly askers: readonly string[] }, fields: readonly ApprovalField[], now: Date): RuleChoice<Rule> {
  const ordered = rules.filter((rule) => inForce(rule, subject.companyId, now)).sort(ruleOrder)
  const matched = ordered.filter((rule) => {
    const condition = parseCondition(rule.condition)
    return condition !== null && conditionHolds(condition, fields, subject.facts)
  })
  const skippedSelf: Rule[] = []
  let deciding: Rule | null = null
  for (const rule of matched) {
    if (rule.approverUserId !== null && subject.askers.includes(rule.approverUserId)) {
      skippedSelf.push(rule)
      continue
    }
    deciding = rule
    break
  }
  return { matched: matched.slice(0, APPROVAL_LIMITS.ruleIds), deciding, skippedSelf }
}

// ---- the change as it will be written -----------------------------------------------------------------------------------

/** One change a request shows (from → to); a money figure carries its grain. */
export interface PreviewChange {
  readonly field: string
  readonly from: unknown
  readonly to: unknown
  readonly grain?: Grain | null
}

/** One fact a request shows (the rule's values: "margin 18 %"); a money figure carries its grain. */
export interface PreviewFact {
  readonly field: string
  readonly value: unknown
  readonly grain?: Grain | null
}

export interface ApprovalPreview {
  readonly changes: readonly PreviewChange[]
  readonly facts: readonly PreviewFact[]
}

/** Plain JSON (dates as ISO text, decimals as their text, undefined keys dropped): what a fingerprint reads. */
export const plainJson = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

/**
 * The SHA-256 (64 hex) of the change as it will be written (PLT-093): the kind, the subject (its model name, id, and the
 * snapshot its kind reads of it), and the changes the request shows. The yes re-reads the subject and compares.
 */
export function approvalFingerprint(input: { readonly kind: string; readonly recordType: string; readonly recordId: string; readonly subject: unknown; readonly changes: readonly PreviewChange[] }): string {
  // The changes as the request stores them (every entry with its grain, null when not money), so the yes reads the same.
  const changes = input.changes.map((change) => ({ field: change.field, from: change.from ?? null, to: change.to ?? null, grain: change.grain ?? null }))
  const text = canonicalJson(plainJson({ fingerprint: 'factory approval v1', kind: input.kind, recordType: input.recordType, recordId: input.recordId, subject: input.subject, changes }))
  return createHash('sha256').update(text).digest('hex')
}

/** A stored preview read back (the database keeps its shape); an unknown shape reads as no change. */
export function parsePreview(json: unknown): ApprovalPreview {
  const raw = (json && typeof json === 'object' && !Array.isArray(json) ? json : {}) as { changes?: unknown; facts?: unknown }
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && typeof (entry as { field?: unknown }).field === 'string') : [])
  const grainOf = (entry: Record<string, unknown>) => (typeof entry.grain === 'string' ? (entry.grain as Grain) : null)
  return {
    changes: list(raw.changes).map((entry) => ({ field: entry.field as string, from: entry.from ?? null, to: entry.to ?? null, grain: grainOf(entry) })),
    facts: list(raw.facts).map((entry) => ({ field: entry.field as string, value: entry.value ?? null, grain: grainOf(entry) })),
  }
}

/** What differs between the facts the request showed and the subject's facts now (the re-check line's "price 480 → 510"). */
export function changedFacts(asked: readonly PreviewFact[], now: readonly PreviewFact[]): Array<{ field: string; was: unknown; now: unknown; grain: Grain | null }> {
  const fields = [...new Set([...asked.map((fact) => fact.field), ...now.map((fact) => fact.field)])]
  return fields.flatMap((field) => {
    const before = asked.find((fact) => fact.field === field)
    const after = now.find((fact) => fact.field === field)
    const was = before?.value ?? null
    const is = after?.value ?? null
    if (canonicalJson(plainJson(was)) === canonicalJson(plainJson(is))) return []
    return [{ field, was, now: is, grain: before?.grain ?? after?.grain ?? null }]
  })
}

/** "3 fields" / "3 campi" (the inbox's Change size). */
export function changeSize(changes: readonly PreviewChange[]): Words {
  const n = changes.length
  return { en: n === 1 ? '1 field' : `${n} fields`, it: n === 1 ? '1 campo' : `${n} campi` }
}

// ---- who may never decide -------------------------------------------------------------------------------------------------

/** The people a request names as having asked it: the office person, whoever wrote it, the floor worker's office account. */
export function askersOf(task: { readonly requestedById: string | null; readonly createdById: string | null }, workerUserId: string | null = null): string[] {
  return [...new Set([task.requestedById, task.createdById, workerUserId].filter((id): id is string => typeof id === 'string'))]
}

/** Nobody approves their own request, the Owner included (Owner answer Q3 = A; PLT-042). */
export const isOwnRequest = (askers: readonly string[], personId: string): boolean => askers.includes(personId)

// ---- refusals, in words ----------------------------------------------------------------------------------------------------

export const APPROVAL_REFUSALS = Object.freeze({
  NOT_PENDING: 'This request was decided, withdrawn or found changed already: nothing waits for a decision.',
  OWN_REQUEST: 'You asked for this: nobody approves their own request, the Owner included. Another approver decides it.',
  NOT_APPROVER: 'This request waits for another approver: it is not addressed to you or to a role you hold over its company.',
  STALE: 'It changed since you looked: the request was asked about another version of the record. Ask again.',
  NO_KIND: 'This kind of request has no checker yet: it cannot be re-read, so it cannot be approved here.',
  SUBJECT_GONE: 'The record of this request is gone or out of your reach.',
  NOT_REQUESTER: 'Only the person who asked for this request takes it back.',
  NAMED_SELF: 'The approval rule names you to approve this, and nobody approves their own request: an administrator names another approver in Admin › Automation.',
  NOT_ASKABLE: 'This kind of request is asked by its own page, not here.',
  PENDING_EXISTS: 'A request for a yes on this record waits already: decide or withdraw it first.',
  RULE_OFF_KIND: 'This kind of request has no checker yet: a rule for it cannot be tested.',
  REASON_CODE: 'Pick a reason of the list "Why an approver says no" (Admin › Reasons).',
  REASON_WORDS: 'Say why in words (1 to 2000 characters).',
  COMMENT: 'A comment is 1 to 2000 characters.',
  APPROVER_ROLE: 'Name an office role whose people may approve (approvals.decide), or one person.',
  APPROVER_PERSON: 'Name an office person who is active and may approve (approvals.decide).',
  CHANGE_GRAIN: 'This rule tests a money figure your roles do not show: someone who sees it changes the rule.',
})
export type ApprovalRefusal = keyof typeof APPROVAL_REFUSALS

/** "You asked for this; Lucia or Marco can approve it." (design home.approvals review, the held Approve). */
export function ownRequestWords(others: readonly string[]): string {
  if (others.length === 0) return `${APPROVAL_REFUSALS.OWN_REQUEST} Nobody else can approve it yet: an administrator names another approver.`
  const names = others.length <= 2 ? others.join(' or ') : `${others.slice(0, 2).join(', ')} or ${others.length - 2} more`
  return `You asked for this: nobody approves their own request, the Owner included. ${names} can approve it.`
}

/** The re-check line (design review "Still current · checked 10:42" / "Changed since asked: …"). */
export function staleWords(changed: ReadonlyArray<{ readonly field: string; readonly was: unknown; readonly now: unknown }>, labels: (field: string) => string): string {
  if (changed.length === 0) return APPROVAL_REFUSALS.STALE
  const parts = changed.slice(0, 3).map((entry) => `${labels(entry.field)} ${String(entry.was ?? '—')} → ${String(entry.now ?? '—')}`)
  return `It changed since you looked (${parts.join('; ')}${changed.length > 3 ? '; …' : ''}): the request was asked about another version of the record. Ask again.`
}

// ---- words of a rule ----------------------------------------------------------------------------------------------------

export const MEANING_WORDS: Readonly<Record<ApprovalMeaning, Words>> = Object.freeze({
  REVIEWED: { en: 'Reviewed', it: 'Revisionato' },
  APPROVED: { en: 'Approved', it: 'Approvato' },
  RELEASED: { en: 'Released', it: 'Rilasciato' },
  VERIFIED: { en: 'Verified', it: 'Verificato' },
})

const OPERATOR_WORDS: Readonly<Record<RuleOperator, Words>> = Object.freeze({
  eq: { en: 'is', it: 'è' },
  ne: { en: 'is not', it: 'non è' },
  lt: { en: 'under', it: 'sotto' },
  lte: { en: 'at most', it: 'al massimo' },
  gt: { en: 'over', it: 'oltre' },
  gte: { en: 'at least', it: 'almeno' },
  in: { en: 'is one of', it: 'è uno tra' },
  notIn: { en: 'is none of', it: 'non è tra' },
  contains: { en: 'contains', it: 'contiene' },
  isTrue: { en: 'yes', it: 'sì' },
  isFalse: { en: 'no', it: 'no' },
})

export interface SentenceInput {
  readonly kindLabel: Words
  readonly condition: RuleCondition | null
  readonly fields: readonly ApprovalField[]
  /** Facts whose values the reader may not see (a money threshold without its grain): "…" in place of the value. */
  readonly hiddenFields?: ReadonlySet<string>
  readonly approver: string | null
  readonly meaning: ApprovalMeaning | null
}

/**
 * A rule in a sentence (design admin.automation "Rule sentence": "Quote: margin under 25 % or discount over 10 % → Sales
 * manager"; home.approvals "Why is this mine?"). A money threshold the reader may not see reads "…".
 */
export function ruleSentence(input: SentenceInput, locale: Locale): string {
  const kind = input.kindLabel[locale]
  const every = locale === 'it' ? 'ogni richiesta' : 'every request'
  const join = input.condition?.combinator === 'or' ? (locale === 'it' ? ' o ' : ' or ') : locale === 'it' ? ' e ' : ' and '
  const rows = (input.condition?.rows ?? []).map((row) => {
    const field = input.fields.find((entry) => entry.id === row.field)
    const label = field ? field.label[locale] : row.field
    const op = OPERATOR_WORDS[row.operator][locale]
    if (row.operator === 'isTrue') return label
    if (row.operator === 'isFalse') return locale === 'it' ? `non ${label}` : `not ${label}`
    if (input.hiddenFields?.has(row.field)) return `${label} ${op} …`
    const valueText = (value: string) => {
      const option = field?.options?.find((entry) => entry.value === value)
      return option ? option.label[locale] : value
    }
    const shown = Array.isArray(row.value) ? row.value.map(valueText).join(', ') : row.value === null ? '' : valueText(row.value as string)
    const unit = field?.unit ? ` ${field.unit}` : ''
    return `${label} ${op} ${shown}${unit}`
  })
  const when = rows.length === 0 ? every : rows.join(join)
  const who = input.approver ?? (locale === 'it' ? '(nessuno)' : '(nobody)')
  const signed = input.meaning ? (locale === 'it' ? `, firma «${MEANING_WORDS[input.meaning].it}»` : `, signed '${MEANING_WORDS[input.meaning].en}'`) : ''
  return `${kind}: ${when} → ${who}${signed}`
}
