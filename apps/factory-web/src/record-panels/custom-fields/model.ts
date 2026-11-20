import { isBusinessDate } from '@nexus/factory-domain/core/time'
import { FIELD_LIMITS } from '@nexus/factory-domain/fields/rules'
import { isMoneyValue, sameStored, storedOf, type StoredValue } from '@nexus/factory-domain/fields/values'
import { minorUnitsOf } from '@nexus/factory-domain/money/currency/currencies'
import { isApiError, issuePath } from '../../lib/api/errors'
import { formatDate, formatNumber } from '../../lib/i18n/format'
import type { Locale } from '../../lib/i18n/locales'
import type { Field, RecordKey } from '../../areas/admin/fields/api'
import { labelIn } from '../../areas/admin/fields/model'
import { previewSections } from '../../areas/admin/fields/model' // F-OO-212
import type { RecordValue, RecordValues, ValueEntry } from './api'

/**
 * The custom-fields section on every record (B-W2b-431; design admin.fields "The record panels show a custom-fields
 * section" — since B-TH-280 at the end of the record frame's first tab), pure: which records have one, a value in words, the draft of the section's edit and what it sends, and the
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

// ---- F-OO-212 (order overview 11-design §8.2; review F9): the section as read — only the filled rows, the empty ones folded ----------

/** The section as read: each section with only its filled fields (a section with none is left out), and the fields with no value. */
export interface FoldedRead {
  readonly sections: readonly { readonly section: string; readonly fields: readonly Field[] }[]
  /** No value stored, in the sections' order: folded into one line ("Not filled: Fair date (required)"). */
  readonly empty: readonly Field[]
}

/**
 * A field with a value stored is a row — also one the reader may not see in words ("Not visible to you", "A record you may not open");
 * a field with none folds into the one "Not filled" line. Edit mode still lists every field (the panel's own).
 */
export function foldedRead(fields: readonly Field[], values: readonly RecordValue[]): FoldedRead {
  const byCode = new Map(values.map((value) => [value.code, value]))
  const filled = (field: Field): boolean => {
    const row = byCode.get(field.code)
    const stored = row ? storedOf(row.value) : null
    // An empty text or list (an older import) says nothing either: it folds too.
    return stored !== null && stored !== '' && !(Array.isArray(stored) && stored.length === 0)
  }
  const all = previewSections(fields)
  return {
    sections: all.map((section) => ({ section: section.section, fields: section.fields.filter(filled) })).filter((section) => section.fields.length > 0),
    empty: all.flatMap((section) => section.fields.filter((field) => !filled(field))),
  }
}

/**
 * Who reads a field shown in the portal on this record type — the tag on its label (a `cf.portal.*` key): the customer on a quote or an
 * order, the supplier on a purchase order, the partner itself on a party (the customer's and the supplier's page read one set of
 * fields); none where the portal reads nothing (style, material, lot, work order: the admin holds "Shown in the portal" there).
 */
export function portalTagOf(recordType: RecordKey | null): string | null {
  switch (recordType) {
    case 'QUOTE':
    case 'ORDER':
      return 'cf.portal.customer'
    case 'PURCHASE_ORDER':
      return 'cf.portal.supplier'
    case 'CUSTOMER':
    case 'SUPPLIER':
      return 'cf.portal.party'
    default:
      return null
  }
}
// ---- end F-OO-212

/**
 * A refused or failed save in our words, and the field it points at (by the order of the entries sent).
 * F-OO-213 (B-OO-014): and the RECORD's own refusals (`record`): 'stale' — its own version moved since it was read (a sales order
 * someone changed first: the panel offers Save again / Discard mine, the draft kept), 'final' — it never changes again (a closed or
 * cancelled order: said in the words that hold Edit).
 */
export function saveFaultOf(error: unknown, sent: readonly ValueEntry[]): { key: string; code: string | null; record?: 'stale' | 'final' } {
  if (!isApiError(error)) return { key: 'cf.fault.failed', code: null }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  const indexed = paths.map((path) => /^body\/values\/(\d+)\/(code|value|version)$/.exec(path)).find((match) => match !== null)
  const code = indexed ? (sent[Number(indexed[1])]?.code ?? null) : null
  // ---- F-OO-213: the record's own refusals come first (a closed order: invalid_state; the order's version: the issue `version`) ----
  if (error.kind === 'conflict' && error.code === 'invalid_state') return { key: 'cf.heldFinal', code: null, record: 'final' }
  if (error.kind === 'conflict' && paths.includes('version')) return { key: 'cf.recordChanged', code: null, record: 'stale' }
  // ---- end F-OO-213
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

// ---- F-OO-213 (order overview 11-design §8.3; B-OO-014): the record's own version with its values — the lost update vs the Orders sheet --

/**
 * The record version a save sends: none unless the page gives one (only the order page does: every other record page behaves as
 * before); else the newer of the page's read of the record and the section's own last read of it (both this person's reads, and a
 * version only grows) — so a save right after the page's own change (Set priority…) or after Discard mine is not refused for nothing.
 */
export function sentRecordVersion(given: number | undefined, read: number | null | undefined): number | undefined {
  if (given === undefined) return undefined
  return typeof read === 'number' && read > given ? read : given
}

/** What Save again does, after "Someone changed {record} first": send the same changes at the version read again, or why not. */
export type SaveAgain = { readonly kind: 'send'; readonly recordVersion: number | undefined } | { readonly kind: 'changed'; readonly codes: readonly string[] } | { readonly kind: 'final' }

/**
 * Save again (Keep mine): the record read again (`fresh`) — closed or cancelled meanwhile: 'final'; one of the fields this edit changes
 * was saved by someone meanwhile (its value's version moved, or the field is gone): 'changed', naming them (the draft is never sent over
 * a colleague's value); else 'send' — the same entries (each at the version first read, unchanged since) at the record's new version.
 */
export function saveAgainOf(sent: readonly ValueEntry[], fresh: Pick<RecordValues, 'fields' | 'values' | 'editHeld' | 'recordVersion'>): SaveAgain {
  if (fresh.editHeld === 'FINAL') return { kind: 'final' }
  const known = new Set(fresh.fields.map((field) => field.code))
  const versions = new Map(fresh.values.map((value) => [value.code, value.version]))
  const codes = sent.filter((entry) => !known.has(entry.code) || (versions.get(entry.code) ?? null) !== entry.version).map((entry) => entry.code)
  if (codes.length > 0) return { kind: 'changed', codes }
  return { kind: 'send', recordVersion: typeof fresh.recordVersion === 'number' ? fresh.recordVersion : undefined }
}
// ---- end F-OO-213
