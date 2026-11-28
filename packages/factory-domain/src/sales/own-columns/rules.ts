/**
 * The customer's own columns on order lines (owb- order workflow, S1 po1.4; design order-workflow § 5zi C "Columns of your own", R62 a;
 * build PL-schema § 5A row 5, guard G8). A customer keeps a few columns of its own ("Rider number", "Logo ready?") and uses them on
 * the lines of its drafts and orders beside the fixed ones. The rules, pure (the database's G8 holds the shapes as the last word):
 *
 *   a column    a name of 1 to 40 characters, never twice among the customer's OPEN columns (whatever the case), never a fixed
 *               column's name (EN or IT); a kind TEXT · YES_NO · CHOICE · NUMBER · DATE; a CHOICE column has at least 2 choices
 *               (each once, 1 to 40 characters), every other kind none. Never deleted: closed, and kept with its values.
 *   on a record at most 8 columns USED on one draft or order, each once, in order; a closed column is not switched on. A used column
 *               that holds a value on a line is not switched off without `dropValues` (the values are then cleared).
 *   a value     applies at once, also after Confirm (it changes no price and no promise); the history keeps from → to (audit). TEXT
 *               words of 1 to 1000; YES_NO true or false; CHOICE one of the column's choices; NUMBER a decimal (at most 14 digits
 *               before the point, 4 after); DATE a day 'YYYY-MM-DD'; null clears it.
 *
 * Switched off (a lead decision, said in the notes): the base gives no DELETE on OrderLineColumnUse, so a column switched off keeps
 * its use row with a place from USE_OFF_FROM on (`isUseOn`); switched on again, the same row takes its place back. Every reader
 * reads uses through the API's ONE reader (modules/sales/own-columns/read.ts ownColumnsOf), never the table.
 * The Italian says "voi" (the portal's words).
 */

export const OWN_COLUMN_KINDS = ['TEXT', 'YES_NO', 'CHOICE', 'NUMBER', 'DATE'] as const
export type OwnColumnKind = (typeof OWN_COLUMN_KINDS)[number]

export const OWN_COLUMN_LIMITS = Object.freeze({ name: 40, perRecord: 8, choicesMin: 2, choicesMax: 30, choice: 40, text: 1000, open: 200 })

/** A use whose place is this or more is switched off (kept, not deleted: see the file's head). */
export const USE_OFF_FROM = 1001
export const isUseOn = (seq: number): boolean => seq < USE_OFF_FROM

/** The fixed columns of the ONE lines table, in English and Italian: never the name of an own column. */
export const FIXED_COLUMN_NAMES: readonly string[] = Object.freeze([
  'Model',
  'Material',
  'Sizes',
  'Pieces',
  'Your price',
  'Line',
  'Picture',
  'Modello',
  'Materiale',
  'Taglie',
  'Pezzi',
  'Il vostro prezzo',
  'Vostro prezzo',
  'Riga',
  'Immagine',
])

type Words = { readonly en: string; readonly it: string }

export const OWN_COLUMN_WORDS = Object.freeze({
  NAME: { en: `A column’s name is 1 to ${OWN_COLUMN_LIMITS.name} characters.`, it: `Il nome di una colonna ha da 1 a ${OWN_COLUMN_LIMITS.name} caratteri.` },
  DUPLICATE: (name: string): Words => ({ en: `You already have a column called “${name}”.`, it: `Avete già una colonna chiamata “${name}”.` }),
  FIXED: (name: string): Words => ({ en: `“${name}” is one of the order’s own columns: choose another name.`, it: `“${name}” è una colonna fissa dell’ordine: scegliete un altro nome.` }),
  CHOICES: { en: `A choice column needs at least ${OWN_COLUMN_LIMITS.choicesMin} choices, each once, each 1 to ${OWN_COLUMN_LIMITS.choice} characters.`, it: `Una colonna a scelta ha almeno ${OWN_COLUMN_LIMITS.choicesMin} scelte, ognuna una volta, ognuna da 1 a ${OWN_COLUMN_LIMITS.choice} caratteri.` },
  NO_CHOICES: { en: 'Only a choice column has choices.', it: 'Solo una colonna a scelta ha delle scelte.' },
  TOO_MANY_OPEN: { en: `You keep ${OWN_COLUMN_LIMITS.open} open columns already: close one first.`, it: `Avete già ${OWN_COLUMN_LIMITS.open} colonne aperte: chiudetene una prima.` },
  TOO_MANY: { en: `An order uses at most ${OWN_COLUMN_LIMITS.perRecord} of your columns.`, it: `Un ordine usa al massimo ${OWN_COLUMN_LIMITS.perRecord} delle vostre colonne.` },
  TWICE: { en: 'Name each column once.', it: 'Indicate ogni colonna una volta sola.' },
  CLOSED: { en: 'This column was closed: it goes on no new order and takes no new value.', it: 'Questa colonna è stata chiusa: non va su nuovi ordini e non prende nuovi valori.' },
  HAS_VALUES: (name: string): Words => ({ en: `“${name}” holds values on this order: switch it off and drop them, or keep it.`, it: `“${name}” ha dei valori su questo ordine: spegnetela togliendo i valori, oppure tenetela.` }),
  NOT_USED: { en: 'This column is not on this order: switch it on first.', it: 'Questa colonna non è su questo ordine: accendetela prima.' },
  ORDER_CLOSED: { en: 'This order is closed or cancelled: its columns and values no longer change.', it: 'Questo ordine è chiuso o annullato: le sue colonne e i suoi valori non cambiano più.' },
  REQUEST_DECIDED: { en: 'This order was confirmed, refused or withdrawn: change its values on the confirmed order.', it: 'Questo ordine è stato confermato, rifiutato o ritirato: cambiate i valori sull’ordine confermato.' },
  VALUE: {
    TEXT: { en: `Words of 1 to ${OWN_COLUMN_LIMITS.text} characters.`, it: `Testo da 1 a ${OWN_COLUMN_LIMITS.text} caratteri.` },
    YES_NO: { en: 'Yes or no.', it: 'Sì o no.' },
    CHOICE: { en: 'One of the column’s choices.', it: 'Una delle scelte della colonna.' },
    NUMBER: { en: 'A number (at most 14 digits before the point and 4 after).', it: 'Un numero (al massimo 14 cifre prima della virgola e 4 dopo).' },
    DATE: { en: 'A date (YYYY-MM-DD).', it: 'Una data (AAAA-MM-GG).' },
  } satisfies Record<OwnColumnKind, Words>,
})

export type ColumnRefusal = { readonly key: 'NAME' | 'DUPLICATE' | 'FIXED' | 'CHOICES' | 'NO_CHOICES' | 'TOO_MANY_OPEN'; readonly words: Words }

/** A name as compared: trimmed, whatever its case. */
export const nameKey = (name: string): string => name.trim().toLocaleLowerCase('en')

export interface NewColumn {
  readonly name: string
  readonly kind: OwnColumnKind
  readonly choices?: readonly string[] | null | undefined
}

/**
 * Why a new column cannot be made (null: it can). `open` = the names of the customer's OPEN columns. NAME is a 400 (the shape);
 * every other one a 409 in words (duplicate, fixed name, fewer than 2 choices).
 */
export function newColumnProblem(column: NewColumn, open: readonly string[]): ColumnRefusal | null {
  const name = column.name.trim()
  if (name.length === 0 || name.length > OWN_COLUMN_LIMITS.name) return { key: 'NAME', words: OWN_COLUMN_WORDS.NAME }
  if (FIXED_COLUMN_NAMES.some((fixed) => nameKey(fixed) === nameKey(name))) return { key: 'FIXED', words: OWN_COLUMN_WORDS.FIXED(name) }
  if (open.some((other) => nameKey(other) === nameKey(name))) return { key: 'DUPLICATE', words: OWN_COLUMN_WORDS.DUPLICATE(name) }
  if (open.length >= OWN_COLUMN_LIMITS.open) return { key: 'TOO_MANY_OPEN', words: OWN_COLUMN_WORDS.TOO_MANY_OPEN }
  const choices = (column.choices ?? []).map((choice) => choice.trim())
  if (column.kind === 'CHOICE') {
    const fine = choices.length >= OWN_COLUMN_LIMITS.choicesMin && choices.length <= OWN_COLUMN_LIMITS.choicesMax && choices.every((choice) => choice.length >= 1 && choice.length <= OWN_COLUMN_LIMITS.choice) && new Set(choices).size === choices.length
    if (!fine) return { key: 'CHOICES', words: OWN_COLUMN_WORDS.CHOICES }
  } else if (choices.length > 0) return { key: 'NO_CHOICES', words: OWN_COLUMN_WORDS.NO_CHOICES }
  return null
}

/** The choices as stored: trimmed for a CHOICE column, none for every other kind. */
export const choicesRowOf = (column: NewColumn): string[] => (column.kind === 'CHOICE' ? (column.choices ?? []).map((choice) => choice.trim()) : [])

export type UseRefusal =
  | { readonly key: 'TOO_MANY' | 'TWICE' | 'CLOSED'; readonly words: Words }
  | { readonly key: 'HAS_VALUES'; readonly words: Words; readonly columnId: string }
  | { readonly key: 'UNKNOWN'; readonly columnId: string }

export interface UseFacts {
  /** The columns asked, in order. */
  readonly asked: readonly string[]
  /** The customer's columns by id (an id not here is another customer's or unknown). */
  readonly columns: ReadonlyMap<string, { readonly name: string; readonly closed: boolean }>
  /** The columns ON this record now. */
  readonly onNow: readonly string[]
  /** The columns that hold a value on a line of this record now. */
  readonly withValues: ReadonlySet<string>
  readonly dropValues: boolean
}

/** Why this record cannot use exactly these columns (null: it can). UNKNOWN is a 404 (the brand wall); the rest 409 in words. */
export function useProblem(facts: UseFacts): UseRefusal | null {
  if (new Set(facts.asked).size !== facts.asked.length) return { key: 'TWICE', words: OWN_COLUMN_WORDS.TWICE }
  if (facts.asked.length > OWN_COLUMN_LIMITS.perRecord) return { key: 'TOO_MANY', words: OWN_COLUMN_WORDS.TOO_MANY }
  for (const columnId of facts.asked) {
    const column = facts.columns.get(columnId)
    if (!column) return { key: 'UNKNOWN', columnId }
    // A closed column stays where it was (kept with its values); it is never switched on again.
    if (column.closed && !facts.onNow.includes(columnId)) return { key: 'CLOSED', words: OWN_COLUMN_WORDS.CLOSED }
  }
  if (!facts.dropValues) {
    const off = facts.onNow.find((columnId) => !facts.asked.includes(columnId) && facts.withValues.has(columnId))
    if (off) return { key: 'HAS_VALUES', words: OWN_COLUMN_WORDS.HAS_VALUES(facts.columns.get(off)?.name ?? ''), columnId: off }
  }
  return null
}

/** One value as stored: only the field its column's kind needs (G8), or all none (a value cleared). */
export interface ValueFields {
  readonly valueText: string | null
  /** A decimal as text ("12.5"): never a float. */
  readonly valueNumber: string | null
  /** A day 'YYYY-MM-DD'. */
  readonly valueDate: string | null
  readonly valueBool: boolean | null
}

const NONE: ValueFields = Object.freeze({ valueText: null, valueNumber: null, valueDate: null, valueBool: null })
const DECIMAL = /^-?\d{1,14}(\.\d{1,4})?$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar day 'YYYY-MM-DD' (no time, no other form). */
export function isDay(value: string): boolean {
  const found = DAY.exec(value)
  if (!found) return false
  const [year, month, day] = [found[1]!, found[2]!, found[3]!].map((part) => Number.parseInt(part, 10)) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The value asked for a column of `kind` (and its choices), as stored; or the refusal's words (400). null clears it. */
export function ownValueFields(kind: OwnColumnKind, choices: readonly string[], value: string | number | boolean | null): { readonly ok: true; readonly fields: ValueFields } | { readonly ok: false; readonly words: Words } {
  if (value === null) return { ok: true, fields: NONE }
  const refused = { ok: false as const, words: OWN_COLUMN_WORDS.VALUE[kind] }
  switch (kind) {
    case 'TEXT': {
      if (typeof value !== 'string') return refused
      const text = value.trim()
      if (text.length === 0) return { ok: true, fields: NONE }
      return text.length > OWN_COLUMN_LIMITS.text ? refused : { ok: true, fields: { ...NONE, valueText: text } }
    }
    case 'YES_NO':
      return typeof value === 'boolean' ? { ok: true, fields: { ...NONE, valueBool: value } } : refused
    case 'CHOICE': {
      if (typeof value !== 'string') return refused
      const picked = value.trim()
      return choices.includes(picked) ? { ok: true, fields: { ...NONE, valueText: picked } } : refused
    }
    case 'NUMBER': {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return DECIMAL.test(text) ? { ok: true, fields: { ...NONE, valueNumber: text } } : refused
    }
    case 'DATE':
      return typeof value === 'string' && isDay(value.trim()) ? { ok: true, fields: { ...NONE, valueDate: value.trim() } } : refused
  }
}

/** A stored value as the answer shows it: words, a choice, a decimal as text, a day, yes/no; none: null. */
export function ownValueOf(kind: OwnColumnKind, fields: ValueFields): string | boolean | null {
  switch (kind) {
    case 'TEXT':
    case 'CHOICE':
      return fields.valueText
    case 'YES_NO':
      return fields.valueBool
    case 'NUMBER':
      return fields.valueNumber === null ? null : trimDecimal(fields.valueNumber)
    case 'DATE':
      return fields.valueDate
  }
}

/** "12.5000" → "12.5", "3.0000" → "3" (the database keeps 4 decimals). */
export function trimDecimal(text: string): string {
  if (!text.includes('.')) return text
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '-0' ? '0' : trimmed
}

/** Whether a stored value holds anything (a cleared value holds nothing). */
export const holdsValue = (fields: ValueFields): boolean => fields.valueText !== null || fields.valueNumber !== null || fields.valueDate !== null || fields.valueBool !== null
