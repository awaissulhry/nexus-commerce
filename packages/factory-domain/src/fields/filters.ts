import type { Issue } from '../core/errors'
import { isBusinessDate } from '../core/time'
import { Dec } from '../tax/decimal'
import { FIELD_CODE, FIELD_LIMITS, type FieldType } from './rules'
import { isMoneyValue, type StoredValue } from './values'

/**
 * A list's filter on its custom fields (B-W2b-421; PLT-111): ONE address term `cf`, so a saved view keeps it like any
 * other term and a list's strict query takes it with one field. Clauses separated by `;`:
 *
 *   code:A,B      the value is one of these: a select's codes (a multi-select: has any of them), yes/no `true`/`false`,
 *                 a person's or a linked record's ids, a day, a number; a text field: contains the words (any case)
 *   code>=X       at least X: a number, a day (2026-12-31), an amount in whole minor units
 *   code<=X       at most X (same)
 *   code:*        has a value          code:-   has none
 *
 * At most 10 clauses. A clause on a field the person does not see is refused like an unknown field (the API says which),
 * so a filter never tells about money or personal data the person may not read.
 */

export type FilterOp = 'any' | 'gte' | 'lte' | 'set' | 'unset'

export interface FilterClause {
  readonly code: string
  readonly op: FilterOp
  /** `any`: the values asked; `gte` / `lte`: one; `set` / `unset`: none. */
  readonly values: readonly string[]
}

const CLAUSE = /^([a-z][a-z0-9_]{0,39})(:|>=|<=)(.*)$/

/** The clauses of a `cf` term, or the problems at `cf`. */
export function parseFilter(term: string | undefined | null): { readonly clauses: readonly FilterClause[]; readonly problems: readonly Issue[] } {
  if (term === undefined || term === null || term.trim() === '') return { clauses: [], problems: [] }
  const parts = term.split(';').map((part) => part.trim()).filter((part) => part !== '')
  const problems: Issue[] = []
  if (parts.length > FIELD_LIMITS.clauses) problems.push({ path: 'cf', message: `At most ${FIELD_LIMITS.clauses} custom field filters at once.` })
  const clauses: FilterClause[] = []
  for (const part of parts.slice(0, FIELD_LIMITS.clauses)) {
    const match = CLAUSE.exec(part)
    if (!match || !FIELD_CODE.test(match[1]!)) {
      problems.push({ path: 'cf', message: `"${part}" is not a custom field filter (code:value, code>=value, code<=value).` })
      continue
    }
    const [, code, sign, rest] = match as unknown as [string, string, string, string]
    if (sign === ':' && rest === '*') clauses.push({ code, op: 'set', values: [] })
    else if (sign === ':' && rest === '-') clauses.push({ code, op: 'unset', values: [] })
    else if (sign === ':') {
      const values = rest.split(',').map((value) => value.trim()).filter((value) => value !== '')
      if (values.length === 0 || values.length > FIELD_LIMITS.multi) problems.push({ path: 'cf', message: `"${part}": give 1 to ${FIELD_LIMITS.multi} values.` })
      else clauses.push({ code, op: 'any', values })
    } else if (rest.trim() === '') problems.push({ path: 'cf', message: `"${part}": give the value to compare with.` })
    else clauses.push({ code, op: sign === '>=' ? 'gte' : 'lte', values: [rest.trim()] })
  }
  return { clauses, problems }
}

/** The problem of a clause for its field's type (a range on a select, a word on a yes/no …), or null. */
export function clauseProblem(type: FieldType, clause: FilterClause): string | null {
  if (clause.op === 'set' || clause.op === 'unset') return null
  if (clause.op === 'gte' || clause.op === 'lte') {
    const value = clause.values[0]!
    if (type === 'DATE') return isBusinessDate(value) ? null : `${clause.code}: a day like 2026-12-31.`
    if (type === 'NUMBER') return /^-?\d+(\.\d+)?$/.test(value) ? null : `${clause.code}: a number like 12.5.`
    if (type === 'MONEY') return /^-?\d+$/.test(value) ? null : `${clause.code}: an amount in whole minor units (89900).`
    return `${clause.code}: only a number, a day or an amount is compared.`
  }
  if (type === 'YES_NO') return clause.values.every((value) => value === 'true' || value === 'false') ? null : `${clause.code}: true or false.`
  if (type === 'DATE') return clause.values.every(isBusinessDate) ? null : `${clause.code}: days like 2026-12-31.`
  if (type === 'NUMBER') return clause.values.every((value) => /^-?\d+(\.\d+)?$/.test(value)) ? null : `${clause.code}: numbers like 12.5.`
  if (type === 'MONEY') return `${clause.code}: compare an amount with >= or <=.`
  if (type === 'FILE') return `${clause.code}: a file field is filtered by having one (:* or :-).`
  return null
}

/** -1, 0 or 1: a stored number against a number of the address (decimals, no float). */
const order = (value: number, text: string): number => new Dec(value).comparedTo(new Dec(text))

/** The value meets the clause (null: the record has none). */
export function meets(type: FieldType, value: StoredValue | null, clause: FilterClause): boolean {
  if (clause.op === 'set') return value !== null
  if (clause.op === 'unset') return value === null
  if (value === null) return false
  if (clause.op === 'gte' || clause.op === 'lte') {
    const bound = clause.values[0]!
    const within = (sign: number) => (clause.op === 'gte' ? sign >= 0 : sign <= 0)
    if (type === 'DATE') return typeof value === 'string' && within(value < bound ? -1 : value > bound ? 1 : 0)
    if (type === 'NUMBER' || type === 'MONEY') {
      const amount = type === 'NUMBER' ? (typeof value === 'number' ? value : null) : isMoneyValue(value) ? value.amount : null
      return amount !== null && within(order(amount, bound))
    }
    return false
  }
  switch (type) {
    case 'TEXT': {
      const text = typeof value === 'string' ? value.toLocaleLowerCase('it') : ''
      return clause.values.some((word) => text.includes(word.toLocaleLowerCase('it')))
    }
    case 'YES_NO':
      return clause.values.includes(String(value))
    case 'NUMBER':
      return typeof value === 'number' && clause.values.some((entry) => order(value, entry) === 0)
    case 'MULTI_SELECT':
      return Array.isArray(value) && (value as string[]).some((code) => clause.values.includes(code))
    case 'PERSON':
    case 'LINK':
      return typeof value === 'string' && clause.values.some((entry) => entry.toLowerCase() === value)
    default:
      return typeof value === 'string' && clause.values.includes(value)
  }
}
