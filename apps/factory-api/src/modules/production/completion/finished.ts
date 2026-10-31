import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCTION_FINISH } from '@nexus/factory-domain/production/completion/permissions'
import { nothingToReport, planReport, reportShapeProblems, reversalPlan, type ReportLine } from '@nexus/factory-domain/production/completion/rules'
import { command, type CommandCaller } from '../../../core/command'
import { defaultPlaceOf, finishedItemFor, postFinishedReceipts, reverseFinishedReceipts, skuKey } from '../../inventory/finished/post'
import { lockRelease } from '../../quality/final/store'
import { lockCells } from '../../shipping/cells'
import { officeContextOf } from '../work-orders/access'
import { readWorkOrder } from '../work-orders/store'
import { officeWorkOrder } from '../work-orders/work-orders'
import { completionView, readCompletionFacts, reportsOf, shareGate, type CompletionView } from './store'

/**
 * Report finished to stock (B-W2a-12; GAP-003 work order completion into finished-goods stock, MES-011 partial
 * completion; design production.workorders pop-up "Report finished to stock": "released quantity per size into finished
 * goods", primary "Report 24 finished"): the pop-up's figures, the report, and taking a report back. Office only.
 *
 * A report is ONE command: the work order's release lock (quality/final `lockRelease`: a quality release or reversal of
 * its garments waits, and so does another report) → its gate SHARED (wave 5: a hold, close or cancel waits for it; the
 * receipt's trigger takes it again) → the cells' shipping locks (shipping/cells `lockCells`, sorted: a packer waits) →
 * the figures read under them (store.ts) → every refusal in words before the database is asked (the work order's
 * blockers, more than a cell can report) → the SKU's FINISHED item made when it is the first time → one
 * PRODUCTION_RECEIPT per cell through the stock ledger (modules/inventory/finished; valued at the standard cost) → the
 * work order's audit row and `workorder.finished_to_stock`. The work order row is never locked (W1's close and cancel
 * lock it before the gate): the database keeps a receipt to an IN_PROGRESS or COMPLETED work order under the gate.
 *
 * Taking a report back: the mirror of each of its receipts not reversed yet (out of the place it went to), with the
 * reason; refused in words when that place no longer holds the garments. Any work order state (the database's rule).
 */

export async function finishedOf(caller: CommandCaller, workOrderId: string): Promise<{ finished: CompletionView }> {
  const workOrder = await officeWorkOrder(caller, workOrderId)
  return { finished: await caller.withClient(async (client) => completionView(await readCompletionFacts(client, workOrder))) }
}

export interface ReportInput {
  /** Per cell the garments to report; left out: every cell, all it can. */
  readonly cells?: readonly ReportLine[] | undefined
  /** A finished-goods place of the site; left out: its one FINISHED_GOODS location. */
  readonly toLocationId?: string | undefined
  readonly note?: string | null | undefined
  /** B-W2a-F8: the reason garments reported inside a SOFT-locked month are posted anyway. */
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

export async function reportFinished(caller: CommandCaller, workOrderId: string, body: ReportInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId, PRODUCTION_FINISH)
  const before = await caller.withClient((client) => readCompletionFacts(client, workOrder))
  if (body.cells) {
    const problems = reportShapeProblems(body.cells, new Set(before.cells.map((cell) => cell.id)))
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These cells cannot be reported.', problems)
  }
  const key = `production.finish:${idempotencyKey ?? newId()}`

  const { result } = await command(caller, { name: 'production.finish', idempotencyKey, input: { workOrderId, ...body } }, async (tools) => {
    const { tx } = tools
    await lockRelease(tx, context.tenantId, workOrder.id)
    await shareGate(tx, context.tenantId, workOrder.id)
    // Every cell's shipping lock (the cells are frozen since the release, sorted by lockCells).
    await lockCells(tx, context.tenantId, before.cells.map((cell) => cell.id))
    const current = (await readWorkOrder(tx, workOrder.id))!
    const facts = await readCompletionFacts(tx, current)
    if (facts.blockers.length > 0) {
      throw new DomainError('invalid_state', facts.blockers.join(' '), facts.blockers.map((message) => ({ path: 'workOrder', message })))
    }
    const plan = planReport(facts.figures, body.cells)
    if (plan.refusals.length > 0) {
      throw new DomainError('conflict', plan.refusals.length === 1 ? plan.refusals[0]!.message : `${plan.refusals.length} cells ask more garments than can go into finished goods.`, plan.refusals)
    }
    if (plan.lines.length === 0) throw new InvalidStateError(nothingToReport(current.number, facts.figures))

    const place = body.toLocationId ? facts.places.find((entry) => entry.id === body.toLocationId) : defaultPlaceOf(facts.places)
    if (!place) {
      throw new ValidationError(
        body.toLocationId ? `Not a finished-goods place of site ${facts.site.code}.` : `Name the place: site ${facts.site.code} has several finished-goods locations.`,
        [{ path: 'body/toLocationId', message: body.toLocationId ? 'Expected a FINISHED_GOODS location of the site, or a place inside one, not archived.' : 'Required: the site has several finished-goods locations.' }],
      )
    }

    const cellOf = new Map(facts.cells.map((cell) => [cell.id, cell]))
    const drafts = []
    for (const [index, line] of plan.lines.entries()) {
      const cell = cellOf.get(line.cellId)!
      const sku = facts.skus.get(skuKey(cell.colourwayId, cell.size))
      if (!sku) {
        throw new ValidationError(`${cell.colourwayCode} ${cell.size} has no SKU: generate the style's SKU matrix (Product › Styles) first.`, [
          { path: `body/cells/${index}/cellId`, message: `Style ${facts.style.code} has no SKU for ${cell.colourwayCode} ${cell.size}.` },
        ])
      }
      const itemId = await finishedItemFor(tools, sku, { styleName: facts.style.name, colourwayName: cell.colourwayName, garmentTracking: facts.style.garmentTracking, companyId: facts.style.companyId })
      drafts.push({ siteId: current.siteId, companyId: current.companyId, workOrderId: current.id, itemId, quantity: line.quantity, toLocationId: place.id, reference: current.batchNumber, note: body.note?.trim() || null, cellId: cell.id })
    }
    const moves = await postFinishedReceipts(tools, drafts, key, body.periodLockOverride)
    const reportId = moves[0]!.id
    const cells = drafts.map((draft) => ({ workOrderSizeId: draft.cellId, itemId: draft.itemId, quantity: draft.quantity }))
    const pieces = cells.reduce((sum, cell) => sum + cell.quantity, 0)
    const after = completionView(await readCompletionFacts(tx, current))
    tools.audit({
      recordType: 'WorkOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { finishedToStock: { reportId, locationId: place.id, cells, pieces, moveIds: moves.map((move) => move.id) } },
      ...(body.note?.trim() ? { reason: body.note.trim() } : {}),
    })
    tools.emit({
      type: 'workorder.finished_to_stock',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { workOrderId: current.id, number: current.number, siteId: current.siteId, reportId, locationId: place.id, moveIds: moves.map((move) => move.id), cells, pieces, allInStock: after.allInStock },
    })
    return { report: { id: reportId, locationId: place.id, locationCode: place.code, moveIds: moves.map((move) => move.id), cells, pieces, valued: moves.every((move) => move.valued) }, finished: after }
  })
  return result
}

export async function reverseReport(caller: CommandCaller, workOrderId: string, reportId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId, PRODUCTION_FINISH)
  if (!isUuid(reportId)) throw new NotFoundError('Report not found.')
  const reason = body.reason.trim()
  const key = `production.finish.reverse:${idempotencyKey ?? newId()}`

  const { result } = await command(caller, { name: 'production.finishReverse', idempotencyKey, input: { workOrderId, reportId, ...body } }, async (tools) => {
    const { tx } = tools
    const current = (await readWorkOrder(tx, workOrder.id))!
    const facts = await readCompletionFacts(tx, current)
    const report = reportsOf(facts.moves).find((entry) => entry.id === reportId)
    if (!report) throw new NotFoundError('Report not found.')
    const plan = reversalPlan(reportId, report.moves.map((entry) => ({ moveId: entry.move.id, reversed: entry.reversal !== null })))
    if (plan.problem) throw new InvalidStateError(plan.problem)
    const originals = report.moves.filter((entry) => entry.reversal === null).map((entry) => entry.move)
    const { moves, overReserved } = await reverseFinishedReceipts(tools, context.tenantId, originals, reason, key)
    const pieces = originals.reduce((sum, move) => sum + Number(move.baseQuantity.toFixed(0)), 0)
    tools.audit({
      recordType: 'WorkOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { finishedToStock: { reportId, moveIds: originals.map((move) => move.id), pieces } },
      after: { finishedReversed: { reportId, moveIds: moves.map((move) => move.id), pieces } },
      reason,
    })
    tools.emit({
      type: 'workorder.finished_reversed',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { workOrderId: current.id, number: current.number, siteId: current.siteId, reportId, moveIds: moves.map((move) => move.id), pieces },
    })
    return { reversed: { reportId, moveIds: moves.map((move) => move.id), pieces }, overReserved, finished: completionView(await readCompletionFacts(tx, current)) }
  })
  return result
}
