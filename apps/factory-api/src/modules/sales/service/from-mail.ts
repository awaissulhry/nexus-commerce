import { z } from 'zod'
import { EMAIL_TRIAGE, THREADS_POST } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { INBOUND_STATUSES } from '@nexus/factory-domain/email-in/rules'
import { plainSubject } from '@nexus/factory-domain/mail-depth/rules'
import { CASE_LIMITS, SERVICE_CASE_RECORD } from '@nexus/factory-domain/sales/service/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { copyMailFiles } from '../../../platform/email-in/capture/copy'
import { processEmailIn } from '../../../platform/email-in/service'
import { emitSorted, joinThread, MAIL_SORT } from '../../../platform/email-in/sort'
import { mailRefusal } from '../../../platform/email-in/team-inbox/store'
import { ensureThread } from '../../../platform/threads/threads'
import { officeOf } from './access'
import { caseView, openBody } from './contract'
import { openInCommand } from './open'
import { caseRecordOf } from './view'

/**
 * A service case from a mail in one step (B-W2b-394; follow-up ML1:03 of B-W2b-345: "no 'open a case from this mail' in one
 * command yet"; design home.mail "Create from this mail": the mail becomes the record's first message):
 *
 *   POST /sales/service/cases/from-mail/:inboundEmailId   sales.service.manage, and email.triage over the mail
 *
 * A mail that waits in Mail to sort (TRIAGE or HELD: a person looked at it) becomes a case of channel MAIL in ONE command —
 * the case opened as POST /sales/service/cases opens one (./open.ts: number, garment facts, the warranty days, its followers,
 * service_case.opened), the mail an INBOUND message of the case's thread shared with its customer (MATCHED, MANUAL, sorted by
 * the person) with its files copied onto the case (read and put before the command, as Attach does), email.inbound_sorted.
 * The customer is the one named, else the one the sorting suggested; a case from a mail names one (the thread is shared with
 * them). What is reported defaults to the mail's subject and text. Body: the case's fields and the MAIL's version.
 */

const issue = output({ path: z.string(), message: z.string() })

export const caseFromMailContract = defineContract({
  params: input({ inboundEmailId: id() }),
  body: openBody.omit({ companyId: true, channel: true, problem: true }).extend({
    /** The mail's version as read. */
    version: z.number().int().min(1),
    /** Only for a mail of an address of every company: the company the case is for. */
    companyId: id().optional(),
    /** Left out: the mail's subject and text. */
    problem: z.string().max(CASE_LIMITS.problem * 2).optional(),
  }),
  response: { 201: output({ case: caseView, warnings: z.array(issue), mail: output({ id: id(), status: z.enum(INBOUND_STATUSES), threadId: id().nullable() }) }) },
})
type Body = z.infer<typeof caseFromMailContract.body>

/** What the customer reports, from the mail: its subject (without Re:/Fwd:) and its text, within the case's limit. */
const problemOf = (mail: { readonly subject: string | null; readonly bodyText: string | null }): string =>
  [plainSubject(mail.subject), (mail.bodyText ?? '').trim()].filter((part) => part !== '').join('\n\n').slice(0, CASE_LIMITS.problem) || '—'

export async function openCaseFromMail(caller: CommandCaller, inboundEmailId: string, body: Body, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const mail = isUuid(inboundEmailId) ? await caller.withClient((db) => db.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: { ...MAIL_SORT, version: true, heldReason: true } })) : null
  if (!mail || !can(actor, EMAIL_TRIAGE, { companyId: mail.companyId })) throw new NotFoundError('Mail not found.')
  if (mail.status !== 'TRIAGE' && mail.status !== 'HELD') throw new ConflictError(`This mail is ${mail.status.toLowerCase()}: only a mail that waits in Mail to sort is made into a case.`)
  if (mail.companyId !== null && body.companyId !== undefined && body.companyId !== mail.companyId) throw new ValidationError('The case is for the company the mail came to.', [{ path: 'body/companyId', message: 'The company the mail came to.' }])
  const companyId = mail.companyId ?? body.companyId ?? null
  if (companyId === null) throw new ValidationError('This mail came to an address of every company: say which company the case is for.', [{ path: 'body/companyId', message: 'Name the company.' }])
  const partyId = body.partyId ?? mail.senderPartyId
  if (!partyId) throw new ValidationError('Name the customer: the mail joins the case’s thread, shared with them.', [{ path: 'body/partyId', message: 'Name the customer.' }])
  const contactId = body.contactId !== undefined ? body.contactId : partyId === mail.senderPartyId ? mail.senderContactId : null
  if (!can(actor, THREADS_POST, { companyId, partyId })) throw new ForbiddenError('You may not write in this customer’s threads.')
  const copies = await copyMailFiles(processEmailIn(), caller, mail, companyId)
  const { version: _version, companyId: _company, problem, ...fields } = body
  const { result } = await command(caller, { name: 'serviceCases.fromMail', idempotencyKey, input: { inboundEmailId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT id FROM "InboundEmail" WHERE id = ${inboundEmailId}::uuid FOR UPDATE`
    const current = await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: { version: true, status: true } })
    if (current.version !== body.version) throw new StaleVersionError('InboundEmail', inboundEmailId, current.version, body.version)
    if (current.status !== 'TRIAGE' && current.status !== 'HELD') throw new ConflictError(`This mail is ${current.status.toLowerCase()} now: read it again.`)
    const { caseId, warnings } = await openInCommand(tools, context, { ...fields, companyId, channel: 'MAIL', partyId, contactId, problem: problem ?? problemOf(mail) })
    const { thread } = await ensureThread(tools, { type: SERVICE_CASE_RECORD, id: caseId }, context.actorId)
    if (thread.partyId === null) throw new ConflictError('This case has no customer to share the mail with.')
    if (mail.emailMessageId && (await tx.message.findFirst({ where: { emailMessageId: mail.emailMessageId }, select: { id: true } }))) throw new ConflictError('This mail is a message of a thread already.')
    const { messageId, fileIds } = await joinThread(tools, thread, mail, copies, mail.senderPartyId === thread.partyId ? mail.senderContactId : null)
    await tx.inboundEmail.update({
      where: { id: inboundEmailId },
      data: { status: 'MATCHED', threadId: thread.id, messageId, matchedBy: 'MANUAL', heldReason: null, sortedAt: now, sortedById: context.actorId, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({
      action: 'emailIn.assign',
      recordType: 'InboundEmail',
      recordId: inboundEmailId,
      companyId: mail.companyId,
      before: { status: mail.status, heldReason: mail.heldReason },
      after: { status: 'MATCHED', matchedBy: 'MANUAL', threadId: thread.id, recordType: SERVICE_CASE_RECORD, recordId: caseId, messageId, files: fileIds.length },
    })
    emitSorted(tools, mail, 'MATCHED', thread.id, messageId)
    return { caseId, warnings, mail: { id: inboundEmailId, status: 'MATCHED' as const, threadId: thread.id } }
  }).catch(mailRefusal)
  return { case: await caseRecordOf(caller, result.caseId), warnings: result.warnings, mail: result.mail }
}
