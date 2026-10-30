import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '../../core/time'
import { legalProblems } from '../../documents/legal'
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
} from '../../documents/model'
import { UOMS } from '../../product/units/units'
import { Dec, parseDecimal } from '../../tax/decimal'
import { DDT_START_GRACE_MINUTES, DDT_START_MAX_DAYS, postalAddressOf, type DdtCarrier, type DdtDestination, type DdtPartySnapshot } from '../ddt'
import { TRANSPORT_BY, type TransportBy } from '../shipments'

/**
 * A DDT for another reason (B-W2a-17; LOG-056; DPR 472/1996 art. 1 c. 3 with DPR 627/1978): goods that travel without a
 * sales shipment carry a transport document of the company's same DDT series (gapless per company and year, every
 * DPR 472/1996 field, never changed once issued: W1's rules, factory-domain shipping/ddt). Its source is the record whose
 * goods travel, of the DDT's company, site and party (the database's factory_ddt_check holds the same):
 *
 *   SubcontractOrder     the kit sent to the workshop to be worked on our behalf (conto lavorazione: WORK_ON_ACCOUNT),
 *                        while the order is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED; its lines are kit lines already
 *                        SENT (their TRANSFER into the workshop's location is posted first)
 *   SupplierClaim        goods going back to the supplier (RETURN) on a claim of kind RETURN, SENT or ACCEPTED; its
 *                        lines are the claim's lines
 *   RepairOrder          the customer's garment going back (REPAIR, or RETURN_FROM_WORK), from RECEIVED, ESTIMATED or
 *                        REPAIRED (a repaired PPE garment only after a passed safety check made after the repair), or a
 *                        replacement for a cancelled DDT once it is SHIPPED; its one line is the garment
 *   ReturnAuthorisation  returned goods sent back unchanged (RETURN), once they arrived (RECEIVED, INSPECTED, CLOSED); its
 *                        lines are the RMA lines decided to go back to the customer as they came
 *
 * OTHER (said in words) fits every source. The reason is printed in words (documents' DDT layout). Who carries the goods,
 * the number of packages and the gross weight are typed (no parcels); the recipient is the source's party, the place of
 * delivery its pickup or delivery address unless the office names another; goods the source has no line for (cut pieces
 * sent with a kit, accessories) are typed lines. Every line of the source travels on at most one live DDT (a DDT that no
 * cancellation names): the API checks it under the source's row lock. A DDT whose goods left (its start is past) and was
 * cancelled is replaced by one that keeps that start.
 */

export const DDT_SOURCE_TYPES = ['SubcontractOrder', 'SupplierClaim', 'RepairOrder', 'ReturnAuthorisation'] as const
export type DdtSourceType = (typeof DDT_SOURCE_TYPES)[number]
export const isDdtSourceType = (value: unknown): value is DdtSourceType => typeof value === 'string' && (DDT_SOURCE_TYPES as readonly string[]).includes(value)

/** The reasons each source's goods travel for, the default first (the database refuses any other). */
export const SOURCE_DDT_REASONS: Readonly<Record<DdtSourceType, readonly DdtReason[]>> = Object.freeze({
  SubcontractOrder: Object.freeze(['WORK_ON_ACCOUNT', 'OTHER'] as const),
  SupplierClaim: Object.freeze(['RETURN', 'OTHER'] as const),
  RepairOrder: Object.freeze(['REPAIR', 'RETURN_FROM_WORK', 'OTHER'] as const),
  ReturnAuthorisation: Object.freeze(['RETURN', 'OTHER'] as const),
})

/** The states in which a source's goods may travel (and a DDT of it may be cancelled and replaced). */
export const SOURCE_TRAVEL_STATES: Readonly<Record<DdtSourceType, readonly string[]>> = Object.freeze({
  SubcontractOrder: Object.freeze(['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED']),
  SupplierClaim: Object.freeze(['SENT', 'ACCEPTED']),
  RepairOrder: Object.freeze(['RECEIVED', 'ESTIMATED', 'REPAIRED', 'SHIPPED']),
  ReturnAuthorisation: Object.freeze(['RECEIVED', 'INSPECTED', 'CLOSED']),
})

/** What each source is called in a sentence. */
export const SOURCE_NAMES: Readonly<Record<DdtSourceType, string>> = Object.freeze({
  SubcontractOrder: 'subcontract order',
  SupplierClaim: 'supplier claim',
  RepairOrder: 'repair',
  ReturnAuthorisation: 'return',
})

const WHY_REASON: Readonly<Record<DdtSourceType, string>> = {
  SubcontractOrder: 'A kit sent to a workshop travels on conto lavorazione (WORK_ON_ACCOUNT), or OTHER said in words.',
  SupplierClaim: 'Goods sent back to a supplier travel as RETURN, or OTHER said in words.',
  RepairOrder: 'A garment going back from repair travels as REPAIR or RETURN_FROM_WORK, or OTHER said in words.',
  ReturnAuthorisation: 'Returned goods sent back unchanged travel as RETURN, or OTHER said in words.',
}

const WHEN_STATE: Readonly<Record<DdtSourceType, string>> = {
  SubcontractOrder: 'its kit travels while it is ISSUED, AT_WORKSHOP or PARTLY_RECEIVED',
  SupplierClaim: 'its goods go back once it is SENT or ACCEPTED',
  RepairOrder: 'the garment goes back from RECEIVED, ESTIMATED or REPAIRED (a new DDT once SHIPPED replaces a cancelled one)',
  ReturnAuthorisation: 'its goods are sent back once they arrived (RECEIVED, INSPECTED or CLOSED)',
}

/** At most this many typed lines on one DDT. */
export const MAX_OTHER_GOODS = 50

// ---- the facts and the request ------------------------------------------------------------------------------------

/** The source record as a DDT sees it. */
export interface DdtSourceFacts {
  readonly type: DdtSourceType
  readonly id: string
  readonly number: string
  /** Its status (a repair's stage). */
  readonly state: string
  /** A supplier claim's kind: RETURN sends the goods back, CLAIM keeps them. */
  readonly claimKind?: 'RETURN' | 'CLAIM' | null
  /** A repair: a PPE garment repaired and not yet checked safe after the repair. */
  readonly repairedUnchecked?: boolean
  /** A repair SHIPPED: when the garment left. */
  readonly shippedAt?: Date | null
}

/** One thing of the source that may travel: a kit, claim or return line, or the repair's garment. */
export interface SourceGoods {
  /** The source's line (kit, claim or return line); the repair itself for its garment. */
  readonly sourceLineId: string
  /** Its place on the source (10, 20 …). */
  readonly seq: number
  readonly code: string | null
  /** Nature and quality, already in the DDT's language (no price). */
  readonly description: string
  /** A decimal above 0 ("12.6", "1"). */
  readonly quantity: string
  readonly uom: string
  readonly batchNumber: string | null
  readonly serials: readonly string[]
  /** Why it cannot travel now, in words (not sent yet, cancelled, undecided…); null: it can. */
  readonly held: string | null
}

/** A DDT of the source and the source lines it carries. */
export interface SourceDdtOf {
  readonly id: string
  readonly number: string
  readonly startAt: Date
  readonly lineIds: readonly string[]
}

/** What the API reads for a source's DDT (under the source's row lock when it issues). */
export interface SourceDdtFacts {
  readonly source: DdtSourceFacts
  readonly company: CompanyLegal
  /** The source's party as printed (legal name, registered or invoice address, VAT number or fiscal code today). */
  readonly recipient: DdtPartySnapshot
  /** Where its goods go by default when not to the recipient's address: the party's pickup or delivery address. */
  readonly defaultDestination: DdtDestination | null
  /** The site's default appearance of the goods (ShippingSettings.defaultGoodsAppearance). */
  readonly defaultAppearance: string | null
  readonly goods: readonly SourceGoods[]
  /** The source's DDTs that no cancellation names, and the cancelled ones. */
  readonly liveDdts: readonly SourceDdtOf[]
  readonly cancelledDdts: readonly SourceDdtOf[]
  /** The documents it refers to (the order, the customer's or supplier's DDT the goods came with). */
  readonly references: readonly DocumentReference[]
  readonly language: DocumentLanguage
}

/** A line the office types: goods the source has no line for. */
export interface OtherGoods {
  readonly code?: string | null | undefined
  readonly description: string
  /** A decimal above 0, at most 4 decimals. */
  readonly quantity: string
  /** One of factory-domain product units (PCS, M, FT2 …). */
  readonly uom: string
}

/** What the office (or the issuing flow) says; everything else comes from the source, its party and the company. */
export interface SourceDdtRequest {
  /** Default: the source's first reason (SOURCE_DDT_REASONS). */
  readonly reason?: DdtReason | undefined
  readonly reasonText?: string | null | undefined
  /** The source's lines that travel; default every one that may travel now. A repair always carries its garment. */
  readonly lineIds?: readonly string[] | undefined
  readonly otherGoods?: readonly OtherGoods[] | undefined
  /** Who carries the goods (trasporto a cura del): SENDER, RECIPIENT or CARRIER. Required. */
  readonly transportBy?: TransportBy | undefined
  /** Required when a carrier carries them. */
  readonly carrier?: DdtCarrier | null | undefined
  /** ISO 8601 with a zone. Default now; a replacement: when the goods of the cancelled DDT left. */
  readonly startAt?: string | null | undefined
  /** Default: the site's default appearance. */
  readonly appearance?: string | null | undefined
  /** Numero colli, from 1. Required. */
  readonly packages?: number | undefined
  /** Kilograms above 0, at most 4 decimals. Required. */
  readonly grossWeightKg?: string | undefined
  readonly netWeightKg?: string | null | undefined
  readonly freight?: DdtFreight | null | undefined
  /** The place of delivery; default the party's (facts.defaultDestination); null: none (the recipient's address). */
  readonly destination?: DdtDestination | null | undefined
  readonly remarks?: string | null | undefined
}

// ---- the printed DDT ------------------------------------------------------------------------------------------------

/** One line of goods as printed (no price). */
export interface SourceDdtLine {
  readonly seq: number
  readonly code: string | null
  readonly description: string
  readonly quantity: string
  readonly uom: string
  /** The source's line it carries (the repair itself for its garment); null: typed by the office. */
  readonly sourceLineId: string | null
  readonly batchNumber: string | null
  readonly serials: readonly string[]
}

/** What a source's DDT says, before its number: the printed columns of the Ddt row. */
export interface SourceDdtDraft {
  readonly documentDate: BusinessDate
  readonly reason: DdtReason
  readonly reasonText: string | null
  readonly transportBy: TransportBy
  readonly carrier: DdtCarrier | null
  /** ISO 8601 UTC. */
  readonly startAt: string
  readonly appearance: string
  readonly packages: number
  readonly grossWeightKg: string
  readonly netWeightKg: string | null
  readonly freight: DdtFreight | null
  readonly sender: DdtPartySnapshot
  readonly recipient: DdtPartySnapshot
  readonly destination: DdtDestination | null
  readonly lines: readonly SourceDdtLine[]
  readonly documentRefs: readonly DocumentReference[]
  readonly remarks: string | null
  /** A replacement of a cancelled DDT whose goods left: it keeps their start. */
  readonly replacement: boolean
}

/** An issued source DDT as the Ddt row keeps it. */
export interface IssuedSourceDdt extends Omit<SourceDdtDraft, 'replacement'> {
  readonly number: string
}

// ---- words ------------------------------------------------------------------------------------------------------------

const WORDS: Readonly<Record<DocumentLanguage, { readonly lot: string; readonly hide: string; readonly batch: string; readonly serials: string; readonly size: string; readonly garment: string; readonly ppe: (category: string) => string; readonly class: string }>> = {
  it: { lot: 'lotto', hide: 'pelle', batch: 'lotto', serials: 'matricole', size: 'taglia', garment: 'Capo', ppe: (category) => `DPI cat. ${category}`, class: 'classe' },
  en: { lot: 'lot', hide: 'hide', batch: 'batch', serials: 'serials', size: 'size', garment: 'Garment', ppe: (category) => `PPE cat. ${category}`, class: 'class' },
}

const filled = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''
const trimmed = (value: string | null | undefined): string | null => (filled(value) ? value.trim() : null)

/** A material as it travels (a kit or claim line): its name and colour, the lot and the hide. */
export function materialDescription(goods: { readonly name: string; readonly colour?: string | null; readonly lot?: string | null; readonly hide?: string | null }, language: DocumentLanguage): string {
  const words = WORDS[language]
  return [
    [goods.name.trim(), ...(filled(goods.colour) ? [goods.colour.trim()] : [])].join(', '),
    ...(filled(goods.lot) ? [`${words.lot} ${goods.lot.trim()}`] : []),
    ...(filled(goods.hide) ? [`${words.hide} ${goods.hide.trim()}`] : []),
  ].join(' - ')
}

const PPE_ROMAN: Readonly<Record<string, string | null>> = { NOT_PPE: null, CATEGORY_I: 'I', CATEGORY_II: 'II', CATEGORY_III: 'III' }

/** A garment as it travels (a repair's): its style, colourway, size and PPE marking, and its serial or batch. */
export function garmentDescription(
  garment: { readonly styleName?: string | null; readonly colourway?: string | null; readonly size?: string | null; readonly serial?: string | null; readonly batchNumber?: string | null; readonly ppe?: { readonly category: string; readonly standard: string | null; readonly class: string | null } | null },
  language: DocumentLanguage,
): string {
  const words = WORDS[language]
  const roman = garment.ppe ? (PPE_ROMAN[garment.ppe.category] ?? null) : null
  const ppe = roman ? [words.ppe(roman), ...(filled(garment.ppe?.standard) ? [garment.ppe!.standard!.trim()] : []), ...(filled(garment.ppe?.class) ? [`${words.class} ${garment.ppe!.class!.trim()}`] : [])].join(', ') : null
  const head = [filled(garment.styleName) ? garment.styleName.trim() : words.garment, ...(filled(garment.colourway) ? [garment.colourway.trim()] : []), ...(filled(garment.size) ? [`${words.size} ${garment.size.trim()}`] : [])].join(', ')
  return [
    `${head}${ppe ? ` (${ppe})` : ''}`,
    ...(filled(garment.batchNumber) ? [`${words.batch} ${garment.batchNumber.trim()}`] : []),
    ...(filled(garment.serial) ? [`${words.serials} ${garment.serial.trim()}`] : []),
  ].join(' - ')
}

// ---- state ----------------------------------------------------------------------------------------------------------

/**
 * Why no DDT can be issued for the source now (empty: it can): its state (the database's list, in words), a claim that
 * keeps its goods, a repaired PPE garment not checked safe, a repair whose garment travels with a live DDT already.
 */
export function sourceIssueStateProblems(facts: Pick<SourceDdtFacts, 'source' | 'liveDdts'>): string[] {
  const { source } = facts
  const name = `The ${SOURCE_NAMES[source.type]} ${source.number}`
  const problems: string[] = []
  if (!SOURCE_TRAVEL_STATES[source.type].includes(source.state)) problems.push(`${name} is ${source.state}: ${WHEN_STATE[source.type]}.`)
  if (source.type === 'SupplierClaim' && source.claimKind === 'CLAIM') problems.push(`${name} keeps the goods (a claim for credit or replacement): only a RETURN claim sends goods back.`)
  if (source.type === 'RepairOrder') {
    if (source.repairedUnchecked === true) problems.push(`${name} is a repaired PPE garment: it goes back only after a passed safety check made after the repair.`)
    const live = facts.liveDdts[0]
    if (live) problems.push(`DDT ${live.number} is live for this repair: cancel it first (the garment travels with one live DDT).`)
  }
  return problems
}

/** An invoice that names a DDT is W1's check (shipping/ddt invoicesOfDdt); the source's own words here. */
export function cancelSourceDdtProblems(facts: { readonly cancelled: boolean; readonly source: Pick<DdtSourceFacts, 'type' | 'number' | 'state'>; readonly invoiceNumbers: readonly string[] }): string[] {
  if (facts.cancelled) return ['This DDT is cancelled already.']
  const problems: string[] = []
  const { source } = facts
  if (!SOURCE_TRAVEL_STATES[source.type].includes(source.state)) {
    problems.push(`The ${SOURCE_NAMES[source.type]} ${source.number} is ${source.state}: its transport is over, so its DDT stays as issued.`)
  }
  if (facts.invoiceNumbers.length > 0) {
    problems.push(`Invoice ${facts.invoiceNumbers.join(', ')} bills the goods of this DDT: an invoiced DDT stays as issued (a credit note corrects the invoice).`)
  }
  return problems
}

// ---- the draft ------------------------------------------------------------------------------------------------------

const sameAddress = (a: PostalAddress, b: PostalAddress): boolean => {
  const key = (address: PostalAddress) => [address.line1, address.line2 ?? '', address.postalCode, address.city, address.country].map((part) => part.trim().toLowerCase().replace(/\s+/g, ' ')).join('|')
  return key(a) === key(b)
}

const positive = (value: string, scale: number): boolean => fitsDecimal(value, 18, scale) && (parseDecimal(value)?.greaterThan(0) ?? false)
const decimalText = (value: string): string => new Dec(value).toFixed()

/** The source's lines the request names (or every one that may travel), with a problem for each one that cannot. */
function goodsThatTravel(facts: SourceDdtFacts, request: SourceDdtRequest, problems: Issue[]): SourceGoods[] {
  const onLive = new Map<string, string>()
  for (const ddt of facts.liveDdts) for (const lineId of ddt.lineIds) onLive.set(lineId, ddt.number)
  const travelling = (goods: SourceGoods): string | null => {
    const live = onLive.get(goods.sourceLineId)
    if (live !== undefined) return facts.source.type === 'RepairOrder' ? `The garment travels with DDT ${live} already.` : `Line ${goods.seq} travels with DDT ${live} already.`
    return goods.held
  }
  if (facts.source.type === 'RepairOrder') {
    if (request.lineIds !== undefined) problems.push({ path: 'body/lineIds', message: "A repair's DDT carries its garment: leave the lines out." })
    // The repair's state problems (a live DDT, an unchecked PPE garment) are the state's: the garment always travels.
    return [...facts.goods]
  }
  if (request.lineIds === undefined) {
    const free = facts.goods.filter((goods) => travelling(goods) === null)
    if (free.length === 0 && (request.otherGoods ?? []).length === 0) {
      const why = facts.goods.map((goods) => travelling(goods)).filter((reason): reason is string => reason !== null)
      problems.push({ path: 'source/lines', message: `Nothing of ${SOURCE_NAMES[facts.source.type]} ${facts.source.number} may travel now${why.length > 0 ? `: ${why.join(' ')}` : ': it has no lines.'}` })
    }
    return free.sort((a, b) => a.seq - b.seq)
  }
  const byId = new Map(facts.goods.map((goods) => [goods.sourceLineId, goods]))
  const chosen: SourceGoods[] = []
  const seen = new Set<string>()
  request.lineIds.forEach((lineId, index) => {
    const at = `body/lineIds/${index}`
    const goods = byId.get(lineId)
    if (!goods) return problems.push({ path: at, message: `Not a line of ${SOURCE_NAMES[facts.source.type]} ${facts.source.number}.` })
    if (seen.has(lineId)) return problems.push({ path: at, message: `Line ${goods.seq} is named twice.` })
    seen.add(lineId)
    const why = travelling(goods)
    if (why !== null) return problems.push({ path: at, message: why })
    chosen.push(goods)
  })
  if (request.lineIds.length === 0 && (request.otherGoods ?? []).length === 0) problems.push({ path: 'body/lineIds', message: 'Name the goods that travel: a DDT lists at least one line.' })
  return chosen.sort((a, b) => a.seq - b.seq)
}

function otherGoodsLines(request: SourceDdtRequest, problems: Issue[]): Omit<SourceDdtLine, 'seq'>[] {
  const typed = request.otherGoods ?? []
  if (typed.length > MAX_OTHER_GOODS) problems.push({ path: 'body/otherGoods', message: `At most ${MAX_OTHER_GOODS} typed lines on one DDT.` })
  return typed.slice(0, MAX_OTHER_GOODS).map((goods, index) => {
    const at = `body/otherGoods/${index}`
    if (!filled(goods.description)) problems.push({ path: `${at}/description`, message: 'Describe the goods: their nature and quality (DPR 472/1996).' })
    const quantity = positive(goods.quantity, 4) ? decimalText(goods.quantity) : goods.quantity
    if (!positive(goods.quantity, 4)) problems.push({ path: `${at}/quantity`, message: 'Expected a quantity above 0, with at most 4 decimals.' })
    if (!(UOMS as readonly string[]).includes(goods.uom)) problems.push({ path: `${at}/uom`, message: `Expected a unit of ${UOMS.join(', ')}.` })
    return { code: trimmed(goods.code), description: (goods.description ?? '').trim(), quantity, uom: goods.uom, sourceLineId: null, batchNumber: null, serials: [] }
  })
}

/**
 * The start of the transport. A replacement (goods of a cancelled DDT of this source whose start is past, or a repair
 * that is SHIPPED) keeps when they left and never starts later; otherwise from now (DDT_START_GRACE_MINUTES before it at
 * most) to DDT_START_MAX_DAYS ahead.
 */
function startOf(facts: SourceDdtFacts, lineIds: readonly string[], request: SourceDdtRequest, now: Date, problems: Issue[]): { start: Date; replacement: boolean } {
  const at = 'body/startAt'
  const given = request.startAt === undefined || request.startAt === null ? null : parseInstant(request.startAt)
  if (request.startAt !== undefined && request.startAt !== null && given === null) {
    problems.push({ path: at, message: 'Give the date and time the transport starts, ISO 8601 with a zone.' })
    return { start: now, replacement: false }
  }
  const grace = DDT_START_GRACE_MINUTES * 60_000
  const carried = new Set(lineIds)
  const left = facts.cancelledDdts
    .filter((ddt) => ddt.startAt.getTime() <= now.getTime() && ddt.lineIds.some((lineId) => carried.has(lineId)))
    .map((ddt) => ddt.startAt)
  if (facts.source.type === 'RepairOrder' && facts.source.state === 'SHIPPED' && facts.source.shippedAt) left.push(facts.source.shippedAt)
  if (left.length > 0) {
    const start = given ?? new Date(Math.min(...left.map((instant) => instant.getTime())))
    if (start.getTime() > now.getTime() + grace) problems.push({ path: at, message: 'The goods left already: the transport started before now.' })
    return { start, replacement: true }
  }
  const start = given ?? now
  if (start.getTime() < now.getTime() - grace) problems.push({ path: at, message: 'The transport starts once the DDT is issued (DPR 472/1996: the DDT travels with the goods), not before.' })
  if (start.getTime() > now.getTime() + DDT_START_MAX_DAYS * 86_400_000) problems.push({ path: at, message: `Give a start at most ${DDT_START_MAX_DAYS} days ahead: a DDT is issued for goods about to leave.` })
  return { start, replacement: false }
}

/**
 * The DDT the source's goods would get now, and every problem (paths `body/…` for what the office says, `company/…` for
 * the company's legal data, `source/…` for what the source or its party lacks). Pure: the API reads the facts under the
 * source's row lock and calls it again inside the issuing command, so what is numbered is what was checked. The state
 * is sourceIssueStateProblems'.
 */
export function draftSourceDdt(facts: SourceDdtFacts, request: SourceDdtRequest, now: Date): { readonly draft: SourceDdtDraft; readonly problems: readonly Issue[] } {
  const problems: Issue[] = []
  const type = facts.source.type
  const allowed = SOURCE_DDT_REASONS[type]
  const reason = request.reason ?? allowed[0]!
  if (!(DDT_REASONS as readonly string[]).includes(reason)) problems.push({ path: 'body/reason', message: 'Give the reason for the transport (causale).' })
  else if (!allowed.includes(reason)) problems.push({ path: 'body/reason', message: WHY_REASON[type] })
  const reasonText = trimmed(request.reasonText)
  if (reason === 'OTHER' && reasonText === null) problems.push({ path: 'body/reasonText', message: 'Say the reason for the transport in words.' })

  const goods = goodsThatTravel(facts, request, problems)
  const typed = otherGoodsLines(request, problems)
  const lines: SourceDdtLine[] = [
    ...goods.map((entry) => ({ code: trimmed(entry.code), description: entry.description, quantity: decimalText(entry.quantity), uom: entry.uom, sourceLineId: entry.sourceLineId, batchNumber: trimmed(entry.batchNumber), serials: [...entry.serials].sort() })),
    ...typed,
  ].map((line, index) => ({ seq: index + 1, ...line }))

  // Who carries the goods: said by the office (a source has no delivery details of its own).
  const transportBy = request.transportBy
  if (transportBy === undefined || !(TRANSPORT_BY as readonly string[]).includes(transportBy)) problems.push({ path: 'body/transportBy', message: 'Say who carries the goods: SENDER, RECIPIENT or CARRIER (DPR 472/1996).' })
  let carrier: DdtCarrier | null = null
  if (transportBy === 'CARRIER') {
    const given = request.carrier ?? null
    if (given === null || !filled(given.name)) problems.push({ path: 'body/carrier/name', message: 'Name the carrier (DPR 472/1996: the identity of whoever carries the goods).' })
    else {
      if (given.address !== null && given.address !== undefined && postalAddressOf(given.address) === null) problems.push({ path: 'body/carrier/address', message: "The carrier's address needs its street, postal code, city and country." })
      carrier = { name: given.name.trim(), address: given.address ? postalAddressOf(given.address) : null, vatNumber: trimmed(given.vatNumber) }
    }
  } else if (request.carrier !== undefined && request.carrier !== null) {
    problems.push({ path: 'body/carrier', message: 'A carrier is named only when a carrier carries the goods (transportBy CARRIER).' })
  }

  const { start, replacement } = startOf(facts, goods.map((entry) => entry.sourceLineId), request, now, problems)
  const appearance = trimmed(request.appearance) ?? trimmed(facts.defaultAppearance)
  if (appearance === null) problems.push({ path: 'body/appearance', message: "Describe the goods' external appearance, e.g. 'scatole di cartone' (aspetto esteriore dei beni, DPR 472/1996)." })
  const packages = request.packages
  if (packages === undefined || !Number.isSafeInteger(packages) || packages < 1) problems.push({ path: 'body/packages', message: 'Give the number of packages (numero colli), from 1.' })
  const gross = request.grossWeightKg
  if (gross === undefined || !positive(gross, 4)) problems.push({ path: 'body/grossWeightKg', message: 'Give the gross weight in kilograms, above 0, with at most 4 decimals.' })
  const netWeightKg = trimmed(request.netWeightKg)
  if (netWeightKg !== null) {
    if (!positive(netWeightKg, 4)) problems.push({ path: 'body/netWeightKg', message: 'Expected a net weight in kilograms above 0, with at most 4 decimals.' })
    else if (gross !== undefined && positive(gross, 4) && new Dec(netWeightKg).greaterThan(new Dec(gross))) problems.push({ path: 'body/netWeightKg', message: `The net weight is at most the gross weight (${new Dec(gross).toFixed(4)} kg).` })
  }
  const freight = request.freight ?? null
  if (freight !== null && !(DDT_FREIGHT as readonly string[]).includes(freight)) problems.push({ path: 'body/freight', message: 'Expected FREE or FORWARD.' })

  problems.push(...legalProblems(facts.company))
  const sender: DdtPartySnapshot = { name: facts.company.legalName, address: facts.company.address, vatNumber: facts.company.vatNumber, fiscalCode: facts.company.fiscalCode }
  const recipient = facts.recipient
  const who = type === 'SubcontractOrder' ? 'workshop' : type === 'SupplierClaim' ? 'supplier' : 'customer'
  if (!filled(recipient.name)) problems.push({ path: 'source/recipient', message: `The ${who} has no name: the DDT names the recipient (DPR 472/1996).` })
  if (recipient.address === null) problems.push({ path: 'source/recipient/address', message: `The ${who} has no complete address (street, postal code, city, country): the DDT prints it (DPR 472/1996).` })
  let destination: DdtDestination | null = null
  const place = request.destination === undefined ? facts.defaultDestination : request.destination
  if (place !== null) {
    const address = postalAddressOf(place)
    if (address === null) problems.push({ path: 'body/destination', message: 'The place of delivery needs its street, postal code, city and country.' })
    else if (!(recipient.address && sameAddress(address, recipient.address))) destination = { ...(filled(place.name) ? { name: place.name.trim() } : {}), ...address }
  }

  return {
    draft: {
      documentDate: businessDate(now),
      reason,
      reasonText,
      transportBy: transportBy ?? 'SENDER',
      carrier,
      startAt: toUtcIso(start),
      appearance: appearance ?? '',
      packages: packages ?? 0,
      grossWeightKg: gross !== undefined && positive(gross, 4) ? new Dec(gross).toFixed(4) : '0.0000',
      netWeightKg: netWeightKg !== null && positive(netWeightKg, 4) ? new Dec(netWeightKg).toFixed(4) : netWeightKg,
      freight,
      sender,
      recipient: { name: recipient.name, address: recipient.address, vatNumber: recipient.vatNumber ?? null, fiscalCode: recipient.fiscalCode ?? null },
      destination,
      lines,
      documentRefs: facts.references,
      remarks: trimmed(request.remarks),
      replacement,
    },
    problems,
  }
}

// ---- the document ---------------------------------------------------------------------------------------------------

/**
 * The source's DDT as a document (factory-domain documents, type DDT) for the PDF: everything from the frozen row, so a
 * copy printed again says what was issued. The reason is printed in words by the DDT layout.
 */
export function sourceDdtDocument(ddt: IssuedSourceDdt, language: DocumentLanguage, currency: string): Omit<DocumentInput, 'company' | 'sample'> {
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
