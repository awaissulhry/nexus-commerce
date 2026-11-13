import type { DocumentLanguage } from './model'
import { formatDecimal } from './format'
import type { TravellerTable } from '../production/work-orders/traveller'

/**
 * The options a garment was sold with, as paper prints them (B-W2b-374; XF3:03): the quote, the order confirmation and the
 * invoice copy print them under a line's description (the layouts whose `printsOptions` is set, documents/layouts.ts), and
 * the work-order traveller prints them per colour and size so the floor makes what was sold. Pure: the API reads the rows
 * (QuoteLineOption, SalesOrderLineOption, WorkOrderSize.optionValueIds) and the names in the document's language.
 *
 * Never a surcharge on paper the floor reads; the customer's documents carry their prices in the line's unit price already.
 */

/** One option as printed: the group and value names in the document's language, the customer's text, a colour or material. */
export interface PrintedOption {
  readonly group: string
  readonly value: string
  /** The customer's own text (a name to embroider), exactly as typed. */
  readonly text?: string | null
  /** A library colour picked with the value ("Rosso (RED)"). */
  readonly colour?: string | null
  /** A material picked with the value, and its colour ("Pelle bovina LTH-01 · Nero"). */
  readonly material?: string | null
}

const WORDS = {
  it: { options: 'Opzioni', colour: 'Colore', sizes: 'Taglie', pieces: 'Capi', title: 'Opzioni da realizzare', empty: 'Nessuna opzione.' },
  en: { options: 'Options', colour: 'Colour', sizes: 'Sizes', pieces: 'Pieces', title: 'Options to make', empty: 'No options.' },
} as const

/** One option in words: "Ricamo: Nome «BIANCHI»", "Pannelli: Colore (Rosso)". */
export function optionWords(option: PrintedOption): string {
  const extras = [option.colour?.trim(), option.material?.trim()].filter((part): part is string => typeof part === 'string' && part !== '')
  const text = option.text?.trim() ? ` «${option.text.trim()}»` : ''
  return `${option.group.trim()}: ${option.value.trim()}${text}${extras.length > 0 ? ` (${extras.join(' · ')})` : ''}`
}

/** A line's options as one printed sentence ("Opzioni: Imbottitura: Sì; Ricamo: Nome «BIANCHI»"), or null when none. */
export function optionsText(options: readonly PrintedOption[] | null | undefined, language: DocumentLanguage): string | null {
  if (!options || options.length === 0) return null
  return `${WORDS[language].options}: ${options.map(optionWords).join('; ')}`
}

/** A description with its options after it, as the priced layouts print it (the description alone when none). */
export function withOptions(description: string, options: readonly PrintedOption[] | null | undefined, language: DocumentLanguage): string {
  const text = optionsText(options, language)
  return text === null ? description : `${description} — ${text}`
}

/** One group of a work order's cells made with the same options: a colour, its sizes, the pieces, what to make. */
export interface TravellerOptionRow {
  readonly colourway: string
  readonly sizes: readonly string[]
  readonly pieces: number
  readonly options: readonly PrintedOption[]
}

/** The traveller's options table (the API's painter prints its tables in order), or null when no cell has an option. */
export function travellerOptionsTable(rows: readonly TravellerOptionRow[], language: DocumentLanguage): TravellerTable | null {
  const made = rows.filter((row) => row.options.length > 0)
  if (made.length === 0) return null
  const words = WORDS[language]
  return {
    title: words.title,
    columns: [
      { label: words.colour, width: 160, align: 'left' },
      { label: words.sizes, width: 200, align: 'left' },
      { label: words.pieces, width: 90, align: 'right' },
      { label: words.options, width: 550, align: 'left' },
    ],
    rows: [...made]
      .sort((a, b) => a.colourway.localeCompare(b.colourway) || (a.sizes[0] ?? '').localeCompare(b.sizes[0] ?? '', undefined, { numeric: true }))
      .map((row) => [row.colourway, row.sizes.join(', '), formatDecimal(String(row.pieces), language), row.options.map(optionWords).join('; ')]),
    total: null,
    empty: words.empty,
  }
}

/** Cells grouped by colourway and the same options (the order of the options kept), for the traveller's table. */
export function groupCellsByOptions(cells: readonly { readonly colourway: string; readonly size: string; readonly quantity: number; readonly options: readonly PrintedOption[] }[], sizeOrder: readonly string[]): TravellerOptionRow[] {
  const groups = new Map<string, { colourway: string; sizes: string[]; pieces: number; options: readonly PrintedOption[] }>()
  for (const cell of cells) {
    const key = `${cell.colourway}\u0000${cell.options.map(optionWords).join('\u0001')}`
    const group = groups.get(key) ?? { colourway: cell.colourway, sizes: [], pieces: 0, options: cell.options }
    if (!group.sizes.includes(cell.size)) group.sizes.push(cell.size)
    group.pieces += cell.quantity
    groups.set(key, group)
  }
  const rank = (size: string) => {
    const at = sizeOrder.indexOf(size)
    return at < 0 ? sizeOrder.length : at
  }
  return [...groups.values()].map((group) => ({ ...group, sizes: [...group.sizes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })) }))
}
