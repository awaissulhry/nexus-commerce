import type { Issue } from '../core/errors'
import { formatDate } from '../documents/format'
import { DOCUMENT_LAYOUTS, MANDATORY_COLUMNS, optionalColumnsOf, type ColumnKey } from '../documents/layouts'
import type { DocumentInput, DocumentType } from '../documents/model'
import { isTemplateLanguage } from './language'
import { placeholderProblems, type PlaceholderValues } from './placeholders'

/**
 * Document templates (B-W2b-422; PLT-231; design admin.documents "Document templates", the builder page "Template: Quote
 * (Italiano)"): a company's words for one kind of document in one language — the header printed above the lines, the terms
 * after the totals, the footer under the legal line — and the optional columns of its layout it shows, in versions
 * (DRAFT → ACTIVE → RETIRED; the database's DocumentTemplate). The layout reads the version in use first
 * (documents/layouts.ts layoutFor); the code's fixed layout stays the fallback. What the paper must say is no template's to
 * remove: the mandatory columns (layouts.ts MANDATORY_COLUMNS) and the parts below. Pure.
 */

/** What a document template is for: DocumentTemplateKind, value for value (the proforma has none: it prints the code's layout). */
export const DOCUMENT_TEMPLATE_KINDS = ['QUOTE', 'ORDER_CONFIRMATION', 'PURCHASE_ORDER', 'DDT', 'INVOICE_COPY', 'PACKING_LIST'] as const satisfies readonly DocumentType[]
export type DocumentTemplateKind = (typeof DOCUMENT_TEMPLATE_KINDS)[number]

export const DOCUMENT_TEMPLATE_LIMITS = Object.freeze({ header: 2000, terms: 20000, footer: 2000, fields: 60 })

/**
 * The parts every document of a kind prints whatever its template says (codes; the screens say them): the company's
 * legal data on the letterhead and the legal line of every page (c.c. art. 2250), the number and date, the party, the
 * kind's facts (a DDT's transport, DPR 472/1996), the totals of a priced document, its fixed notices (an invoice copy's
 * courtesy-copy notice, a purchase order's), a DDT's signature boxes.
 */
export const MANDATORY_PARTS = ['COMPANY_LEGAL', 'NUMBER_AND_DATE', 'PARTY', 'FACTS', 'TOTALS', 'NOTICES', 'SIGNATURES'] as const
export type MandatoryPart = (typeof MANDATORY_PARTS)[number]

export function mandatoryPartsOf(kind: DocumentTemplateKind): MandatoryPart[] {
  const layout = DOCUMENT_LAYOUTS[kind]
  return MANDATORY_PARTS.filter(
    (part) => (part !== 'TOTALS' || layout.priced) && (part !== 'SIGNATURES' || layout.signatures) && (part !== 'NOTICES' || kind === 'INVOICE_COPY' || kind === 'PURCHASE_ORDER'),
  )
}

const COMMON = ['document.number', 'document.date', 'document.paymentTerms', 'document.deliveryTerms', 'party.name', 'company.name', 'company.legalName'] as const

/** The placeholders each kind's words may use: the document's own, then its kind's names for them. */
export const DOCUMENT_PLACEHOLDERS: Readonly<Record<DocumentTemplateKind, readonly string[]>> = Object.freeze({
  QUOTE: [...COMMON, 'quote.number', 'quote.date', 'quote.validUntil'],
  ORDER_CONFIRMATION: [...COMMON, 'order.number', 'order.date', 'order.promiseDate'],
  PURCHASE_ORDER: [...COMMON, 'order.number', 'order.date', 'order.deliveryDate'],
  DDT: [...COMMON, 'ddt.number', 'ddt.date'],
  INVOICE_COPY: [...COMMON, 'invoice.number', 'invoice.date', 'invoice.dueDate'],
  PACKING_LIST: [...COMMON, 'packingList.number', 'packingList.date', 'packingList.packages'],
})

/** What a document prints for each placeholder of its kind, in its language (dates as the document prints them). */
export function documentPlaceholderValues(input: DocumentInput): PlaceholderValues {
  const language = input.language
  const day = (value: string | null | undefined): string | null => (value ? formatDate(value, language) : null)
  const number = input.number.trim()
  const date = day(input.date)
  const common: Record<string, string | null> = {
    'document.number': number,
    'document.date': date,
    'document.paymentTerms': input.paymentTerms?.trim() || null,
    'document.deliveryTerms': input.deliveryTerms?.trim() || null,
    'party.name': input.party.name.trim(),
    'company.name': input.company.tradeName?.trim() || input.company.legalName.trim(),
    'company.legalName': input.company.legalName.trim(),
  }
  switch (input.type) {
    case 'QUOTE':
      return { ...common, 'quote.number': number, 'quote.date': date, 'quote.validUntil': day(input.validUntil) }
    case 'ORDER_CONFIRMATION':
      return { ...common, 'order.number': number, 'order.date': date, 'order.promiseDate': day(input.deliveryDate) }
    case 'PURCHASE_ORDER':
      return { ...common, 'order.number': number, 'order.date': date, 'order.deliveryDate': day(input.deliveryDate) }
    case 'DDT':
      return { ...common, 'ddt.number': number, 'ddt.date': date }
    case 'INVOICE_COPY':
      return { ...common, 'invoice.number': number, 'invoice.date': date, 'invoice.dueDate': day(input.invoice?.dueDate) }
    case 'PACKING_LIST':
      return { ...common, 'packingList.number': number, 'packingList.date': date, 'packingList.packages': input.packing ? String(input.packing.packages) : null }
    case 'PROFORMA':
      return common
  }
}

export interface DocumentTemplateWords {
  readonly header: string | null
  readonly terms: string | null
  readonly footer: string | null
  readonly fieldsShown: readonly string[]
}

/** A template's words cleaned for storing: trimmed, empty is none; the fields shown that the layout has, in its order. */
export function cleanDocumentWords(kind: DocumentTemplateKind, words: DocumentTemplateWords): DocumentTemplateWords {
  const text = (value: string | null): string | null => {
    const trimmed = (value ?? '').replace(/\r\n?/g, '\n').trim()
    return trimmed === '' ? null : trimmed
  }
  const order = DOCUMENT_LAYOUTS[kind].columns.map((entry) => entry.key as string)
  return { header: text(words.header), terms: text(words.terms), footer: text(words.footer), fieldsShown: order.filter((key) => words.fieldsShown.includes(key)) }
}

/** Every problem of a template's words for its kind and language (empty when it can be saved). */
export function documentTemplateProblems(kind: DocumentTemplateKind, language: string, words: DocumentTemplateWords): Issue[] {
  const problems: Issue[] = []
  if (!isTemplateLanguage(language)) problems.push({ path: 'body/language', message: 'Documents are written in Italian or English.' })
  const offered = DOCUMENT_PLACEHOLDERS[kind]
  for (const key of ['header', 'terms', 'footer'] as const) {
    const value = words[key]
    if (value !== null && value.length > DOCUMENT_TEMPLATE_LIMITS[key]) problems.push({ path: `body/${key}`, message: `At most ${DOCUMENT_TEMPLATE_LIMITS[key]} characters.` })
    else problems.push(...placeholderProblems(value, `body/${key}`, offered))
  }
  const optional: readonly string[] = optionalColumnsOf(kind)
  const mandatory: readonly ColumnKey[] = MANDATORY_COLUMNS[kind]
  if (words.fieldsShown.length > DOCUMENT_TEMPLATE_LIMITS.fields) problems.push({ path: 'body/fieldsShown', message: `At most ${DOCUMENT_TEMPLATE_LIMITS.fields} fields.` })
  if (new Set(words.fieldsShown).size !== words.fieldsShown.length) problems.push({ path: 'body/fieldsShown', message: 'Each field once.' })
  words.fieldsShown.forEach((key, index) => {
    if ((mandatory as readonly string[]).includes(key)) problems.push({ path: `body/fieldsShown/${index}`, message: `${key} is always printed: it is not a choice.` })
    else if (!optional.includes(key)) problems.push({ path: `body/fieldsShown/${index}`, message: `${key} is not a column of this document's layout.` })
  })
  return problems
}
