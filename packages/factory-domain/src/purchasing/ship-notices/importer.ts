import { cell } from '../../imports/cells'
import { defineImporter, type Importer, type RowIssue, type RowValues } from '../../imports/importer'
import { QUANTITY_SCALE } from '../../inventory/ledger/moves'
import { MAX_THICKNESS_MM } from '../../inventory/receipts/rules'
import type { Uom } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { SHIP_NOTICE_LIMITS, type HideInput } from './rules'

/**
 * The tannery's packing list on a ship notice (B-W2b-182; SCM-107; design portal.supplier.asn step 2 "Upload CSV, Excel …
 * Rows: hide or bundle ID · area per hide (ft² or m²) · grade · dye batch · thickness"), pure: one row per hide, read by the
 * import engine's own cells (Italian and English numbers and headers, any order). Two ways in, one definition:
 *
 *   the supplier in the portal   its sheet is read in the request with these columns (the notice is the page's, so its
 *                                column is left out: `PORTAL_PACKING_LIST`), checked against the order row by row (the
 *                                verdicts) before anything is kept; nothing of the file is stored.
 *   the office                   through the imports registry (platform/imports, a dry run first) onto a SENT notice by its
 *                                number, when the tannery mailed its list instead (apps/factory-api's adapter).
 *
 * Key: the notice and the tannery's number on the hide: a hide listed again replaces its row (the area, grade …), never a
 * second hide.
 */

export const PACKING_LIST_IMPORTER_KEY = 'purchasing.packingList'

const AREA_ALIASES = { m2: 'M2', mq: 'M2', 'm²': 'M2', 'metri quadri': 'M2', 'square metres': 'M2', ft2: 'FT2', 'ft²': 'FT2', sqft: 'FT2', 'sq ft': 'FT2', piedi: 'FT2', 'piedi quadri': 'FT2', 'square feet': 'FT2', dm2: 'DM2', 'dm²': 'DM2', dmq: 'DM2' } as const satisfies Record<string, Uom>

const code = () => cell.code({ max: SHIP_NOTICE_LIMITS.code })

export const packingListImporter = defineImporter({
  key: PACKING_LIST_IMPORTER_KEY,
  label: 'Packing list of a ship notice',
  description: "The tannery's packing list of a delivery it announced, one row per hide (its number, area, grade, thickness, dye batch), checked against the purchase order before the goods arrive.",
  columns: {
    notice: { label: 'Ship notice', aliases: ['avviso', 'avviso di spedizione', 'asn', 'asn number', 'ship notice number', 'notice'], required: true, type: cell.code({ max: 40 }), description: 'Our ship notice number (ASN-2026-0001): every row of one list names the same notice. The portal leaves it out.' },
    hideNumber: { label: 'Hide number', aliases: ['numero pelle', 'n pelle', 'pelle', 'numero conceria', 'cartellino', 'hide', 'hide no', 'hide id', 'bundle', 'bundle id', 'tag', 'tannery number'], required: true, type: code(), description: "The tannery's own number on the hide (or the bundle): unique on the notice." },
    area: { label: 'Area', aliases: ['superficie', 'misura', 'metratura', 'mq pelle', 'area per hide', 'measured area', 'size'], required: true, type: cell.decimal({ precision: 18, scale: QUANTITY_SCALE, min: '0' }), description: 'The area the tannery measured, above 0.' },
    unit: { label: 'Unit', aliases: ['um', 'u m', 'unita', 'unita di misura', 'uom', 'area unit'], type: cell.oneOf(['M2', 'DM2', 'FT2'] as const, AREA_ALIASES), description: "M2, DM2 or FT2; blank: the order line's unit." },
    line: { label: 'Order line', aliases: ['riga', 'riga ordine', 'n riga', 'order line no', 'po line'], type: cell.integer({ min: 1, max: 9_999 }), description: "Our order line's number (10, 20 …); blank: the notice's one leather line." },
    grade: { label: 'Grade', aliases: ['scelta', 'selezione', 'qualita', 'selection'], type: cell.text({ max: SHIP_NOTICE_LIMITS.code }) },
    thicknessMm: { label: 'Thickness (mm)', aliases: ['spessore', 'spessore mm', 'thickness', 'thickness mm'], type: cell.decimal({ precision: 6, scale: 2, min: '0' }) },
    dyeBatch: { label: 'Dye batch', aliases: ['bagno', 'partita', 'bagno colore', 'bagno di tintura', 'dye lot', 'batch'], type: code(), description: 'The dye batch (one shade) of the hide.' },
    note: { label: 'Note', aliases: ['note', 'nota', 'difetti', 'remarks'], type: cell.text({ max: SHIP_NOTICE_LIMITS.reason }) },
  },
  keyColumns: ['notice', 'hideNumber'],
  maxRows: SHIP_NOTICE_LIMITS.hides,
  // One list is one notice: its apply is one batch (one command).
  batchSize: SHIP_NOTICE_LIMITS.hides,
  validateRow: (values: RowValues): RowIssue[] => {
    const issues: RowIssue[] = []
    if (values.area !== undefined && new Dec(String(values.area)).lessThanOrEqualTo(0)) issues.push({ column: 'area', message: 'A hide has an area above 0.' })
    if (values.thicknessMm !== undefined && new Dec(String(values.thicknessMm)).greaterThan(MAX_THICKNESS_MM)) issues.push({ column: 'thicknessMm', message: `At most ${MAX_THICKNESS_MM} mm.` })
    if (values.thicknessMm !== undefined && new Dec(String(values.thicknessMm)).lessThanOrEqualTo(0)) issues.push({ column: 'thicknessMm', message: 'Above 0.' })
    return issues
  },
})

/** The same list without the notice's column: what the portal reads and gives as its template (the notice is the page's). */
export const PORTAL_PACKING_LIST: Importer = (() => {
  const { notice: _notice, ...columns } = packingListImporter.columns
  return Object.freeze({ ...packingListImporter, columns, keyColumns: ['hideNumber'] })
})()

/** A parsed row as the packing list's row. */
export function hideInputOf(values: RowValues): HideInput {
  const textOf = (value: unknown): string | null => (value === undefined || value === null ? null : String(value))
  return {
    line: typeof values.line === 'number' ? values.line : null,
    hideNumber: String(values.hideNumber ?? ''),
    area: String(values.area ?? ''),
    unit: (values.unit as Uom | undefined) ?? null,
    grade: textOf(values.grade),
    thicknessMm: textOf(values.thicknessMm),
    dyeBatch: textOf(values.dyeBatch),
    note: textOf(values.note),
  }
}
