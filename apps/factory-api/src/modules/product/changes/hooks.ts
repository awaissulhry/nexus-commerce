import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { releaseRefusal, type ChangeEffect } from '@nexus/factory-domain/product/changes/rules'
import { StaleVersionError, type CommandTools } from '../../../core/command'
import { dayOf, lockOrder, refuse, ChangeRefusedError } from './store'

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
}
