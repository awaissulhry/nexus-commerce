import { Decimal } from 'decimal.js'
import type { Issue } from '../core/errors'
import { fitsDecimal, QUANTITY, toMinorUnits, UNIT_PRICE, type CurrencyCode, type MinorUnits } from '../core/money'
import { isBusinessDate, type BusinessDate } from '../core/time'
import { addDays, hidesFor } from '../planning/buy'
import type { PartyRole, PartyStatus } from '../parties/rules'
import { baseFactor, convertibleUnits, COST_SCALE, decimalOf, QUANTITY_SCALE, roundTo, type ItemUnits, type Uom } from '../product/units/units'

/**
 * Purchase orders (B-W1-30; SCM-050, SCM-053, SCM-054, SCM-055, SCM-075; A1 §2.5 "Purchase order"; PLAN §4.7 stage
 * 08-buy), pure: the states, a line's numbers, what a line may say, what stops a send, and when an order may be cancelled.
 * apps/factory-api modules/purchasing reads the facts and writes through command(); the …_supply_guards triggers hold the
 * same states for every login.
 *
 *   states     DRAFT → SENT → CONFIRMED → PARTLY_RECEIVED → RECEIVED → CLOSED; DECLINED by the supplier (B-W1-31's
 *              link), or CHANGES_PROPOSED by it (the buyer accepts → CONFIRMED, or refuses → SENT); CANCELLED by the office. Approval (PENDING_APPROVAL / APPROVED, SCM-078) is W2b: in W1 the
 *              person who may send places the order.
 *   a line     bought in its own unit (ft² or m² for leather, metres, pieces …; any unit the item converts) and counted in
 *              the item's base unit as well (planning nets it, receiving counts against it). Its amount is quantity × unit
 *              price, rounded once to the currency's minor unit; the order's net amount is the sum of its lines.
 *   leather    grade, thickness range, one dye batch, area tolerance %, and about how many hides the area is (the base
 *              area over the item's hide factor, rounded up); the Cr VI flag is copied from the item (REACH Annex XVII
 *              entry 47).
 *   send       the checks of `sendChecks`: a supplier (role) that is ACTIVE, a contact of it who takes ORDERS and has an
 *              e-mail, the company's letterhead and the site's delivery address, at least one line, every line priced
 *              and needed today or later; warnings (never blocking) for the supplier's minimum, order steps and lead
 *              time.
 *   cancel     a draft; a sent order the supplier has not confirmed (SENT, or DECLINED by it). A confirmed order is a
 *              contract: it is not cancelled here (a change with the supplier, W2a). A send and a cancel of one order
 *              never both happen: each is ONE command that compares and sets the order's version, so the second finds a
 *              newer version (409) and, read again, a state that refuses it.
 */

export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'SENT', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number]

export const STATUS_WORDS: Readonly<Record<PurchaseOrderStatus, string>> = Object.freeze({
  DRAFT: 'a draft',
  SENT: 'sent and waiting for the supplier',
  CONFIRMED: 'confirmed by the supplier',
  DECLINED: 'declined by the supplier',
  CHANGES_PROPOSED: "waiting for the buyer's decision on the supplier's changes",
  PARTLY_RECEIVED: 'partly received',
  RECEIVED: 'received',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
})

/** The party roles an order goes to: a supplier, or a subcontractor that also sells us material. */
export const PURCHASE_PARTY_ROLES: readonly PartyRole[] = Object.freeze(['SUPPLIER', 'SUBCONTRACTOR'])
export const isPurchaseParty = (roles: readonly PartyRole[]): boolean => roles.some((role) => PURCHASE_PARTY_ROLES.includes(role))

export const MAX_TEXT = Object.freeze({ description: 300, note: 1000, internalNote: 2000, paymentTerms: 200, incoterms: 60, code: 60, grade: 40, reason: 500, message: 4000 })
/** Lines are numbered 10, 20, 30 … */
export const LINE_SEQ_STEP = 10
/** At most this many lines on one order, and requirements in one "Draft PO". */
export const MAX_LINES = 200

/** The item kind whose lines carry the leather fields. */
export const LEATHER_KIND = 'LEATHER'

const HALF_UP_QUANTITY = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' } as const
const HALF_UP_PRICE = { scale: COST_SCALE, rounding: 'HALF_UP' } as const

// ---- a line's numbers -------------------------------------------------------------------------------------------------

/** The quantity in the item's base unit (four places, half up); null when the item cannot convert `uom`. */
export function baseQuantityOf(quantity: string, uom: Uom, units: ItemUnits): string | null {
  const factor = baseFactor(uom, units)
  if (factor === null) return null
  return roundTo(decimalOf(quantity).times(factor), HALF_UP_QUANTITY).toFixed(QUANTITY_SCALE)
}

/** quantity × unit price, rounded half up to the currency's minor unit (the one rounding point, A1 §2.1). */
export function lineAmount(quantity: string, unitPrice: string, currency: CurrencyCode): MinorUnits {
  return toMinorUnits(decimalOf(quantity).times(decimalOf(unitPrice, 'unitPrice')), currency)
}

/** The order's net amount: the sum of its lines' amounts (the …_supply_guards trigger checks it at the send). */
export const orderAmount = (lines: readonly { readonly netAmount: MinorUnits }[]): MinorUnits => lines.reduce((sum, line) => sum + line.netAmount, 0)

/**
 * The price a new line starts with: the item's standard purchase price (per base unit) in the line's unit, six places,
 * when it is kept in the order's currency; null otherwise (the buyer types it: an unpriced line is not sent).
 */
export function defaultUnitPrice(item: { readonly standardCost: string | null; readonly currency: string; readonly units: ItemUnits }, uom: Uom, orderCurrency: CurrencyCode): string | null {
  if (item.standardCost === null || item.currency !== orderCurrency) return null
  const factor = baseFactor(uom, item.units)
  if (factor === null) return null
  return roundTo(decimalOf(item.standardCost, 'standardCost').times(factor), HALF_UP_PRICE).toFixed(COST_SCALE)
}

/** Leather: about how many hides the base area is (rounded up); null for other kinds or without a hide factor. */
export const estimatedHidesOf = (kind: string, baseQuantity: string, units: ItemUnits): number | null => (kind === LEATHER_KIND ? hidesFor(baseQuantity, units) : null)

/**
 * A line moved to another unit of its material (5 HIDE → 262.5 FT2): the same quantity and the same price per base unit,
 * in the new unit (quantity four places, price six, half up); null when the material cannot convert one of the units.
 */
export function inUnit(line: { readonly quantity: string; readonly unitPrice: string }, from: Uom, to: Uom, units: ItemUnits): { readonly quantity: string; readonly unitPrice: string } | null {
  const fromFactor = baseFactor(from, units)
  const toFactor = baseFactor(to, units)
  if (fromFactor === null || toFactor === null || toFactor.lte(0) || fromFactor.lte(0)) return null
  return {
    quantity: roundTo(decimalOf(line.quantity).times(fromFactor).div(toFactor), HALF_UP_QUANTITY).toFixed(QUANTITY_SCALE),
    unitPrice: roundTo(decimalOf(line.unitPrice, 'unitPrice').div(fromFactor).times(toFactor), HALF_UP_PRICE).toFixed(COST_SCALE),
  }
}

/** A line's quantity in the item's purchase unit (four places, half up), for the supplier's minimum and steps. */
export function purchaseQuantityOf(quantity: string, uom: Uom, units: ItemUnits): string | null {
  const from = baseFactor(uom, units)
  const to = baseFactor(units.purchaseUom, units)
  if (from === null || to === null || to.lte(0)) return null
  return roundTo(decimalOf(quantity).times(from).div(to), HALF_UP_QUANTITY).toFixed(QUANTITY_SCALE)
}

// ---- what a line may say ------------------------------------------------------------------------------------------------

export interface LineItemFacts {
  readonly kind: string
  readonly status: string
  readonly units: ItemUnits
}

export interface LineFields {
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly unitPrice?: string | null | undefined
  readonly needDate?: string | undefined
  readonly grade?: string | null | undefined
  readonly thicknessMinMm?: string | null | undefined
  readonly thicknessMaxMm?: string | null | undefined
  readonly oneDyeBatch?: boolean | undefined
  readonly areaTolerancePct?: string | null | undefined
}

const LEATHER_FIELDS = ['grade', 'thicknessMinMm', 'thicknessMaxMm', 'oneDyeBatch', 'areaTolerancePct'] as const

/**
 * What is wrong with a line as it would be stored (the merged fields: what the caller sent over what the line holds).
 * Paths are `body/<field>`.
 */
export function lineProblems(line: Required<Pick<LineFields, 'quantity' | 'uom' | 'needDate'>> & LineFields, item: LineItemFacts): Issue[] {
  const problems: Issue[] = []
  if (!fitsDecimal(line.quantity, QUANTITY.precision, QUANTITY.scale) || !decimalOf(line.quantity).gt(0)) problems.push({ path: 'body/quantity', message: 'A quantity above 0, at most four decimals.' })
  if (baseFactor(line.uom, item.units) === null) problems.push({ path: 'body/uom', message: `This material is bought in ${convertibleUnits(item.units).join(', ')}.` })
  if (line.unitPrice !== null && line.unitPrice !== undefined && (!fitsDecimal(line.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale) || decimalOf(line.unitPrice, 'unitPrice').lt(0))) {
    problems.push({ path: 'body/unitPrice', message: 'A price of 0 or more, at most six decimals.' })
  }
  if (!isBusinessDate(line.needDate)) problems.push({ path: 'body/needDate', message: 'Expected the day it is needed, YYYY-MM-DD.' })
  if (item.status !== 'ACTIVE') problems.push({ path: 'body/itemId', message: 'The material is archived: it is not bought any more.' })
  if (item.kind !== LEATHER_KIND) {
    for (const field of LEATHER_FIELDS) {
      const value = line[field]
      if (value !== undefined && value !== null && value !== false) problems.push({ path: `body/${field}`, message: 'Only a leather line has a grade, thickness, dye batch or area tolerance.' })
    }
    return problems
  }
  for (const field of ['thicknessMinMm', 'thicknessMaxMm'] as const) {
    const value = line[field]
    if (value !== null && value !== undefined && (!fitsDecimal(value, 6, 2) || !decimalOf(value, field).gt(0))) problems.push({ path: `body/${field}`, message: 'A thickness in millimetres above 0, at most two decimals.' })
  }
  const low = line.thicknessMinMm
  const high = line.thicknessMaxMm
  if (low && high && fitsDecimal(low, 6, 2) && fitsDecimal(high, 6, 2) && decimalOf(low).gt(decimalOf(high))) problems.push({ path: 'body/thicknessMaxMm', message: 'The thickness range goes from low to high.' })
  const tolerance = line.areaTolerancePct
  if (tolerance !== null && tolerance !== undefined && (!fitsDecimal(tolerance, 7, 4) || decimalOf(tolerance, 'areaTolerancePct').lt(0) || decimalOf(tolerance).gt(100))) {
    problems.push({ path: 'body/areaTolerancePct', message: 'An area tolerance from 0 to 100 percent.' })
  }
  if (line.grade !== null && line.grade !== undefined && line.grade.length > MAX_TEXT.grade) problems.push({ path: 'body/grade', message: `At most ${MAX_TEXT.grade} characters.` })
  return problems
}

// ---- what stops a send --------------------------------------------------------------------------------------------------

export const SEND_CHECK_CODES = [
  'NOT_DRAFT',
  'NOT_A_SUPPLIER',
  'SUPPLIER_NOT_ACTIVE',
  'NO_CONTACT',
  'CONTACT_NOT_ORDERS',
  'NO_CONTACT_EMAIL',
  'COMPANY_LEGAL',
  'NO_DELIVERY_ADDRESS',
  'NO_LINES',
  'LINE_NOT_PRICED',
  'NEED_DATE_PAST',
  'REQUESTED_DATE_PAST',
  'BELOW_MINIMUM',
  'NOT_A_MULTIPLE',
  'LATE_FOR_LEAD_TIME',
] as const
export type SendCheckCode = (typeof SEND_CHECK_CODES)[number]
export type CheckSeverity = 'BLOCKS' | 'WARNING'

export interface SendCheck {
  readonly code: SendCheckCode
  readonly severity: CheckSeverity
  readonly path: string
  readonly message: string
}

export interface SendLineFacts {
  readonly seq: number
  readonly itemCode: string
  /** Decimal(18,6) as stored; "0" (or less) is not priced. */
  readonly unitPrice: string
  readonly needDate: BusinessDate
  /** The line's quantity in the item's purchase unit; null when it cannot be converted. */
  readonly purchaseQuantity: string | null
  readonly purchaseUom: Uom
  /** The supplier's terms for the item (planning/buy supplyRulesFor): minimum and steps in the purchase unit. */
  readonly minOrderQuantity: string | null
  readonly orderMultiple: string | null
  readonly leadTimeDays: number | null
  /**
   * B-W2a-52: the earliest arrival with the supplier's closed days not counted (calendars/suppliers arrivalDate over its
   * calendar, from today); none: today plus the lead time in calendar days.
   */
  readonly earliestArrival?: BusinessDate | null | undefined
}

export interface SendFacts {
  readonly status: PurchaseOrderStatus
  readonly today: BusinessDate
  readonly supplier: { readonly name: string; readonly status: PartyStatus; readonly roles: readonly PartyRole[] }
  readonly contact: { readonly name: string; readonly email: string | null; readonly roles: readonly string[]; readonly active: boolean } | null
  /** The company's letterhead problems (documents/legal legalProblems). */
  readonly companyLegal: readonly Issue[]
  readonly deliveryAddress: boolean
  readonly requestedDate: BusinessDate | null
  readonly lines: readonly SendLineFacts[]
}

const text4 = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const plain = (value: string): string => decimalOf(value).toString()

/** Every check of a send, in order; `ready` when none BLOCKS. Warnings never stop a send. */
export function sendChecks(facts: SendFacts): { readonly ready: boolean; readonly checks: SendCheck[] } {
  const checks: SendCheck[] = []
  const block = (code: SendCheckCode, path: string, message: string) => checks.push({ code, severity: 'BLOCKS', path, message })
  const warn = (code: SendCheckCode, path: string, message: string) => checks.push({ code, severity: 'WARNING', path, message })

  if (facts.status !== 'DRAFT') block('NOT_DRAFT', 'status', `The order is ${STATUS_WORDS[facts.status]}: only a draft is sent.`)
  if (!isPurchaseParty(facts.supplier.roles)) block('NOT_A_SUPPLIER', 'partyId', `${facts.supplier.name} is not a supplier: give it the supplier role first.`)
  if (facts.supplier.status !== 'ACTIVE') {
    const why = facts.supplier.status === 'PROSPECT' ? 'still a prospect: approve it as a supplier first' : `${facts.supplier.status.toLowerCase()}: pick another approved source`
    block('SUPPLIER_NOT_ACTIVE', 'partyId', `${facts.supplier.name} is ${why}.`)
  }
  if (facts.contact === null || !facts.contact.active) block('NO_CONTACT', 'contactId', 'Choose the contact at the supplier who receives purchase orders.')
  else {
    if (!facts.contact.roles.includes('ORDERS')) block('CONTACT_NOT_ORDERS', 'contactId', `${facts.contact.name} does not receive purchase orders: choose a contact with the orders role.`)
    if (!facts.contact.email) block('NO_CONTACT_EMAIL', 'contactId', `${facts.contact.name} has no e-mail: the order and its confirm link go by e-mail.`)
  }
  if (facts.companyLegal.length > 0) block('COMPANY_LEGAL', 'companyId', `The company's letterhead is incomplete: ${facts.companyLegal.map((issue) => issue.message).join(' ')}`)
  if (!facts.deliveryAddress) block('NO_DELIVERY_ADDRESS', 'siteId', 'The delivery site has no address to print on the order.')
  if (facts.requestedDate !== null && facts.requestedDate < facts.today) block('REQUESTED_DATE_PAST', 'requestedDate', `The delivery date asked for the order (${facts.requestedDate}) is past: move it to today or later.`)
  if (facts.lines.length === 0) block('NO_LINES', 'lines', 'Add a line: an order without lines is not sent.')

  for (const line of facts.lines) {
    const path = `lines/${line.seq}`
    if (!decimalOf(line.unitPrice, 'unitPrice').gt(0)) block('LINE_NOT_PRICED', `${path}/unitPrice`, `Line ${line.seq} (${line.itemCode}) has no price.`)
    if (line.needDate < facts.today) block('NEED_DATE_PAST', `${path}/needDate`, `Line ${line.seq} (${line.itemCode}) is needed on ${line.needDate}, which is past: move the date.`)
    if (line.purchaseQuantity !== null) {
      const quantity = decimalOf(line.purchaseQuantity)
      if (line.minOrderQuantity !== null && quantity.lt(decimalOf(line.minOrderQuantity))) {
        warn('BELOW_MINIMUM', `${path}/quantity`, `Line ${line.seq} (${line.itemCode}) asks ${plain(text4(quantity))} ${line.purchaseUom}; the supplier sells at least ${plain(line.minOrderQuantity)} ${line.purchaseUom}.`)
      }
      if (line.orderMultiple !== null) {
        const multiple = decimalOf(line.orderMultiple)
        if (multiple.gt(0) && !quantity.mod(multiple).isZero()) {
          warn('NOT_A_MULTIPLE', `${path}/quantity`, `Line ${line.seq} (${line.itemCode}) asks ${plain(text4(quantity))} ${line.purchaseUom}; the supplier sells in steps of ${plain(line.orderMultiple)} ${line.purchaseUom}.`)
        }
      }
    }
    if (line.leadTimeDays !== null && line.needDate >= facts.today) {
      const earliest = line.earliestArrival ?? addDays(facts.today, line.leadTimeDays)
      if (earliest > line.needDate) warn('LATE_FOR_LEAD_TIME', `${path}/needDate`, `Line ${line.seq} (${line.itemCode}) is needed on ${line.needDate}; with ${line.leadTimeDays} days' lead time it arrives on ${earliest} at the earliest.`)
    }
  }
  return { ready: !checks.some((check) => check.severity === 'BLOCKS'), checks }
}

// ---- the state rules of the office's actions ------------------------------------------------------------------------------

/** Lines and header change only while the order is a draft (the …_supply_guards triggers say so too). */
export function draftProblem(status: PurchaseOrderStatus): string | null {
  if (status === 'DRAFT') return null
  return `The order is ${STATUS_WORDS[status]}: its lines and terms change only while it is a draft.`
}

/** A new confirm link goes only to an order waiting for its supplier. */
export function newLinkProblem(status: PurchaseOrderStatus): string | null {
  if (status === 'SENT') return null
  if (status === 'DRAFT') return 'The order is not sent yet: send it.'
  if (status === 'CHANGES_PROPOSED') return "The supplier proposed changes: accept or refuse the supplier's changes first (refused, the order waits for a new link)."
  return `The order is ${STATUS_WORDS[status]}: it waits for no confirmation, so it gets no new link.`
}

/**
 * Whether the office may cancel the order now: a draft, or a sent order the supplier has not confirmed (SENT, or
 * DECLINED by it). Null when it may, else why not (a 409 for the caller).
 */
export function cancelProblem(status: PurchaseOrderStatus): string | null {
  switch (status) {
    case 'DRAFT':
    case 'SENT':
    case 'DECLINED':
      return null
    case 'CHANGES_PROPOSED':
      return "The supplier proposed changes to this order: accept or refuse the supplier's changes first (refused, the order can be cancelled)."
    case 'CONFIRMED':
      return 'The supplier confirmed this order: it is a contract now. Agree any change with the supplier; a confirmed order is not cancelled here.'
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
      return 'Goods were received against this order: it is closed, never cancelled.'
    case 'CLOSED':
    case 'CANCELLED':
      return `The order is ${STATUS_WORDS[status]} already.`
  }
}

/** A cancellation of an order the supplier holds (it was sent) tells the supplier. */
export const supplierKnows = (status: PurchaseOrderStatus): boolean => status === 'SENT' || status === 'DECLINED'

// ---- the confirm link -------------------------------------------------------------------------------------------------------

/** The purpose's default and most (factory-domain links/purposes PO_CONFIRM: 14 and 60 days). */
export const CONFIRM_LINK_DAYS = Object.freeze({ least: 14, most: 60 })

const dayNumber = (date: BusinessDate): number => {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  return Date.UTC(year, month - 1, day) / 86_400_000
}

/**
 * How long the confirm link lives: until the latest need date of the order (a confirmation after the goods are needed
 * is of no use), at least the purpose's default 14 days, at most its 60.
 */
export function confirmLinkDays(today: BusinessDate, latestNeedDate: BusinessDate | null): number {
  const untilNeed = latestNeedDate === null ? 0 : dayNumber(latestNeedDate) - dayNumber(today)
  return Math.min(CONFIRM_LINK_DAYS.most, Math.max(CONFIRM_LINK_DAYS.least, untilNeed))
}

// ---- the supplier's contact ---------------------------------------------------------------------------------------------------

/** The contact a new order goes to: the supplier's first ACTIVE contact who takes ORDERS and has an e-mail. */
export function ordersContactOf<Contact extends { readonly status: string; readonly roles: readonly string[]; readonly email: string | null }>(contacts: readonly Contact[]): Contact | null {
  return contacts.find((contact) => contact.status === 'ACTIVE' && contact.roles.includes('ORDERS') && contact.email !== null && contact.email !== '') ?? null
}

/** The language the supplier reads: the contact's, else the party's; Italian or English (the documents' languages). */
export const supplierLanguageOf = (contactLanguage: string | null | undefined, partyLanguage: string): 'it' | 'en' => ((contactLanguage ?? partyLanguage) === 'it' ? 'it' : 'en')
