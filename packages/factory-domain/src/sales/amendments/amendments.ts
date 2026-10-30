import type { Issue } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { LINE_CHANGE_STATUSES, MAX_REASON, type SalesOrderStatus } from '../orders/orders'
import { MAX_QUOTE_LINES, MAX_SIZE_QUANTITY, type SalesLineKind } from '../quotes/quotes'

/**
 * Order amendments (B-W2a-30; SAL-209 "confirmed orders locked", SAL-217 "order amendment with snapshot"; the design's
 * Lines tab "Amend order" → EditModeBar "Amendment N — not applied" → Review amendment (lines old → new by size, money
 * change, reason, whether the customer must accept again) and the Changes tab), pure. A confirmed order's lines change
 * only through an amendment: apps/factory-api's modules/sales/orders applies one in ONE command (the order locked, the
 * lines written, SalesOrderAmendment with the next revision and the order before and after, frozen). The snapshot holds
 * prices, never a cost (the table's grain is price: whoever reads a change without the cost grain sees it whole).
 *
 *   when      CONFIRMED, IN_PRODUCTION or READY (the …_sales_guards triggers: once anything shipped the lines are
 *             fixed; a later change is a return)
 *   what      the order's lines as they should be: a line's sizes and unit price, its description and note; a new line
 *             (a style in one colourway); a line left out is removed. Its customer reference and requested date. A
 *             made-to-measure line and a line closed short stay as they are (reopen it first)
 *   limits    a size never drops under the pieces work orders already make of it (lower the work order first), and a
 *             line removed has none in work orders
 *   money     the lines priced again on the order's basis and VAT; the customer must accept again when the net total
 *             changed (SalesOrder.reapprovalNeededAt; the re-acceptance link is W2b, SAL-190)
 */

export const AMEND_STATUSES: readonly SalesOrderStatus[] = LINE_CHANGE_STATUSES

/** The order's header as an amendment freezes it. */
export interface SnapshotHeader {
  readonly customerRef: string | null
  readonly requestedDate: BusinessDate | null
  readonly promiseDate: BusinessDate | null
  readonly paymentTerms: string | null
  readonly currency: string
  readonly taxMode: string
  readonly netAmount: MinorUnits
  readonly vatAmount: MinorUnits
  readonly grossAmount: MinorUnits
}

export interface SnapshotSize {
  readonly size: string
  readonly quantity: number
  /** The size's own unit price when it differs from the line's; null: the line's. */
  readonly unitPrice: string | null
}

/** One line as an amendment freezes it: prices, never a cost. */
export interface SnapshotLine {
  readonly id: string
  readonly seq: number
  readonly kind: SalesLineKind
  readonly styleId: string
  readonly colourwayId: string
  readonly description: string | null
  readonly note: string | null
  readonly quantity: number
  readonly unitPrice: string
  readonly netAmount: MinorUnits
  readonly vatRatePct: string
  readonly vatAmount: MinorUnits
  readonly closedShortQuantity: number | null
  readonly sizes: readonly SnapshotSize[]
}

export interface OrderSnapshot {
  readonly header: SnapshotHeader
  readonly lines: readonly SnapshotLine[]
}

/** The snapshot in a fixed order (lines by seq, sizes as given): what SalesOrderAmendment.before/after stores. */
export function snapshotOf(header: SnapshotHeader, lines: readonly SnapshotLine[]): OrderSnapshot {
  return {
    header: { ...header },
    lines: [...lines].sort((a, b) => a.seq - b.seq).map((line) => ({ ...line, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice })) })),
  }
}

// ---- the difference -------------------------------------------------------------------------------------------------

export const LINE_CHANGES = ['ADDED', 'REMOVED', 'CHANGED'] as const
export type LineChangeKind = (typeof LINE_CHANGES)[number]

export interface SizeChange {
  readonly size: string
  readonly before: number
  readonly after: number
}

export interface LineChange {
  readonly change: LineChangeKind
  /** The line (a new line: its id once written). */
  readonly lineId: string
  readonly seq: number
  readonly styleId: string
  readonly colourwayId: string
  readonly piecesBefore: number
  readonly piecesAfter: number
  /** Every size whose pieces differ, old → new (0: not there). */
  readonly sizes: readonly SizeChange[]
  /** Its unit price old → new, when it changed (null otherwise). */
  readonly unitPrice: { readonly before: string | null; readonly after: string | null } | null
  readonly netBefore: MinorUnits
  readonly netAfter: MinorUnits
  /** The description or the note changed. */
  readonly textChanged: boolean
}

export interface HeaderChange {
  readonly field: 'customerRef' | 'requestedDate'
  readonly before: string | null
  readonly after: string | null
}

export interface AmendmentDiff {
  readonly lines: readonly LineChange[]
  readonly header: readonly HeaderChange[]
  readonly netBefore: MinorUnits
  readonly netAfter: MinorUnits
  readonly grossBefore: MinorUnits
  readonly grossAfter: MinorUnits
  /** The net total changed: the customer must accept the order again (SAL-190, W2b link). */
  readonly reacceptanceNeeded: boolean
  /** Nothing changes at all. */
  readonly empty: boolean
}

const sizeMap = (line: SnapshotLine | undefined): Map<string, number> => new Map((line?.sizes ?? []).map((size) => [size.size, size.quantity]))

/** What an amendment changes, line by line and size by size (the review dialog and the Changes tab). */
export function amendmentDiff(before: OrderSnapshot, after: OrderSnapshot): AmendmentDiff {
  const oldLines = new Map(before.lines.map((line) => [line.id, line]))
  const newLines = new Map(after.lines.map((line) => [line.id, line]))
  const changes: LineChange[] = []
  const ids = [...new Set([...before.lines.map((line) => line.id), ...after.lines.map((line) => line.id)])]
  for (const id of ids) {
    const old = oldLines.get(id)
    const now = newLines.get(id)
    const reference = (now ?? old)!
    const oldSizes = sizeMap(old)
    const newSizes = sizeMap(now)
    const order = [...new Set([...(old?.sizes ?? []).map((size) => size.size), ...(now?.sizes ?? []).map((size) => size.size)])]
    const sizes = order.flatMap((size) => ((oldSizes.get(size) ?? 0) === (newSizes.get(size) ?? 0) ? [] : [{ size, before: oldSizes.get(size) ?? 0, after: newSizes.get(size) ?? 0 }]))
    const priceBefore = old?.unitPrice ?? null
    const priceAfter = now?.unitPrice ?? null
    const sizePrices = (line: SnapshotLine | undefined) => JSON.stringify((line?.sizes ?? []).map((size) => [size.size, size.unitPrice]))
    const priceChanged = old !== undefined && now !== undefined && (priceBefore !== priceAfter || sizePrices(old) !== sizePrices(now))
    const textChanged = old !== undefined && now !== undefined && (old.description !== now.description || old.note !== now.note)
    const change: LineChangeKind | null = old === undefined ? 'ADDED' : now === undefined ? 'REMOVED' : sizes.length > 0 || priceChanged || textChanged || old.quantity !== now.quantity ? 'CHANGED' : null
    if (change === null) continue
    changes.push({
      change,
      lineId: id,
      seq: reference.seq,
      styleId: reference.styleId,
      colourwayId: reference.colourwayId,
      piecesBefore: old?.quantity ?? 0,
      piecesAfter: now?.quantity ?? 0,
      sizes,
      unitPrice: change === 'CHANGED' && priceChanged ? { before: priceBefore, after: priceAfter } : null,
      netBefore: old?.netAmount ?? 0,
      netAfter: now?.netAmount ?? 0,
      textChanged,
    })
  }
  changes.sort((a, b) => a.seq - b.seq)
  const header: HeaderChange[] = []
  for (const field of ['customerRef', 'requestedDate'] as const) {
    if (before.header[field] !== after.header[field]) header.push({ field, before: before.header[field], after: after.header[field] })
  }
  const netBefore = before.header.netAmount
  const netAfter = after.header.netAmount
  return {
    lines: changes,
    header,
    netBefore,
    netAfter,
    grossBefore: before.header.grossAmount,
    grossAfter: after.header.grossAmount,
    reacceptanceNeeded: netBefore !== netAfter,
    empty: changes.length === 0 && header.length === 0,
  }
}

// ---- what an amendment may do ------------------------------------------------------------------------------------------

/** One line of the amendment as sent: an existing line (its id) or a new one (style and colourway). */
export interface AmendLineInput {
  readonly id?: string | undefined
  readonly styleId?: string | undefined
  readonly colourwayId?: string | undefined
  readonly sizes?: readonly { readonly size: string; readonly quantity: number; readonly unitPrice?: string | null | undefined }[] | undefined
  readonly unitPrice?: string | null | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A line of the order now, with what its work orders already make per size (cells not cancelled). */
export interface AmendableLine {
  readonly id: string
  readonly seq: number
  readonly kind: SalesLineKind
  readonly closedShort: boolean
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  /** Pieces in work orders, per size (a made-to-measure unit: size ''). */
  readonly inWorkOrders: ReadonlyMap<string, number>
}

export interface AmendmentCheck {
  readonly status: SalesOrderStatus
  readonly reason: string | null | undefined
  readonly lines: readonly AmendLineInput[]
  readonly current: readonly AmendableLine[]
}

const LINE_TEXT = { description: 1000, note: 2000 } as const

/** Why the order cannot take an amendment in this state; null when it can. */
export function amendStateProblem(status: SalesOrderStatus): string | null {
  if (AMEND_STATUSES.includes(status)) return null
  return `The order is ${status}: its lines no longer change (once anything shipped they are fixed; a later change is a return).`
}

/**
 * The problems of an amendment's lines, in words, by path (body/lines/<i>/…): a reason; at least one line; existing
 * lines named once; no size under what its work orders make, no line removed while work orders make it; a
 * made-to-measure line or a line closed short unchanged; a new line names its style and colourway; whole pieces.
 * Style, colourway and sizes offered are the API's checks (they read the catalogue).
 */
export function amendmentProblems(check: AmendmentCheck): Issue[] {
  const issues: Issue[] = []
  if (typeof check.reason !== 'string' || check.reason.trim() === '') issues.push({ path: 'body/reason', message: 'Say why the order changes (it stays with the amendment).' })
  else if (check.reason.trim().length > MAX_REASON) issues.push({ path: 'body/reason', message: `At most ${MAX_REASON} characters.` })
  if (check.lines.length === 0) issues.push({ path: 'body/lines', message: 'An order keeps at least one line: to stop the whole order, cancel it.' })
  if (check.lines.length > MAX_QUOTE_LINES) issues.push({ path: 'body/lines', message: `An order holds at most ${MAX_QUOTE_LINES} lines.` })
  const current = new Map(check.current.map((line) => [line.id, line]))
  const named = new Set<string>()
  check.lines.forEach((line, index) => {
    const at = `body/lines/${index}`
    for (const [field, max] of Object.entries(LINE_TEXT) as ['description' | 'note', number][]) {
      const value = line[field]
      if (typeof value === 'string' && value.trim().length > max) issues.push({ path: `${at}/${field}`, message: `At most ${max} characters.` })
    }
    ;(line.sizes ?? []).forEach((size, sizeIndex) => {
      if (!Number.isInteger(size.quantity) || size.quantity < 0 || size.quantity > MAX_SIZE_QUANTITY) issues.push({ path: `${at}/sizes/${sizeIndex}/quantity`, message: `Whole pieces from 0 to ${MAX_SIZE_QUANTITY}.` })
    })
    if (line.id === undefined) {
      if (!line.styleId) issues.push({ path: `${at}/styleId`, message: 'A new line names its style.' })
      if (!line.colourwayId) issues.push({ path: `${at}/colourwayId`, message: 'A new line names its colourway.' })
      if (!line.sizes || line.sizes.every((size) => size.quantity === 0)) issues.push({ path: `${at}/sizes`, message: 'A size grid line has at least one piece.' })
      return
    }
    const existing = current.get(line.id)
    if (!existing) {
      issues.push({ path: `${at}/id`, message: 'Not a line of this order.' })
      return
    }
    if (named.has(line.id)) issues.push({ path: `${at}/id`, message: 'This line is named twice.' })
    named.add(line.id)
    if (line.styleId !== undefined || line.colourwayId !== undefined) issues.push({ path: `${at}/colourwayId`, message: "A line keeps its style and colourway: remove it and add a new line for another one." })
    const sizesChange = line.sizes !== undefined && JSON.stringify([...line.sizes].filter((size) => size.quantity > 0).map((size) => [size.size, size.quantity]).sort()) !== JSON.stringify(existing.sizes.map((size) => [size.size, size.quantity]).sort())
    const otherChange = line.unitPrice !== undefined || (line.sizes ?? []).some((size) => size.unitPrice !== undefined)
    if (existing.kind === 'MADE_TO_MEASURE' && (sizesChange || otherChange)) issues.push({ path: `${at}/sizes`, message: 'A made-to-measure unit does not change through an amendment.' })
    if (existing.closedShort && (sizesChange || otherChange)) issues.push({ path: `${at}/sizes`, message: 'This line is closed short: reopen it first.' })
    if (line.sizes !== undefined && existing.kind === 'SIZE_GRID') {
      const wanted = new Map(line.sizes.map((size) => [size.size, size.quantity]))
      for (const [size, made] of existing.inWorkOrders) {
        const after = wanted.get(size) ?? 0
        if (made > after) issues.push({ path: `${at}/sizes`, message: `Size ${size}: work orders already make ${made} piece(s); lower the work order first (${after} asked).` })
      }
    }
    if (existing.kind === 'SIZE_GRID' && line.sizes !== undefined && line.sizes.every((size) => size.quantity === 0)) issues.push({ path: `${at}/sizes`, message: 'A line keeps at least one piece: leave the line out to remove it.' })
  })
  for (const line of check.current) {
    if (named.has(line.id)) continue
    const made = [...line.inWorkOrders.values()].reduce((total, value) => total + value, 0)
    if (made > 0) issues.push({ path: 'body/lines', message: `Line ${line.seq} is in work orders (${made} piece(s)): it cannot be removed; lower or cancel the work order first.` })
    if (line.closedShort) issues.push({ path: 'body/lines', message: `Line ${line.seq} is closed short: reopen it before removing it.` })
    if (line.kind === 'MADE_TO_MEASURE') issues.push({ path: 'body/lines', message: `Line ${line.seq} is a made-to-measure unit: it does not change through an amendment.` })
  }
  return issues
}

/** The next amendment's number on an order: one more than the highest so far (1 for the first). */
export const nextRevision = (revisions: readonly number[]): number => Math.max(0, ...revisions) + 1
