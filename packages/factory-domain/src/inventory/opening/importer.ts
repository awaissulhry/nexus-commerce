import { z } from 'zod'
import { CELL_META, cell, plainDecimal, readNumberText, type CellInput, type CellValue, type NumberFormat } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type ImportColumn, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { materialImporter } from '../../product/materials/importer'
import { CR_VI_EVIDENCE, CR_VI_METHODS } from '../../quality/lab/rules'
import { Dec, parseDecimal } from '../../tax/decimal'
import { QUANTITY_SCALE } from '../ledger/moves'
import { areasOf, OPENING_IMPORTER_KEY, OPENING_LIMITS } from './rules'

/**
 * The opening stock import (B-W1-35; SCM-288, QHS-029; A2 SCR-017 admin.import, SCR-060 st-import): one row per line of
 * the count, keyed by the line's own reference (`line`, unique among the company's opening stock). The rules are
 * ./rules.ts; the adapter (apps/factory-api modules/inventory/opening/importer.ts) reads the facts each row names and
 * judges it in the dry run (the engine's `check`) and again when it writes. A line imported before is UNCHANGED when the
 * row says the same (site, location, material, colour, lot, unit and quantities), else an error: never posted twice.
 *
 * Money: the unit cost is the cost grain (per the row's unit, in the material's currency); without it the standard cost
 * values the stock.
 */

/** Several hides of a lot in one cell: their areas split by `;` or `|`, in the job's number format ("5,20; 4,85"). */
function areasCell() {
  const schema = z
    .custom<CellInput>((value) => value !== null && typeof value === 'object' && 'context' in (value as object))
    .transform((input, ctx) => {
      const fail = (message: string) => {
        ctx.issues.push({ code: 'custom', message, input })
        return z.NEVER
      }
      const raw = typeof input.raw === 'string' ? input.raw : typeof input.raw === 'number' && Number.isFinite(input.raw) ? String(input.raw) : null
      if (raw === null) return fail('Expected the hides\' areas split by ; (like 5,20; 4,85).')
      const parts = raw.split(/[;|]/).map((part) => part.trim()).filter((part) => part !== '')
      if (parts.length === 0) return fail('Expected the hides\' areas split by ; (like 5,20; 4,85).')
      if (parts.length > OPENING_LIMITS.hidesPerRow) return fail(`At most ${OPENING_LIMITS.hidesPerRow} hides in one row: split the lot over more rows.`)
      const areas: string[] = []
      for (const part of parts) {
        const text = typeof input.raw === 'number' ? part : readNumberText(part, input.context.numberFormat)
        const value = text === null ? null : parseDecimal(text)
        if (value === null) return fail('Expected the hides\' areas split by ; (like 5,20; 4,85).')
        if (value.lessThanOrEqualTo(0)) return fail('Every hide has an area above 0.')
        if (value.decimalPlaces() > QUANTITY_SCALE) return fail(`At most ${QUANTITY_SCALE} decimals per area.`)
        if (value.greaterThanOrEqualTo(new Dec(10).pow(14))) return fail('An area is too large.')
        areas.push(plainDecimal(value))
      }
      return areas.join(';')
    }) as unknown as z.ZodType<string, CellInput>
  schema.register(CELL_META, { kind: 'text', describe: "the hides' areas split by ; (5,20; 4,85)" })
  return schema
}

const METHOD_ALIASES = {
  '17075-1': 'EN ISO 17075-1',
  'iso 17075-1': 'EN ISO 17075-1',
  'uni en iso 17075-1': 'EN ISO 17075-1',
  colorimetric: 'EN ISO 17075-1',
  colorimetrico: 'EN ISO 17075-1',
  '17075-2': 'EN ISO 17075-2',
  'iso 17075-2': 'EN ISO 17075-2',
  'uni en iso 17075-2': 'EN ISO 17075-2',
  chromatographic: 'EN ISO 17075-2',
  cromatografico: 'EN ISO 17075-2',
} as const satisfies Record<string, (typeof CR_VI_METHODS)[number]>
const EVIDENCE_ALIASES = {
  'lot report': 'LOT_REPORT',
  'rapporto lotto': 'LOT_REPORT',
  'rapporto del lotto': 'LOT_REPORT',
  lotto: 'LOT_REPORT',
  'supplier report': 'SUPPLIER_REPORT',
  'rapporto fornitore': 'SUPPLIER_REPORT',
  'rapporto del fornitore': 'SUPPLIER_REPORT',
  fornitore: 'SUPPLIER_REPORT',
} as const satisfies Record<string, (typeof CR_VI_EVIDENCE)[number]>

const code = (max = 40) => cell.code({ max, upper: true })

export const openingStockImporter = defineImporter({
  key: OPENING_IMPORTER_KEY,
  label: 'Opening stock',
  description: 'The stock on hand before the factory app: lots, hides one by one with their areas, linings, trims and protectors, with the existing chromium VI test reports. Lots that need the quality step wait in quarantine.',
  columns: {
    line: { label: 'Line', aliases: ['riga', 'rif', 'riferimento', 'ref', 'reference', 'riga inventario', 'count line'], required: true, type: code(), description: 'Your reference for the row, unique among the company\'s opening stock (a count sheet line: CS-0001). A line imported once is never posted again.' },
    site: { label: 'Site', aliases: ['sito', 'stabilimento', 'sede', 'site code'], required: true, type: code(), description: "The site's code." },
    location: { label: 'Location', aliases: ['ubicazione', 'location code', 'bin', 'scaffale', 'posizione'], required: true, type: code(), description: 'The code of the location on the site where the stock lies.' },
    item: { label: 'Material', aliases: ['materiale', 'articolo', 'codice articolo', 'material code', 'item code'], required: true, type: code(), description: "The material's code." },
    colour: { label: 'Colour', aliases: ['colore', 'color', 'colour code'], type: code(), description: "The material's colour code; needed when the material has colours." },
    lot: { label: 'Lot', aliases: ['lotto', 'lot code', 'supplier lot', 'lotto fornitore', 'partita'], type: cell.code({ max: OPENING_LIMITS.code }), description: "The supplier's lot or dye batch on the label; needed for a material tracked by lot or hide. The rows of one lot make one lot." },
    dyeBatch: { label: 'Dye batch', aliases: ['bagno', 'bagno di tintura', 'dye lot'], type: cell.code({ max: OPENING_LIMITS.code }) },
    shade: { label: 'Shade', aliases: ['tonalita', 'tono', 'sfumatura'], type: cell.text({ max: 60 }) },
    supplier: { label: 'Supplier', aliases: ['fornitore', 'supplier code', 'codice fornitore', 'conceria', 'tannery'], type: code(), description: "The supplier's party code (the lot's)." },
    quantity: { label: 'Quantity', aliases: ['quantita', 'qta', 'qty', 'giacenza', 'area', 'superficie'], type: cell.decimal({ precision: 18, scale: 4 }), description: 'How much lies there, in Unit; for a hide its measured area.' },
    unit: { label: 'Unit', aliases: ['um', 'unita', 'unita di misura', 'uom'], required: true, type: materialImporter.columns.baseUom.type, description: 'The unit of Quantity (hides: M2, DM2 or FT2).' },
    areas: { label: 'Hide areas', aliases: ['aree', 'aree pelli', 'superfici', 'superfici pelli'], type: areasCell(), description: 'Several hides of the lot in one row: each one\'s area in Unit, split by ; (5,20; 4,85). Leave Quantity blank.' },
    hides: { label: 'Hides', aliases: ['pelli', 'numero pelli', 'n pelli', 'hide count'], type: cell.integer({ min: 1, max: OPENING_LIMITS.hidesPerRow }), description: 'How many hides the row holds (a check of Hide areas).' },
    hideNumber: { label: 'Hide number', aliases: ['numero pelle', 'n pelle', 'hide no', 'tannery number', 'numero conceria'], type: cell.code({ max: OPENING_LIMITS.code }), description: "The tannery's number on the hide (one hide per row)." },
    grade: { label: 'Grade', aliases: ['scelta', 'selezione', 'selection'], type: cell.text({ max: 40 }) },
    thicknessMm: { label: 'Thickness (mm)', aliases: ['spessore', 'spessore mm', 'thickness'], type: cell.decimal({ precision: 6, scale: 2 }) },
    defects: { label: 'Defects', aliases: ['difetti'], type: cell.text({ max: OPENING_LIMITS.defects }) },
    receivedOn: { label: 'Received on', aliases: ['data ricevimento', 'ricevuto il', 'data arrivo', 'received'], type: cell.date(), description: 'The day the lot came in, when known (a supplier report\'s period must hold it); else the stock date.' },
    stockDate: { label: 'Stock date', aliases: ['data giacenza', 'data inventario', 'as of', 'opening date', 'alla data'], type: cell.date(), description: 'The day the counted stock stood there; blank: the day of the import.' },
    unitCost: { label: 'Unit cost', aliases: ['costo unitario', 'costo', 'cost', 'prezzo unitario'], type: cell.decimal({ precision: 18, scale: 6, min: '0' }), grain: 'cost', description: "Per Unit, in the material's currency; blank: its standard cost." },
    crViMgKg: { label: 'Cr VI (mg/kg)', aliases: ['cromo vi', 'cr vi', 'cr6', 'cromo esavalente', 'chromium vi'], type: cell.decimal({ precision: 8, scale: 3, min: '0' }), description: 'The measured chromium VI of the existing report.' },
    detectionLimitMgKg: { label: 'Detection limit (mg/kg)', aliases: ['limite di rilevabilita', 'limite rilevabilita', 'lod', 'detection limit'], type: cell.decimal({ precision: 8, scale: 3 }), description: 'Not detected: the lab\'s detection limit (leave Cr VI blank).' },
    crViMethod: { label: 'Method', aliases: ['metodo', 'metodo di prova', 'test method'], type: cell.oneOf(CR_VI_METHODS, METHOD_ALIASES) },
    lab: { label: 'Lab', aliases: ['laboratorio', 'laboratory'], type: cell.text({ max: OPENING_LIMITS.text }) },
    reportNumber: { label: 'Report number', aliases: ['numero rapporto', 'n rapporto', 'rapporto di prova', 'report no', 'test report'], type: cell.text({ max: OPENING_LIMITS.text }) },
    testedOn: { label: 'Tested on', aliases: ['data prova', 'data test', 'testato il', 'test date'], type: cell.date() },
    evidence: { label: 'Evidence', aliases: ['evidenza', 'tipo rapporto', 'report type'], type: cell.oneOf(CR_VI_EVIDENCE, EVIDENCE_ALIASES), description: "LOT_REPORT (a lab report on this lot) or SUPPLIER_REPORT (the supplier's report covering the article and a period); blank: a supplier report when Report article or a period is given." },
    article: { label: 'Report article', aliases: ['articolo del rapporto', 'articolo rapporto', 'report article'], type: cell.text({ max: OPENING_LIMITS.text }) },
    periodFrom: { label: 'Report from', aliases: ['periodo dal', 'valido dal', 'period from', 'covers from'], type: cell.date() },
    periodTo: { label: 'Report to', aliases: ['periodo al', 'valido al', 'period to', 'covers to'], type: cell.date() },
    reportFile: { label: 'Report file', aliases: ['file rapporto', 'pdf rapporto', 'report pdf', 'allegato'], type: cell.text({ max: OPENING_LIMITS.fileName }), description: "The report's file name, as uploaded to the company's opening-stock reports." },
    certificate: { label: 'PPE certificate', aliases: ['certificato', 'certificato dpi', 'certificate', 'ppe certificate number'], type: cell.text({ max: OPENING_LIMITS.text }), description: "A certified PPE component: its certificate's number in the register." },
  },
  keyColumns: ['line'],
  // Each row may post a lot, many hides and their moves: small batches keep each transaction short.
  batchSize: 50,
  validateRow: (values: RowValues): RowIssue[] => {
    const issues: RowIssue[] = []
    const quantity = values.quantity === undefined ? null : new Dec(String(values.quantity))
    if (quantity !== null && quantity.lessThanOrEqualTo(0)) issues.push({ column: 'quantity', message: 'The quantity is above 0: opening stock is what lies there.' })
    if (values.quantity === undefined && values.areas === undefined) issues.push({ column: 'quantity', message: "Give the quantity (for a hide its measured area), or the hides' areas." })
    if (values.quantity !== undefined && values.areas !== undefined) issues.push({ column: 'areas', message: "Give the quantity or the hides' areas, not both." })
    if (values.hides !== undefined) {
      const count = values.areas === undefined ? 1 : areasOf(values).length
      if (values.hides !== count) issues.push({ column: 'hides', message: `The row holds ${count} hide${count === 1 ? '' : 's'}, not ${String(values.hides)}.` })
    }
    if (values.receivedOn !== undefined && values.stockDate !== undefined && String(values.receivedOn) > String(values.stockDate)) {
      issues.push({ column: 'receivedOn', message: 'The lot came in before the stock date, not after it.' })
    }
    return issues
  },
  plan: (values, existing) => planLine(values, existing),
})

// ---- a line imported before -------------------------------------------------------------------------------------------------

/** What a line posted: the adapter's load answers it as `$imported` beside the columns. */
export interface ImportedLine {
  readonly site: string
  readonly location: string
  readonly item: string
  readonly colour: string | null
  readonly lot: string | null
  /** Our lot number, when it has one. */
  readonly lotCode: string | null
  readonly unit: string
  /** Each move's quantity as entered (one per hide for leather), in posting order. */
  readonly quantities: readonly string[]
}

const IMPORTED = '$imported'

export function importedLineValues(line: string, imported: ImportedLine): RecordValues {
  const columns: Record<string, CellValue | null> = {
    line,
    site: imported.site,
    location: imported.location,
    item: imported.item,
    colour: imported.colour,
    lot: imported.lot,
    unit: imported.unit,
    quantity: imported.quantities.length === 1 ? plainDecimal(new Dec(imported.quantities[0]!)) : null,
    areas: imported.quantities.length > 1 ? imported.quantities.map((value) => plainDecimal(new Dec(value))).join(';') : null,
  }
  return { ...columns, [IMPORTED]: JSON.stringify(imported) }
}

function importedOf(existing: ExistingRecord): ImportedLine {
  const raw = existing.values[IMPORTED]
  if (typeof raw !== 'string') throw new Error('The opening stock import needs the imported line ($imported) beside the columns.')
  return JSON.parse(raw) as ImportedLine
}

const sameQuantities = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => new Dec(value).equals(new Dec(b[index]!)))

/** A new line is a CREATE (its facts are the adapter's check); a line imported before is UNCHANGED when it says the same. */
export function planLine(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) return { action: 'CREATE', after: values }
  const imported = importedOf(existing)
  const quantities = values.areas !== undefined ? areasOf(values) : values.quantity !== undefined ? [String(values.quantity)] : []
  const same =
    imported.site === values.site &&
    imported.location === values.location &&
    imported.item === values.item &&
    imported.colour === (values.colour ?? null) &&
    imported.lot === (values.lot ?? null) &&
    imported.unit === values.unit &&
    sameQuantities(imported.quantities, quantities)
  if (same) return { action: 'UNCHANGED' }
  const what = `${imported.item}${imported.colour ? ` ${imported.colour}` : ''}${imported.lotCode ? `, lot ${imported.lotCode}` : ''} at ${imported.site} ${imported.location}`
  return {
    action: 'ERROR',
    errors: [{ column: 'line', message: `Line ${String(values.line)} was imported before (${what}) with other values: a line is never posted twice. Correct the stock with an adjustment, or give this row a line of its own.` }],
  }
}

// ---- the template -----------------------------------------------------------------------------------------------------------

/** Made-up rows that show every shape: hides one per row, a lot of hides in one row, a lining in metres, protectors per piece. */
const EXAMPLES: readonly Readonly<Record<string, string>>[] = [
  { line: 'CS-0001', site: 'A1', location: 'A1-STORE', item: 'LEA-100', colour: 'BLK', lot: 'DB-4471', quantity: '5.2', unit: 'M2', hideNumber: 'T-101', grade: 'A', thicknessMm: '1.2', stockDate: '2026-12-31', crViMgKg: '1.2', crViMethod: 'EN ISO 17075-1', lab: 'Example Lab', reportNumber: 'EL-0001', testedOn: '2026-09-01', evidence: 'LOT_REPORT', reportFile: 'cr6-db-4471.pdf' },
  { line: 'CS-0002', site: 'A1', location: 'A1-STORE', item: 'LEA-100', colour: 'BLK', lot: 'DB-4471', quantity: '4.85', unit: 'M2', hideNumber: 'T-102', grade: 'B', thicknessMm: '1.25', defects: 'Small scar near the neck edge', stockDate: '2026-12-31', crViMgKg: '1.2', crViMethod: 'EN ISO 17075-1', lab: 'Example Lab', reportNumber: 'EL-0001', testedOn: '2026-09-01', evidence: 'LOT_REPORT', reportFile: 'cr6-db-4471.pdf' },
  { line: 'CS-0003', site: 'A1', location: 'A1-STORE', item: 'LEA-100', colour: 'RED', lot: 'DB-4480', areas: '4.85;5.1;5.3', hides: '3', unit: 'M2', receivedOn: '2026-06-10', stockDate: '2026-12-31', detectionLimitMgKg: '0.5', crViMethod: 'EN ISO 17075-2', lab: 'Example Lab', testedOn: '2026-02-15', evidence: 'SUPPLIER_REPORT', article: 'NAPPA-12', periodFrom: '2026-01-01', periodTo: '2026-12-31', reportFile: 'supplier-nappa-2026.pdf' },
  { line: 'CS-0010', site: 'A1', location: 'A1-STORE', item: 'LIN-200', colour: 'GRY', lot: 'R-77', quantity: '120', unit: 'M', stockDate: '2026-12-31', unitCost: '3.1' },
  { line: 'CS-0020', site: 'A1', location: 'A1-STORE', item: 'PRO-300', lot: 'P-2026-01', quantity: '24', unit: 'PCS', stockDate: '2026-12-31', certificate: 'CERT-0002' },
]

const DECIMAL_COLUMNS = new Set(['quantity', 'areas', 'thicknessMm', 'unitCost', 'crViMgKg', 'detectionLimitMgKg'])
const DATE_COLUMNS = new Set(['receivedOn', 'stockDate', 'testedOn', 'periodFrom', 'periodTo'])

/**
 * The template of the import (A2 SCR-017 "Download template"): every column's label in order, and made-up example rows
 * written as a person types them in the number format (Italian: 5,2 and 31/12/2026; English: 5.2 and 2026-12-31).
 */
export function openingTemplate(format: NumberFormat): { readonly header: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly columns: readonly { readonly name: string; readonly label: string; readonly required: boolean; readonly description: string | null }[] } {
  const columns = Object.entries(openingStockImporter.columns as Readonly<Record<string, ImportColumn>>).map(([name, column]) => ({ name, label: column.label, required: column.required === true, description: column.description ?? null }))
  const shown = (name: string, value: string | undefined): string => {
    if (value === undefined) return ''
    if (DECIMAL_COLUMNS.has(name) && format === 'it') return value.replace(/\./g, ',').replace(/;/g, '; ')
    if (DECIMAL_COLUMNS.has(name)) return value.replace(/;/g, '; ')
    if (DATE_COLUMNS.has(name) && format === 'it') return value.split('-').reverse().join('/')
    return value
  }
  return { header: columns.map((column) => column.label), rows: EXAMPLES.map((example) => columns.map((column) => shown(column.name, example[column.name]))), columns }
}
