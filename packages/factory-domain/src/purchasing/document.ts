import type { CurrencyCode, DecimalString, MinorUnits } from '../core/money'
import type { BusinessDate } from '../core/time'
import { formatDate, formatDecimal, formatQuantity } from '../documents/format'
import type { DocumentInput, DocumentLanguage, DocumentLine, DocumentParty, PostalAddress } from '../documents/model'

/**
 * The purchase order as the supplier gets it (B-W1-30; SCM-054, SCM-055, SCM-075; GAP-008 layout PURCHASE_ORDER/1), pure:
 * the document the PDF is painted from, and the mails. The PDF is the commercial document mailed to the supplier, so it
 * prints the prices (Owner design answer C2, recommended: the supplier's screens are price-free; the confirm LINK's page,
 * B-W1-31, shows no price). Each line spells out what the supplier must deliver: the material and colour with the
 * supplier's own codes, and for leather the grade, thickness, one dye batch, area tolerance, about how many hides, and the
 * Cr VI test (REACH Annex XVII entry 47).
 *
 * The mail that carries the confirm link is written twice (as the quote's, B-W1-24): `stored` says WHERE the link is
 * without it (the thread keeps that text), `withLink(url)` is what leaves, composed in memory: the link is a bearer token
 * and never enters a stored row.
 */

export interface SupplierLeather {
  readonly grade: string | null
  readonly thicknessMinMm: DecimalString | null
  readonly thicknessMaxMm: DecimalString | null
  readonly oneDyeBatch: boolean
  readonly areaTolerancePct: DecimalString | null
  readonly estimatedHides: number | null
  /** The line in the item's base unit (the area). */
  readonly baseQuantity: DecimalString
  readonly baseUom: string
}

export interface SupplierLine {
  readonly seq: number
  /** The supplier's article code, else ours. */
  readonly code: string
  readonly name: string
  /** Our colour's name, with the supplier's colour code when known. */
  readonly colour: { readonly name: string; readonly supplierCode: string | null } | null
  readonly description: string | null
  readonly quantity: DecimalString
  readonly uom: string
  readonly unitPrice: DecimalString
  readonly netAmount: MinorUnits
  readonly needDate: BusinessDate
  readonly leather: SupplierLeather | null
  readonly requiresCrViTest: boolean
  readonly note: string | null
}

export interface SupplierOrder {
  readonly number: string
  readonly revision: number
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly currency: CurrencyCode
  readonly supplier: DocumentParty
  readonly deliverTo: (PostalAddress & { readonly name?: string | null }) | null
  readonly requestedDate: BusinessDate | null
  readonly incoterms: string | null
  readonly paymentTerms: string | null
  readonly note: string | null
  readonly lines: readonly SupplierLine[]
  readonly netAmount: MinorUnits
}

/** The number the order prints: its number, and its revision from the second one ("PO-00012 rev. 2"). */
export const purchaseOrderDocumentNumber = (number: string, revision: number): string => (revision <= 1 ? number : `${number} rev. ${revision}`)

const WORDS = {
  it: {
    colour: (name: string, code: string | null) => (code ? `colore ${name} (cod. fornitore ${code})` : `colore ${name}`),
    grade: (grade: string) => `scelta ${grade}`,
    thickness: (range: string) => `spessore ${range} mm`,
    oneDyeBatch: 'un solo bagno di tintura',
    tolerance: (pct: string) => `tolleranza superficie ±${pct}%`,
    hides: (hides: number, area: string, uom: string) => `circa ${hides} ${hides === 1 ? 'pelle' : 'pelli'} (${area} ${uom})`,
    crVi: 'prova Cr VI richiesta per ogni lotto (REACH All. XVII voce 47)',
  },
  en: {
    colour: (name: string, code: string | null) => (code ? `colour ${name} (supplier code ${code})` : `colour ${name}`),
    grade: (grade: string) => `grade ${grade}`,
    thickness: (range: string) => `thickness ${range} mm`,
    oneDyeBatch: 'one dye batch',
    tolerance: (pct: string) => `area tolerance ±${pct}%`,
    hides: (hides: number, area: string, uom: string) => `about ${hides} ${hides === 1 ? 'hide' : 'hides'} (${area} ${uom})`,
    crVi: 'Cr VI test required for every lot (REACH Annex XVII entry 47)',
  },
} as const

const UOM_TEXT: Readonly<Record<string, string>> = Object.freeze({ FT2: 'ft²', M2: 'm²', DM2: 'dm²' })
export const uomText = (uom: string): string => UOM_TEXT[uom] ?? uom

/** What the supplier reads in a line's description: the material, colour, our words, the leather specs, Cr VI, the note. */
export function lineText(line: SupplierLine, language: DocumentLanguage): string {
  const words = WORDS[language]
  const parts: string[] = [line.name]
  if (line.colour) parts.push(words.colour(line.colour.name, line.colour.supplierCode))
  if (line.description) parts.push(line.description)
  const leather = line.leather
  if (leather) {
    if (leather.grade) parts.push(words.grade(leather.grade))
    const low = leather.thicknessMinMm === null ? null : formatDecimal(leather.thicknessMinMm, language, 1, 2)
    const high = leather.thicknessMaxMm === null ? null : formatDecimal(leather.thicknessMaxMm, language, 1, 2)
    if (low || high) parts.push(words.thickness(low && high ? (low === high ? low : `${low}–${high}`) : (low ?? high)!))
    if (leather.oneDyeBatch) parts.push(words.oneDyeBatch)
    if (leather.areaTolerancePct !== null) parts.push(words.tolerance(formatDecimal(leather.areaTolerancePct, language, 0, 2)))
    if (leather.estimatedHides !== null) parts.push(words.hides(leather.estimatedHides, formatQuantity(leather.baseQuantity, language), uomText(leather.baseUom)))
  }
  if (line.requiresCrViTest) parts.push(words.crVi)
  if (line.note) parts.push(line.note)
  return parts.join(' · ')
}

/** The document of the fixed PURCHASE_ORDER layout (documents/compose), without the company's letterhead. */
export function purchaseOrderDocument(order: SupplierOrder): Omit<DocumentInput, 'company' | 'sample'> {
  const lines: DocumentLine[] = order.lines.map((line) => ({
    code: line.code,
    description: lineText(line, order.language),
    quantity: line.quantity,
    uom: uomText(line.uom),
    unitPrice: line.unitPrice,
    amountMinor: line.netAmount,
    deliveryDate: line.needDate,
  }))
  return {
    type: 'PURCHASE_ORDER',
    language: order.language,
    number: purchaseOrderDocumentNumber(order.number, order.revision),
    date: order.date,
    currency: order.currency,
    party: order.supplier,
    lines,
    // A purchase order states its net value; the VAT is the supplier's invoice's (decided by its seller).
    totals: { netMinor: order.netAmount, vat: [], grossMinor: order.netAmount },
    deliveryDate: order.requestedDate,
    deliverTo: order.deliverTo,
    paymentTerms: order.paymentTerms,
    deliveryTerms: order.incoterms,
    notes: order.note,
  }
}

// ---- the mails ----------------------------------------------------------------------------------------------------------

const MAIL = {
  it: {
    subject: (number: string) => `Ordine di acquisto ${number}`,
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Buongiorno,'),
    intro: (number: string) => `le inviamo il nostro ordine di acquisto ${number}: il documento è in allegato.`,
    again: (number: string) => `le inviamo un nuovo link per confermare il nostro ordine di acquisto ${number}, di nuovo in allegato. I link inviati prima non sono più validi.`,
    linkStored: (until: string) => `Per confermare l'ordine (quantità e date) o per rifiutarlo usi il link personale contenuto nell'e-mail inviata, valido fino al ${until}.`,
    link: (until: string) => `Per confermare l'ordine (quantità e date) o per rifiutarlo usi questo link personale, valido fino al ${until}:`,
    cancelSubject: (number: string) => `Annullamento ordine di acquisto ${number}`,
    cancelled: (number: string) => `il nostro ordine di acquisto ${number} è annullato: la preghiamo di non evaderlo. Il link di conferma non è più valido.`,
  },
  en: {
    subject: (number: string) => `Purchase order ${number}`,
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Hello,'),
    intro: (number: string) => `please find attached our purchase order ${number}.`,
    again: (number: string) => `here is a new link to confirm our purchase order ${number}, attached again. The links sent before no longer work.`,
    linkStored: (until: string) => `To confirm the order (quantities and dates) or decline it, use the personal link in the e-mail as sent, valid until ${until}.`,
    link: (until: string) => `To confirm the order (quantities and dates) or decline it, use this personal link, valid until ${until}:`,
    cancelSubject: (number: string) => `Purchase order ${number} cancelled`,
    cancelled: (number: string) => `our purchase order ${number} is cancelled: please do not deliver it. Its confirm link no longer works.`,
  },
} as const

export interface PurchaseOrderMail {
  readonly subject: string
  /** The text the thread keeps: where the link is, not the link. */
  readonly stored: string
  /** The text that leaves, with the link (composed in memory, never stored). */
  withLink(url: string): string
}

/** The mail of a send (or of a new link): the office's own words, or the standard ones; then the link paragraph. */
export function purchaseOrderMail(input: { readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly linkUntil: BusinessDate; readonly message: string | null; readonly resend: boolean }): PurchaseOrderMail {
  const words = MAIL[input.language]
  const until = formatDate(input.linkUntil, input.language)
  const opening = input.message?.trim() ? input.message.trim() : `${words.hello(input.recipientName)}\n\n${input.resend ? words.again(input.number) : words.intro(input.number)}`
  return {
    subject: words.subject(input.number),
    stored: `${opening}\n\n${words.linkStored(until)}`,
    withLink: (url) => `${opening}\n\n${words.link(until)}\n${url}`,
  }
}

/** The supplier is told that an order it received is cancelled (the office's own words first, when it wrote some). */
export function cancellationMail(input: { readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  const words = MAIL[input.language]
  const body = [words.hello(input.recipientName), words.cancelled(input.number), ...(input.message?.trim() ? [input.message.trim()] : [])].join('\n\n')
  return { subject: words.cancelSubject(input.number), body }
}
