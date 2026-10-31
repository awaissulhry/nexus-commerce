import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { confirmByProblem, moveConfirmByProblem, reminderState } from '@nexus/factory-domain/purchasing/orders/delivery'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { detailInCommand, onOrder } from '../orders'
import { officeContextOf, officeOrder, type Reader } from '../store'
import { remindersOn } from './settings'

/**
 * The supplier's confirm-by deadline and the reminders of an order (B-W2a-52; SCM-087): the office moves the deadline
 * while the order waits (purchasing.manage: nothing goes to the supplier; the trigger keeps it after the send time), and
 * reads the reminders sent (record › Sends "Reminders sent": every revision's, who, when, to which address, the mail's
 * delivery) with where the next stands.
 */

export interface MoveBody {
  readonly version: number
  readonly confirmBy: string
}

/** POST /purchasing/orders/:purchaseOrderId/confirm-by (purchasing.manage). */
export async function moveConfirmBy(caller: CommandCaller, orderId: string, body: MoveBody, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.moveConfirmBy', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const problem = moveConfirmByProblem(current.status)
    if (problem) throw new InvalidStateError(problem)
    const { tx, now } = tools
    const links = await tx.oneOffLink.findMany({ where: { recordType: 'PurchaseOrder', recordId: current.id, purpose: 'PO_CONFIRM', revokedAt: null }, select: { expiresAt: true, revokedAt: true, uses: true, maxUses: true } })
    const live = links.filter((link) => linkState(link, now) === 'LIVE').map((link) => link.expiresAt.getTime())
    const confirmBy = new Date(body.confirmBy)
    const refused = confirmByProblem(confirmBy, { now, sentAt: current.sentAt, linkExpiresAt: live.length > 0 ? new Date(Math.max(...live)) : null })
    if (refused) throw new ValidationError(refused, [{ path: 'body/confirmBy', message: refused }])
    await tx.purchaseOrder.update({ where: { id: current.id }, data: { confirmBy }, select: { id: true } })
    tools.audit({ action: 'purchasing.moveConfirmBy', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { confirmBy: current.confirmBy ? toUtcIso(current.confirmBy) : null }, after: { confirmBy: toUtcIso(confirmBy) } })
    tools.emit({ type: 'purchase_order.confirm_by_moved', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, confirmBy: toUtcIso(confirmBy) } })
    return detailInCommand(tools, current.id)
  })
}

/** The reminders of one order, with where the next one stands (also the due list's row). */
export async function remindersOf(db: Reader, order: { readonly id: string; readonly status: string; readonly revision: number; readonly confirmBy: Date | null }, now: Date) {
  const rows = await db.purchaseOrderReminder.findMany({
    where: { purchaseOrderId: order.id },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    select: { id: true, revision: true, kind: true, sentAt: true, sentById: true, toAddress: true, emailOutboundId: true, note: true },
  })
  const people = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.sentById ? [row.sentById] : [])))] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const mailIds = rows.flatMap((row) => (row.emailOutboundId ? [row.emailOutboundId] : []))
  const mails = new Map((mailIds.length === 0 ? [] : await db.emailOutbound.findMany({ where: { id: { in: mailIds } }, select: { id: true, status: true } })).map((mail) => [mail.id, mail.status]))
  const state = reminderState({ status: order.status, revision: order.revision, confirmBy: order.confirmBy, reminders: rows.filter((row) => row.revision === order.revision) }, now)
  return {
    confirmBy: order.confirmBy ? toUtcIso(order.confirmBy) : null,
    overdue: state.overdue,
    sentForRevision: state.sent,
    nextAutomaticAt: state.nextAt ? toUtcIso(state.nextAt) : null,
    reminders: rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      kind: row.kind,
      sentAt: toUtcIso(row.sentAt),
      automatic: row.sentById === null,
      sentById: row.sentById,
      sentByName: row.sentById ? (people.get(row.sentById) ?? null) : null,
      to: row.toAddress,
      emailId: row.emailOutboundId,
      mailStatus: row.emailOutboundId ? (mails.get(row.emailOutboundId) ?? null) : null,
      note: row.note,
    })),
  }
}

/** GET /purchasing/orders/:purchaseOrderId/reminders (purchasing.view). */
export async function orderReminders(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const tenantId = officeContextOf(caller).tenantId
  // B-W2b-14: the Owner's switch for the order's company (its row, else the tenant's, else OFF).
  return caller.withClient(async (client) => ({ purchaseOrderId: order.id, number: order.number, status: order.status, revision: order.revision, automatic: await remindersOn(client, tenantId, order.companyId), ...(await remindersOf(client, order, serverClock.now())) }))
}
