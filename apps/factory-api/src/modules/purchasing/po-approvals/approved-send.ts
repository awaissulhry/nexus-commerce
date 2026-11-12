import { parsePreview } from '@nexus/factory-domain/approvals/rules'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { PO_APPROVAL_WORDS, sendOptionsOf } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { z } from 'zod'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../../platform/auth/roles/access'
import { processEmail } from '../../../platform/email-out/service'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { ensureThread, mentionProblems, writeMessage } from '../../../platform/threads/threads'
import { sendAs, type SendHost } from '../send'

/**
 * Sent with the yes (B-W2b-305; SCM-078): the worker's handler of purchase_order.approved. The order that waited for its
 * yes is sent exactly as the Send dialog sends it (modules/purchasing/send.ts sendAs: the checks again, the PDF, the
 * confirm link, the mail on the order's thread, purchase_order.sent; the mail leaves with its link from this process right
 * after the commit), as the person who asked: their office context with their roles as they are now (a person who left,
 * or who can no longer send purchase orders, sends nothing), over the system's client (the same tenant wall), with the
 * words they wrote in the Send dialog (kept on the request). ONE command keyed by the request, so a repeated job answers
 * from its receipt and sends nothing twice.
 *
 * A send refused in words (a send check failed since the request: the supplier blocked, its contact gone; or the person's
 * rights) is held, not retried: an internal note on the order's thread names the reason and mentions the person who asked,
 * purchase_order.send_held says so live, and the order waits with its yes until the buyer's Send (the gate sends an
 * approved order while it does not change). Anything else (the database, the file store) is the job's error: retried.
 */

export const APPROVED_SEND_HANDLER = 'purchasing.sendApproved'

const payload = z.object({ purchaseOrderId: z.uuid(), number: z.string(), taskId: z.uuid() })

/** The person who asked, as their live roles make them now, over the system's client (no person, or one who left: no grants). */
async function asPerson(system: CommandCaller, userId: string, now: Date): Promise<CommandCaller> {
  const base = system.factoryContext
  if (!base || !('tenantId' in base) || !base.tenantId) throw new Error('purchasing.sendApproved: a caller outside a tenant')
  const grants = await system.withClient(async (client) => {
    const user = await client.user.findUnique({ where: { id: userId }, select: { requireMfa: true, status: true } })
    if (!user || user.status !== 'ACTIVE') return []
    return sessionGrants(user, await heldRoles(client, userId, now), true)
  })
  const context: OfficeContext = Object.freeze({ audience: 'office', tenantId: base.tenantId, actorId: userId, grants, requestId: base.requestId })
  return { factoryContext: context, withClient: (work) => system.withClient(work) }
}

/** The reasons a refused send gives, as short codes for the event (the paths of its issues, else its code). */
const codesOf = (error: DomainError): string[] => [...new Set((error.issues ?? []).map((issue) => String(issue.path).slice(0, 60)))].slice(0, 40).filter((code) => code.length > 0)

/** The send could not go: the note for the person who asked, and the event. The order keeps its yes. */
async function holdSend(system: CommandCaller, order: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string }, askerId: string, taskId: string, error: DomainError, eventId: string): Promise<void> {
  await command(system, { name: 'purchasing.sendApprovedHeld', idempotencyKey: `po-approved-held-${eventId}`, input: { purchaseOrderId: order.id, taskId } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'PurchaseOrder', id: order.id }, null)
    const mentions = (await mentionProblems(tools.tx, tools.context, thread, [askerId], tools.now)).length === 0 ? [askerId] : []
    await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(PO_APPROVAL_WORDS.heldSend(error.message)), mentions })
    const codes = codesOf(error)
    tools.audit({ action: 'purchasing.sendApprovedHeld', recordType: 'PurchaseOrder', recordId: order.id, companyId: order.companyId, siteId: order.siteId, after: { status: 'PENDING_APPROVAL', approvalTaskId: taskId, codes, words: error.message } })
    tools.emit({ type: 'purchase_order.send_held', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, taskId, codes } })
    return { held: true, codes }
  })
}

/** The send of one approved order (also called by tests with the system caller). */
export async function sendApproved(system: CommandCaller, event: { readonly eventId: string; readonly payload: unknown }): Promise<'SENT' | 'HELD' | 'SETTLED'> {
  const { purchaseOrderId, taskId } = payload.parse(event.payload)
  const found = await system.withClient(async (client) => ({
    order: await client.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { id: true, number: true, status: true, version: true, approvalTaskId: true, companyId: true, siteId: true } }),
    task: await client.approvalTask.findUnique({ where: { id: taskId }, select: { status: true, requestedById: true, preview: true } }),
  }))
  const { order, task } = found
  // Sent already, a draft again, or another request since: nothing to do.
  if (!order || order.status !== 'PENDING_APPROVAL' || order.approvalTaskId !== taskId || task?.status !== 'APPROVED' || !task.requestedById) return 'SETTLED'
  const now = serverClock.now()
  const person = await asPerson(system, task.requestedById, now)
  const options = sendOptionsOf(parsePreview(task.preview).changes)
  const email = processEmail()
  const host: SendHost = { caller: person, link: (token) => `${email.webOrigin}/l#token=${encodeURIComponent(token)}`, system: () => system }
  try {
    await sendAs(
      host,
      order.id,
      {
        version: order.version,
        // A confirm-by time that passed while it waited: the default of the send (48 h, longer by the supplier's closed days).
        confirmBy: options.confirmBy !== null && new Date(options.confirmBy).getTime() > now.getTime() ? options.confirmBy : null,
        subject: options.subject,
        message: options.message,
        ...(options.cc === null ? {} : { cc: options.cc }),
        changeNote: options.changeNote,
      },
      `po-approved-send-${taskId}`,
    )
    return 'SENT'
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    await holdSend(system, order, task.requestedById, taskId, error, event.eventId)
    return 'HELD'
  }
}

export function approvedSendHandler(): EventHandler {
  return defineHandler({
    name: APPROVED_SEND_HANDLER,
    events: ['purchase_order.approved'],
    async handle(event, tools) {
      await sendApproved(tools.caller, event)
    },
  })
}
