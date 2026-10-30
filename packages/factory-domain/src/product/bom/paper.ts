import { BUSINESS_TIME_ZONE } from '../../core/time'
import { formatDateTime } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { RevisionStatus } from '../styles/revisions'
import { UNITS } from '../units/units'
import { numberText, type ExportedLine } from './importer'

/**
 * The BOM sheet as a PDF (feature PRD-090; design style.bom.lines "Export XLSX / PDF"), composed here in words and
 * painted by apps/factory-api modules/product/bom/export.ts: one revision's lines in BOM order with their material,
 * placement, quantity per garment (or per size), unit, wastage, colours, colourway, supplier and note. An internal
 * paper (no legal lines); no money (a cost is the cost sheet's, with its grain). Made on request, stored nowhere.
 */

const WORDS = {
  it: {
    title: 'Distinta base',
    facts: { style: 'Modello', revision: 'Revisione', status: 'Stato', sizes: 'Taglie', printed: 'Stampata il', lines: 'Righe' },
    status: { DRAFT: 'bozza', RELEASED: 'rilasciata', OBSOLETE: 'obsoleta' } satisfies Record<RevisionStatus, string>,
    columns: { seq: 'Pos.', material: 'Materiale', placement: 'Posizione', qty: 'Q.tà per capo', unit: 'UM', wastage: 'Sfrido %', colour: 'Colore', colourway: 'Solo variante', supplier: 'Fornitore', note: 'Nota' },
    bySize: 'per taglia',
    byColourway: 'per variante',
    page: 'Pagina {page} di {pages}',
    continued: 'segue',
  },
  en: {
    title: 'Bill of materials',
    facts: { style: 'Style', revision: 'Revision', status: 'Status', sizes: 'Sizes', printed: 'Printed', lines: 'Lines' },
    status: { DRAFT: 'draft', RELEASED: 'released', OBSOLETE: 'obsolete' } satisfies Record<RevisionStatus, string>,
    columns: { seq: 'Seq', material: 'Material', placement: 'Placement', qty: 'Qty per garment', unit: 'Unit', wastage: 'Wastage %', colour: 'Colour', colourway: 'Only in', supplier: 'Supplier', note: 'Note' },
    bySize: 'by size',
    byColourway: 'by colourway',
    page: 'Page {page} of {pages}',
    continued: 'continued',
  },
} as const

export const BOM_PAPER_WORDS = WORDS

/** A column of the paper's table: its width in thousandths of the table. */
export interface PaperColumn {
  readonly label: string
  readonly width: number
  readonly align: 'left' | 'right'
}

export interface BomPaper {
  readonly language: DocumentLanguage
  readonly title: string
  readonly subtitle: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly columns: readonly PaperColumn[]
  readonly rows: readonly (readonly string[])[]
  readonly footer: { readonly page: string; readonly continued: string }
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
  readonly fileName: string
}

/** A line of the paper: an exported line with its material's name. */
export interface PaperLine extends ExportedLine {
  readonly materialName: string
}

export interface BomPaperInput {
  readonly style: { readonly code: string; readonly name: string }
  readonly revision: { readonly revision: number; readonly status: RevisionStatus }
  readonly sizes: readonly string[]
  readonly lines: readonly PaperLine[]
  readonly printedAt: Date
  readonly language: DocumentLanguage
}

/** The BOM sheet in the paper's words. */
export function bomPaper(input: BomPaperInput): BomPaper {
  const { language, style, revision } = input
  const words = WORDS[language]
  const number = (value: string): string => numberText(value, language)
  const columns: PaperColumn[] = [
    { label: words.columns.seq, width: 45, align: 'right' },
    { label: words.columns.material, width: 190, align: 'left' },
    { label: words.columns.placement, width: 110, align: 'left' },
    { label: words.columns.qty, width: 140, align: 'right' },
    { label: words.columns.unit, width: 45, align: 'left' },
    { label: words.columns.wastage, width: 60, align: 'right' },
    { label: words.columns.colour, width: 110, align: 'left' },
    { label: words.columns.colourway, width: 70, align: 'left' },
    { label: words.columns.supplier, width: 80, align: 'left' },
    { label: words.columns.note, width: 150, align: 'left' },
  ]
  const rows = [...input.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => [
      String(line.seq),
      `${line.material} · ${line.materialName}`,
      line.placement ?? '',
      line.sizeDependent ? `${words.bySize}: ${line.sizes.map((row) => `${row.size} ${number(row.qty)}`).join(' · ')}` : number(line.qty),
      UNITS[line.uom].symbol,
      number(line.wastagePct),
      line.colourDependent ? `${words.byColourway}: ${line.colours.map((cell) => `${cell.colourway} ${cell.colour}`).join(' · ')}` : (line.colour ?? ''),
      line.colourway ?? '',
      line.supplier ?? '',
      line.note ?? '',
    ])
  const title = `${words.title} ${style.code}`
  return {
    language,
    title,
    subtitle: style.name,
    facts: [
      { label: words.facts.style, value: `${style.code} · ${style.name}` },
      { label: words.facts.revision, value: String(revision.revision) },
      { label: words.facts.status, value: words.status[revision.status] },
      { label: words.facts.sizes, value: input.sizes.join(' · ') || '—' },
      { label: words.facts.lines, value: String(rows.length) },
      { label: words.facts.printed, value: formatDateTime(input.printedAt, BUSINESS_TIME_ZONE, language) },
    ],
    columns,
    rows,
    footer: { page: words.page, continued: words.continued },
    meta: { title, subject: `${style.code} rev ${revision.revision}`, createdAt: input.printedAt.toISOString() },
    fileName: `bom-${style.code}-rev${revision.revision}.pdf`,
  }
}
