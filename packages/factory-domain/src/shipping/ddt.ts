import type { Issue } from '../core/errors'
import { fitsDecimal } from '../core/money'
import { businessDate, isBusinessDate, parseInstant, toUtcIso, type BusinessDate } from '../core/time'
import { legalProblems } from '../documents/legal'
import {
  DDT_FREIGHT,
  DDT_REASONS,
  type CompanyLegal,
  type DdtFreight,
  type DdtReason,
  type DocumentInput,
  type DocumentLanguage,
  type DocumentLine,
  type DocumentParty,
  type DocumentReference,
  type PostalAddress,
} from '../documents/model'
import { Dec, parseDecimal, sum } from '../tax/decimal'
import { TRANSPORT_BY, type ShipmentStatus, type TransportBy } from './shipments'

/**
 * The DDT of a shipment (B-W1-47; LOG-054; DPR 472/1996 art. 1 c. 3 with DPR 627/1978; PLAN §2.8 "DDT"). Pure rules;
 * apps/factory-api's modules/shipping/ddt reads the facts, numbers the DDT from the company's DDT series inside the
 * issuing command and stores the frozen row (Ddt, append-only) and its PDF (FISCAL_ARCHIVE, ten years).
 *
 *   contents    number and date; the sender (the company's c.c. art. 2250 data) and the recipient (the order's buyer)
 *               with their addresses, and the place of delivery when it is another; the reason for the transport
 *               (causale); the goods: nature, quality and quantity (style, colourway, size, PPE category, batch,
 *               serials; no price); the number of packages (= the shipment's parcels), their appearance and gross
 *               weight (= the parcels' weights); who carries them and the carrier's identity; the date and time the
 *               transport starts. The PDF adds the signature boxes (driver, carrier, recipient).
 *   moments     a DDT is issued for a PACKED shipment, before the goods leave (carrier labels are bought after it,
 *               SCR-067); the goods then leave (SHIPPED), at once (`ship`) or later; the transport's start on the DDT
 *               is when they leave (planned: from the issue on, at most DDT_START_MAX_DAYS later). A SHIPPED shipment
 *               whose DDT was cancelled takes a replacement, which keeps the start of the transport that happened.
 *   one live    a shipment has at most one DDT that no cancellation names (the API, under the shipment's lock).
 *   cancelling  with its reason, while the goods are packed or travelling and nothing invoiced them; the cancelled
 *               DDT keeps its number (no gap) and a new DDT takes a new one.
 */

/** A start typed a little before the issue (the clock on the wall, a slow click) still counts as "now". */
export const DDT_START_GRACE_MINUTES = 10
/** A planned start at most this many days after the DDT is issued (a DDT is printed for goods about to leave). */
export const DDT_START_MAX_DAYS = 7

/**
 * The reasons a shipment to the order's party can travel for. TRANSFER is a transfer between the company's own sites
 * (the transfers module, W2b), WORK_ON_ACCOUNT goods sent out to be worked on (subcontracting), RETURN goods sent back
 * to a supplier: none is a delivery of a sales order.
 */
export const SHIPMENT_DDT_REASONS: readonly DdtReason[] = Object.freeze(['SALE', 'RETURN_FROM_WORK', 'ON_APPROVAL', 'REPAIR', 'SAMPLE', 'OTHER'])

const NOT_FOR_A_SHIPMENT: Readonly<Partial<Record<DdtReason, string>>> = {
  TRANSFER: "A transfer between sites travels with the transfer's own DDT, not a shipment to a customer.",
  WORK_ON_ACCOUNT: "Goods sent out to be worked on travel with the subcontracting delivery's DDT, not a shipment to a customer.",
  RETURN: "Goods sent back to a supplier travel with the return's DDT, not a shipment to a customer.",
}

// ---- the shapes the Ddt row keeps (as printed) --------------------------------------------------------------------

/** A party as printed: the sender (the company) or the recipient (the order's buyer). */
export interface DdtPartySnapshot {
  readonly name: string
  readonly address: PostalAddress | null
  readonly vatNumber?: string | null
  readonly fiscalCode?: string | null
}

/** The carrier's identity (DPR 472/1996: "generalità" of whoever carries the goods). */
export interface DdtCarrier {
  readonly name: string
  readonly address?: PostalAddress | null
  readonly vatNumber?: string | null
}

/** The place of delivery when it is not the recipient's address. */
export type DdtDestination = PostalAddress & { readonly name?: string | null }

/** One line of goods as printed (no price). */
export interface DdtLine {
  readonly seq: number
  readonly code: string | null
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly workOrderSizeId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly batchNumber: string | null
  readonly serials: readonly string[]
}

/** What a DDT says, before its number: the printed columns of the Ddt row. */
export interface DdtDraft {
  readonly documentDate: BusinessDate
  readonly reason: DdtReason
  readonly reasonText: string | null
  readonly transportBy: TransportBy
  readonly carrier: DdtCarrier | null
  /** ISO 8601 UTC. */
  readonly startAt: string
  readonly appearance: string
  readonly packages: number
  /** Kilograms, Decimal(18,4) as a string. */
  readonly grossWeightKg: string
  readonly netWeightKg: string | null
  readonly freight: DdtFreight | null
  readonly sender: DdtPartySnapshot
  readonly recipient: DdtPartySnapshot
  readonly destination: DdtDestination | null
  readonly lines: readonly DdtLine[]
  readonly documentRefs: readonly DocumentReference[]
  readonly remarks: string | null
}

// ---- the facts and the request ------------------------------------------------------------------------------------

/** The PPE marking of a style (Reg. (EU) 2016/425): printed with the goods' nature and quality. */
export interface PpeMarking {
  readonly category: 'NOT_PPE' | 'CATEGORY_I' | 'CATEGORY_II' | 'CATEGORY_III'
  readonly standard: string | null
  readonly class: string | null
}

/** Garments of one work order cell on the shipment (its lines over every parcel), names already in the DDT's language. */
export interface DdtGoods {
  readonly workOrderSizeId: string
  readonly salesOrderLineId: string
  readonly styleCode: string
  readonly styleName: string
  readonly colourway: string
  readonly size: string
  readonly quantity: number
  readonly batchNumber: string | null
  readonly serials: readonly string[]
  readonly ppe: PpeMarking
}

/** What the API reads for a DDT, under the shipment's lock. */
export interface DdtFacts {
  readonly shipment: {
    readonly status: ShipmentStatus
    readonly transportBy: TransportBy
    readonly carrierName: string | null
    /** The ship-to snapshot (SalesOrder.shipTo's shape). */
    readonly shipTo: unknown
    readonly shippedAt: Date | null
  }
  /** The live DDT's number, if the shipment has one. */
  readonly liveDdtNumber: string | null
  /** The company's legal data, from its Company row. */
  readonly company: CompanyLegal
  /** The order's buyer as accepted (SalesOrder.billTo: { legalName, vatNumber?, fiscalCode?, address }). */
  readonly billTo: unknown
  readonly order: { readonly number: string; readonly orderDate: BusinessDate; readonly customerRef: string | null }
  /** The site's default appearance of the goods (ShippingSettings.defaultGoodsAppearance). */
  readonly defaultAppearance: string | null
  readonly parcels: readonly { readonly seq: number; readonly grossWeightKg: string | null }[]
  readonly goods: readonly DdtGoods[]
  readonly language: DocumentLanguage
}

/** What the office says when it issues (or previews) a DDT; everything else comes from the shipment. */
export interface DdtRequest {
  /** Default SALE. */
  readonly reason?: DdtReason | undefined
  readonly reasonText?: string | null | undefined
  /** Default (a carrier carries it): the shipment's carrier name. Who carries the goods is the shipment's transportBy. */
  readonly carrier?: DdtCarrier | null | undefined
  /** When the transport starts (ISO 8601 with a zone). Default: now; for a replacement, when the goods left. */
  readonly startAt?: string | null | undefined
  /** Default: the site's default appearance. */
  readonly appearance?: string | null | undefined
  readonly netWeightKg?: string | null | undefined
  readonly freight?: DdtFreight | null | undefined
  readonly remarks?: string | null | undefined
  /** The goods leave now: the shipment moves to SHIPPED in the same command. */
  readonly ship?: boolean | undefined
}

// ---- state: may a DDT be issued now? --------------------------------------------------------------------------------

/**
 * Why no DDT can be issued for the shipment now (empty: it can). A PACKED shipment takes its DDT before the goods leave;
 * a SHIPPED one only a replacement for a cancelled DDT (and never "ships" again); one live DDT per shipment.
 */
export function issueStateProblems(status: ShipmentStatus, liveDdtNumber: string | null, ship: boolean): string[] {
  if (status === 'DRAFT') return ['The shipment is a DRAFT: pack it first (a DDT is issued for packed goods).']
  if (status !== 'PACKED' && status !== 'SHIPPED') return [`The shipment is ${status}: no DDT is issued for it.`]
  const problems: string[] = []
  if (liveDdtNumber !== null) problems.push(`DDT ${liveDdtNumber} is live for this shipment: cancel it first (a shipment has one live DDT).`)
  if (status === 'SHIPPED' && ship) problems.push('The goods left already: a replacement DDT does not ship them again.')
  return problems
}

/**
 * Why a DDT cannot be cancelled (empty: it can): once; while the goods are packed or travelling (a replacement can
 * still be issued: the database takes a DDT only for a PACKED or SHIPPED shipment); not once an invoice names it
 * (B-W1-51: the deferred invoice (TD24) refers to its DDTs).
 */
export function cancelDdtProblems(facts: { readonly cancelled: boolean; readonly shipmentStatus: ShipmentStatus; readonly invoiceNumbers: readonly string[] }): string[] {
  if (facts.cancelled) return ['This DDT is cancelled already.']
  const problems: string[] = []
  if (facts.shipmentStatus !== 'PACKED' && facts.shipmentStatus !== 'SHIPPED') {
    problems.push(`The shipment is ${facts.shipmentStatus}: its transport is over, so its DDT stays as issued.`)
  }
  if (facts.invoiceNumbers.length > 0) problems.push(`Invoice ${facts.invoiceNumbers.join(', ')} refers to this DDT: credit the invoice first.`)
  return problems
}

// ---- the draft ------------------------------------------------------------------------------------------------------

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
const trimmed = (value: string | null | undefined): string | null => (filled(value) ? value.trim() : null)

const string = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** A postal address from a JSON snapshot, or null when a required part is missing. */
export function postalAddressOf(value: unknown): PostalAddress | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const line1 = string(record.line1)
  const postalCode = string(record.postalCode)
  const city = string(record.city)
  const country = string(record.country)
  if (!line1 || !postalCode || !city || !country) return null
  return { line1, line2: string(record.line2), postalCode, city, province: string(record.province), country }
}

const sameAddress = (a: PostalAddress, b: PostalAddress): boolean => {
  const key = (address: PostalAddress) => [address.line1, address.line2 ?? '', address.postalCode, address.city, address.country].map((part) => part.trim().toLowerCase().replace(/\s+/g, ' ')).join('|')
  return key(a) === key(b)
}

const WORDS: Readonly<Record<DocumentLanguage, { readonly size: string; readonly batch: string; readonly serials: string; readonly ppe: (category: string) => string; readonly class: string }>> = {
  it: { size: 'taglia', batch: 'lotto', serials: 'matricole', ppe: (category) => `DPI cat. ${category}`, class: 'classe' },
  en: { size: 'size', batch: 'batch', serials: 'serials', ppe: (category) => `PPE cat. ${category}`, class: 'class' },
}

const PPE_ROMAN: Readonly<Record<PpeMarking['category'], string | null>> = { NOT_PPE: null, CATEGORY_I: 'I', CATEGORY_II: 'II', CATEGORY_III: 'III' }

/** The nature and quality of one cell's garments, in the DDT's language: style, colourway, size, PPE, batch, serials. */
export function goodsDescription(goods: DdtGoods, language: DocumentLanguage): string {
  const words = WORDS[language]
  const roman = PPE_ROMAN[goods.ppe.category]
  const ppe = roman ? [words.ppe(roman), ...(filled(goods.ppe.standard) ? [goods.ppe.standard.trim()] : []), ...(filled(goods.ppe.class) ? [`${words.class} ${goods.ppe.class.trim()}`] : [])].join(', ') : null
  return [
    `${goods.styleName.trim()}, ${goods.colourway.trim()}, ${words.size} ${goods.size}${ppe ? ` (${ppe})` : ''}`,
    ...(filled(goods.batchNumber) ? [`${words.batch} ${goods.batchNumber.trim()}`] : []),
    ...(goods.serials.length > 0 ? [`${words.serials} ${[...goods.serials].sort().join(', ')}`] : []),
  ].join(' - ')
}

/** The goods' lines: one per work order cell, by style, colourway and size. */
export function ddtLines(goods: readonly DdtGoods[], language: DocumentLanguage): DdtLine[] {
  return [...goods]
    .sort((a, b) => a.styleCode.localeCompare(b.styleCode) || a.colourway.localeCompare(b.colourway) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.workOrderSizeId.localeCompare(b.workOrderSizeId))
    .map((entry, index) => ({
      seq: index + 1,
      code: trimmed(entry.styleCode),
      description: goodsDescription(entry, language),
      quantity: String(entry.quantity),
      uom: 'PCS',
      workOrderSizeId: entry.workOrderSizeId,
      salesOrderLineId: entry.salesOrderLineId,
      size: entry.size,
      batchNumber: trimmed(entry.batchNumber),
      serials: [...entry.serials].sort(),
    }))
}

/** The start of the transport: the default and the rule of each moment (see the file's comment). */
function startOf(facts: DdtFacts, request: DdtRequest, now: Date, problems: Issue[]): Date {
  const at = 'body/startAt'
  const given = request.startAt === undefined || request.startAt === null ? null : parseInstant(request.startAt)
  if (request.startAt !== undefined && request.startAt !== null && given === null) {
    problems.push({ path: at, message: 'Give the date and time the transport starts, ISO 8601 with a zone.' })
    return now
  }
  const grace = DDT_START_GRACE_MINUTES * 60_000
  if (facts.shipment.status === 'SHIPPED') {
    // A replacement: the transport started when the goods left.
    const start = given ?? facts.shipment.shippedAt ?? now
    if (start.getTime() > now.getTime() + grace) problems.push({ path: at, message: 'The goods left already: the transport started before now.' })
    return start
  }
  const start = given ?? now
  if (request.ship === true) {
    if (Math.abs(start.getTime() - now.getTime()) > grace) problems.push({ path: at, message: `The goods leave now: leave the start out, or give a time within ${DDT_START_GRACE_MINUTES} minutes of now.` })
    return start
  }
  if (start.getTime() < now.getTime() - grace) problems.push({ path: at, message: 'The transport starts once the DDT is issued (DPR 472/1996: the DDT travels with the goods), not before.' })
  if (start.getTime() > now.getTime() + DDT_START_MAX_DAYS * 86_400_000) problems.push({ path: at, message: `Give a start at most ${DDT_START_MAX_DAYS} days ahead: a DDT is issued for goods about to leave.` })
  return start
}

function carrierProblems(carrier: DdtCarrier, problems: Issue[]): void {
  if (!filled(carrier.name)) problems.push({ path: 'body/carrier/name', message: 'Name the carrier (DPR 472/1996: the identity of whoever carries the goods).' })
  if (carrier.address !== null && carrier.address !== undefined && postalAddressOf(carrier.address) === null) {
    problems.push({ path: 'body/carrier/address', message: "The carrier's address needs its street, postal code, city and country." })
  }
}

const positiveKg = (value: string): boolean => fitsDecimal(value, 18, 4) && (parseDecimal(value)?.greaterThan(0) ?? false)

/**
 * The DDT the shipment would get now, and every problem (paths `body/…` for what the office says, `company/…` for the
 * company's legal data, `shipment/…` for what the shipment lacks). Pure: the API reads the facts under the shipment's
 * lock and calls it again inside the issuing command, so what is numbered is what was checked.
 */
export function draftDdt(facts: DdtFacts, request: DdtRequest, now: Date): { readonly draft: DdtDraft; readonly problems: readonly Issue[] } {
  const problems: Issue[] = []
  const reason = request.reason ?? 'SALE'
  if (!(DDT_REASONS as readonly string[]).includes(reason)) problems.push({ path: 'body/reason', message: 'Give the reason for the transport (causale).' })
  else if (!SHIPMENT_DDT_REASONS.includes(reason)) problems.push({ path: 'body/reason', message: NOT_FOR_A_SHIPMENT[reason] ?? 'Not a reason a shipment to a customer travels for.' })
  const reasonText = trimmed(request.reasonText)
  if (reason === 'OTHER' && reasonText === null) problems.push({ path: 'body/reasonText', message: 'Say the reason for the transport in words.' })

  // Who carries the goods is the shipment's (its delivery details): the DDT declares it, never another.
  const transportBy = facts.shipment.transportBy
  if (!(TRANSPORT_BY as readonly string[]).includes(transportBy)) problems.push({ path: 'shipment/transportBy', message: 'Say who carries the goods on the shipment: SENDER, RECIPIENT or CARRIER.' })
  let carrier: DdtCarrier | null = null
  if (transportBy === 'CARRIER') {
    const given = request.carrier ?? (filled(facts.shipment.carrierName) ? { name: facts.shipment.carrierName } : null)
    if (given === null) problems.push({ path: 'body/carrier', message: 'Name the carrier (DPR 472/1996: the identity of whoever carries the goods).' })
    else {
      carrierProblems(given, problems)
      carrier = { name: given.name.trim(), address: given.address ? postalAddressOf(given.address) : null, vatNumber: trimmed(given.vatNumber) }
    }
  } else if (request.carrier !== undefined && request.carrier !== null) {
    problems.push({ path: 'body/carrier', message: 'A carrier is named only when a carrier carries the goods (the shipment says who: transportBy).' })
  }

  const startAt = startOf(facts, request, now, problems)
  const appearance = trimmed(request.appearance) ?? trimmed(facts.defaultAppearance)
  if (appearance === null) problems.push({ path: 'body/appearance', message: "Describe the goods' external appearance, e.g. 'scatole di cartone' (aspetto esteriore dei beni, DPR 472/1996)." })

  const parcels = [...facts.parcels].sort((a, b) => a.seq - b.seq)
  if (parcels.length === 0) problems.push({ path: 'shipment/parcels', message: 'The shipment has no parcels: the DDT states the number of packages.' })
  const unweighed = parcels.filter((parcel) => parcel.grossWeightKg === null || !positiveKg(parcel.grossWeightKg)).map((parcel) => parcel.seq)
  if (unweighed.length > 0) problems.push({ path: 'shipment/parcels', message: `Weigh parcel ${unweighed.join(', ')}: the DDT states the gross weight.` })
  const gross = unweighed.length === 0 && parcels.length > 0 ? sum(parcels.map((parcel) => new Dec(parcel.grossWeightKg!))) : null
  const netWeightKg = trimmed(request.netWeightKg)
  if (netWeightKg !== null) {
    if (!positiveKg(netWeightKg)) problems.push({ path: 'body/netWeightKg', message: 'Expected a net weight in kilograms above 0, with at most 4 decimals.' })
    else if (gross !== null && new Dec(netWeightKg).greaterThan(gross)) problems.push({ path: 'body/netWeightKg', message: `The net weight is at most the gross weight (${gross.toFixed(4)} kg).` })
  }
  const freight = request.freight ?? null
  if (freight !== null && !(DDT_FREIGHT as readonly string[]).includes(freight)) problems.push({ path: 'body/freight', message: 'Expected FREE or FORWARD.' })

  problems.push(...legalProblems(facts.company))
  const sender: DdtPartySnapshot = { name: facts.company.legalName, address: facts.company.address, vatNumber: facts.company.vatNumber, fiscalCode: facts.company.fiscalCode }
  const buyer = (facts.billTo ?? {}) as Record<string, unknown>
  const recipient: DdtPartySnapshot = { name: string(buyer.legalName) ?? '', address: postalAddressOf(buyer.address), vatNumber: string(buyer.vatNumber), fiscalCode: string(buyer.fiscalCode) }
  if (recipient.name === '') problems.push({ path: 'shipment/recipient', message: "The order's buyer has no name: the DDT names the recipient (DPR 472/1996)." })
  if (recipient.address === null) problems.push({ path: 'shipment/recipient/address', message: "The order's buyer has no complete address (street, postal code, city, country): the DDT prints it (DPR 472/1996)." })
  const shipTo = postalAddressOf(facts.shipment.shipTo)
  if (shipTo === null) problems.push({ path: 'shipment/shipTo', message: 'The delivery address is not complete (street, postal code, city, country).' })
  const destinationName = string((facts.shipment.shipTo as Record<string, unknown> | null)?.name)
  const destination: DdtDestination | null = shipTo && !(recipient.address && sameAddress(shipTo, recipient.address)) ? { ...(destinationName ? { name: destinationName } : {}), ...shipTo } : null

  const lines = ddtLines(facts.goods, facts.language)
  if (lines.length === 0) problems.push({ path: 'shipment/lines', message: 'The shipment has no goods: a DDT lists at least one line.' })
  const documentRefs: DocumentReference[] = [
    { kind: 'SALES_ORDER', number: facts.order.number, ...(isBusinessDate(facts.order.orderDate) ? { date: facts.order.orderDate } : {}) },
    ...(filled(facts.order.customerRef) ? [{ kind: 'CUSTOMER_ORDER' as const, number: facts.order.customerRef.trim() }] : []),
  ]

  return {
    draft: {
      documentDate: businessDate(now),
      reason,
      reasonText,
      transportBy,
      carrier,
      startAt: toUtcIso(startAt),
      appearance: appearance ?? '',
      packages: parcels.length,
      grossWeightKg: gross === null ? '0.0000' : gross.toFixed(4),
      netWeightKg: netWeightKg !== null && positiveKg(netWeightKg) ? new Dec(netWeightKg).toFixed(4) : netWeightKg,
      freight,
      sender,
      recipient,
      destination,
      lines,
      documentRefs,
      remarks: trimmed(request.remarks),
    },
    problems,
  }
}

// ---- the document ---------------------------------------------------------------------------------------------------

/** A frozen DDT as the Ddt row keeps it (its number, date and what was printed). */
export interface IssuedDdt extends Omit<DdtDraft, 'documentDate'> {
  readonly number: string
  readonly documentDate: BusinessDate
}

/**
 * The DDT as a document (factory-domain documents, type DDT) for the PDF: everything from the frozen row, so a copy
 * printed again says what was issued. The company's letterhead comes from its Company row (the API).
 */
export function ddtDocument(ddt: IssuedDdt, language: DocumentLanguage, currency: string): Omit<DocumentInput, 'company' | 'sample'> {
  const recipient: DocumentParty = { name: ddt.recipient.name, address: ddt.recipient.address, vatNumber: ddt.recipient.vatNumber ?? null, fiscalCode: ddt.recipient.fiscalCode ?? null }
  const lines: DocumentLine[] = ddt.lines.map((line) => ({ code: line.code, description: line.description, quantity: line.quantity, uom: line.uom }))
  return {
    type: 'DDT',
    language,
    number: ddt.number,
    date: ddt.documentDate,
    currency,
    party: recipient,
    references: ddt.documentRefs,
    lines,
    transport: {
      reason: ddt.reason,
      reasonText: ddt.reasonText,
      transportBy: ddt.transportBy,
      carrier: ddt.carrier,
      startAt: ddt.startAt,
      appearance: ddt.appearance,
      packages: ddt.packages,
      grossWeightKg: ddt.grossWeightKg,
      netWeightKg: ddt.netWeightKg,
      freight: ddt.freight,
      destination: ddt.destination,
    },
    notes: ddt.remarks,
  }
}
