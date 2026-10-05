/**
 * E3 (product-sheet consistency wave 3, 2026-10-05) — ONE sentence for "this value is not on the list".
 *
 * There were four: `Season contains an unaccepted value. Allowed values: …` (the channel validator),
 * `Season: must be equal to one of the allowed values (…)` (Ajv's enum, raw codes), `"X" is not in the list for
 * Season (…). Saved as it is…` (a formula) and `"X" is not in the channel's list — it may be rejected at publish` (the
 * sheet cell, also on Shared lists, and the AI-draft check). Now every one of them is this:
 *
 *   channel  `Season: "Tutte le stagioni" is not on eBay's list. eBay may refuse it. Allowed: Estate, Inverno, … (12 in all).`
 *   Shared   `Season: "Tutte le stagioni" is not one of this column's options. Allowed: …`
 *   formula  the same, with `Saved as it is.` after the first sentence.
 *
 * Such a value is a FLAG (saved, named, held at publish), never a refusal to save — `isOffListMessage` is how a reader
 * of the sentence tells it apart from a refusal, and it keeps recognising the older wordings: stored findings and
 * readiness rows written before this change still carry them.
 *
 * The design system keeps a copy of the sentence (`grid/editors/sheet.ts`, `offListSentence`) because the factory app
 * cannot import packages; `sheet.vitest.test.ts` in the web app pins the two equal.
 */
import { channelLabel } from './channel-label.js'

/** How many allowed values a sentence names before it says how many there are in all. */
export const OFF_LIST_SHOWN = 8

export interface OffListMessageInput {
  /** The column's name as the sheet header shows it. Absent = no `Field:` prefix. */
  field?: string | null
  /** The value or values that are not on the list, as written. */
  values: readonly unknown[]
  /**
   * The channel whose list it is (a code such as `EBAY` or a name such as `eBay`): the channel wording. Absent = the
   * Shared wording — the column's own options, whichever channels supplied them.
   */
  channel?: string | null
  /** Channel wording only: the list is closed, so the channel may refuse the value. Default true. */
  mayRefuse?: boolean
  /** The allowed values as the operator reads them (labels, not codes). Absent or empty = not listed. */
  allowed?: readonly string[] | null
  /** The value was stored anyway (a formula result): `Saved as it is.` */
  saved?: boolean
}

/** `Estate, Inverno` — or the first {@link OFF_LIST_SHOWN} and how many in all, never a list that pretends to be whole. */
export function allowedValuesText(allowed: readonly string[] | null | undefined): string {
  const unique = [...new Set(allowed ?? [])]
  if (unique.length <= OFF_LIST_SHOWN) return unique.join(', ')
  return `${unique.slice(0, OFF_LIST_SHOWN).join(', ')}, … (${unique.length} in all)`
}

export function offListMessage(input: OffListMessageInput): string {
  // A record (a measure, a structured value) reads as its JSON, never as `[object Object]`.
  const values = input.values.map(value => JSON.stringify(value !== null && typeof value === 'object' ? value : String(value)))
  const many = values.length > 1
  const channel = input.channel ? channelLabel(input.channel) : ''
  const subject = values.length ? values.join(', ') : input.field ? 'the value' : 'The value'
  const where = channel ? `not on ${channel}'s list` : many ? "not among this column's options" : "not one of this column's options"
  const sentences = [`${input.field ? `${input.field}: ` : ''}${subject} ${many ? 'are' : 'is'} ${where}.`]
  if (input.saved) sentences.push('Saved as it is.')
  if (channel && input.mayRefuse !== false) sentences.push(`${channel} may refuse ${many ? 'them' : 'it'}.`)
  const allowed = allowedValuesText(input.allowed)
  if (allowed) sentences.push(`Allowed: ${allowed}.`)
  return sentences.join(' ')
}

/** The sentences above. Each wording is matched on its own words, so no other finding ("is required", a cap) reads as one. */
const OFF_LIST = /(?:is|are) not on .+'s list\.|is not one of this column's options\.|are not among this column's options\./
/**
 * The wordings before E3, still in stored findings: the channel validator's, Ajv's `enum` keyword (also what
 * `validateSchemaAttributes` returns raw) and a Shopify `choices` rule (`validateShopifyField`, unchanged).
 */
const LEGACY_OFF_LIST = /contains an unaccepted value\. Allowed values:|must be equal to one of the allowed values|Choose one of these values: /

/** True when the sentence says a value is off a list — a FLAG, never a refusal. */
export function isOffListMessage(message: string): boolean {
  return OFF_LIST.test(message) || LEGACY_OFF_LIST.test(message)
}

/** A finding prefixed with its field name, unless the sentence already starts with it (`Season: "X" is not on eBay's list…`). */
export const withFieldName = (name: string, message: string): string => message.startsWith(`${name}:`) ? message : `${name}: ${message}`
