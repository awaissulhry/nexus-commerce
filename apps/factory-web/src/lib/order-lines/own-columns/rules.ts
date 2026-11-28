import type { OwnColumn, OwnColumnKind, OwnValue } from '../schema'

/**
 * owb-po3.3 (design § 5zi C, prototype oplus.js `LC_TYPES`, `LC_SUGGEST`, `LC_MAX`, `lcAdd`, `lcToggle`, `lcClean`) — "Columns of your
 * own", pure. A column is the customer's; each order says which ones it uses (at most 8). The rules (the server keeps them too; these
 * say them in words BEFORE a write, on leaving the field): a name 1–40, never twice among the customer's open columns (case-free),
 * never a fixed column's name (EN + IT), a choice needs two choices, a column with a value asks before it goes off this order, a
 * column is never deleted (closed, kept). No React, no API.
 */

/** At most this many columns on ONE order (design `LC_MAX`). */
export const OWN_COLUMNS_MAX = 8
/** The name's length (the server's rule). */
export const OWN_COLUMN_NAME_MAX = 40
/** A choice column's choices: 2 to 12, each up to 40 characters. */
export const OWN_CHOICES = Object.freeze({ min: 2, max: 12, length: 40 })
/** A text value's length. */
export const OWN_TEXT_MAX = 200

/** The fixed columns of the table, in both languages: a column of your own never takes one of these names. */
export const FIXED_COLUMN_NAMES: readonly string[] = Object.freeze([
  'model', 'material', 'sizes', 'pieces', 'your price', 'line', 'picture',
  'modello', 'materiale', 'taglie', 'pezzi', 'il vostro prezzo', 'vostro prezzo', 'riga', 'immagine',
])

/** The kinds in the window's order, each with its word key and its lucide icon name. */
export const OWN_KINDS: readonly { readonly kind: OwnColumnKind; readonly key: string }[] = Object.freeze([
  { kind: 'TEXT', key: 'own.kind.TEXT' },
  { kind: 'YES_NO', key: 'own.kind.YES_NO' },
  { kind: 'CHOICE', key: 'own.kind.CHOICE' },
  { kind: 'NUMBER', key: 'own.kind.NUMBER' },
  { kind: 'DATE', key: 'own.kind.DATE' },
])

/** The often used ones, one press each (design `LC_SUGGEST`): the name and the choices come from the words in the page's language. */
export interface QuickColumn {
  readonly id: 'remake' | 'sizing' | 'nameOn' | 'comment' | 'neededBy'
  readonly kind: OwnColumnKind
  /** Word keys of its choices (CHOICE only). */
  readonly choiceKeys: readonly string[]
}
export const QUICK_COLUMNS: readonly QuickColumn[] = Object.freeze([
  { id: 'remake', kind: 'YES_NO', choiceKeys: [] },
  { id: 'sizing', kind: 'CHOICE', choiceKeys: ['own.quickChoice.standard', 'own.quickChoice.mtm'] },
  { id: 'nameOn', kind: 'TEXT', choiceKeys: [] },
  { id: 'comment', kind: 'TEXT', choiceKeys: [] },
  { id: 'neededBy', kind: 'DATE', choiceKeys: [] },
])

const fold = (text: string): string => text.trim().toLocaleLowerCase()

/** The choices typed "with a comma between them": trimmed, each once (case-free), cut to the limits. */
export function choicesOf(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(',')) {
    const word = part.trim().slice(0, OWN_CHOICES.length)
    if (word !== '' && !out.some((each) => fold(each) === fold(word))) out.push(word)
  }
  return out.slice(0, OWN_CHOICES.max)
}

/** The customer's open columns (closed ones are kept, never offered as new). */
export const openColumns = (columns: readonly OwnColumn[]): OwnColumn[] => columns.filter((column) => !column.closed)

/**
 * Why a new column cannot be made (a word key), or null — said on leaving the name field and again on "Add the column":
 * no name · too long · a fixed column's name · the same name twice · a choice with fewer than two choices.
 */
export function newColumnProblem(input: { readonly name: string; readonly kind: OwnColumnKind; readonly choices: string }, columns: readonly OwnColumn[]): string | null {
  const name = input.name.trim()
  if (name === '') return 'own.refused.name'
  if (name.length > OWN_COLUMN_NAME_MAX) return 'own.refused.long'
  if (FIXED_COLUMN_NAMES.includes(fold(name))) return 'own.refused.fixed'
  if (openColumns(columns).some((column) => fold(column.name) === fold(name))) return 'own.refused.twice'
  if (input.kind === 'CHOICE' && choicesOf(input.choices).length < OWN_CHOICES.min) return 'own.refused.choices'
  return null
}

/** This order may take one more column (≤ 8 used). */
export const roomForColumn = (usedIds: readonly string[]): boolean => usedIds.length < OWN_COLUMNS_MAX

/** A value that counts (a "no" counts: it was said; an empty text does not). */
export const hasOwnValue = (value: OwnValue['value'] | undefined): boolean => value !== null && value !== undefined && value !== ''

/** What switching a column off THIS order does: on → off with a value on any line asks first ("ask"); otherwise it goes ("go"). */
export function switchOff(columnId: string, values: Readonly<Record<string, Readonly<Record<string, Pick<OwnValue, 'value'>>>>>): 'ask' | 'go' {
  return Object.values(values).some((line) => hasOwnValue(line[columnId]?.value)) ? 'ask' : 'go'
}

/** The used ids after a switch: on adds it last (room permitting), off takes it out; the order of the others stays. */
export function toggledColumns(usedIds: readonly string[], columnId: string): string[] | null {
  if (usedIds.includes(columnId)) return usedIds.filter((id) => id !== columnId)
  return roomForColumn(usedIds) ? [...usedIds, columnId] : null
}

/**
 * A typed value cleaned for its column, or why it is refused (a word key) — said on leaving the cell; the value from before comes
 * back. '' = empty (null). Text ≤ 200; a number (a decimal comma is read); a date YYYY-MM-DD; yes / no; a choice among its choices.
 */
export function cleanOwnValue(column: Pick<OwnColumn, 'kind' | 'choices'>, raw: string): { readonly value: OwnValue['value'] } | { readonly problem: string } {
  const text = raw.trim()
  if (text === '') return { value: null }
  switch (column.kind) {
    case 'TEXT':
      return text.length > OWN_TEXT_MAX ? { problem: 'own.refused.text' } : { value: text }
    case 'NUMBER': {
      const normal = text.replace(/\s/g, '').replace(',', '.')
      const number = /^-?\d+(\.\d+)?$/.test(normal) ? Number(normal) : Number.NaN
      return Number.isFinite(number) ? { value: number } : { problem: 'own.refused.number' }
    }
    case 'DATE':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T12:00:00Z`)) ? { value: text } : { problem: 'own.refused.date' }
    case 'YES_NO':
      return text === 'yes' ? { value: true } : text === 'no' ? { value: false } : { problem: 'own.refused.yesNo' }
    case 'CHOICE':
      return column.choices.includes(text) ? { value: text } : { problem: 'own.refused.choice' }
  }
}

/** A value as a field holds it (the reverse of `cleanOwnValue`): '' · 'yes' / 'no' · the number · the date · the text. */
export function ownValueText(value: OwnValue['value'] | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}
