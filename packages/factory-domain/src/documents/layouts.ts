import type { DocumentType } from './model'

/**
 * The fixed layouts (GAP-008): per document type, the version of its layout and the columns of its lines table, in
 * order, with their share of the table's width (per mille, summing to 1000) and their alignment. Every company prints
 * the same layout of a type; only the letterhead (the company's legal data and footer) and the language differ. A
 * change that moves what a printed document says is a new layout version, so a copy printed again from a stored
 * record can name the layout it was first printed with.
 */

export const COLUMN_KEYS = ['code', 'description', 'goods', 'quantity', 'uom', 'unitPrice', 'discount', 'vat', 'delivery', 'amount'] as const
export type ColumnKey = (typeof COLUMN_KEYS)[number]

export interface LayoutColumn {
  readonly key: ColumnKey
  /** Share of the table width, per mille. */
  readonly width: number
  readonly align: 'left' | 'right'
}

export interface DocumentLayout {
  /** `<TYPE>/<version>`, printed in the PDF's metadata. */
  readonly id: string
  readonly columns: readonly LayoutColumn[]
  /** The lines carry prices and the document has totals. */
  readonly priced: boolean
  /** Signature boxes at the end (the DDT's driver, carrier and recipient). */
  readonly signatures: boolean
}

const column = (key: ColumnKey, width: number, align: LayoutColumn['align'] = 'left'): LayoutColumn => Object.freeze({ key, width, align })

export const DOCUMENT_LAYOUTS: Readonly<Record<DocumentType, DocumentLayout>> = Object.freeze({
  QUOTE: {
    id: 'QUOTE/1',
    priced: true,
    signatures: false,
    columns: [
      column('code', 110),
      column('description', 400),
      column('quantity', 80, 'right'),
      column('uom', 60),
      column('unitPrice', 120, 'right'),
      column('discount', 70, 'right'),
      column('amount', 160, 'right'),
    ],
  },
  PURCHASE_ORDER: {
    id: 'PURCHASE_ORDER/1',
    priced: true,
    signatures: false,
    columns: [
      column('code', 110),
      column('description', 370),
      column('quantity', 80, 'right'),
      column('uom', 60),
      column('unitPrice', 120, 'right'),
      column('delivery', 100),
      column('amount', 160, 'right'),
    ],
  },
  DDT: {
    id: 'DDT/1',
    priced: false,
    signatures: true,
    columns: [column('code', 150), column('goods', 610), column('quantity', 140, 'right'), column('uom', 100)],
  },
  INVOICE_COPY: {
    id: 'INVOICE_COPY/1',
    priced: true,
    signatures: false,
    columns: [
      column('code', 100),
      column('description', 360),
      column('quantity', 80, 'right'),
      column('uom', 60),
      column('unitPrice', 120, 'right'),
      column('discount', 70, 'right'),
      column('vat', 70, 'right'),
      column('amount', 140, 'right'),
    ],
  },
})

for (const [type, layout] of Object.entries(DOCUMENT_LAYOUTS)) {
  const total = layout.columns.reduce((sum, entry) => sum + entry.width, 0)
  if (total !== 1000) throw new Error(`The ${type} layout's columns take ${total} per mille of the width, not 1000.`)
}
