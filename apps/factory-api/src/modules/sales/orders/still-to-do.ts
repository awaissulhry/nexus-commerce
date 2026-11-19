import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { CHANGE_WORDS, type ChangeCell, type ExtraOutcome, type ExtraPieces, type WorkOrderChangeKind } from '@nexus/factory-domain/order-apply/rules'
import { PRODUCT_CHANGES_MANAGE } from '@nexus/factory-domain/product/changes/permissions'
import { TASK_DISPOSITIONS, type WipDisposition } from '@nexus/factory-domain/product/changes/rules'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { APPLY_WORDS, type ApplyTeam, type StillKind } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import type { Words } from '@nexus/factory-domain/sales/change-requests/rules'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { actorOf, type OfficeContext, type SystemContext } from '../../../core/context'
import { readProposals } from '../../planning/promise-keep/store'
import { wipTaskIdOf } from '../../product/changes/hooks'
import { cellsOf, CHANGE_COLUMNS, extraOf, mayDecide } from '../../production/work-order-changes/read'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import type { OrderRow, Reader } from './store'

/**
 * B-SA-050 (sales page plan R1, P6; 13-backend B4 "Still to do"; 14-change-flow §3.4; review C-8): what is still to do after the
 * customer's (and the office's) accepted changes of ONE order, COMPUTED FROM THE RECORDS — nothing is ticked by hand. Each row names
 * the record that closes it:
 *
 *   WORK_ORDER_CHANGE      a PROPOSED WorkOrderChange — closed by APPLIED, or DECLINED ("Left as is: <why>", the only stored
 *                          decision, ≤ 300 characters)                                                      waits on PLANNER
 *   EXTRA_PIECES           pieces cut beyond the new figure, by their outcome: CHARGE until the customer accepts the priced change
 *                          (the order's re-acceptance cleared), SCRAP until a scrap of the cell after the change stands with its
 *                          approval decided (or none needed); LEFTOVER is recorded with the change: nothing waits  CUSTOMER / PLANNER
 *   STYLE_CHANGE           a product change request a DESIGN request raised — closed when its change order is RELEASED (the
 *                          request DONE) or it is REJECTED                                                  waits on PRODUCT
 *   WORK_IN_PROGRESS_TASK  the task a released change order's REWORK or SCRAP line left on one of the order's work orders
 *                          (product/changes/hooks wipTaskIdOf) — closed when DONE or CANCELLED                waits on PLANNER
 *   REPROMISE              planning's re-promise of one of its lines still WAITING for sales — closed when accepted or
 *                          declined                                                                           waits on SALES
 *   TELL_WORKSHOP          an open subcontract order of a work order an accepted change changed — closed once a notice is
 *                          written to the workshop on it after the change (B-SA-054)                         waits on PLANNER
 *
 * `requestId` names the customer's request a row carries out (B-SA-046c: also a work-in-progress task of the change order a DESIGN
 * request's product change request is carried by); the portal reads only whether one is left per request ("Accepted · we are
 * carrying it out" / "Accepted · done"), never the rows.
 *
 * THE WALL: only this order's own records are read (its requests, its WorkOrderChanges, the work orders of its own lines); a work
 * order the reader does not reach (another customer's, a mixed one made before the one-customer rule) reads "a work order", with no
 * door and no number, and is counted in `workOrdersLeftOut`. A read: nothing is written.
 */


export interface StillRow {
  readonly kind: StillKind
  /**
   * The record that closes it (null: one the reader does not reach — counted, never named). B-OP-021: + its version, for the act
   * done in place (null: a record with none — an amendment, a re-promise).
   */
  readonly ref: { readonly type: string; readonly id: string; readonly number: string | null; readonly version: number | null } | null
  readonly words: Words
  /** Since when it waits. */
  readonly since: string
  readonly waitingOn: ApplyTeam
  /** The reader may act on it now (its own right over the record). */
  readonly mayAct: boolean
  /** The customer's request it carries out (null: an office change, or none). */
  readonly requestId: string | null
}

const STILL_WORDS = {
  extraCharged: (count: number): Words => ({ en: `${count} extra pieces charged: waiting for the customer to accept the priced change`, it: `${count} pezzi in più addebitati: aspetta che il cliente accetti la modifica con prezzo` }),
  extraScrap: (count: number, number: string | null): Words => ({ en: `Scrap the ${count} extra pieces of ${number ?? 'a work order'}, with their approval`, it: `Scarta i ${count} pezzi in più di ${number ?? 'un ordine di lavoro'}, con la loro approvazione` }),
  styleWaiting: (number: string | null, style: string): Words => ({ en: `${APPLY_WORDS.styleChange(style, number).en}: waiting for product`, it: `${APPLY_WORDS.styleChange(style, number).it}: aspetta il prodotto` }),
  wipTask: (disposition: WipDisposition, number: string | null, revision: number | null): Words => {
    const wo = { en: number ?? 'a work order', it: number ?? 'un ordine di lavoro' }
    const to = revision !== null ? { en: ` to revision ${revision}`, it: ` alla revisione ${revision}` } : { en: '', it: '' }
    return disposition === 'REWORK' ? { en: `Open the rework of ${wo.en}${to.en}`, it: `Apri la rilavorazione di ${wo.it}${to.it}` } : { en: `Scrap what is made of ${wo.en}, with its own approval`, it: `Scarta ciò che è fatto di ${wo.it}, con la sua approvazione` }
  },
  repromise: (seq: number): Words => ({ en: `A new date for line ${seq} waits for your answer`, it: `Una nuova data per la riga ${seq} aspetta la tua risposta` }),
  workshop: (number: string | null): Words => (number ? { en: `Tell the outside workshop on ${number}`, it: `Avvisa il terzista su ${number}` } : { en: 'Tell an outside workshop', it: 'Avvisa un terzista' }),
} as const

/** Subcontract orders whose pieces are out at the workshop (production/brand facts' own set). */
const AT_WORKSHOP = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'] as const
const OPEN_TASK = 'OPEN'

/** The open subcontract orders of these work orders. */
export async function openSubcontractsOf(db: Reader, workOrderIds: readonly string[]): Promise<{ id: string; number: string; workOrderId: string; version: number }[]> {
  if (workOrderIds.length === 0) return []
  return db.subcontractOrder.findMany({ where: { workOrderId: { in: [...workOrderIds] }, status: { in: [...AT_WORKSHOP] } }, select: { id: true, number: true, workOrderId: true, version: true /* B-OP-021 */ }, orderBy: { number: 'asc' } })
}

/** The subcontract orders whose workshop was told since then: a notice written to it on the subcontract order (B-SA-054). */
export async function toldSubcontractsOf(db: Reader, subcontractIds: readonly string[], since: Date): Promise<Set<string>> {
  if (subcontractIds.length === 0) return new Set()
  const rows = await db.notification.findMany({ where: { recordType: 'SubcontractOrder', recordId: { in: [...subcontractIds] }, partyId: { not: null }, createdAt: { gte: since } }, select: { recordId: true }, distinct: ['recordId'] })
  return new Set(rows.map((row) => row.recordId))
}

/**
 * The order's Still to do for this reader (see the file's head), oldest first. B-SA-052: the system line's writer counts it as the
 * system (`count` does not depend on the reader; the system reaches no work order, so it names none).
 */
export async function stillToDoOf(db: Reader, context: OfficeContext | SystemContext, order: Pick<OrderRow, 'id' | 'companyId' | 'partyId' | 'reapprovalNeededAt'>): Promise<{ rows: StillRow[]; count: number; workOrdersLeftOut: number }> {
  const actor = actorOf(context)
  const place = { companyId: order.companyId, partyId: order.partyId }
  const rows: StillRow[] = []
  const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true } })
  const seqOf = new Map(lines.map((line) => [line.id, line.seq]))
  const changes = await db.workOrderChange.findMany({ where: { salesOrderId: order.id, status: { in: ['PROPOSED', 'APPLIED'] } }, select: CHANGE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  // The work orders of its own lines (and those its changes name), read once, through the wall.
  const own = lines.length > 0 ? await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lines.map((line) => line.id) } }, select: { workOrderId: true }, distinct: ['workOrderId'] }) : []
  const workOrderIds = [...new Set([...own.map((cell) => cell.workOrderId), ...changes.flatMap((change) => (change.workOrderId ? [change.workOrderId] : []))])]
  const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, partyId: true, version: true /* B-OP-021 */ } }) : []).map((row) => [row.id, row]))
  const reached = (id: string | null) => {
    const workOrder = id ? workOrders.get(id) : undefined
    return workOrder && reachesWorkOrder(actor, WORKORDERS_VIEW, workOrder) ? workOrder : null
  }
  const leftOut = new Set<string>()
  const named = (id: string | null) => {
    const workOrder = reached(id)
    if (id && !workOrder) leftOut.add(id)
    return workOrder
  }

  // WORK_ORDER_CHANGE: each PROPOSED change (APPLIED / DECLINED close it; STALE is replaced).
  for (const change of changes) {
    const workOrder = named(change.workOrderId)
    const cells: readonly ChangeCell[] = cellsOf(change)
    const extra: readonly ExtraPieces[] = extraOf(change)
    const count = extra.reduce((sum, piece) => sum + piece.count, 0)
    if (change.status === 'PROPOSED') {
      rows.push({
        kind: 'WORK_ORDER_CHANGE',
        ref: !change.workOrderId || workOrder ? { type: 'WorkOrderChange', id: change.id, number: workOrder?.number ?? null, version: change.version } : null,
        words: APPLY_WORDS.work(change.kind as WorkOrderChangeKind, workOrder?.number ?? null, CHANGE_WORDS.cells(cells), count),
        since: toUtcIso(change.createdAt),
        waitingOn: 'PLANNER',
        mayAct: (!change.workOrderId || workOrder !== null) && mayDecide(actor, change, workOrder),
        requestId: change.requestId,
      })
    }
    // EXTRA_PIECES by their outcome (LEFTOVER: recorded with the change, nothing waits).
    const outcome = (change.extraOutcome as ExtraOutcome | null) ?? null
    if (count === 0 || outcome === null || outcome === 'LEFTOVER') continue
    if (outcome === 'CHARGE') {
      const amendment = change.amendmentId ? await db.salesOrderAmendment.findUnique({ where: { id: change.amendmentId }, select: { id: true, revision: true, reacceptanceNeeded: true } }) : null
      if (amendment && amendment.reacceptanceNeeded && order.reapprovalNeededAt !== null) {
        rows.push({ kind: 'EXTRA_PIECES', ref: { type: 'SalesOrderAmendment', id: amendment.id, number: String(amendment.revision), version: null }, words: STILL_WORDS.extraCharged(count), since: toUtcIso(change.createdAt), waitingOn: 'CUSTOMER', mayAct: false, requestId: change.requestId })
      }
      continue
    }
    // SCRAP: a scrap of one of the extra pieces' cells after the change stands, its approval decided (or none was needed).
    const cellIds = [...new Set(extra.map((piece) => piece.workOrderSizeId))]
    const scans = change.workOrderId && cellIds.length > 0 ? await db.operationScan.findMany({ where: { workOrderId: change.workOrderId, scrapQuantity: { gt: 0 }, serverTime: { gte: change.createdAt } /* S7 end check: a scan has no createdAt; serverTime orders scans */, bundle: { is: { workOrderSizeId: { in: cellIds } } } }, select: { id: true } }) : []
    const waiting = scans.length > 0 ? await db.scrapApproval.count({ where: { scanId: { in: scans.map((scan) => scan.id) }, status: 'WAITING' } }) : 0
    if (scans.length === 0 || waiting > 0) {
      rows.push({
        kind: 'EXTRA_PIECES',
        ref: workOrder ? { type: 'WorkOrder', id: workOrder.id, number: workOrder.number, version: workOrder.version } : null,
        words: STILL_WORDS.extraScrap(count, workOrder?.number ?? null),
        since: toUtcIso(change.createdAt),
        waitingOn: 'PLANNER',
        mayAct: workOrder !== null && reachesWorkOrder(actor, WORKORDERS_MANAGE, workOrder),
        requestId: change.requestId,
      })
    }
  }

  // STYLE_CHANGE: the product change requests the order's DESIGN requests raised, until released or refused.
  const requests = await db.orderChangeRequest.findMany({ where: { orderId: order.id, status: 'ACCEPTED' }, select: { id: true, kind: true, answeredAt: true } })
  const designIds = requests.filter((request) => request.kind === 'DESIGN').map((request) => request.id)
  const raised = designIds.length > 0 ? await db.changeRequest.findMany({ where: { orderChangeRequestId: { in: designIds }, status: { notIn: ['DONE', 'REJECTED'] } }, select: { id: true, number: true, companyId: true, styleId: true, createdAt: true, orderChangeRequestId: true, version: true /* B-OP-021 */ }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : []
  const styles = new Map((raised.length > 0 ? await db.style.findMany({ where: { id: { in: [...new Set(raised.map((row) => row.styleId))] } }, select: { id: true, code: true } }) : []).map((style) => [style.id, style.code]))
  for (const request of raised) {
    rows.push({ kind: 'STYLE_CHANGE', ref: { type: 'ChangeRequest', id: request.id, number: request.number, version: request.version }, words: STILL_WORDS.styleWaiting(request.number, styles.get(request.styleId) ?? ''), since: toUtcIso(request.createdAt), waitingOn: 'PRODUCT', mayAct: can(actor, PRODUCT_CHANGES_MANAGE, { companyId: request.companyId }), requestId: request.orderChangeRequestId })
  }

  // WORK_IN_PROGRESS_TASK: the tasks released change orders' REWORK and SCRAP lines left on the order's own work orders.
  const ownIds = own.map((cell) => cell.workOrderId)
  const items = ownIds.length > 0 ? await db.changeOrderItem.findMany({ where: { kind: 'WORK_IN_PROGRESS', workOrderId: { in: ownIds }, disposition: { in: [...TASK_DISPOSITIONS] }, changeOrder: { is: { status: 'RELEASED' } } }, select: { changeOrderId: true, workOrderId: true, disposition: true, changeOrder: { select: { toRevisionId: true } } } }) : []
  const taskIds = items.map((item) => wipTaskIdOf(item.changeOrderId, item.workOrderId!))
  const tasks = new Map((taskIds.length > 0 ? await db.task.findMany({ where: { id: { in: taskIds }, status: OPEN_TASK }, select: { id: true, assigneeId: true, createdAt: true, version: true /* B-OP-021 */ } }) : []).map((task) => [task.id, task]))
  // B-SA-046c: a task a design change's change order left carries that customer's request (its product change request names it),
  // so the customer reads "we are carrying it out" until the rework or scrap is done.
  const changeOrderIds = [...new Set(items.map((item) => item.changeOrderId))]
  const carried = new Map((designIds.length > 0 && changeOrderIds.length > 0 ? await db.changeRequest.findMany({ where: { changeOrderId: { in: changeOrderIds }, orderChangeRequestId: { in: designIds } }, select: { changeOrderId: true, orderChangeRequestId: true } }) : []).flatMap((row) => (row.changeOrderId && row.orderChangeRequestId ? [[row.changeOrderId, row.orderChangeRequestId] as const] : [])))
  const revisionIds = [...new Set(items.flatMap((item) => (item.changeOrder.toRevisionId ? [item.changeOrder.toRevisionId] : [])))]
  const revisions = new Map((revisionIds.length > 0 ? await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } }) : []).map((row) => [row.id, row.revision]))
  for (const item of items) {
    const task = tasks.get(wipTaskIdOf(item.changeOrderId, item.workOrderId!))
    if (!task) continue
    const workOrder = named(item.workOrderId)
    const revision = item.changeOrder.toRevisionId ? (revisions.get(item.changeOrder.toRevisionId) ?? null) : null
    rows.push({
      kind: 'WORK_IN_PROGRESS_TASK',
      ref: workOrder ? { type: 'Task', id: task.id, number: workOrder.number, version: task.version } : null,
      words: STILL_WORDS.wipTask(item.disposition as WipDisposition, workOrder?.number ?? null, revision),
      since: toUtcIso(task.createdAt),
      waitingOn: 'PLANNER',
      mayAct: workOrder !== null && (task.assigneeId === context.actorId || reachesWorkOrder(actor, WORKORDERS_MANAGE, workOrder)),
      requestId: carried.get(item.changeOrderId) ?? null, // B-SA-046c
    })
  }

  // REPROMISE: planning's re-promises of its lines still waiting for sales (never answered by who proposed it).
  const manages = can(actor, ORDERS_MANAGE, place)
  for (const proposal of (await readProposals(db, [order.id])).filter((entry) => entry.state === 'WAITING')) {
    rows.push({ kind: 'REPROMISE', ref: { type: 'RePromise', id: proposal.id, number: null, version: null }, words: STILL_WORDS.repromise(seqOf.get(proposal.orderLineId) ?? 0), since: toUtcIso(proposal.proposedAt), waitingOn: 'SALES', mayAct: manages && proposal.proposedById !== context.actorId, requestId: null })
  }

  // TELL_WORKSHOP: the workshops of the work orders an accepted request's changes name, not told since its answer.
  for (const request of requests) {
    if (!request.answeredAt) continue
    const changed = [...new Set(changes.filter((change) => change.requestId === request.id).flatMap((change) => (change.workOrderId ? [change.workOrderId] : [])))]
    const outside = await openSubcontractsOf(db, changed)
    const told = await toldSubcontractsOf(db, outside.map((entry) => entry.id), request.answeredAt)
    for (const entry of outside) {
      if (told.has(entry.id)) continue
      const workOrder = named(entry.workOrderId)
      rows.push({ kind: 'TELL_WORKSHOP', ref: workOrder ? { type: 'SubcontractOrder', id: entry.id, number: entry.number, version: entry.version } : null, words: STILL_WORDS.workshop(workOrder ? entry.number : null), since: toUtcIso(request.answeredAt), waitingOn: 'PLANNER', mayAct: false, requestId: request.id })
    }
  }

  rows.sort((a, b) => a.since.localeCompare(b.since))
  return { rows, count: rows.length, workOrdersLeftOut: leftOut.size }
}
