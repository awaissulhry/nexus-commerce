import type { Issue } from '../../core/errors'
import { formatScanId, parseScanId, tenantTag } from '../../numbering/scan-id'
import { dimensionOf, UNITS, type Uom } from '../../product/units/units'
import { STATUS_WORDS, type PurchaseOrderStatus } from '../../purchasing/orders'
import { Dec, HUNDRED, parseDecimal, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { COST_SCALE } from '../ledger/valuation'
import { QUANTITY_SCALE, type ItemTracking } from '../ledger/moves'

/**
 * Goods receipts against a purchase order (B-W1-32; SCM-113, SCM-116, SCM-117, SCM-121, SCM-187, SCM-232, SCM-233,
 * SCM-247, QHS-030, QHS-073; A1 §2.5 "Lot"; PLAN §4.7 stages 09a-receive and 09b-cr6), pure. apps/factory-api's
 * modules/inventory/receipts reads the facts and writes through command() and the ledger's postMoves; the
 * …_supply_guards triggers hold the states for every login.
 *
 *   receive    against a SENT, CONFIRMED or PARTLY_RECEIVED order, at its delivery site: per order line what came (a
 *              lot-tracked material in lots, leather in lots of hides one by one with each hide's measured area, an
 *              untracked one as a quantity), into one location of the site. Each hide and lot is one RECEIPT move,
 *              valued at the order line's price per base unit (the cost grain).
 *   difference what the order line expects (the supplier's confirmed quantity, else the ordered one) against what came
 *              before plus now, in the base unit: within the line's tolerance (leather: the area tolerance %, else
 *              none) the line counts as received; short leaves the line open (a partial delivery, said in words);
 *              beyond the tolerance over it needs the receiver's reason.
 *   order      PARTLY_RECEIVED while a line is still open, RECEIVED when every line is received; a reversed receipt
 *              moves it back (to CONFIRMED or SENT when nothing is received any more).
 *   lot        QUARANTINE when it needs the chromium VI test (REACH Annex XVII entry 47: RELEASED only with a PASS,
 *              B-W1-34), when it is a certified PPE component (its certificate is checked before release, QHS-030),
 *              or when the receiver holds it (a reason); else RELEASED at receipt. Only RELEASED stock is usable.
 *   hide       its own tag (a HIDE scan id of the tenant), the tannery's number, the measured area in m², dm² or ft²
 *              (and in the base unit), grade, shade, thickness and defects; the lot's stock is the sum of its hides.
 *   reverse    only while the receipt's stock is untouched: one mirror move per receipt move; refused, in words, when
 *              some of it was issued to a work order, moved, scrapped or corrected (what to do first). Its lots become
 *              REJECTED; the order's progress is read again.
 */

export const GOODS_RECEIPT_STATUSES = ['OPEN', 'POSTED', 'REVERSED', 'CANCELLED'] as const
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number]

/** The order states goods are received against (the …_supply_guards GoodsReceipt trigger says so too). */
export const RECEIVING_ORDER_STATUSES: readonly PurchaseOrderStatus[] = Object.freeze(['SENT', 'CONFIRMED', 'PARTLY_RECEIVED'])

/** How much one receipt may hold: its moves are posted in one batch (postMoves takes at most 500). */
export const RECEIPT_LIMITS = Object.freeze({ lines: 100, lotsPerLine: 50, hidesPerLot: 500, moves: 500, text: 500, code: 60 })

const plain = (value: DecimalInput): string => new Dec(value).toDecimalPlaces(QUANTITY_SCALE).toString()
const unitText = (uom: Uom): string => UNITS[uom].symbol
const quantityText = (value: DecimalInput): string => new Dec(value).toFixed(QUANTITY_SCALE)

// ---- the order ---------------------------------------------------------------------------------------------------------------

/** Why goods cannot be received against the order now, or null. */
export function receivingProblem(status: PurchaseOrderStatus): string | null {
  if (RECEIVING_ORDER_STATUSES.includes(status)) return null
  switch (status) {
    case 'DRAFT':
      return 'The order is a draft: it was never sent, so no goods are received against it. Send it first.'
    case 'DECLINED':
      return 'The supplier declined the order: change it and send it again, or cancel it.'
    case 'RECEIVED':
      return 'The order is received in full: record extra goods against a new order (or reverse a wrong receipt first).'
    default:
      return `The order is ${STATUS_WORDS[status]}: no goods are received against it.`
  }
}

/** What an order line expects, in the base unit: the supplier's confirmed quantity (at the line's ratio, rounded down) when it gave one, else the ordered quantity. */
export function expectedBaseOf(line: { readonly quantity: DecimalInput; readonly baseQuantity: DecimalInput; readonly confirmedQuantity: DecimalInput | null }): Decimal {
  const base = new Dec(line.baseQuantity)
  if (line.confirmedQuantity === null) return base
  const quantity = new Dec(line.quantity)
  if (quantity.isZero()) return base
  return new Dec(line.confirmedQuantity).times(base).dividedBy(quantity).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_DOWN)
}

/** The line's tolerance in percent (leather's area tolerance; none: 0). */
const toleranceOf = (pct: DecimalInput | null | undefined): Decimal => {
  const parsed = pct === null || pct === undefined ? null : parseDecimal(pct)
  return parsed === null || parsed.isNegative() ? ZERO : parsed
}

export const DIFFERENCES = ['EXACT', 'WITHIN_TOLERANCE', 'SHORT', 'OVER'] as const
export type Difference = (typeof DIFFERENCES)[number]

export interface LineDifference {
  readonly expected: string
  readonly receivedBefore: string
  readonly receiving: string
  readonly after: string
  /** What is still open after this receipt (0 when the line is received). */
  readonly open: string
  /** after − expected: + over, − short. */
  readonly difference: string
  readonly tolerancePct: string
  /** The most the line may bring without a reason (expected + tolerance). */
  readonly upTo: string
  readonly kind: Difference
  /** The line counts as received (within the tolerance below, or more). */
  readonly complete: boolean
}

/** One order line after a receipt: received before + now against what it expects, with its tolerance either way. */
export function lineDifference(facts: { readonly expected: DecimalInput; readonly receivedBefore: DecimalInput; readonly receiving: DecimalInput; readonly tolerancePct?: DecimalInput | null }): LineDifference {
  const expected = new Dec(facts.expected)
  const before = new Dec(facts.receivedBefore)
  const after = before.plus(facts.receiving)
  const tolerance = toleranceOf(facts.tolerancePct)
  const upTo = expected.times(HUNDRED.plus(tolerance)).dividedBy(HUNDRED)
  const atLeast = expected.times(HUNDRED.minus(tolerance)).dividedBy(HUNDRED)
  const kind: Difference = after.equals(expected) ? 'EXACT' : after.greaterThan(upTo) ? 'OVER' : after.lessThan(atLeast) ? 'SHORT' : 'WITHIN_TOLERANCE'
  const open = Dec.max(ZERO, expected.minus(after))
  return {
    expected: quantityText(expected),
    receivedBefore: quantityText(before),
    receiving: quantityText(facts.receiving),
    after: quantityText(after),
    open: kind === 'SHORT' ? quantityText(open) : quantityText(ZERO),
    difference: quantityText(after.minus(expected)),
    tolerancePct: tolerance.toString(),
    upTo: quantityText(upTo.toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_DOWN)),
    kind,
    complete: kind !== 'SHORT',
  }
}

/** The words of a line's difference, for the receipt's notes (and the refusal of an over-delivery without a reason). */
export function differenceWords(label: string, line: LineDifference, baseUom: Uom): string {
  const u = unitText(baseUom)
  const tolerance = new Dec(line.tolerancePct).isZero() ? 'no tolerance' : `tolerance ${line.tolerancePct}%`
  switch (line.kind) {
    case 'EXACT':
      return `${label}: ${plain(line.after)} ${u} received, as expected.`
    case 'WITHIN_TOLERANCE':
      return `${label}: ${plain(line.after)} ${u} received of ${plain(line.expected)} ${u} expected (${tolerance}): the line is received.`
    case 'SHORT':
      return `${label}: ${plain(line.after)} ${u} received of ${plain(line.expected)} ${u} expected; ${plain(line.open)} ${u} still open (the order waits for it).`
    case 'OVER':
      return `${label}: ${plain(line.after)} ${u} received of ${plain(line.expected)} ${u} expected (${tolerance}: at most ${plain(line.upTo)} ${u}); ${plain(line.difference)} ${u} more than expected.`
  }
}

/** The order's state after its receipts: PARTLY_RECEIVED while a line is open, RECEIVED when none is; back to CONFIRMED or SENT when nothing is received. A closed or cancelled order keeps its state. */
export function orderStatusAfter(
  order: { readonly status: PurchaseOrderStatus; readonly confirmed: boolean },
  lines: readonly { readonly expected: DecimalInput; readonly received: DecimalInput; readonly tolerancePct?: DecimalInput | null }[],
): PurchaseOrderStatus {
  if (!['SENT', 'CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(order.status)) return order.status
  const anything = lines.some((line) => new Dec(line.received).greaterThan(0))
  if (!anything) return order.confirmed ? 'CONFIRMED' : 'SENT'
  const complete = lines.every((line) => lineDifference({ expected: line.expected, receivedBefore: line.received, receiving: '0', tolerancePct: line.tolerancePct ?? null }).complete)
  return complete ? 'RECEIVED' : 'PARTLY_RECEIVED'
}

/** The cost of one base unit at the order line's price: unit price × quantity ÷ base quantity (six decimals, half up). */
export function unitCostPerBase(line: { readonly unitPrice: DecimalInput; readonly quantity: DecimalInput; readonly baseQuantity: DecimalInput }): string {
  const base = new Dec(line.baseQuantity)
  if (base.lessThanOrEqualTo(0)) throw new RangeError('an order line has a base quantity above 0')
  return new Dec(line.unitPrice).times(line.quantity).dividedBy(base).toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP).toFixed(COST_SCALE)
}

// ---- the lot ----------------------------------------------------------------------------------------------------------------

/** Why a lot starts in quarantine. */
export const HOLD_REASONS = ['CR_VI_TEST', 'PPE_CERTIFICATE', 'QUALITY_HOLD'] as const
export type HoldReason = (typeof HOLD_REASONS)[number]

export const HOLD_WORDS: Readonly<Record<HoldReason, string>> = Object.freeze({
  CR_VI_TEST: 'waits for its chromium VI result (REACH Annex XVII entry 47): released only with a PASS',
  PPE_CERTIFICATE: 'a certified PPE component: its certificate is checked before release',
  QUALITY_HOLD: 'held at receipt for a quality check',
})

/** The Cr VI limit when the item names none: the legal one, mg/kg (REACH Annex XVII entry 47). */
export const LEGAL_CR_VI_LIMIT = '3.000'

export interface LotStart {
  readonly qualityStatus: 'QUARANTINE' | 'RELEASED'
  readonly requiresCrViTest: boolean
  /** Set exactly when the test is required. */
  readonly crViLimitMgKg: string | null
  readonly crViStatus: 'NOT_REQUIRED' | 'PENDING'
  readonly holds: readonly HoldReason[]
}

/**
 * How a received lot starts: it needs the Cr VI test when its item or its order line does (the item's limit, else the
 * legal 3 mg/kg); in QUARANTINE when it needs the test, is a certified PPE component, or the receiver holds it; else
 * RELEASED at receipt.
 */
export function lotStart(facts: {
  readonly itemRequiresCrViTest: boolean
  readonly itemCrViLimitMgKg: DecimalInput | null
  readonly lineRequiresCrViTest: boolean
  readonly isPpeComponent: boolean
  readonly holdReason?: string | null
}): LotStart {
  const requiresCrViTest = facts.itemRequiresCrViTest || facts.lineRequiresCrViTest
  const holds: HoldReason[] = []
  if (requiresCrViTest) holds.push('CR_VI_TEST')
  if (facts.isPpeComponent) holds.push('PPE_CERTIFICATE')
  if ((facts.holdReason ?? '').trim()) holds.push('QUALITY_HOLD')
  return {
    qualityStatus: holds.length > 0 ? 'QUARANTINE' : 'RELEASED',
    requiresCrViTest,
    crViLimitMgKg: requiresCrViTest ? new Dec(facts.itemCrViLimitMgKg ?? LEGAL_CR_VI_LIMIT).toFixed(3) : null,
    crViStatus: requiresCrViTest ? 'PENDING' : 'NOT_REQUIRED',
    holds,
  }
}

/** A lot's state in words: "In quarantine: waits for its chromium VI result …; held at receipt …". */
export function lotStateWords(lot: { readonly qualityStatus: string; readonly requiresCrViTest: boolean; readonly crViStatus: string; readonly crViLimitMgKg: string | null; readonly holdNote?: string | null; readonly isPpeComponent?: boolean }): string {
  switch (lot.qualityStatus) {
    case 'RELEASED':
      return 'Released: usable stock.'
    case 'REJECTED':
      return 'Rejected: never used.'
    case 'BLOCKED':
      return 'Blocked after its release: not usable until the quality step releases it again.'
    default: {
      const why: string[] = []
      if (lot.requiresCrViTest && lot.crViStatus !== 'PASS') {
        why.push(lot.crViStatus === 'FAIL' ? 'its chromium VI result failed' : `${HOLD_WORDS.CR_VI_TEST} (limit ${lot.crViLimitMgKg ?? LEGAL_CR_VI_LIMIT} mg/kg)`)
      }
      if (lot.isPpeComponent) why.push(HOLD_WORDS.PPE_CERTIFICATE)
      if (lot.holdNote) why.push(`held at receipt: ${lot.holdNote}`)
      return `In quarantine: ${why.length > 0 ? why.join('; ') : 'waits for the quality step'}. Not usable until released.`
    }
  }
}

// ---- hides ------------------------------------------------------------------------------------------------------------------

/** A hide's thickness, mm: Decimal(6,2) in the database; leather is a few millimetres. */
export const MAX_THICKNESS_MM = '99.99'

/** The units a hide is measured in. */
export const HIDE_AREA_UNITS: readonly Uom[] = Object.freeze(['M2', 'DM2', 'FT2'])

/** The tags of a tenant's hides start with this (`HD-<tenant tag>-`): a HIDE scan id (numbering/scan-id). */
export const hideTagPrefix = (tenantId: string): string => `HD-${tenantTag(tenantId)}-`

/**
 * The next `count` hide tags of a tenant after its last one (the highest reference among its tags; null: none yet).
 * Each is a HIDE scan id: printed on the hide's tag (B-W1-33) and scanned at picking and cutting.
 */
export function nextHideTags(tenantId: string, lastTag: string | null, count: number): string[] {
  const tag = tenantTag(tenantId)
  let ref = 0
  if (lastTag !== null) {
    const parsed = parseScanId(lastTag, { types: ['HIDE'], tenantTag: tag })
    if (parsed.ok) ref = parsed.ref
  }
  return Array.from({ length: count }, (_, index) => formatScanId({ type: 'HIDE', tenantTag: tag, ref: ref + index + 1 }))
}

// ---- what a receipt line sends ---------------------------------------------------------------------------------------------------

export interface HideInput {
  readonly area: string
  readonly areaUom?: Uom | undefined
  readonly thicknessMm?: string | null | undefined
}
export interface LotInput {
  readonly quantity?: string | undefined
  readonly baseQuantity?: string | undefined
  readonly hides?: readonly HideInput[] | undefined
}
export interface LineInput {
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  readonly lots?: readonly LotInput[] | undefined
}

const positiveProblem = (value: string | undefined, path: string, scale = QUANTITY_SCALE): Issue | null => {
  if (value === undefined) return null
  const parsed = parseDecimal(value)
  if (parsed === null) return { path, message: 'Expected a plain decimal such as 12.5.' }
  if (parsed.lessThanOrEqualTo(0)) return { path, message: 'Above 0.' }
  if (parsed.decimalPlaces() > scale) return { path, message: `At most ${scale} decimals.` }
  return null
}

/**
 * What a receipt line must send for its material's tracking (paths relative to the line): leather (HIDE) lots of hides
 * one by one, each with its measured area in m², dm² or ft² (the line's quantity is their sum); a lot-tracked material
 * its lots, each with its quantity in the line's unit (the line's quantity is their sum); an untracked one its quantity
 * and no lot.
 */
export function lineShapeProblems(line: LineInput, tracking: ItemTracking, itemCode: string): Issue[] {
  const problems: Issue[] = []
  const lots = line.lots ?? []
  const add = (issue: Issue | null) => {
    if (issue) problems.push(issue)
  }
  if (tracking === 'HIDE' || tracking === 'LOT') {
    if (line.quantity !== undefined || line.baseQuantity !== undefined) {
      problems.push({ path: 'quantity', message: `${itemCode} is received ${tracking === 'HIDE' ? 'hide by hide: the hides\' areas add up' : 'by lot: the lots\' quantities add up'} to the line; leave the line's quantity out.` })
    }
    if (lots.length === 0) problems.push({ path: 'lots', message: `${itemCode} is tracked by ${tracking}: name at least one lot (a dye batch, a roll batch).` })
    if (lots.length > RECEIPT_LIMITS.lotsPerLine) problems.push({ path: 'lots', message: `At most ${RECEIPT_LIMITS.lotsPerLine} lots on a line.` })
    lots.forEach((lot, index) => {
      const at = `lots/${index}`
      if (tracking === 'HIDE') {
        if (line.uom !== undefined) problems.push({ path: 'uom', message: 'Leather is counted in the unit each hide is measured in: leave the line\'s unit out.' })
        if (lot.quantity !== undefined || lot.baseQuantity !== undefined) problems.push({ path: `${at}/quantity`, message: 'A lot of hides is the sum of its hides: leave its quantity out.' })
        const hides = lot.hides ?? []
        if (hides.length === 0) problems.push({ path: `${at}/hides`, message: 'Receive the hides one by one, each with its measured area.' })
        if (hides.length > RECEIPT_LIMITS.hidesPerLot) problems.push({ path: `${at}/hides`, message: `At most ${RECEIPT_LIMITS.hidesPerLot} hides in a lot.` })
        hides.forEach((hide, hideIndex) => {
          add(positiveProblem(hide.area, `${at}/hides/${hideIndex}/area`))
          if (hide.areaUom !== undefined && !HIDE_AREA_UNITS.includes(hide.areaUom)) problems.push({ path: `${at}/hides/${hideIndex}/areaUom`, message: 'A hide is measured in m², dm² or ft².' })
          const thickness = positiveProblem(hide.thicknessMm ?? undefined, `${at}/hides/${hideIndex}/thicknessMm`, 2)
          add(thickness)
          if (!thickness && hide.thicknessMm && new Dec(hide.thicknessMm).greaterThan(MAX_THICKNESS_MM)) problems.push({ path: `${at}/hides/${hideIndex}/thicknessMm`, message: `At most ${MAX_THICKNESS_MM} mm.` })
        })
      } else {
        if ((lot.hides ?? []).length > 0) problems.push({ path: `${at}/hides`, message: `${itemCode} has no hides: it is counted by lot.` })
        if (lot.quantity === undefined) problems.push({ path: `${at}/quantity`, message: 'How much came in this lot (in the line\'s unit)?' })
        add(positiveProblem(lot.quantity, `${at}/quantity`))
        add(positiveProblem(lot.baseQuantity, `${at}/baseQuantity`))
      }
    })
  } else {
    if (lots.length > 0) problems.push({ path: 'lots', message: `${itemCode} is not tracked by lot: send the line's quantity, no lots.` })
    if (line.quantity === undefined) problems.push({ path: 'quantity', message: 'How much came?' })
    add(positiveProblem(line.quantity, 'quantity'))
    add(positiveProblem(line.baseQuantity, 'baseQuantity'))
  }
  return problems
}

/** The unit a hide is measured in when the request names none: the line's area unit, else the order line's, else the item's base unit. */
export function hideAreaUnit(hide: { readonly areaUom?: Uom | undefined }, orderLineUom: Uom, baseUom: Uom): Uom {
  if (hide.areaUom) return hide.areaUom
  if (HIDE_AREA_UNITS.includes(orderLineUom)) return orderLineUom
  return baseUom
}

/** A leather line's unit: the one its hides share (Q13: one unit end to end), else the item's base unit. */
export function hideLineUnit(units: readonly Uom[], baseUom: Uom): Uom {
  const distinct = [...new Set(units)]
  return distinct.length === 1 ? distinct[0]! : baseUom
}

/** Whether a unit measures area (a hide's unit must). */
export const isAreaUnit = (uom: Uom): boolean => dimensionOf(uom) === 'AREA'

// ---- notes on a receipt (never blocking) -------------------------------------------------------------------------------------

export const RECEIPT_NOTE_CODES = ['SHORT', 'WITHIN_TOLERANCE', 'OVER', 'HIDE_COUNT', 'ONE_DYE_BATCH', 'THICKNESS', 'NO_SUPPLIER_DDT', 'NOT_AT_ORDER_PRICE', 'QUARANTINE'] as const
export type ReceiptNoteCode = (typeof RECEIPT_NOTE_CODES)[number]
export interface ReceiptNote {
  readonly code: ReceiptNoteCode
  /** The receipt line's seq (null: the receipt). */
  readonly seq: number | null
  readonly message: string
}

/** The hides that came against about how many the order line expected (an estimate: a note, never a block). */
export function hideCountNote(label: string, received: number, estimatedOpen: number | null): string | null {
  if (estimatedOpen === null || estimatedOpen <= 0 || received === estimatedOpen) return null
  return `${label}: ${received} hide${received === 1 ? '' : 's'} came; about ${estimatedOpen} were expected.`
}

/** A line bought from one dye batch (one shade) that came in several. */
export function dyeBatchNote(label: string, oneDyeBatch: boolean, batches: readonly (string | null)[]): string | null {
  if (!oneDyeBatch) return null
  const distinct = [...new Set(batches.map((batch) => batch?.trim() || null).filter((batch): batch is string => batch !== null))]
  return distinct.length > 1 ? `${label}: the order asked one dye batch; ${distinct.length} came (${distinct.join(', ')}). Keep the shades apart when cutting.` : null
}

/** Hides outside the thickness range the order line asked for. */
export function thicknessNote(label: string, range: { readonly min: DecimalInput | null; readonly max: DecimalInput | null }, hides: readonly { readonly code: string; readonly thicknessMm: DecimalInput | null }[]): string | null {
  const outside = hides.filter((hide) => {
    if (hide.thicknessMm === null) return false
    const value = new Dec(hide.thicknessMm)
    return (range.min !== null && value.lessThan(range.min)) || (range.max !== null && value.greaterThan(range.max))
  })
  if (outside.length === 0) return null
  return `${label}: ${outside.length} hide${outside.length === 1 ? '' : 's'} outside the ${range.min ?? '…'}–${range.max ?? '…'} mm asked (${outside.map((hide) => hide.code).join(', ')}).`
}

// ---- reversing a receipt ------------------------------------------------------------------------------------------------------

export const REVERSAL_BLOCKERS = ['ISSUED', 'MOVED', 'LEFT_STOCK', 'ADDED'] as const
export type ReversalBlockerCode = (typeof REVERSAL_BLOCKERS)[number]

/** One way a receipt's stock was touched since: what, where, how much (base unit). */
export interface ReversalBlocker {
  readonly code: ReversalBlockerCode
  /** The lot or hide (its id: the stock key the receipt brought). */
  readonly key: string
  /** "hide HD-…" / "lot LA-000001". */
  readonly label: string
  /** The work order number, the location code or the move's reason. */
  readonly where: string
  readonly quantity: string
}

/** A receipt move, as the reversal check reads it. */
export interface ReceiptMoveFact {
  /** The lot's or hide's id (one stock key per hide, or per lot of a lot-tracked material). */
  readonly key: string
  readonly label: string
  readonly toLocationId: string
}

/** Any other move of a receipt's lots and hides (issues, returns, transfers, scraps, corrections and their reversals). */
export interface OtherMoveFact {
  readonly key: string
  readonly reason: string
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  readonly baseQuantity: DecimalInput
  readonly workOrderId: string | null
}

/**
 * How the stock a receipt brought was touched since (empty: untouched, the receipt may be reversed): for each of its
 * lots and hides, the other moves summed per place. Stock still at a work order (issued and not returned) is ISSUED;
 * stock at another location of the site is MOVED; stock that left the site by a scrap, adjustment or count is
 * LEFT_STOCK; stock a correction added is ADDED. An issue that was undone, or a transfer moved back, sums to nothing.
 */
export function reversalBlockers(
  receiptMoves: readonly ReceiptMoveFact[],
  others: readonly OtherMoveFact[],
  names: { readonly location: (id: string) => string; readonly workOrder: (id: string) => string },
): ReversalBlocker[] {
  const blockers: ReversalBlocker[] = []
  for (const receipt of receiptMoves) {
    const places = new Map<string, Decimal>()
    const outside = new Map<string, Decimal>()
    const add = (map: Map<string, Decimal>, key: string, value: Decimal) => map.set(key, (map.get(key) ?? ZERO).plus(value))
    for (const move of others.filter((other) => other.key === receipt.key)) {
      const quantity = new Dec(move.baseQuantity)
      const bucket = move.workOrderId ? `WO|${move.workOrderId}` : `REASON|${move.reason}`
      if (move.fromLocationId) add(places, move.fromLocationId, quantity.negated())
      if (move.toLocationId) add(places, move.toLocationId, quantity)
      if (move.fromLocationId && !move.toLocationId) add(outside, bucket, quantity)
      if (move.toLocationId && !move.fromLocationId) add(outside, bucket, quantity.negated())
    }
    for (const [bucket, net] of outside) {
      if (net.isZero()) continue
      const [kind, value] = bucket.split('|') as [string, string]
      if (kind === 'WO') {
        if (net.greaterThan(0)) blockers.push({ code: 'ISSUED', key: receipt.key, label: receipt.label, where: names.workOrder(value), quantity: quantityText(net) })
      } else if (net.greaterThan(0)) {
        blockers.push({ code: 'LEFT_STOCK', key: receipt.key, label: receipt.label, where: value, quantity: quantityText(net) })
      } else {
        blockers.push({ code: 'ADDED', key: receipt.key, label: receipt.label, where: value, quantity: quantityText(net.negated()) })
      }
    }
    for (const [locationId, net] of places) {
      if (locationId === receipt.toLocationId || net.isZero() || net.isNegative()) continue
      blockers.push({ code: 'MOVED', key: receipt.key, label: receipt.label, where: names.location(locationId), quantity: quantityText(net) })
    }
  }
  return blockers
}

const listed = (labels: readonly string[]): string => (labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`)

/** The refusal of a reversal in words, grouped: what used the stock and what to do first. */
export function reversalRefusal(blockers: readonly ReversalBlocker[], receiptLocation: string): { readonly message: string; readonly issues: Issue[] } {
  const groups = new Map<string, ReversalBlocker[]>()
  for (const blocker of blockers) groups.set(`${blocker.code}|${blocker.where}`, [...(groups.get(`${blocker.code}|${blocker.where}`) ?? []), blocker])
  const issues: Issue[] = []
  for (const [, group] of groups) {
    const first = group[0]!
    const what = `${group.length === 1 ? first.label : `${group.length} of its lots and hides (${listed(group.map((entry) => entry.label))})`}`
    const message =
      first.code === 'ISSUED'
        ? `${what} ${group.length === 1 ? 'is' : 'are'} issued to work order ${first.where}: return ${group.length === 1 ? 'it' : 'them'} to ${receiptLocation} or reverse the issue first, then reverse the receipt.`
        : first.code === 'MOVED'
          ? `${what} ${group.length === 1 ? 'lies' : 'lie'} at ${first.where}: move ${group.length === 1 ? 'it' : 'them'} back to ${receiptLocation} first, then reverse the receipt.`
          : first.code === 'LEFT_STOCK'
            ? `${what} left the stock by a ${first.where.toLowerCase()} move: the receipt can no longer be reversed as a whole; correct the stock with an adjustment instead.`
            : `${what} grew by a ${first.where.toLowerCase()} move: reverse that correction first, then reverse the receipt.`
    issues.push({ path: `blockers/${first.code}`, message })
  }
  const message = issues.length === 1 ? `The receipt's stock was used since it was posted. ${issues[0]!.message}` : `The receipt's stock was used since it was posted in ${issues.length} ways; see each.`
  return { message, issues }
}
