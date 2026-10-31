import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText, type ItemTracking } from '../ledger/moves'

/**
 * Reservations (B-W2a-11; SCM-205 reserve to an order, SCM-209 reserve leather by area, SCM-210 release; factory-db
 * reservations.prisma), pure. Many orders compete for the same hides (SCOPE W2a rule 1): a reservation holds stock of a
 * site for ONE work order or ONE sales order line, so no two of them count on the same material.
 *
 *   QUANTITY  a quantity of an item not tracked hide by hide, in one colour, from one lot or from any lot;
 *   AREA      an area of leather (an item tracked by HIDE), from one lot (one dye batch) or any: hides chosen at cutting;
 *   HIDE      one named hide, whole, with its lot (one ACTIVE reservation per hide at most).
 *
 * Available = on hand − held − reserved, per site, item and colour, and per lot: held is the stock of a lot that is not
 * RELEASED (inventory/stock/overview); reserved is the open quantity (quantity − issued) of the ACTIVE reservations
 * whose demand is still open — a work order DRAFT, RELEASED, IN_PROGRESS or ON_HOLD (a held work order keeps its
 * material), an order line of a CONFIRMED, IN_PRODUCTION, READY or PARTLY_SHIPPED order. A reservation whose work order
 * was completed, closed or cancelled holds nothing any more (it is shown as `stale`, to release). Moves and reservations
 * change apart (a scrap, a count, a reversal): a key can end up over-reserved; the reads say so, a new reservation is
 * refused while it would be.
 *
 * A reservation is checked on the whole site's stock of its item and colour, AND on its lot when it names one: "any lot"
 * reservations take from every lot, lot reservations only from theirs, so both levels together are what can really be
 * given (Hall's condition for this shape). An issue to a work order may take stock its own reservations hold, and free
 * stock, never stock another demand holds; it then counts against its own reservations: the hide's own HIDE reservation
 * first, then those naming the lot, then those of any lot.
 */

export const RESERVATION_KINDS = ['QUANTITY', 'AREA', 'HIDE'] as const
export type ReservationKind = (typeof RESERVATION_KINDS)[number]

export const RESERVATION_STATUSES = ['ACTIVE', 'ISSUED', 'RELEASED'] as const
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

/** A work order stock is reserved for, and whose reservations hold stock (the …_production_w2a_guards list). */
export const OPEN_WORK_ORDER_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
/** A sales order whose lines stock is reserved for (the …_stock_plan_w2a_guards list). */
export const OPEN_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

export const isOpenWorkOrder = (status: string): boolean => (OPEN_WORK_ORDER_STATUSES as readonly string[]).includes(status)
export const isOpenOrder = (status: string): boolean => (OPEN_ORDER_STATUSES as readonly string[]).includes(status)

/** At most this many lines in one reservation request, one release, one write-off. */
export const MAX_RESERVATION_LINES = 200

/** The kind of reservation an item's tracking takes: leather by AREA or HIDE, anything else by QUANTITY. Null: a hide named for an item not tracked by hide. */
export function kindFor(tracking: ItemTracking, hideNamed: boolean): ReservationKind | null {
  if (tracking === 'HIDE') return hideNamed ? 'HIDE' : 'AREA'
  return hideNamed ? null : 'QUANTITY'
}

const dec = (value: DecimalInput): Decimal => new Dec(value)

/** One ACTIVE reservation of an item and colour at a site, as the checks read it. */
export interface HeldReservation {
  readonly id: string
  readonly kind: ReservationKind
  readonly lotId: string | null
  readonly hideId: string | null
  readonly quantity: DecimalInput
  readonly issuedQuantity: DecimalInput
  readonly workOrderId: string | null
  readonly salesOrderLineId: string | null
  /** Its work order (or order) is still open: only then does it hold stock. */
  readonly demandOpen: boolean
}

/** What a reservation still holds: its quantity less what was issued (never below 0). */
export const openOf = (reservation: Pick<HeldReservation, 'quantity' | 'issuedQuantity'>): Decimal => Dec.max(ZERO, dec(reservation.quantity).minus(dec(reservation.issuedQuantity)))

/** The site's stock of one item and colour, per lot and hide (summed over its locations). */
export interface StockPart {
  readonly lotId: string | null
  readonly hideId: string | null
  readonly onHand: DecimalInput
  /** Its lot is not RELEASED. */
  readonly held: boolean
}

export interface Availability {
  readonly onHand: Decimal
  readonly held: Decimal
  readonly reserved: Decimal
  /** On hand − held − reserved; below 0 when the key is over-reserved. */
  readonly available: Decimal
  readonly overReserved: boolean
}

export interface AvailabilityScope {
  /** One lot's figures (its stock, the reservations naming it); left out: the whole item and colour. */
  readonly lotId?: string | null
  /** Reservations left out of `reserved` (an issue's own demand). */
  readonly excluding?: (reservation: HeldReservation) => boolean
}

/** On hand, held, reserved and available of an item and colour at a site (or of one of its lots). */
export function availabilityOf(stock: readonly StockPart[], reservations: readonly HeldReservation[], scope: AvailabilityScope = {}): Availability {
  const lotId = scope.lotId
  const parts = lotId === undefined || lotId === null ? stock : stock.filter((part) => part.lotId === lotId)
  const onHand = parts.reduce<Decimal>((sum, part) => sum.plus(dec(part.onHand)), ZERO)
  const held = parts.filter((part) => part.held).reduce<Decimal>((sum, part) => sum.plus(dec(part.onHand)), ZERO)
  const counted = reservations.filter((reservation) => reservation.demandOpen && !(scope.excluding?.(reservation) ?? false) && (lotId === undefined || lotId === null || reservation.lotId === lotId))
  const reserved = counted.reduce<Decimal>((sum, reservation) => sum.plus(openOf(reservation)), ZERO)
  const available = onHand.minus(held).minus(reserved)
  return { onHand, held, reserved, available, overReserved: available.isNegative() }
}

// ---- reserving ---------------------------------------------------------------------------------------------------------

/** One line of a reservation request, sized and named (the API reads its rows first). */
export interface ReserveRequest {
  readonly index: number
  readonly kind: ReservationKind
  readonly lotId: string | null
  readonly hideId: string | null
  /** In the item's base unit; a HIDE: its whole stock on hand. */
  readonly baseQuantity: DecimalInput
  /** 'TEST-LEATHER BLK', with the lot or hide when one is named: the words of a refusal. */
  readonly label: string
  readonly lotCode: string | null
  readonly lotHeld: boolean
  readonly hideCode: string | null
  readonly baseUom: string
}

export interface ReserveRefusal {
  readonly index: number
  readonly code: 'HIDE_NOT_IN_STOCK' | 'HIDE_RESERVED' | 'LOT_HELD' | 'NOT_AVAILABLE' | 'LOT_NOT_AVAILABLE'
  readonly message: string
}

/**
 * The refusals of requests for one item and colour at one site, in order, each counted against the stock the earlier
 * ones of the batch already took. `holderOf(hideId)` names the demand of the ACTIVE reservation that holds a hide.
 */
export function reserveRefusals(
  stock: readonly StockPart[],
  reservations: readonly HeldReservation[],
  requests: readonly ReserveRequest[],
  holderOf: (reservation: HeldReservation) => string,
): ReserveRefusal[] {
  const refusals: ReserveRefusal[] = []
  const taken: HeldReservation[] = [...reservations]
  for (const request of requests) {
    const quantity = dec(request.baseQuantity)
    const text = (value: Decimal) => `${quantityText(value)} ${request.baseUom}`
    if (request.hideId) {
      const onHand = stock.filter((part) => part.hideId === request.hideId).reduce<Decimal>((sum, part) => sum.plus(dec(part.onHand)), ZERO)
      const holder = taken.find((reservation) => reservation.hideId === request.hideId)
      if (holder) {
        refusals.push({ index: request.index, code: 'HIDE_RESERVED', message: `Hide ${request.hideCode} is reserved already, for ${holderOf(holder)}: release that reservation first.` })
        continue
      }
      if (!onHand.greaterThan(0)) {
        refusals.push({ index: request.index, code: 'HIDE_NOT_IN_STOCK', message: `Hide ${request.hideCode} is not in stock at this site: only a hide in stock is reserved.` })
        continue
      }
    }
    if (request.lotId && request.lotHeld) {
      refusals.push({ index: request.index, code: 'LOT_HELD', message: `Lot ${request.lotCode} is not released: its stock is held, and held stock is not reserved.` })
      continue
    }
    const whole = availabilityOf(stock, taken)
    if (quantity.greaterThan(whole.available)) {
      refusals.push({
        index: request.index,
        code: 'NOT_AVAILABLE',
        message: `${request.label}: ${text(Dec.max(ZERO, whole.available))} available at this site (on hand ${text(whole.onHand)}, held ${text(whole.held)}, reserved ${text(whole.reserved)}); ${text(quantity)} asked.`,
      })
      continue
    }
    if (request.lotId) {
      const lot = availabilityOf(stock, taken, { lotId: request.lotId })
      if (quantity.greaterThan(lot.available)) {
        refusals.push({
          index: request.index,
          code: 'LOT_NOT_AVAILABLE',
          message: `Lot ${request.lotCode}: ${text(Dec.max(ZERO, lot.available))} available (on hand ${text(lot.onHand)}, reserved ${text(lot.reserved)}); ${text(quantity)} asked.`,
        })
        continue
      }
    }
    taken.push({
      id: `request:${request.index}`,
      kind: request.kind,
      lotId: request.lotId,
      hideId: request.hideId,
      quantity: quantityText(quantity),
      issuedQuantity: '0',
      workOrderId: null,
      salesOrderLineId: null,
      demandOpen: true,
    })
  }
  return refusals
}

// ---- issuing against reservations ----------------------------------------------------------------------------------------

/** What an issue names: its lot and hide (or neither), and how much it takes (base unit). */
export interface IssuedStock {
  readonly lotId: string | null
  readonly hideId: string | null
  readonly baseQuantity: DecimalInput
}

/**
 * Why an issue to a demand may not take this stock, or null: a hide another demand holds; more than the stock the other
 * demands leave free, for the item and colour or for the lot. `mine` tells the issuing demand's own reservations.
 */
export function issueConflict(
  stock: readonly StockPart[],
  reservations: readonly HeldReservation[],
  mine: (reservation: HeldReservation) => boolean,
  issue: IssuedStock,
  words: { readonly label: string; readonly baseUom: string; readonly lotCode: string | null; readonly hideCode: string | null; readonly holderOf: (reservation: HeldReservation) => string },
): string | null {
  const others = reservations.filter((reservation) => reservation.demandOpen && !mine(reservation))
  const text = (value: Decimal) => `${quantityText(value)} ${words.baseUom}`
  const quantity = dec(issue.baseQuantity)
  if (issue.hideId) {
    const holder = others.find((reservation) => reservation.hideId === issue.hideId)
    if (holder) return `Hide ${words.hideCode} is reserved for ${words.holderOf(holder)}: issue another hide, or release that reservation first.`
  }
  const holders = (list: readonly HeldReservation[]) => [...new Set(list.map(words.holderOf))].slice(0, 3).join(', ')
  const whole = availabilityOf(stock, reservations, { excluding: mine })
  if (quantity.greaterThan(whole.available)) {
    const free = Dec.max(ZERO, whole.available)
    return `${words.label}: only ${text(free)} is free at this site; the rest is reserved for ${holders(others)}. Issue at most ${text(free)}, or release a reservation first.`
  }
  if (issue.lotId) {
    const lot = availabilityOf(stock, reservations, { lotId: issue.lotId, excluding: mine })
    if (quantity.greaterThan(lot.available)) {
      const free = Dec.max(ZERO, lot.available)
      return `Lot ${words.lotCode}: only ${text(free)} is free; the rest is reserved for ${holders(others.filter((reservation) => reservation.lotId === issue.lotId))}. Take another lot, or release a reservation first.`
    }
  }
  return null
}

/** A reservation after an issue counted against it (or after a reversal gave it back). */
export interface ReservationChange {
  readonly id: string
  readonly issuedQuantity: string
  /** All of it is issued now: ISSUED. */
  readonly issued: boolean
}

/**
 * How an issue counts against the demand's own ACTIVE reservations of its item and colour: the issued hide's HIDE
 * reservation (the hide went whole: all of it is issued), then the AREA or QUANTITY reservations naming the lot, then
 * those of any lot, oldest first, each up to what it still holds. What is left over is free stock the demand took.
 */
export function consumption(mine: readonly (HeldReservation & { readonly createdAt?: string })[], issue: IssuedStock): ReservationChange[] {
  const changes: ReservationChange[] = []
  let left = dec(issue.baseQuantity)
  if (issue.hideId) {
    const own = mine.find((reservation) => reservation.kind === 'HIDE' && reservation.hideId === issue.hideId)
    if (own) return [{ id: own.id, issuedQuantity: quantityText(own.quantity), issued: true }]
  }
  const pool = mine.filter((reservation) => reservation.kind !== 'HIDE')
  const order = [...pool.filter((reservation) => issue.lotId !== null && reservation.lotId === issue.lotId), ...pool.filter((reservation) => reservation.lotId === null)]
  for (const reservation of order) {
    if (!left.greaterThan(0)) break
    const open = openOf(reservation)
    if (!open.greaterThan(0)) continue
    const take = Dec.min(left, open)
    const issued = dec(reservation.issuedQuantity).plus(take)
    changes.push({ id: reservation.id, issuedQuantity: quantityText(issued), issued: issued.greaterThanOrEqualTo(dec(reservation.quantity)) })
    left = left.minus(take)
  }
  return changes
}

/**
 * How the undo or reversal of an issue gives its quantity back to the demand's reservations that are still ACTIVE (an
 * ISSUED one is final): in the reverse order of `consumption` — any lot, then the lot's — up to what each had issued.
 */
export function giveBack(mine: readonly HeldReservation[], reversed: IssuedStock): ReservationChange[] {
  const changes: ReservationChange[] = []
  let left = dec(reversed.baseQuantity)
  const pool = mine.filter((reservation) => reservation.kind !== 'HIDE')
  const order = [...pool.filter((reservation) => reservation.lotId === null).reverse(), ...pool.filter((reservation) => reversed.lotId !== null && reservation.lotId === reversed.lotId).reverse()]
  for (const reservation of order) {
    if (!left.greaterThan(0)) break
    const issuedBefore = dec(reservation.issuedQuantity)
    if (!issuedBefore.greaterThan(0)) continue
    const give = Dec.min(left, issuedBefore)
    changes.push({ id: reservation.id, issuedQuantity: quantityText(issuedBefore.minus(give)), issued: false })
    left = left.minus(give)
  }
  return changes
}

// ---- releasing ---------------------------------------------------------------------------------------------------------

/** A release says why (SCM-210): 1 to 500 characters once trimmed. */
export function releaseReasonProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? '').trim()
  if (!text) return 'A release says why.'
  if (text.length > 500) return 'At most 500 characters.'
  return null
}

/** Why one reservation cannot be released now, or null. */
export function releaseRefusal(reservation: { readonly status: ReservationStatus }, label: string): string | null {
  if (reservation.status === 'RELEASED') return `${label} is released already.`
  if (reservation.status === 'ISSUED') return `${label} is fully issued to its work order: there is nothing left to release.`
  return null
}

// ---- released by the system (B-W2b-15; SCM-211) -------------------------------------------------------------------------

/**
 * A work order whose reservations hold nothing any more: completed, closed or cancelled. The …_followups_stock_w2b_guards
 * reservation trigger lets the system (no person) release the rest of a reservation only then.
 */
export const DONE_WORK_ORDER_STATUSES = ['COMPLETED', 'CLOSED', 'CANCELLED'] as const
export const isDoneWorkOrder = (status: string): boolean => (DONE_WORK_ORDER_STATUSES as readonly string[]).includes(status)

/** At most this many reservations in one system release (the nightly clean-up takes the rest on its next round). */
export const MAX_SYSTEM_RELEASE = 200

/** What a reservation's demand is when the system looks at it: its work order, or its order line and order. */
export type ReservationDemand =
  | { readonly type: 'WorkOrder'; readonly number: string; readonly status: string }
  | { readonly type: 'SalesOrderLine'; readonly number: string; readonly seq: number; readonly orderStatus: string; readonly closedShort: boolean }

/** Is the demand done (the system may release the rest of its reservation)? The trigger's own rule. */
export function demandDone(demand: ReservationDemand): boolean {
  if (demand.type === 'WorkOrder') return isDoneWorkOrder(demand.status)
  return demand.closedShort || !isOpenOrder(demand.orderStatus)
}

/**
 * The reason a system release keeps (Reservation.releaseReason, in English like every stored reason): who released it
 * (the system) and why (the demand is done), so a person reading the reservation later knows it was not a person's act.
 * `by` says which run: the work order's own event, or the nightly clean-up.
 */
export function systemReleaseReason(demand: ReservationDemand, by: 'WORK_ORDER_DONE' | 'NIGHTLY_CLEANUP'): string {
  const what =
    demand.type === 'WorkOrder'
      ? `work order ${demand.number} is ${demand.status.toLowerCase()}`
      : demand.closedShort
        ? `line ${demand.seq} of order ${demand.number} was closed short`
        : `order ${demand.number} is ${demand.orderStatus.toLowerCase().replace(/_/g, ' ')}`
  return by === 'NIGHTLY_CLEANUP' ? `Released by the nightly clean-up: ${what}, so nothing needs it any more.` : `Released by the system: ${what}, so nothing needs the rest any more.`
}
