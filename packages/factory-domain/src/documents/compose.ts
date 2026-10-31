import { ValidationError, type Issue } from '../core/errors'
import { fitsDecimal, isCurrencyCode, isMinorUnits, type MinorUnits } from '../core/money'
import { BUSINESS_TIME_ZONE, businessDayStart, isBusinessDate, parseInstant, toUtcIso } from '../core/time'
import { parseDecimal } from '../tax/decimal'
import { formatDate, formatDateTime, formatDecimal, formatMoney, formatPercent, formatQuantity, formatUnitPrice } from './format'
import { DOCUMENT_WORDS, ddtPartyHeading, type DocumentWords } from './i18n'
import { DOCUMENT_LAYOUTS, type ColumnKey, type LayoutColumn } from './layouts'
import { addressLine, legalFooter, legalLines, legalName, legalProblems } from './legal'
import {
  DDT_FREIGHT,
  DDT_REASONS,
  DDT_TRANSPORT_BY,
  INVOICE_KINDS,
  isDocumentLanguage,
  isDocumentType,
  REFERENCE_KINDS,
  type DocumentInput,
  type DocumentLanguage,
  type DocumentLine,
  type DocumentParty,
  type DocumentType,
  type PostalAddress,
} from './model'

/**
 * composeDocument (GAP-008): a document model → its fixed layout's content, every word resolved in the document's
 * language and every number formatted. Pure and deterministic: the same input gives the same composition, and the
 * API's PDF painter (apps/factory-api platform/documents/pdf.ts) gives the same bytes from it. What a type must say is
 * checked first; a document that would be incomplete on paper is refused with every problem at once:
 *
 *   every type     the company's art. 2250 data (legal.ts), the number, the date, the party's name, at least one line
 *   priced types   the currency, each line's amount, the totals (net = sum of the VAT bases, gross = net + VAT)
 *   DDT            DPR 472/1996: the recipient's address, the goods' description and quantity per line, and the
 *                  transport: reason, who carries it (the carrier's name when a carrier does), the start date and
 *                  time, the goods' appearance, the number of packages and the gross weight
 *   INVOICE_COPY   the buyer's address and each line's VAT rate; it always carries the courtesy-copy notice (the
 *                  legal invoice is the FatturaPA XML sent through SDI)
 *   PACKING_LIST   the number of parcels and, per line, the parcel it is packed in (no prices)
 */

export interface ComposedFact {
  readonly label: string
  readonly value: string
}

export interface ComposedBlock {
  readonly heading: string
  readonly lines: readonly string[]
}

export interface ComposedColumn extends LayoutColumn {
  readonly label: string
}

export interface ComposedTotal extends ComposedFact {
  readonly strong: boolean
}

export interface ComposedDocument {
  readonly type: DocumentType
  readonly language: DocumentLanguage
  /** The layout id and version (`DDT/1`). */
  readonly layout: string
  readonly title: string
  /** The company's name as printed, and the legal lines under it (art. 2250). */
  readonly issuer: ComposedBlock & { readonly name: string }
  /** Number and date, at the top right. */
  readonly identity: readonly ComposedFact[]
  /** A preview's banner, or null. */
  readonly banner: string | null
  /** The party, then a place of delivery or a carrier, in print order. */
  readonly blocks: readonly ComposedBlock[]
  readonly facts: readonly ComposedFact[]
  readonly table: { readonly columns: readonly ComposedColumn[]; readonly rows: readonly (readonly string[])[] }
  readonly totals: readonly ComposedTotal[]
  readonly notes: ComposedFact | null
  /** Fixed notices of the type, printed boxed above the footer (the invoice copy's courtesy-copy notice). */
  readonly notices: readonly string[]
  /** Signature boxes' captions (DDT). */
  readonly signatures: readonly string[]
  /** Every page's footer: the legal line, the company's own footer text, and the page label (`{page}`, `{pages}`). */
  readonly footer: { readonly legal: string; readonly text: string | null; readonly page: string; readonly continued: string }
  /** The PDF's metadata: fixed by the input, so the same document gives the same file. */
  readonly meta: { readonly title: string; readonly author: string; readonly subject: string; readonly createdAt: string; readonly keywords: string }
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
const PRICED_ONLY: readonly ColumnKey[] = ['unitPrice', 'discount', 'vat', 'amount']

function addressProblems(address: PostalAddress | null | undefined, at: string, message: string): Issue[] {
  if (address && filled(address.line1) && filled(address.postalCode) && filled(address.city) && filled(address.country)) return []
  return [{ path: at, message }]
}

function lineProblems(input: DocumentInput, priced: boolean): Issue[] {
  const problems: Issue[] = []
  if (!Array.isArray(input.lines) || input.lines.length === 0) return [{ path: 'document/lines', message: 'A document has at least one line.' }]
  input.lines.forEach((line: DocumentLine, index) => {
    const at = `document/lines/${index}`
    if (!filled(line.description)) problems.push({ path: `${at}/description`, message: input.type === 'DDT' ? 'Describe the goods: their nature and quality (DPR 472/1996).' : 'A line needs a description.' })
    if (!fitsDecimal(line.quantity, 18, 4)) problems.push({ path: `${at}/quantity`, message: 'Expected a quantity with at most 4 decimals.' })
    if (!filled(line.uom)) problems.push({ path: `${at}/uom`, message: 'A line needs its unit of measure.' })
    if (line.unitPrice !== null && line.unitPrice !== undefined && !fitsDecimal(line.unitPrice, 18, 6)) problems.push({ path: `${at}/unitPrice`, message: 'Expected a unit price with at most 6 decimals.' })
    if (line.discountPercent !== null && line.discountPercent !== undefined && !fitsDecimal(line.discountPercent, 5, 2)) problems.push({ path: `${at}/discountPercent`, message: 'Expected a percentage.' })
    if (line.deliveryDate !== null && line.deliveryDate !== undefined && !isBusinessDate(line.deliveryDate)) problems.push({ path: `${at}/deliveryDate`, message: 'Expected YYYY-MM-DD.' })
    if (priced && !isMinorUnits(line.amountMinor)) problems.push({ path: `${at}/amountMinor`, message: 'A priced line needs its amount in minor units.' })
    if (input.type === 'INVOICE_COPY' && !fitsDecimal(line.vatRate, 5, 2)) problems.push({ path: `${at}/vatRate`, message: 'An invoice line needs its VAT rate.' })
  })
  return problems
}

function totalsProblems(input: DocumentInput): Issue[] {
  const totals = input.totals
  if (!totals) return [{ path: 'document/totals', message: 'This document needs its totals.' }]
  const amounts: [string, unknown][] = [
    ['netMinor', totals.netMinor],
    ['grossMinor', totals.grossMinor],
    ...(totals.depositMinor === null || totals.depositMinor === undefined ? [] : [['depositMinor', totals.depositMinor] as [string, unknown]]),
    ...(totals.dueMinor === null || totals.dueMinor === undefined ? [] : [['dueMinor', totals.dueMinor] as [string, unknown]]),
  ]
  const problems: Issue[] = amounts.filter(([, value]) => !isMinorUnits(value)).map(([key]) => ({ path: `document/totals/${key}`, message: 'Expected an amount in minor units.' }))
  if (!Array.isArray(totals.vat)) return [...problems, { path: 'document/totals/vat', message: 'Expected the VAT per rate (an empty list when there is none).' }]
  totals.vat.forEach((entry, index) => {
    if (!fitsDecimal(entry.rate, 5, 2)) problems.push({ path: `document/totals/vat/${index}/rate`, message: 'Expected a VAT rate.' })
    if (!isMinorUnits(entry.taxableMinor) || !isMinorUnits(entry.vatMinor)) problems.push({ path: `document/totals/vat/${index}`, message: 'Expected the base and the VAT in minor units.' })
  })
  if (problems.length > 0) return problems
  // The issuing module computed them (one rounding point); a total that does not add up is a bug, never printed.
  const bases = totals.vat.reduce((sum, entry) => sum + entry.taxableMinor, 0)
  const vat = totals.vat.reduce((sum, entry) => sum + entry.vatMinor, 0)
  if (totals.vat.length > 0 && bases !== totals.netMinor) problems.push({ path: 'document/totals/vat', message: 'The VAT bases do not add up to the net amount.' })
  if (totals.netMinor + vat !== totals.grossMinor) problems.push({ path: 'document/totals/grossMinor', message: 'The gross is not the net amount plus the VAT.' })
  return problems
}

function transportProblems(input: DocumentInput): Issue[] {
  const transport = input.transport
  const at = 'document/transport'
  if (!transport) return [{ path: at, message: 'A DDT needs its transport: reason, who carries it, start, appearance, packages and weight (DPR 472/1996).' }]
  const problems: Issue[] = []
  if (!(DDT_REASONS as readonly string[]).includes(transport.reason)) problems.push({ path: `${at}/reason`, message: 'Give the reason for the transport (causale).' })
  if (transport.reason === 'OTHER' && !filled(transport.reasonText)) problems.push({ path: `${at}/reasonText`, message: 'Say the reason for the transport in words.' })
  if (!(DDT_TRANSPORT_BY as readonly string[]).includes(transport.transportBy)) problems.push({ path: `${at}/transportBy`, message: 'Say who carries the goods.' })
  if (transport.transportBy === 'CARRIER' && !filled(transport.carrier?.name)) problems.push({ path: `${at}/carrier`, message: 'Name the carrier (DPR 472/1996: the carrier\'s identity).' })
  if (parseInstant(transport.startAt) === null) problems.push({ path: `${at}/startAt`, message: 'Give the date and time the transport starts (ISO 8601 with a zone).' })
  if (!filled(transport.appearance)) problems.push({ path: `${at}/appearance`, message: 'Describe the external appearance of the goods.' })
  if (!Number.isSafeInteger(transport.packages) || transport.packages < 1) problems.push({ path: `${at}/packages`, message: 'Give the number of packages (at least 1).' })
  const gross = fitsDecimal(transport.grossWeightKg, 18, 4) ? parseDecimal(transport.grossWeightKg) : null
  if (gross === null || !gross.greaterThan(0)) problems.push({ path: `${at}/grossWeightKg`, message: 'Give the gross weight in kilograms.' })
  if (transport.netWeightKg !== null && transport.netWeightKg !== undefined && !fitsDecimal(transport.netWeightKg, 18, 4)) problems.push({ path: `${at}/netWeightKg`, message: 'Expected a weight in kilograms.' })
  if (transport.freight !== null && transport.freight !== undefined && !(DDT_FREIGHT as readonly string[]).includes(transport.freight)) problems.push({ path: `${at}/freight`, message: 'Expected FREE or FORWARD.' })
  if (transport.destination) problems.push(...addressProblems(transport.destination, `${at}/destination`, 'The place of delivery needs its street, postal code, city and country.'))
  return problems
}

/** A packing list (B-W1-46, LOG-039): the number of parcels, a weight when given, the parcel of every line. */
function packingListProblems(input: DocumentInput): Issue[] {
  const packing = input.packing
  const at = 'document/packing'
  if (!packing) return [{ path: at, message: 'A packing list says how many parcels there are.' }]
  const problems: Issue[] = []
  if (!Number.isSafeInteger(packing.packages) || packing.packages < 1) problems.push({ path: `${at}/packages`, message: 'Give the number of parcels (at least 1).' })
  if (packing.grossWeightKg !== null && packing.grossWeightKg !== undefined) {
    const gross = fitsDecimal(packing.grossWeightKg, 18, 4) ? parseDecimal(packing.grossWeightKg) : null
    if (gross === null || !gross.greaterThan(0)) problems.push({ path: `${at}/grossWeightKg`, message: 'Expected the gross weight in kilograms.' })
  }
  if (packing.shipTo) problems.push(...addressProblems(packing.shipTo, `${at}/shipTo`, 'The place of delivery needs its street, postal code, city and country.'))
  if (Array.isArray(input.lines)) {
    input.lines.forEach((line: DocumentLine, index) => {
      if (!filled(line.parcel)) problems.push({ path: `document/lines/${index}/parcel`, message: 'Say which parcel the line is packed in.' })
    })
  }
  return problems
}

/** Every reason the document cannot be printed as it stands (empty when it can). */
export function documentProblems(input: DocumentInput): Issue[] {
  if (!isDocumentType(input?.type)) return [{ path: 'document/type', message: 'Unknown document type.' }]
  if (!isDocumentLanguage(input.language)) return [{ path: 'document/language', message: 'Documents are printed in it or en.' }]
  const layout = DOCUMENT_LAYOUTS[input.type]
  const problems: Issue[] = [...legalProblems(input.company)]
  if (!filled(input.number)) problems.push({ path: 'document/number', message: 'An issued document has its number.' })
  if (!isBusinessDate(input.date)) problems.push({ path: 'document/date', message: 'Expected the document date, YYYY-MM-DD.' })
  if (layout.priced && !isCurrencyCode(input.currency)) problems.push({ path: 'document/currency', message: 'Expected the document currency (ISO 4217).' })
  if (!filled(input.party?.name)) problems.push({ path: 'document/party/name', message: 'Name the other party.' })
  if (input.type === 'DDT' || input.type === 'INVOICE_COPY') {
    problems.push(...addressProblems(input.party?.address, 'document/party/address', input.type === 'DDT' ? 'The recipient\'s address is printed on a DDT (DPR 472/1996).' : 'The buyer\'s address is printed on the invoice.'))
  }
  for (const [index, reference] of (input.references ?? []).entries()) {
    if (!(REFERENCE_KINDS as readonly string[]).includes(reference.kind) || !filled(reference.number)) problems.push({ path: `document/references/${index}`, message: 'A reference has a kind and a number.' })
    if (reference.date !== null && reference.date !== undefined && !isBusinessDate(reference.date)) problems.push({ path: `document/references/${index}/date`, message: 'Expected YYYY-MM-DD.' })
  }
  for (const key of ['validUntil', 'deliveryDate'] as const) {
    const value = input[key]
    if (value !== null && value !== undefined && !isBusinessDate(value)) problems.push({ path: `document/${key}`, message: 'Expected YYYY-MM-DD.' })
  }
  if (input.type === 'INVOICE_COPY') {
    const kind = input.invoice?.kind
    if (kind !== null && kind !== undefined && !(INVOICE_KINDS as readonly string[]).includes(kind)) problems.push({ path: 'document/invoice/kind', message: 'Expected a FatturaPA document kind.' })
    const due = input.invoice?.dueDate
    if (due !== null && due !== undefined && !isBusinessDate(due)) problems.push({ path: 'document/invoice/dueDate', message: 'Expected YYYY-MM-DD.' })
  }
  if (input.timeZone !== undefined && !validZone(input.timeZone)) problems.push({ path: 'document/timeZone', message: 'Unknown time zone.' })
  problems.push(...lineProblems(input, layout.priced))
  if (layout.priced) problems.push(...totalsProblems(input))
  if (input.type === 'DDT') problems.push(...transportProblems(input))
  if (input.type === 'PACKING_LIST') problems.push(...packingListProblems(input))
  return problems
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function partyLines(party: DocumentParty, type: DocumentType, words: DocumentWords, language: DocumentLanguage): string[] {
  const lines = [party.name.trim()]
  if (party.address) lines.push(addressLine(party.address, language))
  const tax = [filled(party.vatNumber) ? `${words.party.vat} ${party.vatNumber.trim()}` : null, filled(party.fiscalCode) ? `${words.party.fiscalCode} ${party.fiscalCode.trim()}` : null].filter(
    (part): part is string => part !== null,
  )
  if (tax.length > 0) lines.push(tax.join(' · '))
  if (type === 'INVOICE_COPY') {
    if (filled(party.sdiCode)) lines.push(`${words.party.sdiCode}: ${party.sdiCode.trim()}`)
    if (filled(party.pec)) lines.push(`${words.party.pec}: ${party.pec.trim()}`)
  }
  return lines
}

const namedAddress = (place: PostalAddress & { readonly name?: string | null }, language: DocumentLanguage): string[] => [
  ...(filled(place.name) ? [place.name.trim()] : []),
  addressLine(place, language),
]

function cell(key: ColumnKey, line: DocumentLine, currency: string, language: DocumentLanguage): string {
  switch (key) {
    case 'code':
      return line.code?.trim() ?? ''
    case 'description':
    case 'goods':
      return line.description.trim()
    case 'quantity':
      return formatQuantity(line.quantity, language)
    case 'uom':
      return line.uom.trim()
    case 'unitPrice':
      return line.unitPrice === null || line.unitPrice === undefined ? '' : formatUnitPrice(line.unitPrice, language)
    case 'discount':
      return line.discountPercent === null || line.discountPercent === undefined || parseDecimal(line.discountPercent)?.isZero() ? '' : formatPercent(line.discountPercent, language)
    case 'vat':
      return filled(line.vatNature) ? line.vatNature.trim() : line.vatRate === null || line.vatRate === undefined ? '' : formatPercent(line.vatRate, language)
    case 'delivery':
      return line.deliveryDate ? formatDate(line.deliveryDate, language) : ''
    case 'amount':
      return line.amountMinor === null || line.amountMinor === undefined ? '' : formatMoney(line.amountMinor, currency, language)
    case 'parcel':
      return line.parcel?.trim() ?? ''
  }
}

function referenceFacts(input: DocumentInput, words: DocumentWords): ComposedFact[] {
  return (input.references ?? []).map((reference) => ({
    label: words.facts.reference[reference.kind],
    value: reference.date ? words.facts.referenceDated(reference.number.trim(), formatDate(reference.date, input.language)) : reference.number.trim(),
  }))
}

function facts(input: DocumentInput, words: DocumentWords): ComposedFact[] {
  const language = input.language
  const fact = (label: string, value: string | null | undefined): ComposedFact[] => (filled(value) ? [{ label, value: value.trim() }] : [])
  const date = (label: string, value: string | null | undefined): ComposedFact[] => (value ? [{ label, value: formatDate(value, language) }] : [])
  switch (input.type) {
    case 'QUOTE':
      return [...referenceFacts(input, words), ...date(words.facts.validUntil, input.validUntil), ...fact(words.facts.paymentTerms, input.paymentTerms), ...fact(words.facts.deliveryTerms, input.deliveryTerms)]
    case 'PURCHASE_ORDER':
      return [...referenceFacts(input, words), ...date(words.facts.deliveryDate, input.deliveryDate), ...fact(words.facts.deliveryTerms, input.deliveryTerms), ...fact(words.facts.paymentTerms, input.paymentTerms)]
    case 'DDT': {
      const transport = input.transport!
      const zone = input.timeZone ?? BUSINESS_TIME_ZONE
      const reason = transport.reason === 'OTHER' ? transport.reasonText!.trim() : transport.reasonText?.trim() ? `${words.reasons[transport.reason]} - ${transport.reasonText.trim()}` : words.reasons[transport.reason]
      return [
        ...referenceFacts(input, words),
        { label: words.facts.reason, value: reason },
        { label: words.facts.transportBy, value: words.transportBy[transport.transportBy] },
        { label: words.facts.startAt, value: formatDateTime(parseInstant(transport.startAt)!, zone, language) },
        { label: words.facts.appearance, value: transport.appearance.trim() },
        { label: words.facts.packages, value: String(transport.packages) },
        { label: words.facts.grossWeight, value: formatDecimal(transport.grossWeightKg, language, 0, 3) },
        ...(transport.netWeightKg ? [{ label: words.facts.netWeight, value: formatDecimal(transport.netWeightKg, language, 0, 3) }] : []),
        ...(transport.freight ? [{ label: words.facts.freight, value: words.freight[transport.freight] }] : []),
      ]
    }
    case 'INVOICE_COPY':
      return [
        { label: words.facts.invoiceKind, value: words.invoiceKinds[input.invoice?.kind ?? 'TD01'] },
        ...fact(words.facts.sdiId, input.invoice?.sdiId),
        ...referenceFacts(input, words),
        ...fact(words.facts.paymentTerms, input.paymentTerms),
        ...date(words.facts.dueDate, input.invoice?.dueDate),
      ]
    case 'PACKING_LIST': {
      const packing = input.packing!
      return [
        ...referenceFacts(input, words),
        { label: words.facts.packages, value: String(packing.packages) },
        ...(packing.grossWeightKg ? [{ label: words.facts.grossWeight, value: formatDecimal(packing.grossWeightKg, language, 0, 3) }] : []),
      ]
    }
  }
}

function blocks(input: DocumentInput, words: DocumentWords): ComposedBlock[] {
  const language = input.language
  // W2b (B-W2b-19): a DDT's party is the "cessionario" only when the goods are sold to it (i18n ddtPartyHeading).
  const heading = input.type === 'DDT' ? ddtPartyHeading(words, input.transport!.reason) : words.headings.party[input.type]
  const result: ComposedBlock[] = [{ heading, lines: partyLines(input.party, input.type, words, language) }]
  if (input.type === 'PURCHASE_ORDER' && input.deliverTo) result.push({ heading: words.headings.deliverTo, lines: namedAddress(input.deliverTo, language) })
  if (input.type === 'DDT') {
    const transport = input.transport!
    if (transport.destination) result.push({ heading: words.headings.destination, lines: namedAddress(transport.destination, language) })
    if (transport.transportBy === 'CARRIER' && transport.carrier) {
      const carrier = transport.carrier
      result.push({
        heading: words.headings.carrier,
        lines: [carrier.name.trim(), ...(carrier.address ? [addressLine(carrier.address, language)] : []), ...(filled(carrier.vatNumber) ? [`${words.party.vat} ${carrier.vatNumber.trim()}`] : [])],
      })
    }
  }
  if (input.type === 'PACKING_LIST' && input.packing?.shipTo) result.push({ heading: words.headings.destination, lines: namedAddress(input.packing.shipTo, language) })
  return result
}

function totals(input: DocumentInput, words: DocumentWords): ComposedTotal[] {
  const totalsOf = input.totals
  if (!DOCUMENT_LAYOUTS[input.type].priced || !totalsOf) return []
  const money = (amount: MinorUnits): string => formatMoney(amount, input.currency, input.language)
  const rows: ComposedTotal[] = [{ label: words.totals.net, value: money(totalsOf.netMinor), strong: false }]
  for (const entry of totalsOf.vat) {
    const exempt = filled(entry.nature) && parseDecimal(entry.rate)?.isZero() === true
    rows.push({ label: exempt ? words.totals.vatExempt(entry.nature!.trim()) : words.totals.vat(formatPercent(entry.rate, input.language)), value: money(entry.vatMinor), strong: false })
  }
  rows.push({ label: words.totals.gross[input.type], value: money(totalsOf.grossMinor), strong: true })
  if (totalsOf.depositMinor !== null && totalsOf.depositMinor !== undefined && totalsOf.depositMinor !== 0) rows.push({ label: words.totals.deposit, value: money(-totalsOf.depositMinor), strong: false })
  if (totalsOf.dueMinor !== null && totalsOf.dueMinor !== undefined) rows.push({ label: words.totals.due, value: money(totalsOf.dueMinor), strong: true })
  return rows
}

/** The document's fixed layout with every word and number in place. Throws a ValidationError listing every problem. */
export function composeDocument(input: DocumentInput): ComposedDocument {
  const problems = documentProblems(input)
  if (problems.length > 0) throw new ValidationError('The document cannot be printed as it stands.', problems)
  const words = DOCUMENT_WORDS[input.language]
  const layout = DOCUMENT_LAYOUTS[input.type]
  const language = input.language
  const name = legalName(input.company, language)
  const columns = layout.columns.filter((entry) => layout.priced || !PRICED_ONLY.includes(entry.key)).map((entry) => ({ ...entry, label: words.columns[entry.key] }))
  const title = words.title[input.type]
  const notices = [...(input.type === 'INVOICE_COPY' ? [words.notices.courtesyCopy] : []), ...(input.type === 'PURCHASE_ORDER' ? [words.notices.purchaseOrder] : [])]
  return {
    type: input.type,
    language,
    layout: layout.id,
    title,
    issuer: { heading: words.headings.issuer[input.type], name, lines: legalLines(input.company, language) },
    identity: [
      { label: words.number, value: input.number.trim() },
      { label: words.date, value: formatDate(input.date, language) },
    ],
    banner: input.sample === true ? words.notices.sample : null,
    blocks: blocks(input, words),
    facts: facts(input, words),
    table: { columns, rows: input.lines.map((line) => columns.map((entry) => cell(entry.key, line, input.currency, language))) },
    totals: totals(input, words),
    notes: filled(input.notes) ? { label: words.notes, value: input.notes.trim() } : null,
    notices,
    signatures: layout.signatures ? [words.signatures.driver, words.signatures.carrier, words.signatures.recipient] : [],
    footer: {
      legal: legalFooter(input.company, language),
      text: filled(input.company.documentFooter) ? input.company.documentFooter.trim() : null,
      page: words.page,
      continued: words.continued,
    },
    meta: {
      title: `${title} ${input.number.trim()}`,
      author: name,
      subject: `${layout.id} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.date, input.timeZone ?? BUSINESS_TIME_ZONE)),
      keywords: [input.type, input.number.trim(), input.date].join(' '),
    },
  }
}

/** A page label from the footer's template: "Pagina 2 di 3". */
export const pageLabel = (template: string, page: number, pages: number): string => template.replace('{page}', String(page)).replace('{pages}', String(pages))
