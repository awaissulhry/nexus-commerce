import { z } from 'zod'
import { isBusinessDate } from '../../core/time'
import { CELL_META, cell, plainDecimal, readDate, readNumberText, type CellInput, type CellValue, type NumberFormat } from '../../imports/cells'
import { defineImporter, diffPlan, type Importer, type RowIssue, type RowPlan } from '../../imports/importer'
import { COLOURWAY_CODE } from '../../product/styles/colourways'
import { STYLE_CODE } from '../../product/styles/rules'
import { decimalText } from '../../product/units/units'
import { Dec, parseDecimal } from '../../tax/decimal'
import { PRICE_LIST_LIMITS } from '../pricelists/pricelists'
import { PRICING_DEPTH_LIMITS, sizeCodeOf } from './rules'

/**
 * The price list import and export (B-W2b-325; SAL-183; design sales.pricelists pop:pricelists.import "Import prices" —
 * a preview of the changes per row, then Apply; the list frame's Export ▾): one row per price of a list, keyed by the
 * list's code, the style, the colourway (`*`: every colourway of the style) and the first day (`-`: from the version's
 * start). A row lands in the list's DRAFT version (an active version's prices are fixed: make the next version first); a
 * known price changes the cells the row gives, a new one is added. Prices the sheet leaves out stay. The export writes
 * the same columns from any version, so a version exported, edited and imported into the next draft changes exactly what
 * was edited.
 *
 *   list, style, colourway, from    the key
 *   to                              the last day (`-`: to the version's end)
 *   unit price                      net, per piece, in the list's currency (price grain)
 *   quantity breaks                 the price's own breaks as a whole set: `10=425; 50=415` (a unit price from that many
 *                                   pieces) or `100=3%` (a discount); `-` removes them all (price grain)
 *   size surcharges                 B-W2b-380 (XF6:04): the version's size surcharges of the style as a whole set, on the
 *                                   style's row with colourway `*` and first day `-` (a row of only them when the version
 *                                   has no such price): `52=10` (an amount in the list's currency) or `54=5%`; `-` none
 *
 * B-W2b-380 (XF6:04): the version's own row — style `*`, colourway `*`, first day `-`, no price and no days — carries its
 * breaks of every price (discounts only: `100=3%`) and its size surcharges of every style, so a version exported, edited
 * and imported moves its version-wide rules too.
 *
 * A blank cell is "not given" (the import engine's rule). What the codes name, the days that must not overlap another
 * price of the style, and breaks that lower the price are checked by the API's adapter in the dry run.
 */

export const PRICE_LIST_IMPORTER_KEY = 'sales.priceLists'

/** `*` in the colourway column: the style's price for every colourway. */
export const EVERY_COLOURWAY = '*'
/** `-` in a day column: open (from the version's start, to its end); in the breaks column: none. */
export const OPEN = '-'

const custom = <T extends CellValue>(describe: string, kind: 'code' | 'date' | 'text', read: (input: CellInput, fail: (message: string) => never) => T) => {
  const schema = z
    .custom<CellInput>((value) => value !== null && typeof value === 'object' && 'context' in (value as object))
    .transform((input, ctx) => read(input, (message) => {
      ctx.issues.push({ code: 'custom', message, input })
      return z.NEVER as never
    })) as unknown as z.ZodType<T, CellInput>
  schema.register(CELL_META, { kind, describe })
  return schema
}

const textOf = (raw: CellInput['raw']): string | null => (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null)

/** A colourway code, or `*` for every colourway. */
const colourwayCell = () =>
  custom('a colourway code, or * for every colourway', 'code', ({ raw }, fail) => {
    const text = textOf(raw)?.toUpperCase() ?? null
    if (text === EVERY_COLOURWAY) return EVERY_COLOURWAY
    if (text === null || !COLOURWAY_CODE.test(text)) return fail('Expected a colourway code (BLK), or * for every colourway.')
    return text
  })

/** A day, or `-` for open. */
const dayCell = () =>
  custom('a date like 31/12/2026, or - for open', 'date', ({ raw }, fail) => {
    if (typeof raw === 'string' && raw.trim() === OPEN) return OPEN
    const day = readDate(raw)
    return day ?? fail('Expected a date like 31/12/2026 or 2026-12-31, or - for open.')
  })

/** A break's value: a unit price, or a percent (`3%`). */
function breakValue(text: string, format: NumberFormat): string | null {
  const pct = text.endsWith('%')
  const plain = readNumberText(pct ? text.slice(0, -1).trim() : text, format)
  const value = plain === null ? null : parseDecimal(plain)
  if (value === null || value.lte(0)) return null
  if (pct) return value.lt(100) && value.decimalPlaces() <= 4 ? `${plainDecimal(value)}%` : null
  return value.decimalPlaces() <= 6 && value.lt(new Dec(10).pow(12)) ? plainDecimal(value) : null
}

/** One price's breaks as text, in quantity order: `10=425;50=415` (`-`: none). */
export function breaksText(rows: readonly { readonly minQuantity: number; readonly unitPrice: string | null; readonly discountPct: string | null }[]): string {
  if (rows.length === 0) return OPEN
  return [...rows]
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .map((row) => `${row.minQuantity}=${row.unitPrice !== null ? decimalText(row.unitPrice) : `${decimalText(row.discountPct!)}%`}`)
    .join(';')
}

/** A breaks cell's pairs, as the rows a write takes. */
export function breaksOf(text: string): { readonly minQuantity: number; readonly unitPrice: string | null; readonly discountPct: string | null }[] {
  if (text === OPEN) return []
  return text
    .split(';')
    .filter((part) => part !== '')
    .map((part) => {
      const [quantity, value] = part.split('=') as [string, string]
      const pct = value.endsWith('%')
      return { minQuantity: Number.parseInt(quantity, 10), unitPrice: pct ? null : value, discountPct: pct ? value.slice(0, -1) : null }
    })
}

/** The quantity breaks of one price: `10=425; 50=415` or `100=3%`, `;` or `|` between; `-`: none. */
const breaksCell = () =>
  custom('quantity breaks like 10=425; 50=415 or 100=3%, or - for none', 'text', ({ raw, context }, fail) => {
    const text = textOf(raw)
    if (text === null) return fail('Expected quantity breaks like 10=425; 50=415 or 100=3%, or - for none.')
    if (text === OPEN) return OPEN
    const parts = text.split(/[;|]/).map((part) => part.trim()).filter((part) => part !== '')
    if (parts.length === 0 || parts.length > 20) return fail('1 to 20 quantity breaks, like 10=425; 50=415.')
    const rows: { minQuantity: number; unitPrice: string | null; discountPct: string | null }[] = []
    const seen = new Set<number>()
    for (const part of parts) {
      const at = part.search(/[=:]/)
      if (at <= 0) return fail('Expected quantity breaks like 10=425; 50=415 or 100=3%.')
      const quantityText = part.slice(0, at).trim()
      if (!/^\d{1,7}$/.test(quantityText)) return fail(`${quantityText}: a whole number of pieces.`)
      const quantity = Number.parseInt(quantityText, 10)
      if (quantity < 2 || quantity > PRICING_DEPTH_LIMITS.maxQuantity) return fail(`${quantity}: a break applies from 2 to ${PRICING_DEPTH_LIMITS.maxQuantity} pieces.`)
      if (seen.has(quantity)) return fail(`${quantity} pieces is listed twice.`)
      seen.add(quantity)
      const value = breakValue(part.slice(at + 1).trim(), context.numberFormat)
      if (value === null) return fail(`${quantity}: expected a unit price above 0 (6 decimals at most), or a discount like 3% (above 0, below 100).`)
      rows.push(value.endsWith('%') ? { minQuantity: quantity, unitPrice: null, discountPct: value.slice(0, -1) } : { minQuantity: quantity, unitPrice: value, discountPct: null })
    }
    return breaksText(rows)
  })

// ---- B-W2b-380 (XF6:04): version-wide breaks and size surcharges --------------------------------------------------------

/** `*` in the style column (with colourway `*` and first day `-`): the version's own row, its breaks of every price and its size surcharges of every style. */
export const EVERY_STYLE = '*'

/** The sizes one surcharges cell may name. */
const SURCHARGE_SIZES = 60
const SIZE = /^\S{1,40}$/

export interface SurchargeText {
  readonly size: string
  /** An amount in the list's currency, or null for a percent. */
  readonly amount: string | null
  readonly pct: string | null
}

const bySize = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true })

/** One set of size surcharges as text, in size order: `52=10;54=5%` (`-`: none). */
export function surchargesText(rows: readonly SurchargeText[]): string {
  if (rows.length === 0) return OPEN
  return [...rows]
    .sort((a, b) => bySize(a.size, b.size))
    .map((row) => `${row.size}=${row.amount !== null ? decimalText(row.amount) : `${decimalText(row.pct!)}%`}`)
    .join(';')
}

/** A surcharges cell's pairs, as the rows a write takes. */
export function surchargesOf(text: string): SurchargeText[] {
  if (text === OPEN) return []
  return text
    .split(';')
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.indexOf('=')
      const value = part.slice(at + 1)
      const pct = value.endsWith('%')
      return { size: part.slice(0, at), amount: pct ? null : value, pct: pct ? value.slice(0, -1) : null }
    })
}

/** A surcharge's value: an amount (above 0, 6 decimals) or a percent (`5%`: above 0, at most 100, 4 decimals). */
function surchargeValue(text: string, format: NumberFormat): string | null {
  const pct = text.endsWith('%')
  const plain = readNumberText(pct ? text.slice(0, -1).trim() : text, format)
  const value = plain === null ? null : parseDecimal(plain)
  if (value === null || value.lte(0)) return null
  if (pct) return value.lte(100) && value.decimalPlaces() <= 4 ? `${plainDecimal(value)}%` : null
  return value.decimalPlaces() <= 6 && value.lt(new Dec(10).pow(12)) ? plainDecimal(value) : null
}

/** The size surcharges of a style (or of every style): `52=10; 54=5%`, `;` or `|` between; `-`: none. */
const surchargesCell = () =>
  custom('size surcharges like 52=10; 54=5%, or - for none', 'text', ({ raw, context }, fail) => {
    const text = textOf(raw)
    if (text === null) return fail('Expected size surcharges like 52=10; 54=5%, or - for none.')
    if (text === OPEN) return OPEN
    const parts = text.split(/[;|]/).map((part) => part.trim()).filter((part) => part !== '')
    if (parts.length === 0 || parts.length > SURCHARGE_SIZES) return fail(`1 to ${SURCHARGE_SIZES} size surcharges, like 52=10; 54=5%.`)
    const rows: SurchargeText[] = []
    for (const part of parts) {
      const at = part.search(/[=:]/)
      if (at <= 0) return fail('Expected size surcharges like 52=10; 54=5%.')
      const size = sizeCodeOf(part.slice(0, at))
      if (!SIZE.test(size)) return fail(`${size}: a size code of 1 to 40 characters, without spaces.`)
      if (rows.some((row) => row.size === size)) return fail(`Size ${size} is listed twice.`)
      const value = surchargeValue(part.slice(at + 1).trim(), context.numberFormat)
      if (value === null) return fail(`${size}: expected an amount above 0 (6 decimals at most), or a percent like 5% (above 0, at most 100).`)
      rows.push(value.endsWith('%') ? { size, amount: null, pct: value.slice(0, -1) } : { size, amount: value, pct: null })
    }
    return surchargesText(rows)
  })

/** The row is the version's own (style `*`). */
export const isVersionRow = (values: Readonly<Record<string, unknown>>): boolean => values.style === EVERY_STYLE

/** A style's row that gives only its size surcharges (no price, no days, no breaks). */
export const isSurchargesOnly = (values: Readonly<Record<string, unknown>>): boolean =>
  !isVersionRow(values) && values.sizeSurcharges !== undefined && values.unitPrice === undefined && values.breaks === undefined && values.validTo === undefined

export const priceListImporter = defineImporter({
  key: PRICE_LIST_IMPORTER_KEY,
  label: 'Price list prices',
  description: "Prices of price lists' draft versions, by list, style, colourway and first day: the unit price, its last day and its quantity breaks.",
  columns: {
    list: { label: 'Price list', aliases: ['listino', 'codice listino', 'price list code', 'list'], required: true, type: cell.code({ upper: true, max: PRICE_LIST_LIMITS.code }), description: "The list's code: the price goes into its draft version." },
    style: { label: 'Style', aliases: ['modello', 'codice modello', 'style code', 'codice stile', 'articolo'], required: true, type: cell.code({ upper: true, max: 24 }) },
    colourway: { label: 'Colourway', aliases: ['variante', 'colore', 'colorway', 'variante colore'], required: true, type: colourwayCell(), description: 'The colourway it prices, or * for every colourway of the style.' },
    validFrom: { label: 'Valid from', aliases: ['valido dal', 'dal', 'from', 'da', 'inizio'], required: true, type: dayCell(), description: 'The first day the price holds, or - from the start of the version.' },
    validTo: { label: 'Valid to', aliases: ['valido al', 'al', 'to', 'until', 'fino al', 'fine'], type: dayCell(), description: 'The last day the price holds, or - to the end of the version.' },
    unitPrice: { label: 'Unit price', aliases: ['prezzo', 'prezzo unitario', 'prezzo netto', 'price', 'net price'], type: cell.decimal({ precision: 18, scale: 6, min: '0.000001' }), grain: 'price', description: "Net, per piece, in the list's currency. Needed for a new price." },
    breaks: { label: 'Quantity breaks', aliases: ['scaglioni', 'sconti quantita', 'sconti quantità', 'breaks', 'quantity break'], type: breaksCell(), grain: 'price', description: 'Every break of the price: 10=425; 50=415 (a unit price from that many pieces) or 100=3% (a discount); - for none. On the row of every style (style *): the discounts of every price.' },
    // B-W2b-380 (XF6:04)
    sizeSurcharges: { label: 'Size surcharges', aliases: ['maggiorazioni taglia', 'maggiorazioni per taglia', 'maggiorazioni', 'size surcharge', 'surcharges'], type: surchargesCell(), grain: 'price', description: "The version's size surcharges as a whole set: on the style's row with colourway * and first day - the style's, on the row of every style (style *) every style's; 52=10 (an amount in the list's currency) or 54=5% (a percent of the price); - for none." },
  },
  keyColumns: ['list', 'style', 'colourway', 'validFrom'],
  batchSize: 100,
  validateRow(values) {
    const issues: RowIssue[] = []
    if (typeof values.style === 'string' && values.style !== EVERY_STYLE && !STYLE_CODE.test(values.style)) issues.push({ column: 'style', message: 'Not a style code, nor * for every style.' })
    // B-W2b-380 (XF6:04): the version's own row, and where a style's surcharges go.
    if (isVersionRow(values)) {
      if (values.colourway !== EVERY_COLOURWAY) issues.push({ column: 'colourway', message: 'The row of every style (style *) takes colourway *.' })
      if (values.validFrom !== OPEN) issues.push({ column: 'validFrom', message: 'The row of every style (style *) takes first day -.' })
      if (values.validTo !== undefined) issues.push({ column: 'validTo', message: 'The row of every style (style *) has no days: leave the last day empty.' })
      if (values.unitPrice !== undefined) issues.push({ column: 'unitPrice', message: 'The row of every style (style *) has no unit price: its breaks are discounts of every price, like 100=3%.' })
      if (typeof values.breaks === 'string' && breaksOf(values.breaks).some((row) => row.unitPrice !== null)) issues.push({ column: 'breaks', message: 'A break of every price is a discount, like 100=3%.' })
    } else if (values.sizeSurcharges !== undefined && (values.colourway !== EVERY_COLOURWAY || values.validFrom !== OPEN)) {
      issues.push({ column: 'sizeSurcharges', message: "Size surcharges go on the style's row with colourway * and first day -." })
    }
    const from = typeof values.validFrom === 'string' && values.validFrom !== OPEN ? values.validFrom : null
    const to = typeof values.validTo === 'string' && values.validTo !== OPEN ? values.validTo : null
    if (from !== null && to !== null && isBusinessDate(from) && isBusinessDate(to) && to < from) issues.push({ column: 'validTo', message: 'The last day is on or after the first.' })
    return issues
  },
  plan(values, existing): RowPlan {
    // B-W2b-380: the version's own row and a style's surcharges alone carry no price.
    if (existing === null && values.unitPrice === undefined && !isVersionRow(values) && !isSurchargesOnly(values)) return { action: 'ERROR', errors: [{ column: 'unitPrice', message: 'A new price needs its unit price.' }] }
    return diffPlan(priceListImporter as Importer, values, existing)
  },
})

/** The columns in the order the export writes them. */
export const PRICE_LIST_COLUMNS = ['list', 'style', 'colourway', 'validFrom', 'validTo', 'unitPrice', 'breaks', 'sizeSurcharges'] as const satisfies readonly (keyof typeof priceListImporter.columns)[]

/** One price as the export (and the import's load) writes it. */
export interface ExportedPrice {
  readonly list: string
  readonly style: string
  /** Null: every colourway. */
  readonly colourway: string | null
  readonly validFrom: string | null
  readonly validTo: string | null
  readonly unitPrice: string
  readonly breaks: readonly { readonly minQuantity: number; readonly unitPrice: string | null; readonly discountPct: string | null }[]
  /** B-W2b-380: the version's surcharges of the style, on its row for every colourway from the start (else absent). */
  readonly sizeSurcharges?: readonly SurchargeText[] | undefined
}

/** One row's values in the importer's columns; a column the row does not carry is absent (an empty cell). */
export type PriceRecordValues = Partial<Record<(typeof PRICE_LIST_COLUMNS)[number], string>> & Pick<Record<(typeof PRICE_LIST_COLUMNS)[number], string>, 'list' | 'style' | 'colourway' | 'validFrom'>

/** A price's values in the importer's columns (the load's record values; the export's cells). */
export function priceRecordValues(price: ExportedPrice): PriceRecordValues {
  return {
    list: price.list,
    style: price.style,
    colourway: price.colourway ?? EVERY_COLOURWAY,
    validFrom: price.validFrom ?? OPEN,
    validTo: price.validTo ?? OPEN,
    unitPrice: decimalText(price.unitPrice),
    breaks: breaksText(price.breaks),
    ...(price.sizeSurcharges !== undefined ? { sizeSurcharges: surchargesText(price.sizeSurcharges) } : {}),
  }
}

/** B-W2b-380: the version's own row (style `*`): its breaks of every price and its size surcharges of every style. */
export function versionRecordValues(list: string, breaks: ExportedPrice['breaks'], surcharges: readonly SurchargeText[]): PriceRecordValues {
  return { list, style: EVERY_STYLE, colourway: EVERY_COLOURWAY, validFrom: OPEN, breaks: breaksText(breaks), sizeSurcharges: surchargesText(surcharges) }
}

/** B-W2b-380: a style's row of only its size surcharges (the version has no price of the style for every colourway from its start). */
export function surchargesRecordValues(list: string, style: string, surcharges: readonly SurchargeText[]): PriceRecordValues {
  return { list, style, colourway: EVERY_COLOURWAY, validFrom: OPEN, sizeSurcharges: surchargesText(surcharges) }
}
