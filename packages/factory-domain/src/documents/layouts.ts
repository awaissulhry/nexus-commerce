import type { DocumentType } from './model'

/**
 * The fixed layouts (GAP-008): per document type, the version of its layout and the columns of its lines table, in
 * order, with their share of the table's width (per mille, summing to 1000) and their alignment. Every company prints
 * the same layout of a type; only the letterhead (the company's legal data and footer) and the language differ. A
 * change that moves what a printed document says is a new layout version, so a copy printed again from a stored
 * record can name the layout it was first printed with.
 *
 * B-W2b-422 (PLT-231): a company's document template in use (DocumentTemplate ACTIVE, per type and language) is read first
 * (layoutFor): its words above the lines, its terms, its footer text and the optional columns it shows; this fixed layout
 * stays the fallback, and the mandatory columns and the company's legal data are never left out.
 */

export const COLUMN_KEYS = ['code', 'description', 'goods', 'quantity', 'uom', 'unitPrice', 'discount', 'vat', 'delivery', 'amount', 'parcel'] as const
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
  /** B-W2b-374 (XF3:03): a line's options are printed after its description (documents/options-block.ts). */
  readonly printsOptions?: boolean
}

const column = (key: ColumnKey, width: number, align: LayoutColumn['align'] = 'left'): LayoutColumn => Object.freeze({ key, width, align })

export const DOCUMENT_LAYOUTS: Readonly<Record<DocumentType, DocumentLayout>> = Object.freeze({
  QUOTE: {
    // B-W2b-374: version 2 prints each line's options.
    id: 'QUOTE/2',
    priced: true,
    signatures: false,
    printsOptions: true,
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
  // B-W2b-303 (SAL-208): the order confirmation prints as the quote does (the customer reads the same columns).
  ORDER_CONFIRMATION: {
    // B-W2b-374: version 2 prints each line's options.
    id: 'ORDER_CONFIRMATION/2',
    priced: true,
    signatures: false,
    printsOptions: true,
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
    // B-W2b-374: version 2 prints each line's options (the XML's Descrizione stays the line's text).
    id: 'INVOICE_COPY/2',
    priced: true,
    signatures: false,
    printsOptions: true,
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
  PACKING_LIST: {
    id: 'PACKING_LIST/1',
    priced: false,
    signatures: false,
    columns: [column('parcel', 100), column('code', 150), column('goods', 530), column('quantity', 120, 'right'), column('uom', 100)],
  },
  // B-W2b-391 (LOG-058): the proforma invoice (customs, samples, a prepayment request): priced, VAT per line, no signatures.
  PROFORMA: {
    id: 'PROFORMA/1',
    priced: true,
    signatures: false,
    columns: [
      column('code', 110),
      column('description', 390),
      column('quantity', 80, 'right'),
      column('uom', 60),
      column('unitPrice', 120, 'right'),
      column('vat', 70, 'right'),
      column('amount', 170, 'right'),
    ],
  },
})

for (const [type, layout] of Object.entries(DOCUMENT_LAYOUTS)) {
  const total = layout.columns.reduce((sum, entry) => sum + entry.width, 0)
  if (total !== 1000) throw new Error(`The ${type} layout's columns take ${total} per mille of the width, not 1000.`)
}

/**
 * B-W2b-422 (PLT-231): the columns a document template can never leave out, per type: what the paper must say of each line
 * (the goods and their quantity; a priced document its amount; an invoice copy also the unit price and the VAT rate, DPR
 * 633/1972 art. 21; a DDT and a packing list the unit, DPR 472/1996; a packing list the parcel). Every other column of the
 * layout is one a template may show or leave out (its `fieldsShown`). The company's legal data (c.c. art. 2250), the number,
 * the date, the party, the type's facts, the totals and the fixed notices are not columns: no template removes them.
 */
export const MANDATORY_COLUMNS: Readonly<Record<DocumentType, readonly ColumnKey[]>> = Object.freeze({
  QUOTE: ['description', 'quantity', 'amount'],
  ORDER_CONFIRMATION: ['description', 'quantity', 'amount'],
  PURCHASE_ORDER: ['description', 'quantity', 'amount'],
  DDT: ['goods', 'quantity', 'uom'],
  INVOICE_COPY: ['description', 'quantity', 'unitPrice', 'vat', 'amount'],
  PACKING_LIST: ['parcel', 'goods', 'quantity', 'uom'],
  PROFORMA: ['description', 'quantity', 'unitPrice', 'vat', 'amount'],
})

/** B-W2b-422: the columns of a type's layout a template may show or leave out. */
export const optionalColumnsOf = (type: DocumentType): ColumnKey[] => DOCUMENT_LAYOUTS[type].columns.map((entry) => entry.key).filter((key) => !MANDATORY_COLUMNS[type].includes(key))

/**
 * B-W2b-422 (PLT-231): the version of a company's document template in use for a type and language (DocumentTemplate,
 * ACTIVE), as the layout reads it: the words printed above the lines, the terms after the totals, the footer text under the
 * legal line, and the optional columns it shows. A key the layout does not have is ignored.
 */
export interface LayoutTemplate {
  readonly type: DocumentType
  readonly language: string
  /** Its version number (DocumentTemplate.revision). */
  readonly revision: number
  readonly header: string | null
  readonly terms: string | null
  /** null: the company's own footer text (Company.documentFooter). */
  readonly footer: string | null
  readonly fieldsShown: readonly string[]
}

// The templates in use of a company's legal data, kept beside it and never on it: JSON, spreads, receipts and audit rows of
// the legal data stay as they were, and a document whose company carries none prints the code's layout.
const attached = new WeakMap<object, readonly LayoutTemplate[]>()

/**
 * B-W2b-422: gives a company's legal data (platform/documents companyLegalOf) the templates in use of the company, one per
 * type and language at most; composeDocument reads the one of its type and language (layoutTemplateOf). Returns the target.
 */
export function attachLayoutTemplates<T extends object>(company: T, templates: readonly LayoutTemplate[]): T {
  if (templates.length > 0) attached.set(company, Object.freeze([...templates]))
  else attached.delete(company)
  return company
}

/** B-W2b-422: the template in use for this type and language, when the company's legal data carries one. */
export function layoutTemplateOf(company: object, type: DocumentType, language: string): LayoutTemplate | null {
  return attached.get(company)?.find((template) => template.type === type && template.language === language) ?? null
}

/**
 * B-W2b-422: the layout a document prints with: the active template's first (its optional columns; the mandatory ones always;
 * the width of a column left out goes to the description), else the code's fixed layout as in W1. The id names the template's
 * version beside the layout's (`QUOTE/2+t3`), so a printed copy says which words it was printed with.
 */
export function layoutFor(type: DocumentType, template: LayoutTemplate | null): DocumentLayout {
  const layout = DOCUMENT_LAYOUTS[type]
  if (!template || template.type !== type) return layout
  const kept = layout.columns.filter((entry) => MANDATORY_COLUMNS[type].includes(entry.key) || template.fieldsShown.includes(entry.key))
  const freed = 1000 - kept.reduce((sum, entry) => sum + entry.width, 0)
  const wide: ColumnKey = kept.some((entry) => entry.key === 'description') ? 'description' : 'goods'
  return Object.freeze({
    ...layout,
    id: `${layout.id}+t${template.revision}`,
    columns: kept.map((entry) => (entry.key === wide ? column(entry.key, entry.width + freed, entry.align) : entry)),
  })
}
