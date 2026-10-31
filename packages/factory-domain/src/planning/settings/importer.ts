import { z } from 'zod'
import type { Issue } from '../../core/errors'
import { QUANTITY } from '../../core/money'
import { CELL_META, cell, foldWord, type CellInput, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { Dec } from '../../tax/decimal'
import {
  ITEM_PLANNING_LIMITS,
  ITEM_PLANNING_METHODS,
  itemPlanningProblems,
  LEAD_TIME_FIELDS,
  mergeItemPlanning,
  QUANTITY_FIELDS,
  type ItemPlanningPatch,
  type ItemPlanningValues,
} from './items'

/**
 * The item parameters' import (B-W2b-20; B-W2a-16 and B-W2a-59's gap; PLN-005, PLN-099; design planning.settings "Item
 * parameters" › Import): how each site plans each item and colour, one row per site × item × colour, keyed by the site's
 * code, the item's code and the colour's code (`*`: every colour of the item). A new key makes the site's row; a known
 * one changes the cells the row gives (a blank cell is "not given", never "clear it"). The dry run applies the same
 * rules as POST/PATCH /planning/item-parameters (./items `mergeItemPlanning` + `itemPlanningProblems`), so a row that
 * would break one is an error in the review, never a failed apply:
 *
 *   site, item, colour                     the key (the site of the job's company; the item's colour, or `*`)
 *   method                                 ORDERS, REORDER_POINT, MIN_MAX or MANUAL (Italian words too)
 *   source                                 BUY, MAKE, or ITEM (= follow the item's own sourcing)
 *   supplier, make site                    a party's code (an approved source of the item), a plant's code
 *   lead times                             buying, making and safety time in calendar days (0 to 366)
 *   quantities                             safety stock, reorder point, lot size, min and max stock, order minimum, step
 *                                          and maximum, in the item's BASE unit (at most four decimals)
 *   note
 *
 * A change of method clears the old method's own fields the row does not give, and a change of source the supplier or
 * make site, exactly as the PATCH does: the review shows them as cleared (a column with its value before and none
 * after). What each code names (the site, the item and colour, the supplier as an approved source, the plant) is
 * checked against the database by the API's adapter (modules/planning/settings/importer.ts). No money, no person.
 *
 * The plan works on the codes: the supplier's and make site's codes stand where the values hold their ids, which is all
 * the rules need of them (present or not).
 */

export const ITEM_PARAMETERS_IMPORTER_KEY = 'planning.itemParameters'

/** The colour key that means every colour of the item (the row with no colour). */
export const EVERY_COLOUR = '*'
/** The source that means "follow the item's own sourcing" (no source of the site's own). */
export const ITEM_SOURCE = 'ITEM'
export const IMPORT_SOURCES = ['BUY', 'MAKE', ITEM_SOURCE] as const

const EVERY_COLOUR_WORDS = new Set(['*', '-', 'tutti', 'tutti i colori', 'ogni colore', 'qualsiasi', 'all', 'any', 'every colour', 'every color', 'all colours', 'all colors'].map(foldWord))

/** The colour's code, or `*` (also written "tutti", "all", "every colour") for every colour. */
const colourCell = (() => {
  const schema = z
    .custom<CellInput>((value) => value !== null && typeof value === 'object' && 'context' in (value as object))
    .transform((input, ctx) => {
      const raw = typeof input.raw === 'string' ? input.raw.trim() : typeof input.raw === 'number' ? String(input.raw) : null
      const fail = (message: string) => {
        ctx.issues.push({ code: 'custom', message, input })
        return z.NEVER
      }
      if (raw === null || raw === '') return fail('Expected a colour code, or * for every colour.')
      if (EVERY_COLOUR_WORDS.has(foldWord(raw))) return EVERY_COLOUR
      if (/\s/.test(raw)) return fail('A colour code has no spaces (write * for every colour).')
      if (raw.length > 40) return fail('At most 40 characters.')
      return raw.toUpperCase()
    }) as unknown as z.ZodType<string, CellInput>
  schema.register(CELL_META, { kind: 'code', describe: 'the colour code of the item, or * for every colour' })
  return schema
})()

const METHOD_ALIASES = {
  ordini: 'ORDERS', 'da ordini': 'ORDERS', 'su ordine': 'ORDERS', orders: 'ORDERS', fabbisogno: 'ORDERS',
  'punto di riordino': 'REORDER_POINT', riordino: 'REORDER_POINT', 'reorder point': 'REORDER_POINT', rop: 'REORDER_POINT',
  'min max': 'MIN_MAX', 'min/max': 'MIN_MAX', minmax: 'MIN_MAX', 'scorta min max': 'MIN_MAX', 'minimo massimo': 'MIN_MAX',
  manuale: 'MANUAL', manual: 'MANUAL', 'a mano': 'MANUAL',
} as const satisfies Record<string, (typeof ITEM_PLANNING_METHODS)[number]>

const SOURCE_ALIASES = {
  acquisto: 'BUY', acquista: 'BUY', comprato: 'BUY', compra: 'BUY', buy: 'BUY', bought: 'BUY',
  produzione: 'MAKE', produci: 'MAKE', prodotto: 'MAKE', interno: 'MAKE', make: 'MAKE', made: 'MAKE',
  articolo: ITEM_SOURCE, "come l'articolo": ITEM_SOURCE, 'come articolo': ITEM_SOURCE, default: ITEM_SOURCE, item: ITEM_SOURCE, "item's": ITEM_SOURCE,
} as const satisfies Record<string, (typeof IMPORT_SOURCES)[number]>

const days = () => cell.integer({ min: ITEM_PLANNING_LIMITS.days.min, max: ITEM_PLANNING_LIMITS.days.max })
const quantity = () => cell.decimal({ precision: QUANTITY.precision, scale: QUANTITY.scale, min: '0' })
const BASE = 'In the item’s base unit, at most four decimals.'

export const itemParametersImporter = defineImporter({
  key: ITEM_PARAMETERS_IMPORTER_KEY,
  label: 'Item planning parameters',
  description: 'How each site plans each item and colour: method, source and supplier, lead times, safety stock, reorder and min/max rules, order minimum, step and maximum.',
  columns: {
    site: { label: 'Site', aliases: ['sito', 'stabilimento', 'codice sito', 'site code', 'plant'], required: true, type: cell.code({ upper: true, max: 24 }), description: 'The site’s code (a site of the job’s company).' },
    item: { label: 'Item', aliases: ['articolo', 'materiale', 'codice articolo', 'item code', 'material'], required: true, type: cell.code({ upper: true, max: 40 }) },
    colour: { label: 'Colour', aliases: ['colore', 'codice colore', 'colour code', 'color'], required: true, type: colourCell, description: 'The item’s colour code, or * for every colour.' },
    method: { label: 'Method', aliases: ['metodo', 'metodo di pianificazione', 'planning method'], type: cell.oneOf(ITEM_PLANNING_METHODS, METHOD_ALIASES), description: 'Needs a reorder point and lot size (REORDER_POINT) or a minimum and maximum stock (MIN_MAX).' },
    source: { label: 'Source', aliases: ['origine', 'fonte', 'approvvigionamento', 'make or buy'], type: cell.oneOf(IMPORT_SOURCES, SOURCE_ALIASES), description: 'BUY, MAKE, or ITEM to follow the item’s own sourcing.' },
    supplier: { label: 'Supplier', aliases: ['fornitore', 'fornitore preferito', 'preferred supplier', 'codice fornitore'], type: cell.code({ upper: true, max: 24 }), description: 'An approved source of the item (source BUY).' },
    makeSite: { label: 'Make site', aliases: ['sito di produzione', 'stabilimento di produzione', 'produce a', 'make at'], type: cell.code({ upper: true, max: 24 }), description: 'A plant of the company (source MAKE).' },
    buyLeadTimeDays: { label: 'Buying lead time (days)', aliases: ['lead time acquisto', 'giorni acquisto', 'buy lead time', 'tempo di approvvigionamento'], type: days() },
    makeLeadTimeDays: { label: 'Making lead time (days)', aliases: ['lead time produzione', 'giorni produzione', 'make lead time'], type: days() },
    safetyLeadTimeDays: { label: 'Safety time (days)', aliases: ['giorni di sicurezza', 'tempo di sicurezza', 'safety lead time', 'safety days'], type: days() },
    safetyStock: { label: 'Safety stock', aliases: ['scorta di sicurezza', 'scorta minima di sicurezza'], type: quantity(), description: BASE },
    reorderPoint: { label: 'Reorder point', aliases: ['punto di riordino', 'livello di riordino', 'rop'], type: quantity(), description: BASE },
    lotSize: { label: 'Lot size', aliases: ['lotto', 'lotto di riordino', 'quantita di riordino', 'reorder quantity'], type: quantity(), description: BASE },
    minStock: { label: 'Minimum stock', aliases: ['scorta minima', 'minimo', 'min stock', 'min'], type: quantity(), description: BASE },
    maxStock: { label: 'Maximum stock', aliases: ['scorta massima', 'massimo', 'max stock', 'max'], type: quantity(), description: BASE },
    minOrderQty: { label: 'Order minimum', aliases: ['minimo ordinabile', 'ordine minimo', 'moq', 'minimum order'], type: quantity(), description: BASE },
    orderMultiple: { label: 'Order step', aliases: ['multiplo', 'multiplo di ordine', 'passo', 'order multiple'], type: quantity(), description: BASE },
    maxOrderQty: { label: 'Order maximum', aliases: ['ordine massimo', 'massimo ordinabile', 'maximum order'], type: quantity(), description: BASE },
    note: { label: 'Note', aliases: ['nota', 'note', 'commento'], type: cell.text({ max: ITEM_PLANNING_LIMITS.note }) },
  },
  keyColumns: ['site', 'item', 'colour'],
  batchSize: 100,
  plan: (values, existing) => planItemParametersRow(values, existing),
})

type Column = keyof typeof itemParametersImporter.columns
/** The value columns (every column but the key). */
const VALUE_COLUMNS = ['method', 'source', 'supplier', 'makeSite', ...LEAD_TIME_FIELDS, ...QUANTITY_FIELDS, 'note'] as const satisfies readonly Column[]
type ValueColumn = (typeof VALUE_COLUMNS)[number]

/** A value's column: the supplier's and make site's ids stand as their codes here. */
const COLUMN_OF: Readonly<Record<keyof ItemPlanningValues, ValueColumn>> = Object.freeze({
  method: 'method',
  source: 'source',
  supplierId: 'supplier',
  makeSiteId: 'makeSite',
  buyLeadTimeDays: 'buyLeadTimeDays',
  makeLeadTimeDays: 'makeLeadTimeDays',
  safetyLeadTimeDays: 'safetyLeadTimeDays',
  safetyStock: 'safetyStock',
  reorderPoint: 'reorderPoint',
  lotSize: 'lotSize',
  minStock: 'minStock',
  maxStock: 'maxStock',
  minOrderQty: 'minOrderQty',
  orderMultiple: 'orderMultiple',
  maxOrderQty: 'maxOrderQty',
  note: 'note',
})
const FIELD_OF = Object.fromEntries(Object.entries(COLUMN_OF).map(([field, column]) => [column, field])) as Readonly<Record<ValueColumn, keyof ItemPlanningValues>>

/** A site's row as the import sees it: its values with the supplier's and make site's codes where the ids stand. */
export type ImportedItemParameters = ItemPlanningValues

/** The record values the adapter's load answers for a row: every value column (source null is ITEM). */
export function importRecordValues(values: ImportedItemParameters): RecordValues {
  const out: Record<string, CellValue | null> = {}
  for (const [field, column] of Object.entries(COLUMN_OF) as [keyof ItemPlanningValues, ValueColumn][]) out[column] = values[field]
  out.source = values.source ?? ITEM_SOURCE
  return out
}

/** The stored row back from the record values (codes where the ids stand). */
function currentOf(existing: ExistingRecord): ImportedItemParameters {
  const values: Record<string, unknown> = {}
  for (const column of VALUE_COLUMNS) values[FIELD_OF[column]] = existing.values[column] ?? null
  if (values.source === ITEM_SOURCE) values.source = null
  return values as unknown as ImportedItemParameters
}

/** The values a row gives, as a patch of the site's row (codes where the ids stand; source ITEM is none). */
export function patchOf(values: RowValues): ItemPlanningPatch {
  const patch: Record<string, unknown> = {}
  for (const column of VALUE_COLUMNS) {
    const value = values[column]
    if (value === undefined) continue
    patch[FIELD_OF[column]] = column === 'source' && value === ITEM_SOURCE ? null : value
  }
  return patch as ItemPlanningPatch
}

/** A rule's path (`body/<field>`) as the column it is about. */
const rowIssues = (issues: readonly Issue[]): RowIssue[] =>
  issues.map((issue) => {
    const field = issue.path.split('/').at(-1) ?? ''
    const column = Object.hasOwn(COLUMN_OF, field) ? COLUMN_OF[field as keyof ItemPlanningValues] : undefined
    return column ? { column, message: issue.message } : { message: issue.message }
  })

const QUANTITY_COLUMNS = new Set<string>(QUANTITY_FIELDS)
/** One value column's two values are the same (quantities by value: "12.5" = "12.5000"). */
function same(column: ValueColumn, a: CellValue | null, b: CellValue | null): boolean {
  if (a === null || b === null) return a === b
  if (QUANTITY_COLUMNS.has(column) && typeof a === 'string' && typeof b === 'string') return new Dec(a).eq(b)
  return a === b
}

const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

/**
 * What one row does (the importer's `plan`): the site's row after the cells it gives (merged as the PATCH merges, the
 * method's and source's clearing included), checked by the item parameters' rules. CREATE with the given values; UPDATE
 * with each value column that changes (`before` → `after`; a cleared column has its value before and none after);
 * UNCHANGED when none does.
 */
export function planItemParametersRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  const current = existing ? currentOf(existing) : null
  const { values: next } = mergeItemPlanning(current, patchOf(values))
  const problems = itemPlanningProblems(next)
  if (problems.length > 0) return refused(rowIssues(problems))
  if (current === null) return { action: 'CREATE', after: values }
  const before: Record<string, CellValue | null> = {}
  const after: Record<string, CellValue> = {}
  const from = importRecordValues(current)
  const to = importRecordValues(next)
  for (const column of VALUE_COLUMNS) {
    const was = from[column] ?? null
    const now = to[column] ?? null
    if (same(column, was, now)) continue
    before[column] = was
    if (now !== null) after[column] = now
  }
  return Object.keys(before).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before, after }
}
