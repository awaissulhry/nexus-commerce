import { cell } from '../../imports/cells'
import { defineImporter, type RowIssue, type RowValues } from '../../imports/importer'
import type { TemplateExample } from '../../imports/templates'
import { ORDERING_LIMITS, type SizeAsk, type Words } from './rules'

/**
 * Order upload from a spreadsheet (B-W2b-190, SAL-073; design portal.customer.neworder upload "Template (style, colour,
 * size, quantity, your code) · Upload CSV or Excel · Result per row: ready / refused with the reason ('Size 62 not
 * offered for JKT-RACE') · Nothing is added until 'Add 42 rows to the order' · Download refused rows to fix them").
 *
 * The importer (the imports registry's `sales.portalOrderLines`, so the sheet is read, its headers mapped and its cells
 * parsed by the imports engine's own rules): one row per style, colour and size. The dry run gives each row a verdict
 * before anything lands: READY, or REFUSED with the reason in words (a cell that does not parse, a style not in the
 * customer's catalogue, a colour it does not have, a size not offered, a row that repeats an earlier one). Adding puts
 * the READY rows into the draft, one line per style and colour with its sizes (a line the draft already has for that
 * style and colour takes the sizes it did not have; a size it had keeps the draft's quantity and is named).
 */

export const portalOrderLinesImporter = defineImporter({
  key: 'sales.portalOrderLines',
  label: 'Order lines (customer portal)',
  description: 'One row per style, colour and size of an order request; read in the customer portal with a dry run.',
  columns: {
    style: { label: 'Style', aliases: ['style code', 'codice', 'codice articolo', 'articolo', 'modello', 'our code'], required: true, type: cell.code({ max: 64, upper: true }), description: 'Our style code, as the catalogue shows it.' },
    colour: { label: 'Colour', aliases: ['color', 'colore', 'colourway', 'variante', 'colour code'], required: true, type: cell.text({ max: 100 }), description: "The colour's code or name, as the catalogue shows it." },
    size: { label: 'Size', aliases: ['taglia', 'misura'], required: true, type: cell.text({ max: ORDERING_LIMITS.size }) },
    quantity: { label: 'Quantity', aliases: ['qty', 'pieces', 'quantità', 'quantita', 'pezzi', 'qta'], required: true, type: cell.integer({ min: 1, max: ORDERING_LIMITS.quantity }) },
    yourCode: { label: 'Your code', aliases: ['your style code', 'il vostro codice', 'vostro codice', 'codice cliente', 'customer code'], type: cell.text({ max: 100 }), description: 'Your own code for the style (kept as the line note).' },
  },
  keyColumns: ['style', 'colour', 'size'],
  maxRows: 2000,
})

/** Made-up example rows of the order template (never business data). */
export const ORDER_TEMPLATE_EXAMPLES: readonly TemplateExample[] = Object.freeze([
  { style: 'JKT-100', colour: 'BLK', size: '50', quantity: '4', yourCode: 'R-100' },
  { style: 'JKT-100', colour: 'BLK', size: '52', quantity: '6', yourCode: 'R-100' },
])

export interface UploadRow {
  readonly rowNumber: number
  readonly values: RowValues
  /** The engine's parse problems (a cell that does not parse, a required cell left blank). */
  readonly errors: readonly RowIssue[]
}

/** The customer's catalogue as the check reads it: by style code (upper case). */
export interface CatalogueEntry {
  readonly styleId: string
  readonly styleCode: string
  /** Colourways by code and by name (folded to lower case): their id and the sizes offered in range order. */
  readonly colourways: readonly { readonly id: string; readonly code: string; readonly name: string; readonly offered: readonly string[] }[]
}

export interface RowVerdict {
  readonly rowNumber: number
  readonly status: 'READY' | 'REFUSED'
  readonly style: string | null
  readonly colour: string | null
  readonly size: string | null
  readonly quantity: number | null
  readonly yourCode: string | null
  /** READY: the line it goes to. */
  readonly styleId: string | null
  readonly colourwayId: string | null
  readonly reasons: readonly Words[]
}

const text = (value: unknown): string | null => (value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim())
const fold = (value: string): string => value.trim().toLowerCase()

/** One verdict per row, in the sheet's order. */
export function uploadVerdicts(rows: readonly UploadRow[], catalogue: ReadonlyMap<string, CatalogueEntry>): RowVerdict[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const style = text(row.values.style)?.toUpperCase() ?? null
    const colour = text(row.values.colour)
    const size = text(row.values.size)
    const quantity = typeof row.values.quantity === 'number' ? row.values.quantity : null
    const yourCode = text(row.values.yourCode)
    const base = { rowNumber: row.rowNumber, style, colour, size, quantity, yourCode }
    const refused = (reasons: Words[]): RowVerdict => ({ ...base, status: 'REFUSED', styleId: null, colourwayId: null, reasons })
    if (row.errors.length > 0) return refused(row.errors.map((issue) => ({ it: `${issue.column ? `${issue.column}: ` : ''}${issue.message}`, en: `${issue.column ? `${issue.column}: ` : ''}${issue.message}` })))
    const entry = style === null ? undefined : catalogue.get(style)
    if (!entry) return refused([{ it: `${style ?? 'Lo stile'} non è nel vostro catalogo.`, en: `${style ?? 'The style'} is not in your catalogue.` }])
    const wanted = colour === null ? '' : fold(colour)
    const colourway = entry.colourways.find((item) => fold(item.code) === wanted) ?? entry.colourways.find((item) => fold(item.name) === wanted)
    if (!colourway) return refused([{ it: `${entry.styleCode} non ha il colore ${colour ?? ''}.`, en: `${entry.styleCode} has no colour ${colour ?? ''}.` }])
    if (size === null || !colourway.offered.includes(size)) return refused([{ it: `Taglia ${size ?? ''} non offerta per ${entry.styleCode} ${colourway.code}.`, en: `Size ${size ?? ''} not offered for ${entry.styleCode} ${colourway.code}.` }])
    const key = `${entry.styleId}|${colourway.id}|${size}`
    const first = seen.get(key)
    if (first !== undefined) return refused([{ it: `Ripete la riga ${first} (stesso stile, colore e taglia).`, en: `Repeats row ${first} (same style, colour and size).` }])
    seen.set(key, row.rowNumber)
    return { ...base, status: 'READY', styleId: entry.styleId, colourwayId: colourway.id, reasons: [] }
  })
}

export interface UploadLine {
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: readonly SizeAsk[]
  /** The customer's own code(s) for the style, kept as the line note. */
  readonly note: string | null
}

/** The READY rows as draft lines: one per style and colour, its sizes in the sheet's order. */
export function linesOfReady(verdicts: readonly RowVerdict[]): UploadLine[] {
  const lines = new Map<string, { styleId: string; colourwayId: string; sizes: SizeAsk[]; codes: Set<string> }>()
  for (const verdict of verdicts) {
    if (verdict.status !== 'READY') continue
    const key = `${verdict.styleId}|${verdict.colourwayId}`
    const line = lines.get(key) ?? { styleId: verdict.styleId!, colourwayId: verdict.colourwayId!, sizes: [], codes: new Set<string>() }
    line.sizes.push({ size: verdict.size!, quantity: verdict.quantity! })
    if (verdict.yourCode) line.codes.add(verdict.yourCode)
    lines.set(key, line)
  }
  return [...lines.values()].map((line) => ({ styleId: line.styleId, colourwayId: line.colourwayId, sizes: line.sizes, note: line.codes.size === 0 ? null : [...line.codes].join(', ').slice(0, ORDERING_LIMITS.lineNote) }))
}

/** The refused rows as a CSV to fix them (header + the row's cells + the reason), `;` between cells (an Italian Excel's). */
export function refusedRowsCsv(verdicts: readonly RowVerdict[], locale: 'it' | 'en'): string {
  const cellText = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const header = locale === 'it' ? ['Riga', 'Stile', 'Colore', 'Taglia', 'Quantità', 'Vostro codice', 'Motivo'] : ['Row', 'Style', 'Colour', 'Size', 'Quantity', 'Your code', 'Reason']
  const rows = verdicts
    .filter((verdict) => verdict.status === 'REFUSED')
    .map((verdict) => [String(verdict.rowNumber), verdict.style ?? '', verdict.colour ?? '', verdict.size ?? '', verdict.quantity === null ? '' : String(verdict.quantity), verdict.yourCode ?? '', verdict.reasons.map((reason) => reason[locale]).join(' ')])
  return `${[header, ...rows].map((row) => row.map(cellText).join(';')).join('\r\n')}\r\n`
}
