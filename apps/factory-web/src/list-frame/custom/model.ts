import { isMoneyValue, storedOf } from '@nexus/factory-domain/fields/values'
import { minorUnitsOf } from '@nexus/factory-domain/money/currency/currencies'
import { formatDate, formatNumber } from '../../lib/i18n/format'
import type { Locale } from '../../lib/i18n/locales'
import type { ListField, ListFieldValue } from '../tools/transport'
import type { BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import type { ListEditField } from '../w2b/model'

/**
 * B-TH-241 (threads plan TH-4, SHEET-G04; features SHEET.brand-fields-F02 custom columns in the grid, -F05 in the file; wall W17):
 * the custom columns of the ONE list frame, pure. A list that asks (`ListFrame.custom`) gets its record type's custom fields as
 * columns `cf:<code>` (the API's column id: the export engine writes them, and leaves a money one out for a person without its
 * grain), hidden until a view shows them (an opt-in column: list-frame/tools model), their values read for the loaded rows only
 * while one of them is in view (`POST /fields/rows/:recordType`, 200 ids a read). A field for one customer shows its value on
 * that customer's rows only — the API answers so, and the frame holds to it again by the row's customer (`partyOf`).
 */

/** What a list asks of the frame (absent: no custom columns, the list exactly as before). */
export interface ListCustom<T> {
  /** The fields registry's record type (apps/factory-api platform/fields records.ts: `ORDER`, `CUSTOMER`, `QUOTE` …). */
  readonly recordType: string
  /** One company's sheet: its fields and every company's. */
  readonly companyId?: string | null
  /** One customer's sheet: its own fields and every customer's (never another customer's: the API's answer). */
  readonly partyId?: string | null
  /** A row's customer: a field for one customer shows nothing on another customer's row. */
  readonly partyOf?: (row: T) => string | null
  // ── B-TH-245 (threads plan TH-4, SHEET-G09; SHEET.brand-fields-F03, -F08) ──
  /** A field for one customer is a column only on that customer's own list (`partyId` given): never on a list of every customer. */
  readonly partyFieldsOnPartySheet?: boolean
  /**
   * The custom values edit in their cells (and in Edit N) through the list's bulk target, when the list itself edits (`edit`):
   * TEXT, NUMBER, DATE, SELECT and YES_NO; `held` says why a row keeps them (a closed order), in the list's words.
   */
  readonly edit?: { readonly held?: (row: T) => string | null } | null
  // ── end B-TH-245 ──
}

/** The most ids one read of the values takes (platform/fields FIELD_LIMITS.perRequest). */
export const CUSTOM_BATCH = 200

/** A custom column's id is the field's column id (`cf:<code>`, `cf:<grain>:<code>`). */
export const isCustomColumnId = (id: string): boolean => id.startsWith('cf:')

/** The field's name in the person's language. */
export const fieldLabel = (field: Pick<ListField, 'labelIt' | 'labelEn'>, locale: Locale): string => (locale === 'it' ? field.labelIt : field.labelEn) || field.labelEn || field.labelIt

/** May the row show the field's value? A field for every customer: yes; a field for one customer: only on that customer's row. */
export function fieldOnRow(field: Pick<ListField, 'partyId'>, rowParty: string | null | undefined): boolean {
  if (field.partyId === null) return true
  // Without the row's customer the API's answer stands (it sends a customer's values on that customer's records only).
  if (rowParty === undefined) return true
  return rowParty === field.partyId
}

/** The ids still to read (neither read nor being read), in chunks the API takes. */
export function idsToRead(ids: readonly string[], known: ReadonlySet<string>, reading: ReadonlySet<string>): string[][] {
  const wanted = [...new Set(ids)].filter((id) => !known.has(id) && !reading.has(id))
  const chunks: string[][] = []
  for (let start = 0; start < wanted.length; start += CUSTOM_BATCH) chunks.push(wanted.slice(start, start + CUSTOM_BATCH))
  return chunks
}

const placesOf = (currency: string): number => {
  try {
    return minorUnitsOf(currency)
  } catch {
    return 2
  }
}

/**
 * A value as its cell shows it: a select's label (a deactivated one too), a number with its unit, a date in the person's language,
 * money in its currency, yes / no (`yes` | `no`: the frame says them in its words), a person's or record's words from the API
 * (null: nothing, or a record the reader may not open).
 */
export function cellWords(field: ListField, value: ListFieldValue | undefined, locale: Locale): { text: string | null; yesNo?: 'yes' | 'no' } {
  if (!value) return { text: null }
  const stored = storedOf(value.value)
  if (stored === null) return { text: null }
  const words = locale === 'it' ? value.wordsIt : value.wordsEn
  const option = (code: string) => field.options.find((entry) => entry.code === code)
  switch (field.type) {
    case 'NUMBER':
      return { text: typeof stored === 'number' ? `${formatNumber(stored, locale, { maximumFractionDigits: 6 })}${field.unit ? ` ${field.unit}` : ''}` : null }
    case 'MONEY':
      return { text: isMoneyValue(stored) ? formatNumber(stored.amount / 10 ** placesOf(stored.currency), locale, { style: 'currency', currency: stored.currency }) : null }
    case 'DATE':
      return { text: typeof stored === 'string' ? formatDate(`${stored}T12:00:00Z`, { locale, timeZone: 'UTC' }) : null }
    case 'SELECT': {
      const found = typeof stored === 'string' ? option(stored) : undefined
      return { text: found ? fieldLabel(found, locale) : (words ?? (typeof stored === 'string' ? stored : null)) }
    }
    case 'MULTI_SELECT': {
      const codes = Array.isArray(stored) ? stored.filter((code): code is string => typeof code === 'string') : []
      return { text: codes.length === 0 ? null : codes.map((code) => { const found = option(code); return found ? fieldLabel(found, locale) : code }).join(', ') }
    }
    case 'PERSON':
    case 'LINK':
    case 'FILE':
      return { text: words }
    case 'YES_NO':
      return { text: null, yesNo: stored === true ? 'yes' : 'no' }
    default:
      return { text: typeof stored === 'string' ? stored : typeof stored === 'number' ? String(stored) : null }
  }
}

/** The custom columns a layout shows (the opt-in rule: the layout orders them and does not hide them). */
export function shownCustomIds(columns: ReadonlyArray<{ readonly colId?: string | undefined; readonly hide?: boolean | null | undefined }>): string[] {
  return columns.filter((column) => typeof column.colId === 'string' && isCustomColumnId(column.colId) && !column.hide).map((column) => column.colId as string)
}

/**
 * Where the custom columns go among the list's own: before a trailing ⋯ column pinned right (it stays the last), else at the end.
 */
export function withCustomColumns<C extends { readonly pinned?: unknown }>(own: readonly C[], custom: readonly C[]): C[] {
  if (custom.length === 0) return [...own]
  const last = own[own.length - 1]
  if (last && last.pinned === 'right') return [...own.slice(0, -1), ...custom, last]
  return [...own, ...custom]
}

// ── B-TH-245 (threads plan TH-4, SHEET-G09; features SHEET.brand-fields-F03 edit in a cell, -F08 Edit N; wall W17) ──
/** The fields a list draws: on a list of every customer, a field for one customer only when the list allows it (W17, SHEET-G06). */
export function fieldsForList<F extends Pick<ListField, 'partyId'>>(found: readonly F[], partyId: string | null, partyFieldsOnPartySheet: boolean): F[] {
  return partyFieldsOnPartySheet && !partyId ? found.filter((field) => field.partyId === null) : [...found]
}

/** The custom field types a cell edits (apps/factory-api platform/views/bulk/targets/sales-orders.ts IN_CELL); the rest open the record. */
export const IN_CELL_TYPES: readonly string[] = Object.freeze(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'YES_NO'])

/** A stored value as a cell holds it for the bulk target: a select's code, a number, a day, a text; yes / no as YES / NO. */
export function cellValueOf(field: Pick<ListField, 'type'>, value: ListFieldValue | undefined): BulkValue {
  const stored = value ? storedOf(value.value) : null
  if (stored === null || stored === undefined) return null
  if (field.type === 'YES_NO') return stored === true ? 'YES' : 'NO'
  return typeof stored === 'string' || typeof stored === 'number' ? stored : null
}

/** A cell's saved value back as the field stores it (YES / NO as true / false; nothing: no value). */
export function storedOfCell(field: Pick<ListField, 'type'>, value: BulkValue): unknown {
  if (value === null) return null
  return field.type === 'YES_NO' ? value === 'YES' : value
}

/**
 * A custom field as an edit field of the frame (null: it does not edit in a cell). W17: a field for one customer is held on another
 * customer's row (the API refuses the same), with the frame's words.
 */
export function editFieldOf<T>(field: ListField, input: { valueOf: (row: T) => BulkValue; partyOf?: (row: T) => string | null; held?: (row: T) => string | null; label: string; words: { notThisCustomer: string; yes: string; no: string } }, locale: Locale): ListEditField<T> | null {
  if (!IN_CELL_TYPES.includes(field.type)) return null
  const held = (row: T): string | null => input.held?.(row) ?? (field.partyId !== null && input.partyOf && input.partyOf(row) !== field.partyId ? input.words.notThisCustomer : null)
  const base = { valueOf: input.valueOf, label: input.label, nullable: true, held }
  switch (field.type) {
    case 'NUMBER':
      return { ...base, kind: 'number' }
    case 'DATE':
      return { ...base, kind: 'date' }
    case 'SELECT': {
      const offered = field.options.filter((option) => option.active)
      return { ...base, kind: 'choice', choices: offered.map((option) => option.code), choiceLabels: Object.fromEntries(field.options.map((option) => [option.code, fieldLabel(option, locale)])) }
    }
    case 'YES_NO':
      return { ...base, kind: 'choice', choices: ['YES', 'NO'], choiceLabels: { YES: input.words.yes, NO: input.words.no } }
    default:
      return { ...base, kind: 'text', maxLength: 2000 }
  }
}
// ── end B-TH-245 ──
