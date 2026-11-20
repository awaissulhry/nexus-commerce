import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors' // B-CP-024: + ConflictError; B-OL-033: NotFoundError moved to ./pricing.ts
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { amendmentDiff, amendmentProblems, amendStateProblem, leftOutOf, nextRevision, snapshotOf, type AmendableLine, type AmendLineInput, type AmendmentDiff, type OrderSnapshot, type SnapshotHeader, type SnapshotLine } from '@nexus/factory-domain/sales/amendments/amendments'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { isGoodsLine, isIssueList, MAX_TEXT, priceBasisOf, priceText, sizeGrid, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { lockOrderLines } from '../../production/work-orders/store'
import type { SheetCache } from '../quotes/pricing'
import { storedVat, treatmentOfStored } from '../quotes/store'
import { officeContextOf } from './access'
import { officeOrder, recordAfter } from './moves'
import { newLineDraft, orderPriceChain, priceLines, scaledCost, snapshotLine, type LineDraft, type PricedLines } from './pricing' // B-OL-033: + orderPriceChain
import { lockStepRequests, remakeScheduleInCommand } from './schedule'
import { asDay, dayOrNull, lockOrder, readOrder, readOrderFacts, type LineRecord, type OrderFacts, type OrderRow, type Reader } from './store'
import type { OrderView } from './views'
// B-W2b-303 (SO1:02): the line rules on an amendment's lines.
import { amendedLineProblems } from '../orders-depth/line-rules'
// B-W2b-309 (SAL-218, SAL-219, SAL-221, SAL-190, SAL-306): the freeze rules, the priced change, its extra deposit (B-OP-010: no yes).
import type { PricedInput } from '@nexus/factory-domain/sales/order-changes/priced'
import { afterAmendment, amendmentExtras, beforeAmendmentWrites, type ChangeOptions } from '../order-changes/apply'
import { previewFrozenProblems } from '../order-changes/freeze'
// B-W2b-374 (XF3:02): a new line's options.
import { entryOptionsAudit, planEntryOptions, writeEntryOptions, type EntryOptions } from './lines/options-entry'
// B-SA-042 (P6', R1): an amendment under what work orders make proposes the gap to them in its command; extra pieces need an outcome.
import { chargeFeeOf, extraOf as extraOfPlanned, type ExtraOutcome, type ExtraPieces, type PlannedChange, type PricedSize, type WorkCell } from '@nexus/factory-domain/order-apply/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { proposeGapsInCommand, type GapLine } from '../../production/work-order-changes/propose'
// B-OP-013 (order page plan N2): the previews say what the work orders will do, read as the command reads it.
import { plannedChangesOf, workOrderPreviewOf } from './work-order-plan'
// B-OP-014 (order page plan N1): a line work orders make, left out, is closed short in the same command (as a close of lines).
import { closeShortPlan } from '@nexus/factory-domain/sales/orders/daily'
import { reducesDoneInCommand, shortLinesOf } from './close-lines'
// B-OP-012 (order page plan N2, D1): the work orders follow the amendment in its command where the person may.
import { withAutoApply, type AutoApply, type FollowedWorkOrders } from '../../production/work-order-changes/auto'
// B-OP-015 (order page plan N1): the delivery address changes with the amendment, by the rule of an accepted request's.
import { moveShipTo, shipToProblem } from '../change-requests/office'
// B-CP-024 (customer page plan C3; review G5): a removed line takes the customer's price with it.
import { removeBrandPricesOfLines } from '../brand-prices/store'

/**
 * Order amendments (B-W2a-30; SAL-209, SAL-217; the design's "Amend order" → "Review amendment" → Changes tab). A
 * confirmed order's lines change only here (W1's promise change writes only dates): ONE command on the order
 * (orders.manage; a reason) —
 *
 *   1. the lines' work-order locks (no work order is made for them meanwhile), the money locks of the open
 *      before-shipping steps' deposit requests (B-W2a-F2), then the order's row FOR UPDATE at the version read;
 *      CONFIRMED, IN_PRODUCTION or READY (the …_sales_guards triggers say so too);
 *   2. the order as it is (the snapshot before: header and lines with sizes and prices, never a cost), the lines as they
 *      will be (factory-domain sales/amendments `amendmentProblems`: never under what work orders make; a new line's
 *      style, colourway, sizes and list price as for a quote line), priced again on the order's basis and VAT (an
 *      existing line keeps its cost per piece, a new one is costed from today's sheet);
 *   3. the lines written (a line left out is removed only when nothing refers to it: no work order, reservation,
 *      planning, shipment or invoice line; B-OP-014: one work orders make is closed short instead — the office's own
 *      amendment, `closeLeftOut` — never deleted, its gap proposed to them), the order's totals, reapprovalNeededAt when the net total changed (the
 *      customer accepts again: the re-acceptance link is W2b, SAL-190), the SalesOrderAmendment with the next revision
 *      and both snapshots (append-only), the OPEN payment steps made again for the new total, an audit row and
 *      sales_order.amended.
 *
 * The preview runs steps 1–2 without writing and answers the review dialog: lines old → new by size, the money change,
 * whether the customer must accept again, and the problems in words.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export interface AmendBody {
  readonly version?: number | undefined
  readonly reason?: string | undefined
  readonly customerRef?: string | null | undefined
  readonly requestedDate?: BusinessDate | null | undefined
  readonly lines: readonly AmendLineInput[]
  /** B-SA-042 (R1): what happens to pieces already cut beyond the new figures (CHARGE · LEFTOVER · SCRAP); required when there are some. */
  readonly extraOutcome?: ExtraOutcome | null | undefined
  /** B-OP-015: a new delivery address (an ACTIVE one of the order's customer); none: the order's own stays. */
  readonly shipToAddressId?: string | null | undefined
}

/** The plan's words when nothing changes. */
const NOTHING_CHANGES = 'Nothing changes: the order already looks like this.'
/** B-OP-015: the plan says only that nothing changes — with a new delivery address, the address is the whole change (no amendment). */
const onlyTheAddress = (plan: AmendmentPlan | Issue[]): boolean => isIssueList(plan) && plan.length === 1 && plan[0]!.message === NOTHING_CHANGES

const priceOf = (value: { toString(): string } | null): string | null => (value === null ? null : priceText(value.toString()))

/** A new line's id in a plan (before it is written): the applied snapshot names the id it got. */
const placeholderId = (index: number): string => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`

// ── B-SA-042: the gap an amendment leaves on the order's work orders, read from its plan (before anything is written) ──
/**
 * The lines after the amendment as the gap reads them (a line closed short does not change through an amendment). B-OP-014: one
 * the amendment closes short (`closing`, with what shipped of it per size) wants what shipped of it, as a close of lines reads it.
 */
function gapLinesAfter(after: OrderSnapshot, stored: readonly LineRecord[], closing: ReadonlyMap<string, AmendmentPlan['closing'][number]['shipped']> = new Map()): GapLine[] {
  return after.lines.flatMap((line) => {
    if (line.kind !== 'SIZE_GRID' && line.kind !== 'MADE_TO_MEASURE') return []
    if (line.closedShortQuantity !== null && !closing.has(line.id)) return []
    const own = stored.find((entry) => entry.id === line.id)
    const unit = line.kind === 'MADE_TO_MEASURE'
    const shipped = closing.get(line.id)
    if (shipped) return [{ id: line.id, styleId: line.styleId, siteId: own?.siteId ?? null, madeToMeasure: unit, sizes: new Map(line.sizes.map((size) => [size.size, shipped.find((entry) => entry.size === size.size)?.quantity ?? 0])) }]
    const sizes = new Map<string, number>(unit ? (own?.baseSize ? [[own.baseSize, 1]] : []) : line.sizes.map((size) => [size.size, size.quantity]))
    return [{ id: line.id, styleId: line.styleId, siteId: own?.siteId ?? null, madeToMeasure: unit, sizes }]
  })
}

/** The sizes of the snapshot's lines (before the amendment), by line. */
const sizesOf = (snapshot: OrderSnapshot): Map<string, Map<string, number>> => new Map(snapshot.lines.map((line) => [line.id, new Map(line.sizes.map((size) => [size.size, size.quantity]))]))

/** Each size's unit price after the amendment (its own, else the line's): what CHARGE asks for an extra piece. */
const pricesOf = (after: OrderSnapshot): PricedSize[] => after.lines.flatMap((line) => line.sizes.map((size) => ({ lineId: line.id, size: size.size, unitPrice: size.unitPrice ?? line.unitPrice })))

/** The extra pieces an amendment's plan would leave (cut beyond the new figures), with the order's work orders as they are. */
export async function plannedExtra(db: Reader, tenantId: string, order: Pick<OrderRow, 'id' | 'status'>, plan: Pick<AmendmentPlan, 'before' | 'after' | 'diff' | 'closing'>, stored: readonly LineRecord[]): Promise<ExtraPieces[]> {
  return extraOfPlanned((await plannedGap(db, tenantId, order, plan, stored)).changes)
}

/**
 * B-SA-045: the work-order changes an amendment's plan would propose (the apply plan shows them before Accept), with the order's
 * work orders as they are; `closing` replaces the plan's own line of the same id (a colourway change's old line, closed short after).
 * B-OP-013: read as the command proposes them — the lines the amendment changes (the diff's), the waiting changes they replace with
 * theirs (./work-order-plan.ts plannedChangesOf) — and with the cells read (what is cut), for the plan rows.
 */
export async function plannedGap(db: Reader, tenantId: string, order: Pick<OrderRow, 'id' | 'status'>, plan: Pick<AmendmentPlan, 'before' | 'after' | 'diff' | 'closing'>, stored: readonly LineRecord[], closing: readonly GapLine[] = []): Promise<{ changes: PlannedChange[]; cells: WorkCell[] }> {
  const replaced = new Set(closing.map((line) => line.id))
  const changed = new Set(plan.diff.lines.map((line) => line.lineId))
  const lines = [...gapLinesAfter(plan.after, stored, new Map(plan.closing.map((line) => [line.id, line.shipped]))).filter((line) => changed.has(line.id) && !replaced.has(line.id)), ...closing]
  return plannedChangesOf(db, tenantId, order, lines, sizesOf(plan.before))
}

/** A fee in major units plus another (either may be absent), 2 places. */
const addFee = (a: string | null | undefined, b: string): string => (a ? new Dec(a).plus(b).toFixed(2) : b)
// ── end B-SA-042 ──

function headerOf(order: OrderRow, money: { netAmount: number; vatAmount: number; grossAmount: number }, change: { customerRef?: string | null; requestedDate?: string | null } = {}): SnapshotHeader {
  return {
    customerRef: change.customerRef !== undefined ? change.customerRef : order.customerRef,
    requestedDate: change.requestedDate !== undefined ? change.requestedDate : dayOrNull(order.requestedDate),
    promiseDate: dayOrNull(order.promiseDate),
    paymentTerms: order.paymentTerms,
    currency: order.currency,
    taxMode: order.taxMode,
    netAmount: money.netAmount,
    vatAmount: money.vatAmount,
    grossAmount: money.grossAmount,
  }
}

const lineSnapshot = (line: LineRecord): SnapshotLine => ({
  id: line.id,
  seq: line.seq,
  kind: line.kind,
  styleId: line.styleId,
  colourwayId: line.colourwayId,
  description: line.description,
  note: line.note,
  quantity: line.quantity,
  unitPrice: priceText(line.unitPrice.toString()),
  netAmount: line.netAmount,
  vatRatePct: line.vatRatePct.toFixed(2),
  vatAmount: line.vatAmount,
  closedShortQuantity: line.closedShortQuantity,
  sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: priceOf(size.unitPrice) })),
})

// ── B-CP-024 (customer page plan C3; review G5) ──
/** The words of a line the customer's price still holds (a price given between the plan and the delete). */
export const LINE_HAS_BRAND_PRICE = (seq: number | null): string => `${seq === null ? 'This line' : `Line ${seq}`} has the customer's price: it was given while the line was being removed. Read the order again, then remove the line.`

/** A line deleted; the customer's price that still holds it (the foreign key is Restrict) is a 409 in words, never a 500. */
async function deleteLine(tx: CommandTools['tx'], lineId: string, seq: number | null): Promise<void> {
  try {
    await tx.salesOrderLine.delete({ where: { id: lineId }, select: { id: true } })
  } catch (error) {
    const found = error as { code?: unknown; message?: unknown; meta?: unknown } | null
    if (found?.code === 'P2003' && `${String(found.message)} ${JSON.stringify(found.meta ?? {})}`.includes('OrderBrandPrice')) throw new ConflictError(LINE_HAS_BRAND_PRICE(seq))
    throw error
  }
}
// ── end B-CP-024 ──

/** What refers to each line, by line (a line referred to is never removed: the database keeps the reference). */
async function referencesOf(db: Reader, lineIds: readonly string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  if (lineIds.length === 0) return found
  const note = (lineId: string | null, what: string) => {
    if (lineId === null) return
    const list = found.get(lineId) ?? []
    if (!list.includes(what)) list.push(what)
    found.set(lineId, list)
  }
  const where = { salesOrderLineId: { in: [...lineIds] } }
  for (const row of await db.workOrderSize.findMany({ where, select: { salesOrderLineId: true } })) note(row.salesOrderLineId, 'a work order')
  for (const row of await db.reservation.findMany({ where, select: { salesOrderLineId: true } })) note(row.salesOrderLineId, 'a reservation')
  for (const row of await db.requirementPegging.findMany({ where, select: { salesOrderLineId: true }, distinct: ['salesOrderLineId'] })) note(row.salesOrderLineId, 'a planning run')
  for (const row of await db.shipmentLine.findMany({ where, select: { salesOrderLineId: true } })) note(row.salesOrderLineId, 'a shipment')
  for (const row of await db.invoiceLine.findMany({ where, select: { salesOrderLineId: true } })) note(row.salesOrderLineId, 'an invoice')
  for (const row of await db.returnLine.findMany({ where, select: { salesOrderLineId: true } })) note(row.salesOrderLineId, 'a return')
  // B-W2b-183: a customer's change or cancel request names the line (OrderChangeRequestLine keeps it).
  for (const row of await db.orderChangeRequestLine.findMany({ where: { orderLineId: { in: [...lineIds] } }, select: { orderLineId: true } })) note(row.orderLineId, "a customer's change request")
  // B-W2b-317 (PLN-173): a line promised is kept with its promise history (append-only PromiseRecord rows refer to it).
  for (const row of await db.promiseRecord.findMany({ where, select: { salesOrderLineId: true }, distinct: ['salesOrderLineId'] })) note(row.salesOrderLineId, 'its promise history')
  return found
}

export interface AmendmentPlan {
  readonly before: OrderSnapshot
  readonly after: OrderSnapshot
  readonly diff: AmendmentDiff
  readonly priced: PricedLines
  /** The lines left out (removed), and the new lines' drafts in `priced` have id null. */
  readonly removed: readonly string[]
  /** B-OP-014: the lines left out that work orders make: closed short (what is left of each), never deleted; kept in `priced`. */
  readonly closing: readonly { readonly id: string; readonly seq: number; readonly closedShortQuantity: number; readonly shipped: readonly { readonly size: string; readonly quantity: number }[] }[]
  readonly header: { readonly customerRef: string | null; readonly requestedDate: BusinessDate | null }
  /** B-W2b-374 (XF3:02): the new lines' options by seq (already in their price), written with the lines. */
  readonly options?: ReadonlyMap<number, EntryOptions>
}

/** B-OP-014: how an amendment treats a line left out that work orders make — the office's own amendment closes it short. */
export interface PlanOptions {
  /** Close short a line left out that work orders make (its cells point at it); off: such a line is refused, as before. */
  readonly closeLeftOut?: boolean
  /** A put-back of the change that closed these lines short: they read open again (reopened in the same command). */
  readonly reopen?: ReadonlySet<string>
}

/**
 * The amendment as it would be applied, read in `db` (the command's transaction, or a client for the preview), the
 * order at `status`. Returns the plan or the problems (the API's own checks after the domain's).
 */
export async function planAmendment(db: Reader, order: OrderRow, status: OrderRow['status'], facts: OrderFacts, body: AmendBody, now: Date, /* B-OP-014 */ planOptions: PlanOptions = {}): Promise<AmendmentPlan | Issue[]> {
  const stateProblem = amendStateProblem(status)
  if (stateProblem) return [{ path: 'body', message: stateProblem }]
  if (facts.lines.some((line) => line.kind === 'FEE')) return [{ path: 'body', message: 'This order has a fee line: a fee is changed on its own line, so the order is not amended here.' }]
  const lines = facts.lines.filter(isGoodsLine)
  // B-W2b-368 (XF1:01): an order with a made-to-measure unit is amended too; the unit is kept as it was sold (./amendments/mtm).
  const inWorkOrders = new Map<string, Map<string, number>>()
  for (const row of facts.progress.rows) {
    if (row.inWorkOrders === 0) continue
    const map = inWorkOrders.get(row.lineId) ?? new Map<string, number>()
    map.set(row.size ?? '', row.inWorkOrders)
    inWorkOrders.set(row.lineId, map)
  }
  const reopen = planOptions.reopen ?? new Set<string>()
  const current: AmendableLine[] = lines.map((line) => ({ id: line.id, seq: line.seq, kind: line.kind, closedShort: line.closedShortQuantity !== null && !reopen.has(line.id), sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })), inWorkOrders: inWorkOrders.get(line.id) ?? new Map() }))
  const issues = amendmentProblems({ status, reason: body.reason, lines: body.lines, current })
  if (body.customerRef !== undefined && body.customerRef !== null && body.customerRef.trim().length > MAX_TEXT.customerRef) issues.push({ path: 'body/customerRef', message: `At most ${MAX_TEXT.customerRef} characters.` })
  if (body.requestedDate !== undefined && body.requestedDate !== null && body.requestedDate < businessDate(now)) issues.push({ path: 'body/requestedDate', message: 'A requested date is today or later.' })
  if (issues.length > 0) return issues

  const kept = new Set(body.lines.flatMap((line) => (line.id ? [line.id] : [])))
  const leftOut = lines.filter((line) => !kept.has(line.id)).map((line) => line.id)
  const references = await referencesOf(db, leftOut)
  // B-OP-014 (order page plan N1): the office's own amendment closes short a line left out that work orders make (any cell that
  // points at it, a cancelled work order's too); every other line left out is removed when nothing refers to it.
  const madeByWorkOrders = new Set(leftOut.filter((lineId) => references.get(lineId)?.includes('a work order')))
  const { remove: removed, close } = planOptions.closeLeftOut ? leftOutOf({ lines: body.lines, current }, madeByWorkOrders) : { remove: leftOut, close: [] as string[] }
  for (const lineId of removed) {
    const what = references.get(lineId)
    if (what) issues.push({ path: 'body/lines', message: `Line ${lines.find((line) => line.id === lineId)!.seq} is referred to by ${what.join(', ')}: it cannot be removed; close it short instead, or lower its sizes.` })
  }
  // What is left of each line closed short (nothing has shipped in the states an amendment takes): the close's own plan.
  let closing: AmendmentPlan['closing'] = []
  if (close.length > 0) {
    const closePlan = closeShortPlan(status, shortLinesOf(facts), close)
    if (Array.isArray(closePlan)) issues.push(...closePlan.map((issue) => ({ path: 'body/lines', message: issue.message })))
    else closing = closePlan.close.map((line) => ({ id: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity, shipped: facts.progress.rows.flatMap((row) => (row.lineId === line.id && row.size !== null && row.shipped > 0 ? [{ size: row.size, quantity: row.shipped }] : [])) }))
  }

  const newStyles = [...new Set(body.lines.flatMap((line) => (line.id === undefined && line.styleId ? [line.styleId] : [])))]
  // B-OL-033: the order's price chain, read as the style search for the order reads it (./pricing.ts orderPriceChain).
  const { party, chain } = await orderPriceChain(db, order, now, newStyles)
  const cache: SheetCache = new Map()
  const byId = new Map(lines.map((line) => [line.id, line]))
  let nextSeq = Math.max(0, ...lines.map((line) => line.seq)) + 10
  const drafts: LineDraft[] = []
  // B-W2b-374 (XF3:02): a new line's options, checked and added to its price (written with the line).
  const options = new Map<number, EntryOptions>()
  const vat = lines[0] ? storedVat(treatmentOfStored(lines[0])) : null
  const optionsCtx = { companyId: order.companyId, currency: order.currency, basis: priceBasisOf(order.taxMode), vatRatePct: vat && vat.vatNature === null ? vat.vatRatePct : null }
  // B-OP-014: a line closed short stays on the order as it is (its price kept: a closed line is not billed).
  const inputs: readonly AmendLineInput[] = [...body.lines, ...closing.map((line) => ({ id: line.id }))]
  for (const [index, input] of inputs.entries()) {
    const at = `body/lines/${index}`
    if (input.id === undefined) {
      const draft = await newLineDraft(db, { companyId: order.companyId, taxMode: order.taxMode, party, chain, cache, now }, { styleId: input.styleId!, colourwayId: input.colourwayId!, sizes: input.sizes ?? [], unitPrice: input.unitPrice, description: input.description, note: input.note }, nextSeq, at)
      nextSeq += 10
      if (isIssueList(draft)) {
        issues.push(...draft)
        continue
      }
      const entry = await planEntryOptions(db, optionsCtx, draft, input.options, `${at}/options`)
      if (isIssueList(entry)) issues.push(...entry)
      else {
        drafts.push(entry.draft)
        if (entry.options) options.set(entry.draft.seq, entry.options)
      }
      continue
    }
    if (input.options !== undefined && input.options.length > 0) {
      issues.push({ path: `${at}/options`, message: `Line ${byId.get(input.id)!.seq} keeps its options here: change them in its Options.` })
      continue
    }
    const line = byId.get(input.id)!
    let sizes: SizeRow[] = line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: priceOf(size.unitPrice) }))
    if (input.sizes !== undefined) {
      const style = await db.style.findUnique({ where: { id: line.styleId }, select: { sizes: true } })
      const variants = await db.variant.findMany({ where: { styleId: line.styleId, colourwayId: line.colourwayId, status: 'ACTIVE' }, select: { size: true } })
      // The sizes it already has stay valid even if their SKU was archived since (the customer bought them).
      const offered = new Set([...variants.map((variant) => variant.size), ...line.sizes.map((size) => size.size)])
      const own = new Map(line.sizes.map((size) => [size.size, priceOf(size.unitPrice)]))
      const grid = sizeGrid(
        input.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice === undefined ? (own.get(size.size) ?? null) : size.unitPrice })),
        { range: style?.sizes ?? [], offered },
        `${at}/sizes`,
      )
      if (isIssueList(grid)) {
        issues.push(...grid)
        continue
      }
      sizes = grid
    }
    const unitPrice = input.unitPrice === undefined || input.unitPrice === null ? priceText(line.unitPrice.toString()) : input.unitPrice
    if (!/^\d+(\.\d{1,6})?$/.test(unitPrice)) {
      issues.push({ path: `${at}/unitPrice`, message: 'A unit price of 0 or more with at most 6 decimals.' })
      continue
    }
    const description = input.description === undefined ? line.description : blankToNull(input.description)
    const note = input.note === undefined ? line.note : blankToNull(input.note)
    const pieces = sizes.reduce((total, size) => total + size.quantity, 0)
    const sameSizes = JSON.stringify(sizes) === JSON.stringify(line.sizes.map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: priceOf(size.unitPrice) })))
    const unitCost = priceOf(line.unitCost)
    drafts.push({
      id: line.id,
      seq: line.seq,
      kind: line.kind,
      styleId: line.styleId,
      styleRevisionId: line.styleRevisionId,
      colourwayId: line.colourwayId,
      measurementProfileId: line.measurementProfileId,
      baseSize: line.baseSize,
      description,
      note,
      unitPrice: priceText(unitPrice),
      sizes,
      unitCost,
      costAmount: sameSizes ? line.costAmount : scaledCost(unitCost, pieces, order.currency),
      changed: !sameSizes || priceText(unitPrice) !== priceText(line.unitPrice.toString()) || description !== line.description || note !== line.note,
    })
  }
  // B-W2b-303 (SO1:02): a new or changed line outside the released scope, or another customer's private-label style, is refused.
  if (issues.length === 0) issues.push(...(await amendedLineProblems(db, order, drafts.filter((draft) => draft.changed))))
  if (issues.length > 0) return issues
  drafts.sort((a, b) => a.seq - b.seq)
  const priced = priceLines(priceBasisOf(order.taxMode), order.currency, treatmentOfStored(lines[0]!), drafts)
  const header = {
    customerRef: body.customerRef === undefined ? order.customerRef : blankToNull(body.customerRef),
    requestedDate: body.requestedDate === undefined ? dayOrNull(order.requestedDate) : body.requestedDate,
  }
  const before = snapshotOf(headerOf(order, order), lines.map(lineSnapshot))
  const closedOf = new Map<string, number | null>([
    ...lines.map((line) => [line.id, reopen.has(line.id) ? null : line.closedShortQuantity] as const),
    /* B-OP-014 */ ...closing.map((line) => [line.id, line.closedShortQuantity] as const),
  ])
  const after = snapshotOf(
    headerOf(order, priced, header),
    priced.lines.map((line, index) => snapshotLine({ ...line, id: line.id ?? placeholderId(index), closedShortQuantity: line.id ? (closedOf.get(line.id) ?? null) : null })),
  )
  const diff = amendmentDiff(before, after)
  if (diff.empty) return [{ path: 'body/lines', message: NOTHING_CHANGES }]
  return { before, after, diff, priced, removed, closing, header, options }
}

/** The diff as answered: pieces and sizes for everyone with orders.view, prices only with the price grain. */
export function diffView(diff: AmendmentDiff) {
  return {
    lines: diff.lines.map((line) => ({
      change: line.change,
      lineId: line.lineId,
      seq: line.seq,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      piecesBefore: line.piecesBefore,
      piecesAfter: line.piecesAfter,
      sizes: line.sizes.map((size) => ({ ...size })),
      priceChanged: line.unitPrice !== null,
      textChanged: line.textChanged,
      closedShort: line.closedShort, // B-OP-014
      reopened: line.reopened, // B-OP-014
    })),
    header: diff.header.map((entry) => ({ ...entry })),
    prices: asMoney(
      'price',
      diff.lines.map((line) => ({ lineId: line.lineId, unitPrice: asMoney('price', line.unitPrice), netBefore: line.netBefore, netAfter: line.netAfter })),
    ),
    netAmountBefore: asMoney('price', diff.netBefore),
    netAmountAfter: asMoney('price', diff.netAfter),
    grossAmountBefore: asMoney('price', diff.grossBefore),
    grossAmountAfter: asMoney('price', diff.grossAfter),
    reacceptanceNeeded: diff.reacceptanceNeeded,
  }
}

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The order cannot be amended like this.', issues)

/**
 * orders.manage: the review of an amendment before it is applied (nothing written). Problems come back as `problems`
 * (the dialog shows them), with `ok` false; a state that takes no amendment is a 409.
 */
export async function previewAmendment(caller: CommandCaller, orderId: string, body: AmendBody) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const facts = await readOrderFacts(client, order)
    // B-OP-014: a line left out that work orders make is closed short (the apply's own plan).
    const plan = await planAmendment(client, order, order.status, facts, body, now, { closeLeftOut: true })
    const revision = nextRevision((await client.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true } })).map((row) => row.revision))
    // B-OP-015: a new delivery address, checked as the apply checks it (only the address changing: no amendment is written).
    const address = body.shipToAddressId ? await shipToProblem(client, order, body.shipToAddressId, 'OFFICE') : null
    const addressProblems = address ? [address] : []
    const shipTo = (amendment: boolean) => (body.shipToAddressId ? { addressId: body.shipToAddressId, amendment } : null)
    if (isIssueList(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      if (body.shipToAddressId && onlyTheAddress(plan)) return { ok: address === null, revision, version: order.version, problems: addressProblems, diff: null, workOrders: null, shipTo: shipTo(false) }
      return { ok: false, revision, version: order.version, problems: [...plan, ...addressProblems], diff: null, workOrders: null, shipTo: shipTo(true) }
    }
    // B-W2b-309 (SAL-218): what the company's freeze rules hold at the stage production reached, said before Apply.
    const frozen = await previewFrozenProblems(client, order, plan.diff, false)
    // B-SA-042 (R1, Round 4): the extra pieces it would leave, shown before Apply; Apply stays held until their outcome is chosen.
    // B-OP-013: and what each work order will do — in the same click or waiting, and why (the command's own rule).
    const context = officeContextOf(caller)
    const workOrders = await workOrderPreviewOf(client, context, order, await plannedGap(client, context.tenantId, order, plan, facts.lines), { requireOutcome: true, outcomeChosen: Boolean(body.extraOutcome) })
    if (frozen.length > 0 || addressProblems.length > 0) return { ok: false, revision, version: order.version, problems: [...frozen, ...addressProblems], diff: diffView(plan.diff), workOrders, shipTo: shipTo(true) }
    return { ok: !workOrders.needsOutcome, revision, version: order.version, problems: [] as Issue[], diff: diffView(plan.diff), workOrders, shipTo: shipTo(true) }
  })
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/**
 * orders.manage: apply an amendment (ONE command; see the module's head). B-OP-012: its work orders follow in it where the person may.
 * B-OP-015: with a new delivery address it moves in the same command; when only the address changes (the lines and header as they
 * are), it moves alone — no amendment is written (`amendment` null), the order's row locked at the version read.
 */
export async function applyAmendment(caller: CommandCaller, orderId: string, body: AmendBody, idempotencyKey?: string): Promise<{ order: OrderView; amendment: AmendmentView | null; workOrders: FollowedWorkOrders }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  // B-OP-015: read before the command; the version locked in it says nothing changed since.
  const addressOnly = body.shipToAddressId ? await caller.withClient(async (client) => onlyTheAddress(await planAmendment(client, order, order.status, await readOrderFacts(client, order), body, serverClock.now(), { closeLeftOut: true }))) : false
  const { result } = await withAutoApply((autoApply) =>
    command(caller, { name: 'orders.amend', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
      if (addressOnly) {
        const locked = await lockOrder(tools.tx, order.id, body.version)
        const state = amendStateProblem(locked.status)
        if (state) throw new InvalidStateError(state)
        await moveShipTo(tools, (await readOrder(tools.tx, order.id))!, body.shipToAddressId!, body.reason!.trim(), 'OFFICE')
        const none: FollowedWorkOrders = { applied: [], waiting: [] }
        return { amendmentId: null as string | null, workOrders: none }
      }
      const done = await amendInCommand(tools, context.tenantId, order, body, { autoApply, /* B-OP-014 */ closeLeftOut: true })
      return { amendmentId: done.amendmentId as string | null, workOrders: done.workOrders } /* plain JSON: never its `before` Map */
    }),
  )
  const amendmentId = result.amendmentId
  const amendment =
    amendmentId === null
      ? null
      : await caller.withClient(async (client) => {
          const row = await client.salesOrderAmendment.findUniqueOrThrow({ where: { id: amendmentId }, select: AMENDMENT_COLUMNS })
          return amendmentViewOf(row, await namesOf(client, [row.createdById]))
        })
  return { order: await recordAfter(caller, order.id), amendment, workOrders: result.workOrders }
}

/**
 * The amendment's work inside a command that is already open (steps 1–3 of the module's head): the order applyAmendment's
 * own command amends, and B-W2b-183's accepted change request (modules/sales/change-requests) in the same command that
 * answers the request. The caller checked orders.manage over `order`.
 */
export async function amendInCommand(
  tools: CommandTools,
  tenantId: string,
  order: OrderRow,
  body: AmendBody,
  options: {
    readonly reacceptance?: boolean
    /* B-W2b-309 */ readonly priced?: PricedInput
    readonly putBack?: boolean
    /** B-SA-042: the customer's request it carries out; `later`: the caller proposes the gap once at its end (Accept). */
    readonly requestId?: string | null
    readonly workOrders?: 'now' | 'later'
    /** B-OP-012: the office routes' runner (../../production/work-order-changes/auto.ts); left out: every change waits. */
    readonly autoApply?: AutoApply
    /** B-OP-014: the office's own amendment — a line left out that work orders make is closed short (PlanOptions). */
    readonly closeLeftOut?: boolean
    /** B-OP-014: a put-back of a change that closed these lines short reopens them (as Reopen lines does). */
    readonly reopen?: readonly string[]
  } = {} /* B-W2b-303: a split asks no re-acceptance */,
): Promise<{ amendmentId: string; /* B-SA-042 */ changedLineIds: string[]; before: Map<string, Map<string, number>>; /* B-OP-012 */ workOrders: FollowedWorkOrders }> {
  const { tx, now } = tools
  const lineIds = (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
  await lockOrderLines(tx, tenantId, lineIds)
  // B-W2a-F2: the deposit requests of the open before-shipping steps, before the order's row (a payment takes a
  // request's lock, then the order's row).
  await lockStepRequests(tools, order.id)
  const locked = await lockOrder(tx, order.id, body.version)
  const fresh = (await readOrder(tx, order.id))!
  const facts = await readOrderFacts(tx, fresh)
  // B-OP-014: only lines still closed short are reopened (one reopened since by hand stays as it is).
  const reopening = new Set(facts.lines.filter((line) => line.closedShortQuantity !== null && (options.reopen ?? []).includes(line.id)).map((line) => line.id))
  const plan = await planAmendment(tx, fresh, locked.status, facts, body, now, { closeLeftOut: options.closeLeftOut === true, reopen: reopening })
  if (isIssueList(plan)) {
    if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
    throw invalid(plan)
  }
  // B-SA-042 (R1): pieces already cut beyond the new figures are extra pieces; "keep and charge the customer" makes the amendment
  // a priced change (its fee: each extra piece at its size's price). The outcome is checked when the gap is proposed.
  let priced = options.priced ?? null
  if (body.extraOutcome === 'CHARGE' && options.reacceptance !== false && options.putBack !== true) {
    const fee = chargeFeeOf(await plannedExtra(tx, tenantId, { id: fresh.id, status: locked.status }, plan, facts.lines), pricesOf(plan.after))
    if (fee) priced = { ...(priced ?? {}), fee: addFee(priced?.fee, fee) }
  }
  // B-W2b-309: one change at a time, the freeze rules, the customer's materials of removed lines (before any write).
  const changeOptions: ChangeOptions = { split: options.reacceptance === false, priced, putBack: options.putBack === true }
  await beforeAmendmentWrites(tools, fresh, plan, changeOptions)
  // B-OP-015: a new delivery address with the amendment (an ACTIVE one of the customer; refused while a shipment is being prepared).
  if (body.shipToAddressId) await moveShipTo(tools, fresh, body.shipToAddressId, body.reason!.trim(), 'OFFICE')
  const actorId = actorIdOf(tools)
  // Removed lines (nothing refers to them: planAmendment checked).
  // B-CP-024: their customer's prices go first, audited (the foreign key is Restrict); one given meanwhile is named in words.
  await removeBrandPricesOfLines(tools, order, plan.removed)
  for (const lineId of plan.removed) {
    await tx.salesOrderLineSize.deleteMany({ where: { lineId } })
    await deleteLine(tx, lineId, plan.before.lines.find((line) => line.id === lineId)?.seq ?? null) // B-CP-024
  }
  const finalIds: string[] = []
  const optionsWritten: { lineId: string; options: EntryOptions }[] = []
  for (const [index, line] of plan.priced.lines.entries()) {
    const sizesOf = (lineId: string) => line.sizes.map((size) => ({ id: newId(), lineId, partyId: order.partyId, size: size.size, quantity: size.quantity, unitPrice: size.unitPrice, createdAt: now, updatedAt: now, createdById: actorId }))
    if (line.id !== null) {
      finalIds[index] = line.id
      if (!line.changed && plan.before.lines.find((entry) => entry.id === line.id)!.netAmount === line.netAmount) continue
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: { quantity: line.quantity, unitPrice: line.unitPrice, netAmount: line.netAmount, vatAmount: line.vatAmount, vatRatePct: line.vatRatePct, vatNature: line.vatNature, costAmount: line.costAmount, description: line.description, note: line.note, updatedAt: now, version: { increment: 1 } },
        select: { id: true },
      })
      await tx.salesOrderLineSize.deleteMany({ where: { lineId: line.id } })
      await tx.salesOrderLineSize.createMany({ data: sizesOf(line.id) })
      continue
    }
    const id = newId()
    finalIds[index] = id
    if (plan.options?.has(line.seq)) optionsWritten.push({ lineId: id, options: plan.options.get(line.seq)! })
    await tx.salesOrderLine.create({
      data: {
        id,
        companyId: order.companyId,
        orderId: order.id,
        partyId: order.partyId,
        seq: line.seq,
        kind: line.kind,
        styleId: line.styleId,
        styleRevisionId: line.styleRevisionId,
        colourwayId: line.colourwayId,
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        netAmount: line.netAmount,
        vatRatePct: line.vatRatePct,
        vatNature: line.vatNature,
        vatAmount: line.vatAmount,
        unitCost: line.unitCost,
        costAmount: line.costAmount,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    await tx.salesOrderLineSize.createMany({ data: sizesOf(id) })
  }
  // B-OP-014 (order page plan N1): the lines left out that work orders make, closed short as a close of lines closes them (never
  // deleted: their cells point at them) with the amendment's reason; an APPROVED reduction of their cells is done with it.
  const closedIds = plan.closing.map((line) => line.id)
  for (const line of plan.closing) {
    await tx.salesOrderLine.update({ where: { id: line.id }, data: { closedShortQuantity: line.closedShortQuantity, closedShortAt: now, closedShortById: actorId, closeShortReason: body.reason!.trim(), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  }
  const reducesDone = closedIds.length > 0 ? await reducesDoneInCommand(tools, order, closedIds) : []
  // B-OP-014: a put-back reopens the lines its change closed short, as Reopen lines does (the four columns and the code cleared).
  const reopenedIds = [...reopening]
  for (const lineId of reopenedIds) {
    await tx.salesOrderLine.update({ where: { id: lineId }, data: { closedShortQuantity: null, closedShortAt: null, closedShortById: null, closeShortReason: null, closedShortReasonCode: null, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  }
  // B-W2b-374 (XF3:02): the new lines' options (the order is CONFIRMED, IN_PRODUCTION or READY: amendStateProblem).
  const optionLineIds = await writeEntryOptions(tools, order.partyId, optionsWritten)
  // The snapshot after names the new lines by the ids they got.
  const newIds = new Map(plan.priced.lines.flatMap((line, index) => (line.id === null ? [[placeholderId(index), finalIds[index]!] as const] : [])))
  const after: OrderSnapshot = { header: plan.after.header, lines: plan.after.lines.map((line) => (newIds.has(line.id) ? { ...line, id: newIds.get(line.id)! } : line)) }
  // B-W2b-303: a split moves lines to new orders of the same customer and quote: the customer accepts nothing again.
  // B-W2b-309: a priced change always asks the customer (its price is new); a put-back restores what was accepted.
  const reacceptanceNeeded = options.reacceptance === false || options.putBack === true ? false : plan.diff.reacceptanceNeeded || priced !== null /* B-SA-042: CHARGE too */
  await tx.salesOrder.update({
    where: { id: order.id },
    data: {
      netAmount: plan.priced.netAmount,
      vatAmount: plan.priced.vatAmount,
      grossAmount: plan.priced.grossAmount,
      costAmount: plan.priced.costAmount,
      customerRef: plan.header.customerRef,
      requestedDate: plan.header.requestedDate === null ? null : asDay(plan.header.requestedDate),
      ...(reacceptanceNeeded ? { reapprovalNeededAt: now } : {}),
      updatedAt: now,
      version: { increment: 1 },
    },
    select: { id: true },
  })
  const revision = nextRevision((await tx.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true } })).map((row) => row.revision))
  const amendmentId = newId()
  // B-W2b-309: the priced parts and fee and the extra deposit the row names (append-only: named at insert). B-OP-010: no yes.
  const extras = await amendmentExtras(tools, fresh, { revision, before: plan.before, after }, changeOptions)
  await tx.salesOrderAmendment.create({
    data: {
      id: amendmentId,
      companyId: order.companyId,
      orderId: order.id,
      partyId: order.partyId,
      revision,
      reason: body.reason!.trim(),
      before: plan.before as unknown as Prisma.InputJsonValue,
      after: after as unknown as Prisma.InputJsonValue,
      netAmountBefore: plan.diff.netBefore,
      netAmountAfter: plan.diff.netAfter,
      grossAmountBefore: plan.diff.grossBefore,
      grossAmountAfter: plan.diff.grossAfter,
      reacceptanceNeeded,
      // B-W2b-309
      ...(extras.priceDeltaLines !== undefined ? { priceDeltaLines: extras.priceDeltaLines } : {}),
      feeAmount: extras.feeAmount,
      depositRequestId: extras.depositRequestId,
      requestId: tools.context.requestId,
      createdAt: now,
      createdById: actorId,
    },
    select: { id: true },
  })
  const schedule = await remakeScheduleInCommand(tools, fresh, plan.priced.grossAmount, revision)
  const changedLineIds = [...new Set([...plan.diff.lines.map((line) => newIds.get(line.lineId) ?? line.lineId)])]
  tools.audit({
    action: 'orders.amend',
    recordType: 'SalesOrder',
    recordId: order.id,
    companyId: order.companyId,
    before: { netAmount: markMoney('price', plan.diff.netBefore), grossAmount: markMoney('price', plan.diff.grossBefore), lines: plan.before.lines.length },
    after: {
      amendmentId,
      revision,
      changes: plan.diff.lines.map((line) => ({ change: line.change, lineId: newIds.get(line.lineId) ?? line.lineId, seq: line.seq, piecesBefore: line.piecesBefore, piecesAfter: line.piecesAfter })),
      removedLineIds: plan.removed,
      // B-OP-014
      ...(plan.closing.length > 0 ? { closedLines: plan.closing.map((line) => ({ lineId: line.id, seq: line.seq, closedShortQuantity: line.closedShortQuantity })), reducesDone } : {}),
      ...(reopenedIds.length > 0 ? { reopenedLineIds: reopenedIds } : {}),
      netAmount: markMoney('price', plan.diff.netAfter),
      grossAmount: markMoney('price', plan.diff.grossAfter),
      reacceptanceNeeded,
      scheduleRemade: schedule.inserted.length > 0 || schedule.cancelled.length > 0,
      // B-W2b-374
      ...(optionsWritten.length > 0 ? { options: entryOptionsAudit(optionsWritten) } : {}),
    },
    reason: body.reason!.trim(),
  })
  // B-SA-001: both name the order's customer (the order row's own, read on the server).
  if (optionLineIds.length > 0) tools.emit({ type: 'sales_order.options_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, lineIds: optionLineIds, change: 'CHOSEN', partyId: order.partyId } })
  tools.emit({ type: 'sales_order.amended', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, amendmentId, revision, reacceptanceNeeded, lineIds: changedLineIds, partyId: order.partyId } })
  // B-OP-014: the lines closed short, as a close of lines announces them (the floor's note, the settlement, the keeper).
  if (closedIds.length > 0) tools.emit({ type: 'sales_order.lines_closed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'CLOSED', lineIds: closedIds, partyId: order.partyId } })
  if (reopenedIds.length > 0) tools.emit({ type: 'sales_order.lines_closed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, change: 'REOPENED', lineIds: reopenedIds, partyId: order.partyId } })
  // B-W2b-309: sales_order.change_priced; the customer's materials of the changed lines follow their sizes.
  await afterAmendment(tools, fresh, { amendmentId, revision, changedLineIds, extras })
  // B-SA-042: the gap to the order's work orders, proposed in this command (Accept proposes once at its own end). B-OP-012: and
  // carried out where the person may (a put-back's extra pieces stay production's, as before).
  const before = sizesOf(plan.before)
  let workOrders: FollowedWorkOrders = { applied: [], waiting: [] }
  if (options.workOrders !== 'later') {
    const gap = await proposeGapsInCommand(tools, { order: { ...fresh, status: locked.status }, requestId: options.requestId ?? null, amendmentId, reason: body.reason!.trim(), extraOutcome: body.extraOutcome ?? null, requireOutcome: options.putBack !== true /* a put-back leaves them to production */, lineIds: changedLineIds, before }, options.autoApply)
    workOrders = { applied: gap.applied, waiting: gap.waiting }
  }
  return { amendmentId, changedLineIds, before, workOrders }
}

// ---- the Changes tab ------------------------------------------------------------------------------------------------------

const AMENDMENT_COLUMNS = {
  id: true,
  revision: true,
  reason: true,
  before: true,
  after: true,
  netAmountBefore: true,
  netAmountAfter: true,
  grossAmountBefore: true,
  grossAmountAfter: true,
  reacceptanceNeeded: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SalesOrderAmendmentSelect
type AmendmentRow = Prisma.SalesOrderAmendmentGetPayload<{ select: typeof AMENDMENT_COLUMNS }>

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

function amendmentViewOf(row: AmendmentRow, names: Map<string, string>) {
  const before = row.before as unknown as OrderSnapshot
  const after = row.after as unknown as OrderSnapshot
  return {
    id: row.id,
    revision: row.revision,
    reason: row.reason,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
    /** SAL-190 (the customer's re-acceptance link) is W2b: NEEDED says the customer must accept again. */
    reacceptance: row.reacceptanceNeeded ? ('NEEDED' as const) : ('NOT_NEEDED' as const),
    diff: diffView(amendmentDiff(before, after)),
    before: asMoney('price', before as unknown as Record<string, unknown>),
    after: asMoney('price', after as unknown as Record<string, unknown>),
  }
}

export type AmendmentView = ReturnType<typeof amendmentViewOf>

/** orders.view: the order's amendments, newest first (the design's Changes tab; the snapshots and money by grain). */
export async function listAmendments(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const rows = await client.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: AMENDMENT_COLUMNS, orderBy: { revision: 'desc' } })
    const names = await namesOf(client, rows.map((row) => row.createdById))
    return { orderId: order.id, number: order.number, reapprovalNeededAt: order.reapprovalNeededAt === null ? null : toUtcIso(order.reapprovalNeededAt), amendments: rows.map((row) => amendmentViewOf(row, names)) }
  })
}
