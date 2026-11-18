import { createHash } from 'node:crypto'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { releaseRefusal, type ChangeEffect } from '@nexus/factory-domain/product/changes/rules'
import { StaleVersionError, type CommandTools } from '../../../core/command'
import { dayOf, lockOrder, refuse, ChangeRefusedError } from './store'
// B-SA-049 (sales page plan R3, P7; 13-backend B6; review F-5): the work-in-progress decisions carried out on release.
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { CHANGE_ORDER_HOLD_REASON, CHANGE_ORDER_HOLD_WORDS, DISPOSITION_WORDS, HOLDING_DISPOSITIONS, releaseHoldsRefusal, TASK_DISPOSITIONS, wipTaskTitle, type WipDisposition } from '@nexus/factory-domain/product/changes/rules'
import { PRODUCTION_HOLD_LIST } from '@nexus/factory-domain/production/holds/kinds'
import { WORKORDERS_HOLD } from '@nexus/factory-domain/production/work-orders/permissions'
import { actorOf, type OfficeContext } from '../../../core/context'
import { addStandardInCommand } from '../../../platform/reasons/reasons'
import { reasonFor } from '../../../platform/reasons/service'
import { followInCommand } from '../../../platform/threads/followers'
import { placeWorkOrderHoldsInCommand } from '../../production/holds/holds'
import { supervisorOfWorkOrder } from '../../production/supervisor/resolver'
import { reachesWorkOrder } from '../../production/work-orders/scope'

/**
 * The change order's two seams in W1's revision commands (modules/product/bom/revisions.ts, one line each, marked B-W2b-226),
 * so the redlines are a real revision of the style made and released by W1's own copy and release (its checks, effectivity,
 * type-change reviews, events), in the same transaction as the change order's move:
 *
 *   copy     `linkDraftInCommand`: the change order's "Start the draft revision" copies the released revision into the next
 *            DRAFT (the edit rule lets a new revision through for it under CHANGE_ORDER) and names it the proposed revision
 *   release  `changeOrderAtReleaseInCommand` before the release: a draft that a live change order proposes is released only
 *            once that order is APPROVED (and not before its day); `releaseChangeOrderInCommand` after it: the order is
 *            RELEASED by the person who released the revision, and its requests are DONE
 */

export interface DraftFor {
  readonly id: string
  readonly number: string
  /** The change order's version the caller read. */
  readonly version: number
}

/** Inside W1's copy, after the new DRAFT revision's row: the change order proposes it. */
export async function linkDraftInCommand(tools: CommandTools, changeOrder: DraftFor, draft: { readonly styleId: string; readonly revisionId: string; readonly revision: number }): Promise<void> {
  const order = await lockOrder(tools.tx, changeOrder.id)
  if (order.version !== changeOrder.version) throw new StaleVersionError('ChangeOrder', order.id, order.version, changeOrder.version)
  if (order.status !== 'DRAFT' || order.toRevisionId !== null || order.styleId !== draft.styleId) {
    throw new ChangeRefusedError({ code: 'ORDER_NOT_DRAFT', message: `Change order ${order.number} already proposes a revision, or is no longer a draft: load it again.` })
  }
  await tools.tx.changeOrder.update({ where: { id: order.id }, data: { toRevisionId: draft.revisionId, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'product.changes.startDraft', recordType: 'ChangeOrder', recordId: order.id, companyId: order.companyId, before: { toRevisionId: null }, after: { toRevisionId: draft.revisionId, revision: draft.revision } })
  tools.emit({ type: 'change_order.changed', subject: order.id, companyId: order.companyId, payload: { changeOrderId: order.id, number: order.number, styleId: order.styleId, status: order.status, change: 'REVISION_LINKED', approverIds: [] } })
}

export interface ReleasingOrder {
  readonly id: string
}

/**
 * Inside W1's release, before anything changes: the live change order that proposes this draft, if any. A DRAFT or SUBMITTED
 * one refuses the release in words (the four eyes first); an APPROVED one before its day too.
 */
export async function changeOrderAtReleaseInCommand(tools: CommandTools, revision: { readonly styleId: string; readonly revisionId: string }): Promise<ReleasingOrder | null> {
  const live = await tools.tx.changeOrder.findFirst({ where: { toRevisionId: revision.revisionId, status: { in: ['DRAFT', 'SUBMITTED', 'APPROVED'] } }, select: { id: true } })
  if (!live) return null
  const order = await lockOrder(tools.tx, live.id)
  refuse(releaseRefusal({ number: order.number, status: order.status, effect: order.effect as ChangeEffect, effectiveDate: dayOf(order.effectiveDate) }, businessDate(tools.now)))
  if (tools.context.audience !== 'office') throw new ForbiddenError(`Change order ${order.number} is released by a person.`)
  // B-SA-049 (review F-5): releasing places the holds its HOLD and REWORK lines ask for — refused, before anything changes, unless
  // the releaser may hold each of those work orders (workorders.hold over its company, site and customer).
  const actor = actorOf(tools.context as OfficeContext)
  const unheld = (await holdingLinesOf(tools, order.id)).filter((line) => !reachesWorkOrder(actor, WORKORDERS_HOLD, line.workOrder))
  if (unheld.length > 0) throw new ChangeRefusedError(releaseHoldsRefusal(unheld.map((line) => line.workOrder.number)))
  return { id: order.id }
}

/** Inside W1's release, after the revision is RELEASED: the change order RELEASED and its requests DONE. */
export async function releaseChangeOrderInCommand(tools: CommandTools, releasing: ReleasingOrder): Promise<void> {
  const { tx, now } = tools
  const releasedById = tools.context.audience === 'office' ? tools.context.actorId : null
  const order = await lockOrder(tx, releasing.id)
  await tx.changeOrder.update({ where: { id: order.id }, data: { status: 'RELEASED', releasedAt: now, releasedById, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'product.changes.release', recordType: 'ChangeOrder', recordId: order.id, companyId: order.companyId, before: { status: order.status }, after: { status: 'RELEASED', releasedAt: toUtcIso(now), releasedById, toRevisionId: order.toRevisionId } })
  tools.emit({ type: 'change_order.changed', subject: order.id, companyId: order.companyId, payload: { changeOrderId: order.id, number: order.number, styleId: order.styleId, status: 'RELEASED', change: 'RELEASED', approverIds: [] } })
  const requests = await tx.changeRequest.findMany({ where: { changeOrderId: order.id, status: 'ACCEPTED' }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true } })
  for (const request of requests) {
    await tx.changeRequest.update({ where: { id: request.id }, data: { status: 'DONE', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'product.changes.requestDone', recordType: 'ChangeRequest', recordId: request.id, companyId: request.companyId, siteId: request.siteId, before: { status: 'ACCEPTED' }, after: { status: 'DONE', changeOrderId: order.id } })
    tools.emit({ type: 'change_request.changed', subject: request.id, companyId: request.companyId, siteId: request.siteId, payload: { changeRequestId: request.id, number: request.number!, styleId: request.styleId, status: 'DONE', changeOrderId: order.id, change: 'DONE' } })
  }
  // B-SA-049: then each work-in-progress decision carried out (it was a record only before).
  await carryOutWorkInProgressInCommand(tools, { id: order.id, number: order.number, toRevisionId: order.toRevisionId })
}

// ── B-SA-049 (sales page plan R3, P7; 13-backend B6; review F-5, BW-9) ──────────────────────────────────────────────────────────
/**
 * A change order's work-in-progress decisions carried out when it is released, in the release's own command:
 *
 *   HOLD        a real production hold on the work order (reason CHANGE_ORDER, its standard words "Design change in progress"), the
 *               office's note "ECO-… released", the customer reading only "Being updated to the new design" (its language)
 *   REWORK      the same hold, and a task on the work order to its supervisor (else the releaser): "Open the rework of WO-… to
 *               revision N" — no rework order is made (it needs a cell, an operation and a count the change order does not hold)
 *   SCRAP       a task only: the scrap keeps its own approval
 *   FINISH_OLD  nothing: its frozen revision stays
 *
 * A work order no longer open (completed, closed, cancelled) has nothing in progress: it is left as it is. The work-in-progress
 * lines were set by a person of every customer (B-PR-37), so a hold never reaches a work order its customer did not decide on;
 * the hold's customer words name no other work order. Each task's id is derived from the change order and the work order
 * (`wipTaskIdOf`): a replayed release writes none twice, and the order's "Still to do" finds it (B-SA-050).
 */

/** A UUID (version 8, RFC 9562) derived from a text: the same text, the same id. */
function derivedId(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The task a REWORK or SCRAP line of a change order leaves on its work order. */
export const wipTaskIdOf = (changeOrderId: string, workOrderId: string): string => derivedId(`change-order-wip|${changeOrderId}|${workOrderId}`)

const OPEN_WORK = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const

interface WipLine {
  readonly disposition: WipDisposition
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: string; readonly companyId: string; readonly siteId: string; readonly partyId: string | null }
}

/** The change order's work-in-progress lines on work orders still open, in their order. */
async function wipLinesOf(tools: Pick<CommandTools, 'tx'>, changeOrderId: string): Promise<WipLine[]> {
  const items = await tools.tx.changeOrderItem.findMany({ where: { changeOrderId, kind: 'WORK_IN_PROGRESS', workOrderId: { not: null }, disposition: { not: null } }, select: { workOrderId: true, disposition: true }, orderBy: { seq: 'asc' } })
  if (items.length === 0) return []
  const rows = new Map((await tools.tx.workOrder.findMany({ where: { id: { in: items.map((item) => item.workOrderId!) } }, select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true } })).map((row) => [row.id, row]))
  return items.flatMap((item) => {
    const workOrder = rows.get(item.workOrderId!)
    return workOrder && (OPEN_WORK as readonly string[]).includes(workOrder.status) ? [{ disposition: item.disposition as WipDisposition, workOrder: { ...workOrder, status: workOrder.status as string } }] : []
  })
}

/** The lines whose release holds their work order (HOLD, REWORK). */
const holdingLinesOf = async (tools: Pick<CommandTools, 'tx'>, changeOrderId: string): Promise<WipLine[]> => (await wipLinesOf(tools, changeOrderId)).filter((line) => HOLDING_DISPOSITIONS.includes(line.disposition))

/** The customer's language for its hold words: its own, else Italian (the factory's). */
async function customerLocale(tools: Pick<CommandTools, 'tx'>, partyId: string | null): Promise<'it' | 'en'> {
  if (!partyId) return 'it'
  const party = await tools.tx.party.findUnique({ where: { id: partyId }, select: { language: true } })
  return party?.language?.toLowerCase().startsWith('en') ? 'en' : 'it'
}

const [taskCreated, taskAssigned] = taskEvents

async function carryOutWorkInProgressInCommand(tools: CommandTools, order: { readonly id: string; readonly number: string; readonly toRevisionId: string | null }): Promise<void> {
  const lines = await wipLinesOf(tools, order.id)
  if (lines.length === 0) return
  const { tx, now } = tools
  const releaserId = tools.context.audience === 'office' ? tools.context.actorId : null
  const holding = lines.filter((line) => HOLDING_DISPOSITIONS.includes(line.disposition))
  if (holding.length > 0) {
    // A tenant whose hold list was made before this reason existed gets the standard one now (data, no schema: a code it already
    // has, even switched off, is never touched — a switched-off one refuses the release in the hold's own words).
    if (!(await reasonFor(tx, PRODUCTION_HOLD_LIST, CHANGE_ORDER_HOLD_REASON))) await addStandardInCommand(tools, PRODUCTION_HOLD_LIST)
    for (const line of holding) {
      const words = CHANGE_ORDER_HOLD_WORDS[await customerLocale(tools, line.workOrder.partyId)]
      await placeWorkOrderHoldsInCommand(tools, { workOrderIds: [line.workOrder.id], kind: 'PRODUCTION', reasonCode: CHANGE_ORDER_HOLD_REASON, note: `${order.number} released: ${DISPOSITION_WORDS[line.disposition]}.`, brandWords: words })
    }
  }
  const revision = order.toRevisionId ? (await tx.styleRevision.findUnique({ where: { id: order.toRevisionId }, select: { revision: true } }))?.revision ?? null : null
  for (const line of lines.filter((entry) => TASK_DISPOSITIONS.includes(entry.disposition))) {
    const id = wipTaskIdOf(order.id, line.workOrder.id)
    if (await tx.task.findUnique({ where: { id }, select: { id: true } })) continue
    const assigneeId = (await supervisorOfWorkOrder(tx, line.workOrder.id))?.userId ?? releaserId
    const title = wipTaskTitle(line.disposition, line.workOrder.number, revision)
    const scope = { companyId: line.workOrder.companyId, siteId: line.workOrder.siteId }
    await tx.task.create({
      data: {
        id,
        companyId: line.workOrder.companyId,
        siteId: line.workOrder.siteId,
        partyId: line.workOrder.partyId,
        title,
        description: `${order.number} released: ${DISPOSITION_WORDS[line.disposition]}.`,
        recordType: 'WorkOrder',
        recordId: line.workOrder.id,
        recordLabel: line.workOrder.number,
        assigneeId,
        assignedById: assigneeId ? releaserId : null,
        assignedAt: assigneeId ? now : null,
        checklist: [],
        createdAt: now,
        updatedAt: now,
        createdById: releaserId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: id, ...scope, after: { title, status: 'OPEN', assigneeId, recordType: 'WorkOrder', recordId: line.workOrder.id, by: 'product.changes.release', changeOrderId: order.id, disposition: line.disposition } })
    tools.audit({ action: 'tasks.create', recordType: 'WorkOrder', recordId: line.workOrder.id, ...scope, after: { taskId: id, title } })
    const about = { taskId: id, recordType: 'WorkOrder', recordId: line.workOrder.id }
    tools.emit(eventFor(taskCreated, { subject: id, ...scope, payload: { ...about, assigneeId } }))
    if (assigneeId) {
      tools.emit(eventFor(taskAssigned, { subject: id, ...scope, payload: { ...about, assigneeId, assignedById: releaserId } }))
      await followInCommand(tools, { type: 'WorkOrder', id: line.workOrder.id, companyId: line.workOrder.companyId, siteId: line.workOrder.siteId }, assigneeId, 'ASSIGNEE', releaserId)
    }
  }
}
// ── end B-SA-049 ──
