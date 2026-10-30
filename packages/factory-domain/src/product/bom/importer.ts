import { z } from 'zod'
import { CELL_META, cell, plainDecimal, readNumberText, type CellInput, type CellValue, type NumberFormat } from '../../imports/cells'
import { defineImporter, diffPlan, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { Dec, parseDecimal } from '../../tax/decimal'
import { unitCell } from '../materials/importer'
import { normaliseSizeCode, SIZE_CODE } from '../sizes/rules'
import { COLOURWAY_CODE, MAX_COLOURWAYS } from '../styles/colourways'
import { MAX_RANGE_SIZES, STYLE_CODE } from '../styles/rules'
import { QUANTITY_SCALE, type Uom } from '../units/units'
import { MAX_SEQ } from './rules'

/**
 * The BOM import and export (feature PRD-090; design products.styles pop:styles.importBom, style.bom.lines "Import BOM ·
 * Export XLSX / PDF"): one row per BOM line, keyed by its style's code and its place in the BOM (`seq`). A row lands in
 * the style's DRAFT revision (never a released one: a released revision is frozen; start a revision first); a known
 * place changes the cells the row gives, a new one adds the line. Lines the sheet leaves out stay. The export writes the
 * same columns, so a BOM exported, edited and imported again changes exactly what was edited; a sheet may hold the BOMs
 * of several styles.
 *
 *   style, seq                       the key: the style's code, the line's place (1 to 99999)
 *   material, placement, qty, unit   the material's code; quantity per garment in the line's unit
 *   wastage %                        0 to 60
 *   by size, quantity by size        a size-dependent line's quantities: `50=43,5; 52=45` (the job's number format);
 *                                    the list is the line's whole set: a size left out is cleared
 *   by colourway, colour by colourway  a colour-dependent line's material colours: `BLK=BLK; RED=RED` (colourway code =
 *                                    the material's colour code); the whole grid
 *   colour                           the material's one colour for every colourway
 *   only in colourway, supplier, note
 *
 * A blank cell is "not given" (the import engine's rule): it never clears a field. What each code names, and every BOM
 * rule (product/bom/rules planLine), is checked against the database by the API's adapter (modules/product/bom/
 * importer.ts) in the dry run, so a row that would break one is an error in the review, never a failed apply. No money.
 */

export const BOM_IMPORTER_KEY = 'product.bom'

/** `KEY=VALUE` pairs split by `;` or `|` (also `KEY:VALUE`): the cell's text, canonical (`;` between, no spaces). */
function pairsCell(options: { readonly what: string; readonly example: string; readonly max: number; readonly key: (text: string) => string | null; readonly value: (text: string, format: NumberFormat, raw: CellInput['raw']) => string | null; readonly valueRule: string }) {
  const schema = z
    .custom<CellInput>((value) => value !== null && typeof value === 'object' && 'context' in (value as object))
    .transform((input, ctx) => {
      const fail = (message: string) => {
        ctx.issues.push({ code: 'custom', message, input })
        return z.NEVER
      }
      const raw = typeof input.raw === 'string' ? input.raw : null
      if (raw === null) return fail(`Expected ${options.what} like ${options.example}.`)
      const parts = raw.split(/[;|]/).map((part) => part.trim()).filter((part) => part !== '')
      if (parts.length === 0) return fail(`Expected ${options.what} like ${options.example}.`)
      if (parts.length > options.max) return fail(`At most ${options.max} entries.`)
      const seen = new Set<string>()
      const out: string[] = []
      for (const part of parts) {
        const at = part.search(/[=:]/)
        if (at <= 0) return fail(`Expected ${options.what} like ${options.example}.`)
        const key = options.key(part.slice(0, at).trim())
        if (key === null) return fail(`Expected ${options.what} like ${options.example}.`)
        if (seen.has(key)) return fail(`${key} is listed twice.`)
        seen.add(key)
        const value = options.value(part.slice(at + 1).trim(), input.context.numberFormat, input.raw)
        if (value === null) return fail(`${key}: ${options.valueRule}`)
        out.push(`${key}=${value}`)
      }
      return out.join(';')
    }) as unknown as z.ZodType<string, CellInput>
  schema.register(CELL_META, { kind: 'text', describe: `${options.what} (${options.example})` })
  return schema
}

const sizeKey = (text: string): string | null => {
  const code = normaliseSizeCode(text)
  return SIZE_CODE.test(code) ? code : null
}
const sizeQuantity = (text: string, format: NumberFormat): string | null => {
  const plain = readNumberText(text, format)
  const value = plain === null ? null : parseDecimal(plain)
  if (value === null || value.isNegative() || value.decimalPlaces() > QUANTITY_SCALE || value.greaterThanOrEqualTo(new Dec(10).pow(14))) return null
  return plainDecimal(value)
}
const colourwayKey = (text: string): string | null => {
  const code = text.toUpperCase()
  return COLOURWAY_CODE.test(code) ? code : null
}
const colourCode = (text: string): string | null => {
  const code = text.toUpperCase()
  return code !== '' && code.length <= 40 && !/\s/.test(code) ? code : null
}

/** A size-dependent line's quantities: `50=43,5; 52=45`. */
const sizesCell = () =>
  pairsCell({ what: 'quantities by size', example: '50=43,5; 52=45', max: MAX_RANGE_SIZES, key: sizeKey, value: sizeQuantity, valueRule: `expected a quantity of 0 or more with at most ${QUANTITY_SCALE} decimals.` })
/** A colour-dependent line's material colours: `BLK=BLK; RED=RED`. */
const coloursCell = () => pairsCell({ what: 'material colours by colourway', example: 'BLK=BLK; RED=RED', max: MAX_COLOURWAYS, key: colourwayKey, value: colourCode, valueRule: 'expected the material colour code.' })

export const bomImporter = defineImporter({
  key: BOM_IMPORTER_KEY,
  label: 'BOM lines',
  description: "Lines of styles' draft BOMs, by style and place: materials, quantities per garment and per size, wastage and colours.",
  columns: {
    style: { label: 'Style', aliases: ['modello', 'codice modello', 'style code', 'codice stile'], required: true, type: cell.code({ upper: true, max: 24 }), description: 'The style code: the line goes into its draft revision.' },
    seq: { label: 'Seq', aliases: ['posizione', 'pos', 'sequenza', 'place', 'n'], required: true, type: cell.integer({ min: 1, max: MAX_SEQ }), description: 'The line\'s place in the BOM (10, 20, 30 …).' },
    material: { label: 'Material', aliases: ['materiale', 'codice materiale', 'material code', 'item'], type: cell.code({ upper: true, max: 40 }), description: 'Needed for a new line.' },
    placement: { label: 'Placement', aliases: ['posizionamento', 'parte', 'collocazione'], type: cell.text({ max: 120 }) },
    qty: { label: 'Qty per garment', aliases: ['quantita', 'qta', 'q.ta', 'q.tà', 'consumo', 'quantity', 'qty'], type: cell.decimal({ precision: 18, scale: 4, min: '0' }), description: 'In the line\'s unit; a size-dependent line gives its quantities by size instead.' },
    uom: { label: 'Unit', aliases: ['um', 'unita', 'unita di misura', 'uom'], type: unitCell(), description: "Default the material's consumption unit." },
    wastagePct: { label: 'Wastage %', aliases: ['sfrido', 'sfrido %', 'scarto', 'scarto %', 'wastage'], type: cell.decimal({ precision: 7, scale: 4, min: '0' }) },
    sizeDependent: { label: 'By size', aliases: ['per taglia', 'varia per taglia', 'size dependent'], type: cell.boolean() },
    sizes: { label: 'Quantity by size', aliases: ['quantita per taglia', 'qta per taglia', 'sizes'], type: sizesCell(), description: 'Every size of the line: 50=43,5; 52=45.' },
    colourDependent: { label: 'By colourway', aliases: ['per variante', 'per colore', 'colour dependent'], type: cell.boolean() },
    colours: { label: 'Colour by colourway', aliases: ['colore per variante', 'colori per variante', 'colours'], type: coloursCell(), description: 'Every colourway of the line: BLK=BLK; RED=RED.' },
    colour: { label: 'Colour', aliases: ['colore', 'colore materiale', 'material colour'], type: cell.code({ upper: true, max: 40 }), description: "The material's one colour for every colourway." },
    colourway: { label: 'Only in colourway', aliases: ['solo variante', 'solo nella variante', 'variante'], type: cell.code({ upper: true, max: 12 }) },
    supplier: { label: 'Supplier', aliases: ['fornitore', 'codice fornitore'], type: cell.code({ upper: true, max: 40 }), description: "Only when it is not the material's default." },
    note: { label: 'Note', aliases: ['nota', 'note', 'notes'], type: cell.text({ max: 1000 }) },
  },
  keyColumns: ['style', 'seq'],
  batchSize: 100,
  validateRow(values) {
    const issues: RowIssue[] = []
    if (typeof values.style === 'string' && !STYLE_CODE.test(values.style)) issues.push({ column: 'style', message: 'Not a style code.' })
    if (values.sizes !== undefined && values.sizeDependent === false) issues.push({ column: 'sizes', message: 'A line that is not by size gives one quantity per garment, not quantities by size.' })
    if (values.colours !== undefined && values.colourDependent === false) issues.push({ column: 'colours', message: 'A line that is not by colourway gives one colour, not colours by colourway.' })
    return issues
  },
  plan: (values, existing) => planBomRow(values, existing),
})

/** The pairs of a `sizes` or `colours` cell, by key. */
export function pairsOf(text: string): Map<string, string> {
  return new Map(
    text
      .split(';')
      .filter((part) => part !== '')
      .map((part) => {
        const at = part.indexOf('=')
        return [part.slice(0, at), part.slice(at + 1)] as const
      }),
  )
}

/** Two `sizes` (quantities by value) or `colours` cells hold the same pairs, in any order. */
function samePairs(column: 'sizes' | 'colours', a: CellValue | null, b: CellValue | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return a === b
  const left = pairsOf(a)
  const right = pairsOf(b)
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other === undefined) return false
    if (column === 'sizes' ? !new Dec(value).equals(new Dec(other)) : value !== other) return false
  }
  return true
}

/**
 * What one row does: a new place adds the line (CREATE with every given value); a known one changes the cells that
 * differ (quantities by size and colours by colourway compared as sets), else UNCHANGED. Whether the codes exist and
 * the line keeps every BOM rule is the adapter's check (the engine's `check`, before this).
 */
export function planBomRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    if (values.material === undefined) return { action: 'ERROR', errors: [{ column: 'material', message: 'Material is needed for a new line.' }] }
    return { action: 'CREATE', after: values }
  }
  const plain = Object.fromEntries(Object.entries(values).filter(([name]) => name !== 'sizes' && name !== 'colours'))
  const diff = diffPlan(bomImporter, plain, existing)
  const before: Record<string, CellValue | null> = diff.action === 'UPDATE' ? { ...diff.before } : {}
  const after: Record<string, CellValue> = diff.action === 'UPDATE' ? { ...diff.after } : {}
  for (const column of ['sizes', 'colours'] as const) {
    const given = values[column]
    if (given === undefined) continue
    const current = existing.values[column] ?? null
    if (!samePairs(column, given, current)) {
      before[column] = current
      after[column] = given
    }
  }
  return Object.keys(after).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before, after }
}

// ---- the export -----------------------------------------------------------------------------------------------------

/** A BOM line as the export writes it: codes, not ids. */
export interface ExportedLine {
  readonly style: string
  readonly seq: number
  readonly material: string
  readonly placement: string | null
  readonly qty: string
  readonly uom: Uom
  readonly wastagePct: string
  readonly sizeDependent: boolean
  readonly sizes: readonly { readonly size: string; readonly qty: string }[]
  readonly colourDependent: boolean
  readonly colours: readonly { readonly colourway: string; readonly colour: string }[]
  readonly colour: string | null
  readonly colourway: string | null
  readonly supplier: string | null
  readonly note: string | null
}

type Column = keyof typeof bomImporter.columns
export const BOM_COLUMNS = Object.keys(bomImporter.columns) as Column[]

/** A plain decimal written in a number format ("43.5" → "43,5" for it). */
export const numberText = (value: string, format: NumberFormat): string => (format === 'it' ? value.replace('.', ',') : value)

/**
 * The values of one exported line, by column, as the import reads them back: decimals as plain decimal strings (the
 * writer formats them), booleans as booleans, the pair cells in the number format, and nothing for an empty field.
 */
export function exportedValues(line: ExportedLine, format: NumberFormat): Partial<Record<Column, string | number | boolean>> {
  const values: Partial<Record<Column, string | number | boolean>> = {
    style: line.style,
    seq: line.seq,
    material: line.material,
    uom: line.uom,
    wastagePct: line.wastagePct,
    sizeDependent: line.sizeDependent,
    colourDependent: line.colourDependent,
  }
  if (!line.sizeDependent) values.qty = line.qty
  if (line.placement !== null) values.placement = line.placement
  if (line.sizeDependent && line.sizes.length > 0) values.sizes = line.sizes.map((row) => `${row.size}=${numberText(row.qty, format)}`).join('; ')
  if (line.colourDependent && line.colours.length > 0) values.colours = line.colours.map((cell) => `${cell.colourway}=${cell.colour}`).join('; ')
  if (line.colour !== null) values.colour = line.colour
  if (line.colourway !== null) values.colourway = line.colourway
  if (line.supplier !== null) values.supplier = line.supplier
  if (line.note !== null) values.note = line.note
  return values
}

/** The record values the adapter loads for a stored line (the columns, in the JSON kinds the cells parse to). */
export function lineRecordValues(line: ExportedLine): RecordValues {
  const values = exportedValues(line, 'en')
  const record: Record<string, CellValue | null> = Object.fromEntries(BOM_COLUMNS.map((column) => [column, null]))
  for (const [column, value] of Object.entries(values)) record[column] = value ?? null
  // Stored canonically: `;` between pairs, plain decimals.
  record.sizes = line.sizeDependent && line.sizes.length > 0 ? line.sizes.map((row) => `${row.size}=${row.qty}`).join(';') : null
  record.colours = line.colourDependent && line.colours.length > 0 ? line.colours.map((cell) => `${cell.colourway}=${cell.colour}`).join(';') : null
  return record
}
