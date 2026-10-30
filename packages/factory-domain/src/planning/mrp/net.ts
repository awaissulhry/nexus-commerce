import type { Decimal } from 'decimal.js'
import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE, type DecimalInput } from '../../product/units/units'
import type { LotFacts, OpenPurchase, PurchaseLine, StockEntry, StockLine } from '../netting'
import { usabilityOf } from '../usable'

/**
 * MRP every day (B-W2a-22; PLN-071 pegging, PLN-075 firm planned orders, PLN-086 material readiness), pure: one material
 * in one colour netted against its demand PART by part, so every quantity of the result says which supply covers which
 * demand. It extends W1's netting (../netting `netMaterial`) and gives the same numbers when there is no reservation and
 * no firm planned order:
 *
 *   parts         the demand: an order line in one size (a made-to-measure unit: the line), split by the open work
 *                 order that makes it (WORK_ORDER) and the pieces no work order makes yet (ORDER_LINE); each needs its
 *                 quantity less what is already issued to its work order (../explode).
 *   reservations  ACTIVE reservations whose demand is open (B-W2a-11) hold usable stock for ONE work order or order
 *                 line: a lot reservation stock of its lot, an any-lot one stock of the material. What a reservation
 *                 holds covers its own demand's parts first (a work order's own, then its order line's), whatever their
 *                 date; it never covers another demand, and what its demand does not need stays held ("reserved for
 *                 others": not counted).
 *   free stock    usable stock no reservation holds; then open purchase order lines due on or before the part's day
 *                 (earliest first): the demand is walked by day exactly as W1 does.
 *
 *   usable = free stock + what reservations covered,  on order = what purchase lines covered,
 *   net    = max(0, gross − usable − on order)        (the …_supply_guards identity; asserted equal to the walk)
 *
 *   firm          a firm planned order the run carries (PLN-075: fixed by a planner, not planned again) covers what is
 *                 still short, by day; a part it covers after the part's day is covered LATE (the order should come
 *                 earlier); what it cannot cover at all is `uncovered` (pegged PLANNED at the need date; a SHORT
 *                 exception when above 0).
 *
 * Quantities in the item's base unit, four decimals, exact. A part without a date is needed on the run's day.
 */

const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const min = (a: Decimal, b: Decimal): Decimal => (a.lt(b) ? a : b)
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** One part of the demand on a material (./plan, ../explode). */
export interface DemandPart {
  /** Unique in the material: `<orderLineId>|<size>|<workOrderId or ->`. */
  readonly key: string
  readonly orderId: string
  readonly orderNumber: string
  readonly orderLineId: string
  readonly lineSeq: number
  /** The order line's party (the pegging's key to the line). */
  readonly partyId: string | null
  /** The size of a size grid; null for a made-to-measure unit. */
  readonly size: string | null
  /** The open work order that makes these pieces; null: no work order yet. */
  readonly workOrderId: string | null
  readonly workOrderNumber: string | null
  readonly pieces: number
  readonly dueDate: BusinessDate | null
  /** What the pieces take, base unit, four decimals. */
  readonly quantity: string
  /** Of it, already issued to the work order. */
  readonly issued: string
}

/** An ACTIVE reservation of the material (B-W2a-11), as netting reads it. */
export interface PlanReservation {
  readonly id: string
  readonly itemId: string
  readonly itemColourId: string | null
  /** A lot (and hide) reservation holds stock of that lot; null: any lot. */
  readonly lotId: string | null
  readonly hideId: string | null
  /** What it still holds: quantity less issued (base unit). */
  readonly open: DecimalInput
  readonly workOrderId: string | null
  readonly salesOrderLineId: string | null
  /** Its work order or order is still open (only then does it hold stock). */
  readonly demandOpen: boolean
}

/** A firm planned order of an earlier run that this run carries (MaterialRequirement's firm columns). */
export interface FirmSupply {
  /** The firm line of the earlier run. */
  readonly requirementId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly action: 'BUY' | 'MAKE'
  /** In the line's suggested unit, and in the base unit. */
  readonly quantity: string
  readonly uom: string
  readonly baseQuantity: string
  readonly date: BusinessDate
  readonly supplierId: string | null
  readonly firmedAt: Date
  readonly firmedById: string | null
}

export const SUPPLY_KINDS = ['ISSUED', 'RESERVATION', 'STOCK', 'PURCHASE_ORDER', 'FIRM', 'PLANNED'] as const
export type SupplyKind = (typeof SUPPLY_KINDS)[number]

/** One supply of one part. ISSUED is already at its work order (never pegged); PLANNED is what the plan suggests. */
export interface PartSupply {
  readonly kind: SupplyKind
  readonly quantity: string
  readonly reservationId?: string
  readonly purchaseOrderLineId?: string
  /** PURCHASE_ORDER: the line's due day; FIRM: the firm date. */
  readonly date?: BusinessDate
  /** FIRM after the part's day. */
  readonly late?: boolean
}

export interface PartCoverage {
  readonly part: DemandPart
  /** The day the netting needs it on (the part's date, else the run's day). */
  readonly day: BusinessDate
  readonly supplies: readonly PartSupply[]
  /** Short after stock, reservations and purchase orders (the identity's share). */
  readonly short: string
  /** Still short after the firm planned order: what the suggestion has to bring. */
  readonly uncovered: string
}

export interface ReservationUse {
  readonly id: string
  /** What it still holds (quantity less issued). */
  readonly open: string
  /** What usable stock backs of its open quantity (a reservation of stock that is gone, or held, backs less). */
  readonly backed: string
  /** What the plan's parts took of it. */
  readonly used: string
  /** Its demand is in the plan (an open work order or order line the run plans). */
  readonly forPlan: boolean
}

export interface FirmUse {
  readonly requirementId: string
  readonly baseQuantity: string
  readonly date: BusinessDate
  /** Taken by parts on or after the firm date. */
  readonly inTime: string
  /** Taken by parts needed BEFORE the firm date. */
  readonly late: string
  /** The earliest day a part it covers late is needed. */
  readonly firstLateDay: BusinessDate | null
  /** Not needed by any part. */
  readonly unused: string
}

export interface MaterialPegging {
  readonly gross: string
  readonly usable: string
  readonly held: string
  readonly onOrder: string
  readonly net: string
  /** The day the first part is short, else the first part's day; the run's day without demand. */
  readonly needDate: BusinessDate
  /** Still short after the firm planned order (what the suggestion brings). */
  readonly uncovered: string
  readonly stock: readonly StockLine[]
  readonly purchases: readonly PurchaseLine[]
  readonly reservations: readonly ReservationUse[]
  /** Usable stock held by reservations the plan's parts did not take (another demand's, or more than its demand needs). */
  readonly reservedForOthers: string
  readonly firm: FirmUse | null
  /** By day, as walked. */
  readonly coverage: readonly PartCoverage[]
}

const dayOf = (part: DemandPart, runDate: BusinessDate): BusinessDate => part.dueDate ?? runDate

/** Nets one material in one colour (`itemColourId`; null: a material without colours), part by part. */
export function pegMaterial(input: {
  readonly itemColourId: string | null
  readonly parts: readonly DemandPart[]
  readonly stock: readonly StockEntry[]
  readonly lotOf: (lotId: string) => LotFacts | undefined
  readonly reservations?: readonly PlanReservation[]
  readonly purchases: readonly OpenPurchase[]
  readonly firm?: Pick<FirmSupply, 'requirementId' | 'baseQuantity' | 'date'> | null
  readonly runDate: BusinessDate
}): MaterialPegging {
  const { runDate } = input
  // ---- stock: usable, held, not counted (W1's rules) ------------------------------------------------------------------
  const stock: StockLine[] = input.stock
    .filter((entry) => decimalOf(entry.quantity).gt(0))
    .map((entry) => {
      if (entry.itemColourId !== input.itemColourId) return { entry, notCounted: 'OTHER_COLOUR' as const, held: false }
      const usability = usabilityOf(entry.lotId ? (input.lotOf(entry.lotId) ?? { qualityStatus: 'QUARANTINE', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' }) : null)
      return usability.usable ? { entry, notCounted: null, held: false } : { entry, notCounted: usability.reason, held: usability.held }
    })
  const usableLines = stock.filter((line) => line.notCounted === null)
  const usableTotal = usableLines.reduce((sum, line) => sum.plus(decimalOf(line.entry.quantity)), ZERO)
  const held = stock.filter((line) => line.held).reduce((sum, line) => sum.plus(decimalOf(line.entry.quantity)), ZERO)
  const usableOfLot = new Map<string, Decimal>()
  for (const line of usableLines) if (line.entry.lotId) usableOfLot.set(line.entry.lotId, (usableOfLot.get(line.entry.lotId) ?? ZERO).plus(decimalOf(line.entry.quantity)))

  // ---- reservations: what usable stock backs, lot reservations first -------------------------------------------------
  const reservations = (input.reservations ?? [])
    .filter((reservation) => reservation.demandOpen && reservation.itemColourId === input.itemColourId && decimalOf(reservation.open).gt(0))
    .sort((a, b) => (a.lotId === null) !== (b.lotId === null) ? (a.lotId === null ? 1 : -1) : compare(a.id, b.id))
  let freeLeft = usableTotal
  const lotLeft = new Map(usableOfLot)
  const backing = new Map<string, { reservation: PlanReservation; left: Decimal; backed: Decimal; used: Decimal }>()
  for (const reservation of reservations) {
    const room = reservation.lotId === null ? freeLeft : min(freeLeft, lotLeft.get(reservation.lotId) ?? ZERO)
    const backed = min(decimalOf(reservation.open), room)
    freeLeft = freeLeft.minus(backed)
    if (reservation.lotId !== null) lotLeft.set(reservation.lotId, (lotLeft.get(reservation.lotId) ?? ZERO).minus(backed))
    backing.set(reservation.id, { reservation, left: backed, backed, used: ZERO })
  }

  // ---- the parts, by day -------------------------------------------------------------------------------------------------
  // Every part is answered (one fully issued too: readiness says so); only those still needing something are walked.
  const all = input.parts
    .map((part, index) => ({ part, index, day: dayOf(part, runDate), need: decimalOf(part.quantity).minus(decimalOf(part.issued)), supplies: [] as PartSupply[] }))
    .sort((a, b) => compare(a.day, b.day) || a.index - b.index)
  const parts = all.filter((entry) => entry.need.gt(0))
  const gross = parts.reduce((sum, entry) => sum.plus(entry.need), ZERO)
  const planDemands = new Set(parts.flatMap((entry) => [entry.part.workOrderId ? `WO|${entry.part.workOrderId}` : null, `OL|${entry.part.orderLineId}`].filter((key): key is string => key !== null)))

  // Pass 1: each part takes what its own reservations hold (its work order's, then its order line's).
  let reservedUsed = ZERO
  for (const entry of parts) {
    const own = [...backing.values()].filter(
      (held) => (held.reservation.workOrderId !== null && held.reservation.workOrderId === entry.part.workOrderId) || (held.reservation.workOrderId === null && held.reservation.salesOrderLineId === entry.part.orderLineId),
    )
    own.sort((a, b) => (a.reservation.workOrderId === null ? 1 : 0) - (b.reservation.workOrderId === null ? 1 : 0) || compare(a.reservation.id, b.reservation.id))
    for (const held of own) {
      if (entry.need.isZero()) break
      const take = min(held.left, entry.need)
      if (take.lte(0)) continue
      held.left = held.left.minus(take)
      held.used = held.used.plus(take)
      entry.need = entry.need.minus(take)
      reservedUsed = reservedUsed.plus(take)
      entry.supplies.push({ kind: 'RESERVATION', quantity: q(take), reservationId: held.reservation.id })
    }
  }

  // Pass 2: free stock first, then purchase lines due on or before the part's day (W1's walk).
  const lines = input.purchases
    .map((line, index) => ({ line, left: decimalOf(line.openQuantity), index }))
    .filter((entry) => entry.left.gt(0))
    .sort((a, b) => compare(a.line.dueDate, b.line.dueDate) || compare(a.line.purchaseOrderNumber, b.line.purchaseOrderNumber) || a.index - b.index)
  const opened = new Map(lines.map((entry) => [entry, entry.left]))
  let stockLeft = freeLeft
  let short = ZERO
  let firstShort: BusinessDate | null = null
  const shortOf = new Map<(typeof parts)[number], Decimal>()
  for (const entry of parts) {
    const fromStock = min(stockLeft, entry.need)
    if (fromStock.gt(0)) {
      stockLeft = stockLeft.minus(fromStock)
      entry.need = entry.need.minus(fromStock)
      entry.supplies.push({ kind: 'STOCK', quantity: q(fromStock) })
    }
    for (const line of lines) {
      if (entry.need.isZero()) break
      if (line.line.dueDate > entry.day || line.left.isZero()) continue
      const take = min(line.left, entry.need)
      line.left = line.left.minus(take)
      entry.need = entry.need.minus(take)
      entry.supplies.push({ kind: 'PURCHASE_ORDER', quantity: q(take), purchaseOrderLineId: line.line.purchaseOrderLineId, date: line.line.dueDate })
    }
    shortOf.set(entry, entry.need)
    if (entry.need.gt(0)) {
      short = short.plus(entry.need)
      firstShort ??= entry.day
    }
  }
  const onOrder = lines.reduce((sum, entry) => sum.plus(opened.get(entry)!.minus(entry.left)), ZERO)
  // usable = all free stock + what reservations covered (free stock left over means nothing is short).
  const usableCounted = freeLeft.plus(reservedUsed)
  const formula = gross.minus(usableCounted).minus(onOrder)
  const net = formula.isNegative() ? ZERO : formula
  // The walk and the trigger's identity agree by construction; a difference is a bug, never a plan.
  if (!net.eq(short)) throw new Error(`netting walk ${q(short)} differs from max(0, gross - usable - on order) ${q(net)}`)

  // ---- the firm planned order covers what is short, by day ---------------------------------------------------------------
  let firm: FirmUse | null = null
  if (input.firm) {
    let left = decimalOf(input.firm.baseQuantity)
    let inTime = ZERO
    let late = ZERO
    let firstLateDay: BusinessDate | null = null
    for (const entry of parts) {
      if (left.isZero()) break
      if (entry.need.isZero()) continue
      const take = min(left, entry.need)
      left = left.minus(take)
      entry.need = entry.need.minus(take)
      const isLate = input.firm.date > entry.day
      if (isLate) {
        late = late.plus(take)
        firstLateDay ??= entry.day
      } else inTime = inTime.plus(take)
      entry.supplies.push({ kind: 'FIRM', quantity: q(take), date: input.firm.date, late: isLate })
    }
    firm = { requirementId: input.firm.requirementId, baseQuantity: q(decimalOf(input.firm.baseQuantity)), date: input.firm.date, inTime: q(inTime), late: q(late), firstLateDay, unused: q(left) }
  }
  const uncovered = parts.reduce((sum, entry) => sum.plus(entry.need), ZERO)
  for (const entry of parts) if (entry.need.gt(0)) entry.supplies.push({ kind: 'PLANNED', quantity: q(entry.need) })

  const purchases: PurchaseLine[] = lines.map((entry) => {
    const open = opened.get(entry)!
    const counted = open.minus(entry.left)
    return { line: entry.line, counted: q(counted), notCounted: q(entry.left), why: entry.left.isZero() ? null : net.gt(0) ? 'TOO_LATE' : 'NOT_NEEDED' }
  })
  const uses: ReservationUse[] = [...backing.values()].map((held) => ({
    id: held.reservation.id,
    open: q(decimalOf(held.reservation.open)),
    backed: q(held.backed),
    used: q(held.used),
    forPlan: (held.reservation.workOrderId !== null && planDemands.has(`WO|${held.reservation.workOrderId}`)) || (held.reservation.salesOrderLineId !== null && planDemands.has(`OL|${held.reservation.salesOrderLineId}`)),
  }))
  const reservedForOthers = [...backing.values()].reduce((sum, held) => sum.plus(held.left), ZERO)
  return {
    gross: q(gross),
    usable: q(usableCounted),
    held: q(held),
    onOrder: q(onOrder),
    net: q(net),
    needDate: firstShort ?? parts[0]?.day ?? runDate,
    uncovered: q(uncovered),
    stock,
    purchases,
    reservations: uses,
    reservedForOthers: q(reservedForOthers),
    firm,
    coverage: all.map((entry) => ({ part: entry.part, day: entry.day, supplies: entry.supplies, short: q(shortOf.get(entry) ?? ZERO), uncovered: q(entry.need.gt(0) ? entry.need : ZERO) })),
  }
}

/** Issued material of a part, for readiness (never pegged: it left stock for its work order). */
export const issuedSupply = (part: DemandPart): PartSupply | null => (decimalOf(part.issued).gt(0) ? { kind: 'ISSUED', quantity: q(decimalOf(part.issued)) } : null)
