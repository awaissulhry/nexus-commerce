import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { amendmentDiff, amendmentProblems, amendStateProblem, nextRevision, snapshotOf, type AmendableLine, type AmendLineInput, type AmendmentDiff, type OrderSnapshot, type SnapshotHeader, type SnapshotLine } from '@nexus/factory-domain/sales/amendments/amendments'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { isIssueList, MAX_TEXT, priceBasisOf, priceText, sizeGrid, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { lockOrderLines } from '../../production/work-orders/store'
import { chainForQuote } from '../quotes/list-price'
import type { SheetCache } from '../quotes/pricing'
import { quotePartyOf, treatmentOfStored } from '../quotes/store'
import { officeContextOf } from './access'
import { officeOrder, recordAfter } from './moves'
import { newLineDraft, priceLines, scaledCost, snapshotLine, type LineDraft, type PricedLines } from './pricing'
import { lockStepRequests, remakeScheduleInCommand } from './schedule'
import { asDay, dayOrNull, lockOrder, readOrder, readOrderFacts, type LineRecord, type OrderFacts, type OrderRow, type Reader } from './store'
import type { OrderView } from './views'

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
 *      planning, shipment or invoice line), the order's totals, reapprovalNeededAt when the net total changed (the
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
}

const priceOf = (value: { toString(): string } | null): string | null => (value === null ? null : priceText(value.toString()))

/** A new line's id in a plan (before it is written): the applied snapshot names the id it got. */
const placeholderId = (index: number): string => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`

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
  return found
}

export interface AmendmentPlan {
  readonly before: OrderSnapshot
  readonly after: OrderSnapshot
  readonly diff: AmendmentDiff
  readonly priced: PricedLines
  /** The lines left out (removed), and the new lines' drafts in `priced` have id null. */
  readonly removed: readonly string[]
  readonly header: { readonly customerRef: string | null; readonly requestedDate: BusinessDate | null }
}

/**
 * The amendment as it would be applied, read in `db` (the command's transaction, or a client for the preview), the
 * order at `status`. Returns the plan or the problems (the API's own checks after the domain's).
 */
export async function planAmendment(db: Reader, order: OrderRow, status: OrderRow['status'], facts: OrderFacts, body: AmendBody, now: Date): Promise<AmendmentPlan | Issue[]> {
  const stateProblem = amendStateProblem(status)
  if (stateProblem) return [{ path: 'body', message: stateProblem }]
  const lines = facts.lines
  if (lines.some((line) => line.kind === 'MADE_TO_MEASURE')) return [{ path: 'body', message: 'This order has a made-to-measure unit: made-to-measure comes later, so the order is not amended here.' }]
  const inWorkOrders = new Map<string, Map<string, number>>()
  for (const row of facts.progress.rows) {
    if (row.inWorkOrders === 0) continue
    const map = inWorkOrders.get(row.lineId) ?? new Map<string, number>()
    map.set(row.size ?? '', row.inWorkOrders)
    inWorkOrders.set(row.lineId, map)
  }
  const current: AmendableLine[] = lines.map((line) => ({ id: line.id, seq: line.seq, kind: line.kind, closedShort: line.closedShortQuantity !== null, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })), inWorkOrders: inWorkOrders.get(line.id) ?? new Map() }))
  const issues = amendmentProblems({ status, reason: body.reason, lines: body.lines, current })
  if (body.customerRef !== undefined && body.customerRef !== null && body.customerRef.trim().length > MAX_TEXT.customerRef) issues.push({ path: 'body/customerRef', message: `At most ${MAX_TEXT.customerRef} characters.` })
  if (body.requestedDate !== undefined && body.requestedDate !== null && body.requestedDate < businessDate(now)) issues.push({ path: 'body/requestedDate', message: 'A requested date is today or later.' })
  if (issues.length > 0) return issues

  const kept = new Set(body.lines.flatMap((line) => (line.id ? [line.id] : [])))
  const removed = lines.filter((line) => !kept.has(line.id)).map((line) => line.id)
  const references = await referencesOf(db, removed)
  for (const lineId of removed) {
    const what = references.get(lineId)
    if (what) issues.push({ path: 'body/lines', message: `Line ${lines.find((line) => line.id === lineId)!.seq} is referred to by ${what.join(', ')}: it cannot be removed; close it short instead, or lower its sizes.` })
  }

  const party = await quotePartyOf(db, order.partyId, businessDate(now), now)
  if (!party) throw new NotFoundError('Customer not found.')
  const pinned = order.quoteVersionId ? ((await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { priceListVersionId: true } }))?.priceListVersionId ?? null) : null
  const newStyles = [...new Set(body.lines.flatMap((line) => (line.id === undefined && line.styleId ? [line.styleId] : [])))]
  const chain = await chainForQuote(db, order, { currency: order.currency, priceListVersionId: pinned }, party, now, newStyles)
  const cache: SheetCache = new Map()
  const byId = new Map(lines.map((line) => [line.id, line]))
  let nextSeq = Math.max(0, ...lines.map((line) => line.seq)) + 10
  const drafts: LineDraft[] = []
  for (const [index, input] of body.lines.entries()) {
    const at = `body/lines/${index}`
    if (input.id === undefined) {
      const draft = await newLineDraft(db, { companyId: order.companyId, taxMode: order.taxMode, party, chain, cache, now }, { styleId: input.styleId!, colourwayId: input.colourwayId!, sizes: input.sizes ?? [], unitPrice: input.unitPrice, description: input.description, note: input.note }, nextSeq, at)
      nextSeq += 10
      if (isIssueList(draft)) issues.push(...draft)
      else drafts.push(draft)
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
  if (issues.length > 0) return issues
  drafts.sort((a, b) => a.seq - b.seq)
  const priced = priceLines(priceBasisOf(order.taxMode), order.currency, treatmentOfStored(lines[0]!), drafts)
  const header = {
    customerRef: body.customerRef === undefined ? order.customerRef : blankToNull(body.customerRef),
    requestedDate: body.requestedDate === undefined ? dayOrNull(order.requestedDate) : body.requestedDate,
  }
  const before = snapshotOf(headerOf(order, order), lines.map(lineSnapshot))
  const closedOf = new Map(lines.map((line) => [line.id, line.closedShortQuantity]))
  const after = snapshotOf(
    headerOf(order, priced, header),
    priced.lines.map((line, index) => snapshotLine({ ...line, id: line.id ?? placeholderId(index), closedShortQuantity: line.id ? (closedOf.get(line.id) ?? null) : null })),
  )
  const diff = amendmentDiff(before, after)
  if (diff.empty) return [{ path: 'body/lines', message: 'Nothing changes: the order already looks like this.' }]
  return { before, after, diff, priced, removed, header }
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
    const plan = await planAmendment(client, order, order.status, facts, body, now)
    const revision = nextRevision((await client.salesOrderAmendment.findMany({ where: { orderId: order.id }, select: { revision: true } })).map((row) => row.revision))
    if (isIssueList(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      return { ok: false, revision, version: order.version, problems: plan, diff: null }
    }
    return { ok: true, revision, version: order.version, problems: [] as Issue[], diff: diffView(plan.diff) }
  })
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** orders.manage: apply an amendment (ONE command; see the module's head). */
export async function applyAmendment(caller: CommandCaller, orderId: string, body: AmendBody, idempotencyKey?: string): Promise<{ order: OrderView; amendment: AmendmentView }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.amend', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const lineIds = (await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id)
    await lockOrderLines(tx, context.tenantId, lineIds)
    // B-W2a-F2: the deposit requests of the open before-shipping steps, before the order's row (a payment takes a
    // request's lock, then the order's row).
    await lockStepRequests(tools, order.id)
    const locked = await lockOrder(tx, order.id, body.version)
    const fresh = (await readOrder(tx, order.id))!
    const facts = await readOrderFacts(tx, fresh)
    const plan = await planAmendment(tx, fresh, locked.status, facts, body, now)
    if (isIssueList(plan)) {
      if (plan.length === 1 && plan[0]!.path === 'body') throw new InvalidStateError(plan[0]!.message)
      throw invalid(plan)
    }
    const actorId = actorIdOf(tools)
    // Removed lines (nothing refers to them: planAmendment checked).
    for (const lineId of plan.removed) {
      await tx.salesOrderLineSize.deleteMany({ where: { lineId } })
      await tx.salesOrderLine.delete({ where: { id: lineId }, select: { id: true } })
    }
    const finalIds: string[] = []
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
    // The snapshot after names the new lines by the ids they got.
    const newIds = new Map(plan.priced.lines.flatMap((line, index) => (line.id === null ? [[placeholderId(index), finalIds[index]!] as const] : [])))
    const after: OrderSnapshot = { header: plan.after.header, lines: plan.after.lines.map((line) => (newIds.has(line.id) ? { ...line, id: newIds.get(line.id)! } : line)) }
    const reacceptanceNeeded = plan.diff.reacceptanceNeeded
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
        netAmount: markMoney('price', plan.diff.netAfter),
        grossAmount: markMoney('price', plan.diff.grossAfter),
        reacceptanceNeeded,
        scheduleRemade: schedule.inserted.length > 0 || schedule.cancelled.length > 0,
      },
      reason: body.reason!.trim(),
    })
    tools.emit({ type: 'sales_order.amended', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, amendmentId, revision, reacceptanceNeeded, lineIds: changedLineIds } })
    return { amendmentId }
  })
  const amendment = await caller.withClient(async (client) => {
    const row = await client.salesOrderAmendment.findUniqueOrThrow({ where: { id: result.amendmentId }, select: AMENDMENT_COLUMNS })
    return amendmentViewOf(row, await namesOf(client, [row.createdById]))
  })
  return { order: await recordAfter(caller, order.id), amendment }
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
