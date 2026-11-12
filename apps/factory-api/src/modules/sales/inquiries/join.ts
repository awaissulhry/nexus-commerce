import { toUtcIso } from '@nexus/factory-domain/core/time'
import { inboundMachine } from '@nexus/factory-domain/email-in/rules'
import { canTransition } from '@nexus/factory-domain/state/machine'
import type { CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { emitSorted, joinThread, MAIL_SORT } from '../../../platform/email-in/sort'
import { ensureThread } from '../../../platform/threads/threads'
import type { InquiryData } from './store'

/** The mail columns an inquiry reads of its mail (email in's sorting columns, its status, why it is held, its version). */
export const MAIL_COLUMNS = { ...MAIL_SORT, status: true, heldReason: true, version: true } as const

/**
 * Inside a command: the inquiry's mail, while it waits in Mail to sort (TRIAGE or HELD), joins the inquiry's thread as an INBOUND
 * message (MATCHED, MANUAL; email in's own seam `joinThread`), shared with the inquiry's customer. Nothing happens when the
 * inquiry names no mail or no customer, or the mail is in a thread already.
 */
export async function joinMailInCommand(tools: CommandTools, context: OfficeContext, inquiry: Pick<InquiryData, 'id' | 'companyId' | 'number' | 'sourceEmailId' | 'partyId' | 'contactId'>): Promise<void> {
  if (!inquiry.sourceEmailId || !inquiry.partyId) return
  const { tx, now } = tools
  await tx.$queryRaw`SELECT id FROM "InboundEmail" WHERE id = ${inquiry.sourceEmailId}::uuid FOR UPDATE`
  const mail = await tx.inboundEmail.findUnique({ where: { id: inquiry.sourceEmailId }, select: MAIL_COLUMNS })
  if (!mail || !canTransition(inboundMachine, mail.status, 'MATCHED') || (mail.status !== 'TRIAGE' && mail.status !== 'HELD')) return
  if (mail.emailMessageId && (await tx.message.findFirst({ where: { emailMessageId: mail.emailMessageId }, select: { id: true } }))) return
  const { thread } = await ensureThread(tools, { type: 'Inquiry', id: inquiry.id }, context.actorId)
  if (thread.partyId === null) return
  const contactId = inquiry.contactId ?? (mail.senderPartyId === thread.partyId ? mail.senderContactId : null)
  const { messageId } = await joinThread(tools, thread, mail, [], contactId)
  await tx.inboundEmail.update({
    where: { id: mail.id },
    data: { status: 'MATCHED', threadId: thread.id, messageId, matchedBy: 'MANUAL', heldReason: null, sortedAt: now, sortedById: context.actorId, version: { increment: 1 } },
    select: { id: true },
  })
  tools.audit({
    action: 'emailIn.assign',
    recordType: 'InboundEmail',
    recordId: mail.id,
    companyId: mail.companyId,
    before: { status: mail.status, heldReason: mail.heldReason },
    after: { status: 'MATCHED', matchedBy: 'MANUAL', threadId: thread.id, recordType: 'Inquiry', recordId: inquiry.id, messageId, files: 0, sortedAt: toUtcIso(now) },
  })
  emitSorted(tools, mail, 'MATCHED', thread.id, messageId)
}
