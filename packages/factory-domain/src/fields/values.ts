import { Dec } from '../tax/decimal'
import { minorUnitsOf } from '../money/currency/currencies'
import { isBusinessDate } from '../core/time'
import { cell, foldWord, readDate } from '../imports/cells'
import type { ExportCell, ExportLocale } from '../views/exports'
import { FIELD_LIMITS, type FieldType } from './rules'

/**
 * A custom field's value (B-W2b-421; PLT-111, PLT-115), pure: what a person sends (JSON from a form, or a cell of an
 * import) checked and turned into the stored shape the database's guard accepts (CustomFieldValue.value, B-W2b-379):
 *
 *   TEXT          a string of 1-4000 characters (trimmed)
 *   NUMBER        a number below 10^15 (the field's unit beside it on screen)
 *   MONEY         { amount: <whole minor units>, currency: "EUR" } — of the field's grain
 *   DATE          a day, YYYY-MM-DD
 *   SELECT        a value code of the field's list
 *   MULTI_SELECT  1-100 value codes of the list, each once, in the list's order
 *   PERSON        an office person (a User id; the API checks it is one)
 *   LINK          a record of the field's linked type (its id; the API checks it exists and its company)
 *   FILE          a file of the record (a StoredFile id; the API checks it is available and the record's)
 *   YES_NO        true or false
 *
 * A code the list has deactivated is refused for a NEW pick and stays where a record has it (PLT-115). Clearing a value
 * is null (the row is removed), never an empty value.
 */

export type MoneyValue = { readonly amount: number; readonly currency: string }
export type StoredValue = string | number | boolean | readonly string[] | MoneyValue

/** A list value as a value check reads it. */
export interface OptionFacts {
  readonly code: string
  readonly active: boolean
  readonly labelIt: string
  readonly labelEn: string
  readonly sortOrder: number
}

export type ValueCheck = { readonly value: StoredValue } | { readonly problem: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURRENCY = /^[A-Z]{3}$/
const NUMBER_LIMIT = 1e15

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function isMoneyValue(value: unknown): value is MoneyValue {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2 && keys[0] === 'amount' && keys[1] === 'currency' && Number.isSafeInteger(value.amount) && Math.abs(value.amount as number) < NUMBER_LIMIT && typeof value.currency === 'string' && CURRENCY.test(value.currency)
}

/**
 * A value as a person sends it, checked for the field: the stored value, or the problem in words. `options` = the
 * field's list (SELECT, MULTI_SELECT); `current` = the record's value now (a deactivated code it holds stays allowed).
 */
export function checkValue(field: { readonly type: FieldType; readonly options?: readonly OptionFacts[] }, input: unknown, current: StoredValue | null = null): ValueCheck {
  switch (field.type) {
    case 'TEXT': {
      if (typeof input !== 'string') return { problem: 'Expected text.' }
      const text = input.trim()
      if (text === '') return { problem: 'Leave the field empty instead of blank text.' }
      if (text.length > FIELD_LIMITS.text) return { problem: `At most ${FIELD_LIMITS.text} characters.` }
      return { value: text }
    }
    case 'NUMBER':
      if (typeof input !== 'number' || !Number.isFinite(input)) return { problem: 'Expected a number.' }
      if (Math.abs(input) >= NUMBER_LIMIT) return { problem: 'The number is too large.' }
      return { value: input }
    case 'MONEY':
      return isMoneyValue(input) ? { value: { amount: input.amount, currency: input.currency } } : { problem: 'Expected an amount in whole minor units and its currency ({"amount": 89900, "currency": "EUR"}).' }
    case 'DATE':
      return isBusinessDate(input) ? { value: input } : { problem: 'Expected a day (2026-12-31).' }
    case 'YES_NO':
      return typeof input === 'boolean' ? { value: input } : { problem: 'Expected yes or no.' }
    case 'SELECT': {
      if (typeof input !== 'string') return { problem: 'Expected a value of the list.' }
      const option = (field.options ?? []).find((entry) => entry.code === input)
      if (!option) return { problem: `${input} is not a value of the list.` }
      if (!option.active && current !== input) return { problem: `${input} is no longer offered: pick an active value.` }
      return { value: input }
    }
    case 'MULTI_SELECT': {
      if (!Array.isArray(input) || input.length === 0 || input.some((entry) => typeof entry !== 'string')) return { problem: 'Expected one or more values of the list.' }
      const codes = input as string[]
      if (codes.length > FIELD_LIMITS.multi) return { problem: `At most ${FIELD_LIMITS.multi} values.` }
      if (new Set(codes).size !== codes.length) return { problem: 'Each value once.' }
      const held = new Set(Array.isArray(current) ? (current as string[]) : [])
      const byCode = new Map((field.options ?? []).map((entry) => [entry.code, entry]))
      for (const code of codes) {
        const option = byCode.get(code)
        if (!option) return { problem: `${code} is not a value of the list.` }
        if (!option.active && !held.has(code)) return { problem: `${code} is no longer offered: pick an active value.` }
      }
      return { value: [...codes].sort((a, b) => byCode.get(a)!.sortOrder - byCode.get(b)!.sortOrder || (a < b ? -1 : 1)) }
    }
    case 'PERSON':
    case 'LINK':
    case 'FILE':
      return typeof input === 'string' && UUID.test(input) ? { value: input.toLowerCase() } : { problem: field.type === 'PERSON' ? 'Expected a person.' : field.type === 'LINK' ? 'Expected a record.' : 'Expected a file of this record.' }
  }
}

/** Two stored values are the same (a multi-select's codes in any order; an amount and its currency). */
export function sameStored(a: StoredValue | null, b: StoredValue | null): boolean {
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    const set = new Set(a as string[])
    return (b as string[]).every((code) => set.has(code))
  }
  if (isMoneyValue(a) || isMoneyValue(b)) return isMoneyValue(a) && isMoneyValue(b) && a.amount === b.amount && a.currency === b.currency
  return a === b
}

/** A stored value read back from the database's JSON, or null when it is not one of the shapes above. */
export function storedOf(value: unknown): StoredValue | null {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[]
  return isMoneyValue(value) ? value : null
}

// ---- imports --------------------------------------------------------------------------------------------------------

/**
 * What an import cell of a custom field asks for, before the API resolves the references: the value as checkValue takes
 * it, or `{ ref }` for what the database must find (a person's e-mail, a linked record's code or number), or the problem.
 * A number and an amount have columns of their own (parsed in the job's number format): not this text.
 */
export type ImportInput = { readonly input: unknown } | { readonly ref: string } | { readonly problem: string }

const optionByWord = (options: readonly OptionFacts[], word: string): OptionFacts | undefined => {
  const folded = foldWord(word)
  return options.find((entry) => foldWord(entry.code) === folded) ?? options.find((entry) => foldWord(entry.labelIt) === folded || foldWord(entry.labelEn) === folded)
}

export function importInput(field: { readonly type: FieldType; readonly options?: readonly OptionFacts[] }, text: string): ImportInput {
  const raw = text.trim()
  switch (field.type) {
    case 'TEXT':
      return { input: raw }
    case 'NUMBER':
      return { problem: 'A number field takes its number in the Number column.' }
    case 'MONEY':
      return { problem: 'A money field takes its amount in the column of its grain (Price, Cost …) and the currency beside it.' }
    case 'DATE': {
      const day = readDate(raw)
      return day === null ? { problem: 'Expected a date like 31/12/2026 or 2026-12-31.' } : { input: day }
    }
    case 'YES_NO': {
      const parsed = cell.boolean().safeParse({ raw, context: { numberFormat: 'it' } })
      return parsed.success ? { input: parsed.data } : { problem: 'Expected sì or no (yes or no).' }
    }
    case 'SELECT': {
      const option = optionByWord(field.options ?? [], raw)
      return option ? { input: option.code } : { problem: `${raw} is not a value of the list: give its code or its label.` }
    }
    case 'MULTI_SELECT': {
      const words = raw.split(/[,|]/).map((word) => word.trim()).filter((word) => word !== '')
      const codes: string[] = []
      for (const word of words) {
        const option = optionByWord(field.options ?? [], word)
        if (!option) return { problem: `${word} is not a value of the list: give codes or labels separated by commas.` }
        codes.push(option.code)
      }
      return { input: codes }
    }
    case 'PERSON':
    case 'LINK':
      return raw === '' ? { problem: 'Expected a value.' } : { ref: field.type === 'PERSON' ? raw.toLowerCase() : raw }
    case 'FILE':
      return { problem: 'A file is added on the record itself, not by an import.' }
  }
}

/** An amount of an import (a plain decimal) in whole minor units of its currency, or the problem. */
export function minorOfImport(decimal: string, currency: string): { readonly amount: number } | { readonly problem: string } {
  if (!CURRENCY.test(currency)) return { problem: 'Give the currency as its three letters (EUR).' }
  const places = minorUnitsOf(currency)
  const minor = new Dec(decimal).times(new Dec(10).pow(places))
  if (!minor.isInteger()) return { problem: `At most ${places} decimals in ${currency}.` }
  if (minor.abs().greaterThanOrEqualTo(NUMBER_LIMIT)) return { problem: 'The amount is too large.' }
  return { amount: Number.parseInt(minor.toFixed(0), 10) }
}

/** An amount in minor units as the import cell writes it back (a plain decimal), for the dry run's comparison. */
export function decimalOfMinor(value: MoneyValue): string {
  const places = minorUnitsOf(value.currency)
  return new Dec(value.amount).dividedBy(new Dec(10).pow(places)).toFixed(places)
}

// ---- display --------------------------------------------------------------------------------------------------------

/** The words a value's references need, resolved by the API: a person's name, a record's code, a file's name. */
export type ReferenceWords = (id: string) => string | null

const YES: Readonly<Record<ExportLocale, string>> = { it: 'Sì', en: 'Yes' }
const NO: Readonly<Record<ExportLocale, string>> = { it: 'No', en: 'No' }

/** A value as a file's cell (an export): text, a number, a day, an amount with its currency, words of codes. */
export function exportCellOf(field: { readonly type: FieldType; readonly options?: readonly OptionFacts[] }, value: StoredValue | null, locale: ExportLocale, words: ReferenceWords): ExportCell {
  if (value === null) return null
  const label = (code: string) => {
    const option = (field.options ?? []).find((entry) => entry.code === code)
    return option ? (locale === 'it' ? option.labelIt : option.labelEn) : code
  }
  switch (field.type) {
    case 'TEXT':
      return typeof value === 'string' ? value : null
    case 'NUMBER':
      return typeof value === 'number' ? value : null
    case 'MONEY':
      return isMoneyValue(value) ? { minor: value.amount, currency: value.currency } : null
    case 'DATE':
      return typeof value === 'string' ? { day: value } : null
    case 'YES_NO':
      return typeof value === 'boolean' ? (value ? YES[locale] : NO[locale]) : null
    case 'SELECT':
      return typeof value === 'string' ? label(value) : null
    case 'MULTI_SELECT':
      return Array.isArray(value) ? (value as string[]).map(label).join(', ') : null
    case 'PERSON':
    case 'LINK':
    case 'FILE':
      return typeof value === 'string' ? (words(value) ?? null) : null
  }
}
