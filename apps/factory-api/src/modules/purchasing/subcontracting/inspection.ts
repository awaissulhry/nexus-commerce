import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { heldWords } from '@nexus/factory-domain/quality/incoming/units'
import type { CommandTools } from '../../../core/command'
import { postCostsInCommand } from '../../costing/actual/post'
import { reportOutsideInCommand, type OutsideReport } from '../../production/scans/outside'
import { plannedOpenings } from '../../quality/triggers/handler'
import { openIncoming } from '../../quality/triggers/open'
import type { Reader } from '../store'
import { RECEIPT_INSPECTED_ACTION, rejectedLinesOf, reportedLines } from './held'
import { nameOf, type OperationRow, type OrderRow } from './store'

/**
 * Goods back from a workshop checked before stock and before payment (B-W2b-111; QHS-036; design floor.kits "Finish
 * receipt: goods go to inspection before stock and before the workshop is paid"; purchasing.subcontracting "Received
 * back"). One rule for the office's receipt and the floor's kit task (receive.ts receiveBackAs):
 *
 *   receive   when a rule of the company asks for an incoming inspection of the receipt (an ACTIVE GOODS_RECEIPT rule
 *             whose chips fit it, B-W2b-101's own decision), it is opened INSIDE the receive command (triggers/open.ts
 *             openIncoming, under the receipt's lock: the rules' handler a moment later finds it open); the receipt's
 *             bundles are then not reported at their outside operation (they wait at the workshop's step), and their good
 *             pieces earn no fee and count in no supplier invoice's match while it is open (held.ts).
 *   decision  (quality/incoming decide.ts, inside its command) `releaseReceiptInCommand`: the lines (bundles) rejected
 *             move their good pieces to defective on their operation (no fee for them; the workshop's invoice matches the
 *             pieces accepted); every other line not yet reported is reported at its operation as it came back (the scan
 *             names the receipt line: its counts are the line's, the database's rule); the fee posts for what is no
 *             longer held; the receipt's own audit row keeps the lines rejected (held.ts reads it back).
 *   cancel    the same with nothing rejected: the goods go on as received.
 * The order's row is held and its version moves (a stale screen of the order reloads); `subcontract_order.updated`.
 */

export interface ReceiptLineRow {
  readonly id: string
  readonly seq: number
  readonly operationId: string
  readonly operationSeq: number
  readonly workOrderOperationId: string
  readonly operationCode: string
  readonly operationName: string
  readonly bundleId: string | null
  readonly bundleCode: string | null
  readonly good: number
  readonly defective: number
  readonly scrapped: number
  readonly reasonCode: string | null
  readonly reasonNote: string | null
  /** The scan that reported the line at its operation from the receipt; null: not reported. */
  readonly scanId: string | null
}

export interface ReceiptRow {
  readonly id: string
  readonly seq: number
  readonly siteId: string
  readonly workOrderId: string
  readonly receivedAt: Date
  readonly workshopDdtNumber: string | null
  readonly order: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string; readonly status: string; readonly partyId: string; readonly currency: string }
  readonly workshop: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly workOrder: { readonly id: string; readonly number: string }
  readonly lines: readonly ReceiptLineRow[]
  /** The lines (bundles) its decided incoming inspection rejected (the receipt's audit row), and that inspection's number. */
  readonly rejected: { readonly number: string | null; readonly lineIds: readonly string[] }
}

/** A workshop's receipt as its inspection reads it (read as the office or, for a tablet, as the tenant's system caller). */
export async function readReceipt(db: Reader, receiptId: string): Promise<ReceiptRow | null> {
  const receipt = await db.subcontractReceipt.findUnique({ where: { id: receiptId }, select: { id: true, seq: true, siteId: true, workOrderId: true, subcontractOrderId: true, receivedAt: true, workshopDdtNumber: true } })
  if (!receipt) return null
  const order = await db.subcontractOrder.findUnique({ where: { id: receipt.subcontractOrderId }, select: { id: true, number: true, companyId: true, siteId: true, status: true, partyId: true, currency: true } })
  const workOrder = await db.workOrder.findUnique({ where: { id: receipt.workOrderId }, select: { id: true, number: true } })
  if (!order || !workOrder) return null
  const party = await db.party.findUnique({ where: { id: order.partyId }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const lines = await db.subcontractReceiptLine.findMany({
    where: { receiptId },
    select: { id: true, seq: true, subcontractOperationId: true, bundleId: true, goodQuantity: true, defectiveQuantity: true, scrappedQuantity: true, reasonCode: true, reasonNote: true },
    orderBy: { seq: 'asc' },
  })
  const operations = new Map((await db.subcontractOperation.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.subcontractOperationId))] } }, select: { id: true, seq: true, workOrderOperationId: true } })).map((row) => [row.id, row]))
  const steps = new Map((await db.workOrderOperation.findMany({ where: { id: { in: [...operations.values()].map((row) => row.workOrderOperationId) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const bundleIds = lines.flatMap((line) => (line.bundleId ? [line.bundleId] : []))
  const bundles = new Map((bundleIds.length ? await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
  const reported = await reportedLines(db, receipt.workOrderId, lines.map((line) => line.id))
  const decided = await rejectedLinesOf(db, receipt.id)
  return {
    id: receipt.id,
    seq: receipt.seq,
    siteId: receipt.siteId,
    workOrderId: receipt.workOrderId,
    receivedAt: receipt.receivedAt,
    workshopDdtNumber: receipt.workshopDdtNumber,
    order,
    workshop: party ? { id: party.id, code: party.code, name: nameOf(party) } : null,
    workOrder,
    lines: lines.map((line) => {
      const operation = operations.get(line.subcontractOperationId)
      const step = operation ? steps.get(operation.workOrderOperationId) : undefined
      return {
        id: line.id,
        seq: line.seq,
        operationId: line.subcontractOperationId,
        operationSeq: operation?.seq ?? 0,
        workOrderOperationId: operation?.workOrderOperationId ?? '',
        operationCode: step?.code ?? '',
        operationName: step?.name ?? '',
        bundleId: line.bundleId,
        bundleCode: line.bundleId ? (bundles.get(line.bundleId) ?? null) : null,
        good: line.goodQuantity,
        defective: line.defectiveQuantity,
        scrapped: line.scrappedQuantity,
        reasonCode: line.reasonCode,
        reasonNote: line.reasonNote,
        scanId: reported.get(line.id) ?? null,
      }
    }),
    rejected: { number: decided.number, lineIds: [...decided.lineIds] },
  }
}

export interface OpenedForReceipt {
  readonly id: string
  readonly number: string
  readonly words: { readonly it: string; readonly en: string }
}

/**
 * Inside the receive command, after the receipt and its lines are written: the incoming inspection a rule asks for, opened
 * now (null: no rule asks, or the rule could not open one: the receipt goes on as before, the rule's trail says why).
 */
export async function openForReceiptInCommand(tools: CommandTools, order: Pick<OrderRow, 'companyId'>, receiptId: string, pieces: number): Promise<OpenedForReceipt | null> {
  const work = await plannedOpenings(tools.tx, { type: 'subcontract_order.received', payload: { receiptId }, companyId: order.companyId })
  for (const item of work) {
    if (item.subject.type !== 'WORKSHOP') continue
    for (const opening of item.openings) {
      if (opening.kind !== 'INCOMING') continue
      const outcome = await openIncoming(tools, opening, item.subject)
      if ('opened' in outcome && outcome.opened.number) return { id: outcome.opened.id, number: outcome.opened.number, words: heldWords(pieces, outcome.opened.number) }
    }
  }
  return null
}

/** The receipt's lines as the receive answer's `outside` says them while they wait for the inspection (no scan). */
export async function heldReports(db: Reader, workOrderId: string, operations: readonly Pick<OperationRow, 'id' | 'workOrderOperationId'>[], receipt: { readonly lines: readonly { readonly id: string; readonly operationId: string; readonly bundleId: string | null }[] }, words: string): Promise<OutsideReport[]> {
  const steps = new Map((await db.workOrderOperation.findMany({ where: { workOrderId }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]))
  const bundleIds = receipt.lines.flatMap((line) => (line.bundleId ? [line.bundleId] : []))
  const codes = new Map((bundleIds.length ? await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
  return receipt.lines.map((line) => {
    const stepId = operations.find((operation) => operation.id === line.operationId)?.workOrderOperationId ?? ''
    const step = steps.get(stepId)
    return {
      receiptLineId: line.id,
      bundleId: line.bundleId,
      bundleCode: line.bundleId ? (codes.get(line.bundleId) ?? null) : null,
      operation: { id: stepId, seq: step?.seq ?? 0, code: step?.code ?? '', name: step?.name ?? '' },
      scanId: null,
      kind: null,
      goodQuantity: 0,
      scrapQuantity: 0,
      reworkQuantity: 0,
      words,
    }
  })
}

export interface ReleaseOutcome {
  /** Each line that was reported at its operation now (or why not). */
  readonly reports: readonly OutsideReport[]
  /** The good pieces moved to defective per rejected line. */
  readonly rejected: readonly { readonly lineId: string; readonly pieces: number }[]
  readonly ledger: { readonly posted: number; readonly waiting: readonly string[] }
}

/**
 * What the decision of a workshop receipt's incoming inspection does to the order (null rejected: the inspection was
 * cancelled, nothing rejected), inside the inspection's command (its row is held; then the order's row, then the work
 * order's scan lock in the outside reports: the receive command's own order of locks).
 */
export async function releaseReceiptInCommand(tools: CommandTools, inspection: { readonly id: string; readonly number: string; readonly subcontractReceiptId: string }, rejectedLineIds: ReadonlySet<string> | null): Promise<ReleaseOutcome> {
  const { tx } = tools
  const receipt = await readReceipt(tx, inspection.subcontractReceiptId)
  if (!receipt) throw new InvalidStateError('The receipt of this inspection is not found.')
  await tx.$queryRaw`SELECT "id" FROM "SubcontractOrder" WHERE "id" = ${receipt.order.id}::uuid FOR UPDATE`
  const order = (await tx.subcontractOrder.findUnique({ where: { id: receipt.order.id }, select: { id: true, number: true, status: true, companyId: true, siteId: true, workOrderId: true } }))!
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') throw new InvalidStateError(`Subcontract order ${order.number} is ${order.status}: its counts change no more.`)
  const rejected = rejectedLineIds ?? new Set<string>()
  const moved = receipt.lines.filter((line) => rejected.has(line.id) && line.good > 0).map((line) => ({ lineId: line.id, operationId: line.operationId, pieces: line.good }))
  const perOperation = new Map<string, number>()
  for (const entry of moved) perOperation.set(entry.operationId, (perOperation.get(entry.operationId) ?? 0) + entry.pieces)
  const before: Record<string, { good: number; defective: number }> = {}
  const after: Record<string, { good: number; defective: number }> = {}
  for (const [operationId, pieces] of perOperation) {
    const operation = (await tx.subcontractOperation.findUnique({ where: { id: operationId }, select: { piecesBackGood: true, piecesBackDefective: true } }))!
    before[operationId] = { good: operation.piecesBackGood, defective: operation.piecesBackDefective }
    after[operationId] = { good: operation.piecesBackGood - pieces, defective: operation.piecesBackDefective + pieces }
    await tx.subcontractOperation.update({ where: { id: operationId }, data: { piecesBackGood: { decrement: pieces }, piecesBackDefective: { increment: pieces }, version: { increment: 1 } }, select: { id: true } })
  }
  await tx.subcontractOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } }, select: { id: true } })
  // Every line kept and not yet reported goes on to the next operation as it came back (its counts are the line's).
  const toReport = receipt.lines.filter((line) => !rejected.has(line.id) && line.scanId === null)
  const reports = toReport.length
    ? await reportOutsideInCommand(
        tools,
        { workOrderId: order.workOrderId, number: order.number },
        toReport.map((line) => ({ lineId: line.id, receiptSeq: receipt.seq, bundleId: line.bundleId, workOrderOperationId: line.workOrderOperationId, good: line.good, defective: line.defective, scrapped: line.scrapped, reasonCode: line.reasonCode })),
      )
    : []
  const cost = await postCostsInCommand(tools, order.workOrderId, { subcontractOrderIds: [order.id] })
  tools.audit({
    action: RECEIPT_INSPECTED_ACTION,
    recordType: 'SubcontractReceipt',
    recordId: receipt.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { held: true, operations: before },
    after: {
      incomingInspectionId: inspection.id,
      number: inspection.number,
      outcome: rejectedLineIds === null ? 'CANCELLED' : 'DECIDED',
      rejectedLines: [...rejected],
      moved: moved.map((entry) => ({ lineId: entry.lineId, pieces: entry.pieces })),
      operations: after,
      reported: reports.filter((report) => report.scanId !== null).map((report) => report.receiptLineId),
    },
  })
  tools.emit({
    type: 'subcontract_order.updated',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { subcontractOrderId: order.id, number: order.number, status: order.status as 'AT_WORKSHOP', fields: ['incomingInspection', ...(moved.length > 0 ? ['piecesBackGood', 'piecesBackDefective'] : [])] },
  })
  return {
    reports,
    rejected: moved.map((entry) => ({ lineId: entry.lineId, pieces: entry.pieces })),
    ledger: { posted: cost.posted.filter((entry) => entry.kind === 'SUBCONTRACT').length, waiting: cost.waiting.filter((entry) => entry.sourceType === 'SubcontractOrder').map((entry) => entry.words) },
  }
}
