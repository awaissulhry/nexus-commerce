import { isBusinessDate } from '@nexus/factory-domain/core/time'
import { FIELD_LIMITS } from '@nexus/factory-domain/fields/rules'
import { isMoneyValue, sameStored, storedOf, type StoredValue } from '@nexus/factory-domain/fields/values'
import { minorUnitsOf } from '@nexus/factory-domain/money/currency/currencies'
import { isApiError, issuePath } from '../../lib/api/errors'
import { formatDate, formatNumber } from '../../lib/i18n/format'
import type { Locale } from '../../lib/i18n/locales'
import type { Field, RecordKey } from '../../areas/admin/fields/api'
import { labelIn } from '../../areas/admin/fields/model'
import type { RecordValue, ValueEntry } from './api'

/**
 * The custom-fields section on every record (B-W2b-431; design admin.fields "The record panels show a custom-fields
 * section"), pure: which panels have one, a value in words, the draft of the section's edit and what it sends, and the
 * API's refusals in our words (`cf.*` keys of the `admin-fields` catalogue — never `panels.`, `files.` … the record
 * panels' own key test reads those as `records` keys).
 */

/**
 * A panel's record type (the API's model name) → the fields registry's record type (factory-api platform/fields/records.ts).
 * A party is a customer and a supplier at once: both read the party's one set of fields (`sharedWith`).
 */
export const RECORD_OF_MODEL: Readonly<Record<string, RecordKey>> = Object.freeze({
  Party: 'CUSTOMER',
  Quote: 'QUOTE',
  SalesOrder: 'ORDER',
  Style: 'STYLE',
  Item: 'MATERIAL',
  PurchaseOrder: 'PURCHASE_ORDER',
  Lot: 'LOT',
  WorkOrder: 'WORK_ORDER',
})

export const fieldsRecordOf = (model: string): RecordKey | null => RECORD_OF_MODEL[model] ?? null

/** A reference value (person, linked record, file): its id and the words it shows. */
export interface RefDraft {
  id: string | null
  words: string | null
}

/** What a person types for one field, by type: text for TEXT/NUMBER/DATE, an amount and currency, codes, a reference, yes/no. */
export type DraftValue = string | readonly string[] | { amount: string; currency: string } | RefDraft

export type Draft = Readonly<Record<string, DraftValue>>

export const DEFAULT_CURRENCY = 'EUR'

const placesOf = (currency: string): number => {
  try {
    return minorUnitsOf(currency)
  } catch {
    return 2
  }
}

/** Minor units as the amount a person types (`89900` EUR → `899.00`). */
export const amountText = (minor: number, currency: string): string => {
  const places = placesOf(currency)
  return places === 0 ? String(minor) : (minor / 10 ** places).toFixed(places)
}

/** The draft of the stored values (empty where the record holds none). */
export function draftOf(fields: readonly Field[], values: readonly RecordValue[]): Draft {
  const byCode = new Map(values.map((value) => [value.code, value]))
  const draft: Record<string, DraftValue> = {}
  for (const field of fields) {
    const row = byCode.get(field.code)
    const stored = row ? storedOf(row.value) : null
    switch (field.type) {
      case 'MONEY':
        draft[field.code] = isMoneyValue(stored) ? { amount: amountText(stored.amount, stored.currency), currency: stored.currency } : { amount: '', currency: DEFAULT_CURRENCY }
        break
      case 'MULTI_SELECT':
        draft[field.code] = Array.isArray(stored) ? [...(stored as string[])] : []
        break
      case 'PERSON':
      case 'LINK':
      case 'FILE':
        draft[field.code] = { id: typeof stored === 'string' ? stored : null, words: row?.wordsEn ?? null }
        break
      case 'YES_NO':
        draft[field.code] = stored === true ? 'yes' : stored === false ? 'no' : ''
        break
      case 'NUMBER':
        draft[field.code] = typeof stored === 'number' ? String(stored) : ''
        break
      default:
        draft[field.code] = typeof stored === 'string' ? stored : ''
    }
  }
  return draft
}

const DECIMAL = /^-?\d+(?:[.,]\d+)?$/

/** A typed number in either language (`1.234,5` and `1234.5` both read; spaces and thousand dots dropped), or null. */
export function readNumber(text: string): number | null {
  const raw = text.trim().replace(/\s/g, '')
  if (raw === '') return null
  const lastComma = raw.lastIndexOf(',')
  const lastDot = raw.lastIndexOf('.')
  const decimal = lastComma > lastDot ? ',' : '.'
  const thousands = decimal === ',' ? '.' : ','
  const plain = raw.split(thousands).join('').replace(decimal, '.')
  if (!DECIMAL.test(plain)) return null
  const value = Number(plain)
  return Number.isFinite(value) ? value : null
}

/** What one field's draft sends: the value, null (cleared), or why it cannot go (a `cf.check.*` key). */
export function inputOf(field: Field, draft: DraftValue | undefined): { value: StoredValue | null } | { problem: string } {
  const empty = (): { value: null } | { problem: string } => (field.required ? { problem: 'cf.check.required' } : { value: null })
  switch (field.type) {
    case 'TEXT': {
      const text = typeof draft === 'string' ? draft.trim() : ''
      if (text === '') return empty()
      return text.length > FIELD_LIMITS.text ? { problem: 'cf.check.tooLong' } : { value: text }
    }
    case 'NUMBER': {
      const text = typeof draft === 'string' ? draft : ''
      if (text.trim() === '') return empty()
      const value = readNumber(text)
      if (value === null) return { problem: 'cf.check.number' }
      return Math.abs(value) >= 1e15 ? { problem: 'cf.check.tooLarge' } : { value }
    }
    case 'MONEY': {
      const money = draft && typeof draft === 'object' && 'amount' in draft ? draft : { amount: '', currency: DEFAULT_CURRENCY }
      if (money.amount.trim() === '') return empty()
      const currency = money.currency.trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) return { problem: 'cf.check.currency' }
      const value = readNumber(money.amount)
      if (value === null) return { problem: 'cf.check.number' }
      const places = placesOf(currency)
      const minor = Math.round(value * 10 ** places)
      if (Math.abs(minor / 10 ** places - value) > 1e-9) return { problem: 'cf.check.places' }
      return Math.abs(minor) >= 1e15 ? { problem: 'cf.check.tooLarge' } : { value: { amount: minor, currency } }
    }
    case 'DATE': {
      const text = typeof draft === 'string' ? draft : ''
      if (text === '') return empty()
      return isBusinessDate(text) ? { value: text } : { problem: 'cf.check.date' }
    }
    case 'SELECT':
      return typeof draft === 'string' && draft !== '' ? { value: draft } : empty()
    case 'MULTI_SELECT': {
      const codes = Array.isArray(draft) ? (draft as string[]) : []
      if (codes.length === 0) return empty()
      const order = new Map((field.picklist?.values ?? []).map((value) => [value.code, value.sortOrder]))
      return { value: [...codes].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) }
    }
    case 'PERSON':
    case 'LINK':
    case 'FILE': {
      const ref = draft && typeof draft === 'object' && 'id' in draft ? draft : null
      return ref?.id ? { value: ref.id } : empty()
    }
    case 'YES_NO':
      return draft === 'yes' ? { value: true } : draft === 'no' ? { value: false } : empty()
  }
}

/** The section's changes: one entry per changed field (with its version, null when it had none), and the problems by code. */
export function changesOf(fields: readonly Field[], values: readonly RecordValue[], draft: Draft): { entries: ValueEntry[]; problems: Record<string, string> } {
  const byCode = new Map(values.map((value) => [value.code, value]))
  const entries: ValueEntry[] = []
  const problems: Record<string, string> = {}
  for (const field of fields) {
    const row = byCode.get(field.code)
    const stored = row ? storedOf(row.value) : null
    const input = inputOf(field, draft[field.code])
    if ('problem' in input) {
      // A required field left as it was (empty) is the record's own state, not this edit's: only a change is checked.
      if (input.problem === 'cf.check.required' && stored === null) continue
      problems[field.code] = input.problem
      continue
    }
    if (sameStored(stored, input.value)) continue
    entries.push({ code: field.code, value: input.value, version: row?.version ?? null })
  }
  return { entries, problems }
}

/** How many fields the draft changed (the edit bar's count), problems included. */
export const changedCount = (fields: readonly Field[], values: readonly RecordValue[], draft: Draft): number => {
  const { entries, problems } = changesOf(fields, values, draft)
  return entries.length + Object.keys(problems).length
}

/** A stored value in words, as the section reads it. `hidden`: a linked record the reader may not open. */
export function valueWords(field: Field, row: RecordValue | undefined, locale: Locale): { text: string | null; hidden?: boolean; inactive?: boolean } {
  if (!row) return { text: null }
  const stored = storedOf(row.value)
  if (stored === null) return { text: null }
  const words = locale === 'it' ? row.wordsIt : row.wordsEn
  switch (field.type) {
    case 'NUMBER':
      return { text: typeof stored === 'number' ? `${formatNumber(stored, locale, { maximumFractionDigits: 6 })}${field.unit ? ` ${field.unit}` : ''}` : null }
    case 'MONEY':
      return { text: isMoneyValue(stored) ? formatNumber(stored.amount / 10 ** placesOf(stored.currency), locale, { style: 'currency', currency: stored.currency }) : null }
    case 'DATE':
      return { text: typeof stored === 'string' ? formatDate(`${stored}T12:00:00Z`, { locale, timeZone: 'UTC' }) : null }
    case 'SELECT': {
      const option = field.picklist?.values.find((value) => value.code === stored)
      return { text: option ? labelIn(option, locale) : (words ?? String(stored)), inactive: option ? !option.active : false }
    }
    case 'MULTI_SELECT': {
      const codes = Array.isArray(stored) ? (stored as string[]) : []
      const options = codes.map((code) => field.picklist?.values.find((value) => value.code === code))
      return { text: options.map((option, index) => (option ? labelIn(option, locale) : codes[index])).join(', '), inactive: options.some((option) => option && !option.active) }
    }
    case 'PERSON':
    case 'LINK':
    case 'FILE':
      return words ? { text: words } : { text: null, hidden: true }
    case 'YES_NO':
      return { text: stored === true ? 'yes' : 'no' }
    default:
      return { text: typeof stored === 'string' ? stored : null }
  }
}

/** A refused or failed save in our words, and the field it points at (by the order of the entries sent). */
export function saveFaultOf(error: unknown, sent: readonly ValueEntry[]): { key: string; code: string | null } {
  if (!isApiError(error)) return { key: 'cf.fault.failed', code: null }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  const indexed = paths.map((path) => /^body\/values\/(\d+)\/(code|value|version)$/.exec(path)).find((match) => match !== null)
  const code = indexed ? (sent[Number(indexed[1])]?.code ?? null) : null
  switch (error.kind) {
    case 'conflict':
      return { key: paths.includes('refusal/FIELDS') ? 'cf.fault.database' : 'cf.fault.stale', code }
    case 'invalid':
      return { key: indexed?.[2] === 'value' ? 'cf.fault.value' : indexed?.[2] === 'code' ? 'cf.fault.gone' : 'cf.fault.invalid', code }
    case 'forbidden':
      return { key: 'cf.fault.forbidden', code: null }
    case 'not_found':
      return { key: 'cf.fault.notFound', code: null }
    case 'unavailable':
      return { key: 'cf.fault.offline', code: null }
    case 'signed_out':
      return { key: 'cf.fault.signedOut', code: null }
    default:
      return { key: 'cf.fault.failed', code: null }
  }
}
