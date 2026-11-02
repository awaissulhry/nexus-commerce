import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'
import { CODE_MEANINGS, codeOrder, HOUR_CODES, isFixedCode, mappingKey, type EarningCode, type HourCode, type PayrollCodeKind } from './codes'

/**
 * The values of a payroll export (B-W2b-54; MES-267; design people.payroll "4 · Preview"), pure: per employee code, hours by
 * type, absences by code, and piece pay and bonuses as payroll items.
 *
 *   who      the company's employees with days or earnings in the month. Agency and external people are left out: their
 *            employer pays them (MES-211); the check says how many
 *   hours    the sum of the closed days' MINUTES as they stand (each figure replaced by its latest correction), never of
 *            rounded hours. Overtime is the APPROVED entries only. Night and holiday hours are "of which", as on the LUL
 *   earnings the LOCKED period's ledger, reversals included, summed by kind. Work of an earlier month paid in this one is its
 *            own code. Nothing here computes pay: the consultant does
 *   order    by employee code, then the code's place, so the same facts give the same file, and a seal can be checked
 */

export const VALUE_UNITS = ['HOURS', 'PIECES'] as const
export type ValueUnit = (typeof VALUE_UNITS)[number]

/** One row of what an export sends (PayrollExport.values). */
export interface PayrollValue {
  /** The payroll's matricola; empty only in a preview: a person without one holds the export (EMPLOYEE_CODES). */
  readonly employeeCode: string
  readonly kind: PayrollCodeKind
  /** Our code. */
  readonly code: string
  /** The provider's, as mapped when it was read; null: not mapped. */
  readonly providerCode: string | null
  readonly meaning: string
  readonly unit: ValueUnit | null
  /** A decimal with a dot ("168.50"), or null when the row is only an amount. */
  readonly quantity: string | null
  /** HOUR and ABSENCE: the exact minutes behind the rounded hours. */
  readonly minutes: number | null
  /** Minor units; null when the row is only hours. */
  readonly amount: number | null
  readonly currency: string | null
  /** The person's last working day, when it falls in or before this month (MES-214). */
  readonly lastDay: BusinessDate | null
}

/** A person's earnings of one code in the period. */
export interface EarningFact {
  readonly code: EarningCode
  readonly pieces: number | null
  /** The ledger's minutes (a decimal), summed. */
  readonly minutes: string | null
  readonly amount: number
  readonly currency: string
}

/** What one person brings to the file. */
export interface PersonFacts {
  readonly employeeId: string
  readonly employeeCode: string | null
  readonly kind: 'EMPLOYEE' | 'AGENCY' | 'EXTERNAL'
  readonly lastDay: BusinessDate | null
  readonly hours: Readonly<Record<HourCode, number>>
  /** Minutes per absence code (ours). */
  readonly absences: ReadonlyMap<string, number>
  readonly earnings: readonly EarningFact[]
}

export interface MappedCode {
  readonly providerCode: string | null
  readonly meaning: string
}

export interface PersonValues {
  readonly employeeId: string
  readonly employeeCode: string | null
  readonly lastDay: BusinessDate | null
  readonly values: readonly PayrollValue[]
}

/** A row of the ledger, summed per person, kind and corrected period. */
export interface LedgerSum {
  readonly kind: 'SCAN' | 'TEAM_SPLIT' | 'MAKE_UP' | 'OFF_STANDARD' | 'ADJUSTMENT'
  readonly correctsPeriodId: string | null
  readonly currency: string
  readonly amount: number
  readonly pieces: number | null
  readonly minutes: string | null
}

const EARNING_OF_KIND: Readonly<Record<LedgerSum['kind'], EarningCode>> = Object.freeze({ SCAN: 'PIECE', TEAM_SPLIT: 'TEAM_SHARE', MAKE_UP: 'MAKE_UP', OFF_STANDARD: 'OFF_STANDARD', ADJUSTMENT: 'ADJUSTMENT' })

/** One person's ledger as payroll items, one per code and currency (work of an earlier month paid here is its own code). */
export function earningFacts(rows: readonly LedgerSum[]): EarningFact[] {
  const sums = new Map<string, { code: EarningCode; currency: string; amount: number; pieces: number | null; minutes: Decimal | null }>()
  for (const row of rows) {
    const code = row.correctsPeriodId !== null ? 'EARLIER_MONTH' : EARNING_OF_KIND[row.kind]
    const key = `${code}|${row.currency}`
    const sum = sums.get(key) ?? { code, currency: row.currency, amount: 0, pieces: null, minutes: null }
    sum.amount += row.amount
    sum.pieces = row.pieces === null ? sum.pieces : (sum.pieces ?? 0) + row.pieces
    sum.minutes = row.minutes === null ? sum.minutes : (sum.minutes ?? new Dec(0)).plus(row.minutes)
    sums.set(key, sum)
  }
  return [...sums.values()].map((sum) => ({ code: sum.code, currency: sum.currency, amount: sum.amount, pieces: sum.pieces, minutes: sum.minutes?.toString() ?? null }))
}

/** Minutes as decimal hours with a dot (450 → "7.50"): the sum adds the minutes, never the rounded hours. */
export function hoursOf(minutes: number): string {
  return new Dec(minutes).div(60).toFixed(2)
}

const AMOUNT_ONLY: ReadonlySet<EarningCode> = new Set(['ADJUSTMENT', 'EARLIER_MONTH'])

function earningQuantity(fact: EarningFact): { readonly unit: ValueUnit | null; readonly quantity: string | null } {
  if (AMOUNT_ONLY.has(fact.code)) return { unit: null, quantity: null }
  if (fact.pieces !== null && fact.pieces !== 0) return { unit: 'PIECES', quantity: String(fact.pieces) }
  if (fact.minutes !== null && !new Dec(fact.minutes).isZero()) return { unit: 'HOURS', quantity: new Dec(fact.minutes).div(60).toFixed(2) }
  return { unit: null, quantity: null }
}

/** The file's values of the people it carries, in file order. Agency and external people carry nothing. */
export function personValues(people: readonly PersonFacts[], mapping: ReadonlyMap<string, MappedCode>, meaningOfAbsence: (code: string) => string): PersonValues[] {
  const meaningOf = (kind: PayrollCodeKind, code: string): string => mapping.get(mappingKey(kind, code))?.meaning ?? (isFixedCode(code) ? CODE_MEANINGS[code].en : meaningOfAbsence(code))
  const rows = people
    .filter((person) => person.kind === 'EMPLOYEE')
    .map((person): PersonValues => {
      const row = (kind: PayrollCodeKind, code: string, parts: Pick<PayrollValue, 'unit' | 'quantity' | 'minutes' | 'amount' | 'currency'>): PayrollValue => ({
        employeeCode: person.employeeCode ?? '',
        kind,
        code,
        providerCode: mapping.get(mappingKey(kind, code))?.providerCode ?? null,
        meaning: meaningOf(kind, code),
        lastDay: person.lastDay,
        ...parts,
      })
      const timed = (kind: PayrollCodeKind, code: string, minutes: number) => row(kind, code, { unit: 'HOURS', quantity: hoursOf(minutes), minutes, amount: null, currency: null })
      const values = [
        ...HOUR_CODES.filter((code) => person.hours[code] > 0).map((code) => timed('HOUR', code, person.hours[code])),
        ...[...person.absences].filter(([, minutes]) => minutes > 0).map(([code, minutes]) => timed('ABSENCE', code, minutes)),
        ...person.earnings.filter((fact) => fact.amount !== 0).map((fact) => row('EARNING', fact.code, { ...earningQuantity(fact), minutes: null, amount: fact.amount, currency: fact.currency })),
      ].sort(codeOrder)
      return { employeeId: person.employeeId, employeeCode: person.employeeCode, lastDay: person.lastDay, values }
    })
    .filter((person) => person.values.length > 0)
  return rows.sort((a, b) => ((a.employeeCode ?? '') < (b.employeeCode ?? '') ? -1 : (a.employeeCode ?? '') > (b.employeeCode ?? '') ? 1 : a.employeeId < b.employeeId ? -1 : 1))
}

export const flatValues = (rows: readonly PersonValues[]): PayrollValue[] => rows.flatMap((row) => row.values)

/** The company's sum per code, for the preview and the summary. Hours add minutes. */
export interface CodeSum {
  readonly kind: PayrollCodeKind
  readonly code: string
  readonly providerCode: string | null
  readonly meaning: string
  readonly unit: ValueUnit | null
  readonly quantity: string | null
  readonly amount: number | null
  readonly currency: string | null
  readonly people: number
}

export function codeSums(values: readonly PayrollValue[]): CodeSum[] {
  const sums = new Map<string, { base: PayrollValue; minutes: number; quantity: Decimal | null; amount: number | null; people: Set<string> }>()
  for (const value of values) {
    const key = `${value.kind}|${value.code}|${value.currency ?? ''}`
    const sum = sums.get(key) ?? { base: value, minutes: 0, quantity: null, amount: null, people: new Set<string>() }
    sum.minutes += value.minutes ?? 0
    sum.quantity = value.quantity === null || value.minutes !== null ? sum.quantity : (sum.quantity ?? new Dec(0)).plus(value.quantity)
    sum.amount = value.amount === null ? sum.amount : (sum.amount ?? 0) + value.amount
    sum.people.add(value.employeeCode)
    sums.set(key, sum)
  }
  return [...sums.values()]
    .map(({ base, minutes, quantity, amount, people }): CodeSum => ({
      kind: base.kind,
      code: base.code,
      providerCode: base.providerCode,
      meaning: base.meaning,
      unit: base.unit,
      quantity: base.minutes !== null ? hoursOf(minutes) : quantity === null ? null : base.unit === 'PIECES' ? quantity.toFixed(0) : quantity.toFixed(2),
      amount,
      currency: base.currency,
      people: people.size,
    }))
    .sort(codeOrder)
}

// ---- corrections ---------------------------------------------------------------------------------------------------------

export interface ValueChange {
  readonly employeeCode: string
  readonly kind: PayrollCodeKind
  readonly code: string
  readonly meaning: string
  readonly unit: ValueUnit | null
  readonly change: 'ADDED' | 'REMOVED' | 'CHANGED'
  readonly fromQuantity: string | null
  readonly toQuantity: string | null
  readonly fromAmount: number | null
  readonly toAmount: number | null
  readonly fromProviderCode: string | null
  readonly toProviderCode: string | null
  readonly currency: string | null
}

const valueKey = (value: Pick<PayrollValue, 'employeeCode' | 'kind' | 'code' | 'currency'>): string => `${value.employeeCode}|${value.kind}|${value.code}|${value.currency ?? ''}`

const sameValue = (a: PayrollValue, b: PayrollValue): boolean => (a.minutes ?? a.quantity) === (b.minutes ?? b.quantity) && a.amount === b.amount && a.providerCode === b.providerCode

const changeOf = (employeeCode: string, before: PayrollValue | null, after: PayrollValue | null): ValueChange => {
  const base = (after ?? before)!
  return {
    employeeCode,
    kind: base.kind,
    code: base.code,
    meaning: base.meaning,
    unit: base.unit,
    change: before === null ? 'ADDED' : after === null ? 'REMOVED' : 'CHANGED',
    fromQuantity: before?.quantity ?? null,
    toQuantity: after?.quantity ?? null,
    fromAmount: before?.amount ?? null,
    toAmount: after?.amount ?? null,
    fromProviderCode: before?.providerCode ?? null,
    toProviderCode: after?.providerCode ?? null,
    currency: base.currency,
  }
}

/** What differs between the file before and the figures now, in file order (MES-273). A figure put back is no change. */
export function valueChanges(before: readonly PayrollValue[], after: readonly PayrollValue[]): ValueChange[] {
  const old = new Map(before.map((value) => [valueKey(value), value]))
  const now = new Map(after.map((value) => [valueKey(value), value]))
  const changes: ValueChange[] = []
  for (const [key, value] of now) {
    const earlier = old.get(key) ?? null
    if (earlier === null || !sameValue(earlier, value)) changes.push(changeOf(value.employeeCode, earlier, value))
  }
  for (const [key, value] of old) if (!now.has(key)) changes.push(changeOf(value.employeeCode, value, null))
  return changes.sort((a, b) => (a.employeeCode < b.employeeCode ? -1 : a.employeeCode > b.employeeCode ? 1 : codeOrder(a, b)))
}

/** "3 people, 7 values". */
export const changeCounts = (changes: readonly ValueChange[]): { readonly people: number; readonly values: number } => ({ people: new Set(changes.map((change) => change.employeeCode)).size, values: changes.length })

/**
 * The stored rows read back. Rows written by the schema's seed name only employeeCode, code, quantity and amount: a row
 * that names no kind is taken for an hour, with no unit and no minutes.
 */
export function parseValues(stored: unknown): PayrollValue[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((entry): PayrollValue[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    if (typeof row.employeeCode !== 'string' || typeof row.code !== 'string') return []
    return [
      {
        employeeCode: row.employeeCode,
        kind: row.kind === 'ABSENCE' || row.kind === 'EARNING' ? row.kind : 'HOUR',
        code: row.code,
        providerCode: typeof row.providerCode === 'string' ? row.providerCode : null,
        meaning: typeof row.meaning === 'string' ? row.meaning : row.code,
        unit: row.unit === 'HOURS' || row.unit === 'PIECES' ? row.unit : null,
        quantity: typeof row.quantity === 'string' ? row.quantity : null,
        minutes: typeof row.minutes === 'number' ? row.minutes : null,
        amount: typeof row.amount === 'number' ? row.amount : null,
        currency: typeof row.currency === 'string' ? row.currency : null,
        lastDay: typeof row.lastDay === 'string' ? row.lastDay : null,
      },
    ]
  })
}

/** The export carries amounts: its files ask the pay grain. */
export const carriesPay = (values: readonly PayrollValue[]): boolean => values.some((value) => value.amount !== null)

/** A stable text of the values (the export's last command compares them with the draft's). */
export const valuesText = (values: readonly PayrollValue[]): string => JSON.stringify(values.map((value) => [value.employeeCode, value.kind, value.code, value.providerCode, value.quantity, value.minutes, value.amount, value.currency, value.lastDay]))
