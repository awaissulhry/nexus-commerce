import { EMAIL_TRIAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { FromMailBody } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import { mailRefusal, mailTakenRefusal, prospectFromMail, requestFromMail, techPackProblems } from '@nexus/factory-domain/sales/inquiries/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { attachmentsOf, keptOf } from '../../../platform/email-in/sort'
import { checkedProspect, checkNew, insertInquiry, viewInCommand, type NewInquiry } from './inquiries'
import { joinMailInCommand, MAIL_COLUMNS } from './join'
import { assertNoProblems, badBody, databaseRefusal, may, officeOf, refuse, type Reader } from './store'

/**
 * An inquiry from a mail (B-W2b-295; SAL-033; design home.mail "Make an inquiry", sales.inquiries "Sender's mail as sent"):
 * a mail that waits in Mail to sort (TRIAGE or HELD) or is in a thread already (MATCHED) becomes an inquiry of source MAIL
 * that names it (one inquiry per mail). Its sender is the customer when Nexus knows them (the contact email in's sorting
 * suggested, by their address or their company's domain), else a prospect from its From line; its subject and text are what
 * is asked; its kept attachments stay files of the mail and may be named as the brand's tech pack as they are.
 *
 *   GET  /sales/inquiries/from-mail/:inboundEmailId   what "Make an inquiry" starts from (or the inquiry already made)
 *   POST /sales/inquiries/from-mail/:inboundEmailId   the inquiry (email.triage over the mail, sales.inquiries.manage)
 *
 * A waiting mail from a customer joins the inquiry's thread in the same command (MATCHED, MANUAL: the Activity tab shows "the
 * original mail and every reply"); a prospect's mail keeps waiting in Mail to sort until the inquiry is matched to a customer,
 * then joins it (inquiries.ts updateInquiry). The attachments are not copied: the inquiry reads them from its mail.
 */

const fileOf = (file: { id: string; recordType: string; originalName: string; contentType: string; sizeBytes: number; status: string; versionNo: number }) => ({ id: file.id, recordType: file.recordType, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status, versionNo: file.versionNo })

/** The mail as a person who sorts mail sees it (email.triage over its company), else not found. */
async function readMail(caller: CommandCaller, context: OfficeContext, inboundEmailId: string) {
  if (!isUuid(inboundEmailId)) throw new NotFoundError('Mail not found.')
  const mail = await caller.withClient((db) => db.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: MAIL_COLUMNS }))
  if (!mail || !can(actorOf(context), EMAIL_TRIAGE, { companyId: mail.companyId })) throw new NotFoundError('Mail not found.')
  return mail
}

type Mail = Awaited<ReturnType<typeof readMail>>

/** The customer the mail's sender is, when email in's sorting suggested one that is a customer or brand of this company and the caller may see. */
async function suggestedParty(db: Reader, context: OfficeContext, mail: Mail, companyId: string | null) {
  if (!mail.senderPartyId || companyId === null) return null
  const party = await db.party.findUnique({ where: { id: mail.senderPartyId }, select: { id: true, code: true, legalName: true, tradeName: true, companyId: true, roles: true, status: true } })
  if (!party || (party.companyId !== null && party.companyId !== companyId) || party.status === 'ARCHIVED') return null
  if (!party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) return null
  if (!may(context, SALES_INQUIRIES_MANAGE, { companyId, partyId: party.id })) return null
  return { party, contactId: mail.senderContactId, matchedBy: (mail.senderContactId ? 'CONTACT' : 'DOMAIN') as 'CONTACT' | 'DOMAIN' }
}

const mailView = (mail: Mail) => ({ id: mail.id, status: mail.status, receivedAt: toUtcIso(mail.receivedAt), from: { address: mail.fromAddress, name: mail.fromName }, subject: mail.subject, bodyText: mail.bodyText, bodyHtml: mail.bodyHtml, threadId: mail.threadId })

/** The mail's kept attachments (files of the mail, not deleted). */
async function attachmentFiles(db: Reader, mail: Mail) {
  const kept = keptOf(attachmentsOf(mail)).flatMap((part) => (part.fileId ? [part.fileId] : []))
  if (kept.length === 0) return []
  return db.storedFile.findMany({
    where: { id: { in: kept }, recordType: 'InboundEmail', recordId: mail.id, status: { not: 'DELETED' } },
    select: { id: true, recordType: true, originalName: true, contentType: true, sizeBytes: true, status: true, versionNo: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** GET /sales/inquiries/from-mail/:inboundEmailId: what "Make an inquiry" starts from. */
export async function mailDraft(caller: CommandCaller, inboundEmailId: string) {
  const context = officeOf(caller)
  const mail = await readMail(caller, context, inboundEmailId)
  return caller.withClient(async (db) => {
    const made = await db.inquiry.findFirst({ where: { sourceEmailId: mail.id }, select: { id: true, number: true } })
    const companyId = mail.companyId ?? context.companyId ?? null
    const suggestion = await suggestedParty(db, context, mail, companyId)
    const refusal = made ? mailTakenRefusal(made.number) : mailRefusal(mail.status)
    return {
      inquiry: made,
      mail: mailView(mail),
      companyId,
      party: suggestion ? { id: suggestion.party.id, code: suggestion.party.code, name: suggestion.party.tradeName ?? suggestion.party.legalName } : null,
      contactId: suggestion?.contactId ?? null,
      matchedBy: suggestion?.matchedBy ?? null,
      prospect: suggestion ? null : (({ lawfulBasis: _basis, ...words }) => words)(prospectFromMail(mail)),
      request: requestFromMail(mail),
      attachments: (await attachmentFiles(db, mail)).map(fileOf),
      refusal,
    }
  })
}

/** POST /sales/inquiries/from-mail/:inboundEmailId: "Make an inquiry". */
export async function createFromMail(caller: CommandCaller, inboundEmailId: string, body: FromMailBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const mail = await readMail(caller, context, inboundEmailId)
  refuse(mailRefusal(mail.status))
  if (mail.companyId !== null && body.companyId !== undefined && body.companyId !== mail.companyId) badBody('companyId', "The inquiry is for the company the mail came to.")
  const companyId = mail.companyId ?? body.companyId ?? null
  if (companyId === null) badBody('companyId', 'This mail came to an address of every company: say which company the inquiry is for.')
  const { party, contactId, attachments } = await caller.withClient(async (db) => {
    const made = await db.inquiry.findFirst({ where: { sourceEmailId: mail.id }, select: { number: true } })
    if (made) refuse(mailTakenRefusal(made.number))
    const suggestion = body.partyId === undefined && body.prospect === undefined ? await suggestedParty(db, context, mail, companyId) : null
    return { party: body.partyId ?? suggestion?.party.id ?? null, contactId: body.contactId ?? (body.partyId === undefined ? (suggestion?.contactId ?? null) : null), attachments: await attachmentFiles(db, mail) }
  })
  const techPackFileIds = body.techPackFileIds ?? []
  assertNoProblems(techPackProblems(techPackFileIds, 'body/techPackFileIds'))
  if (techPackFileIds.some((fileId) => !attachments.some((file) => file.id === fileId))) badBody('techPackFileIds', "The tech pack is files the mail brought (its kept attachments).")
  const made: NewInquiry = {
    companyId,
    source: 'MAIL',
    sourceEmailId: mail.id,
    receivedAt: mail.receivedAt,
    partyId: party,
    contactId,
    prospect: body.prospect !== undefined ? checkedProspect(body.prospect) : party === null ? checkedProspect(prospectFromMail(mail)) : null,
    request: body.request ?? requestFromMail(mail),
    wantedDate: body.wantedDate ?? null,
    targetUnitPrice: (body.targetUnitPrice as string | undefined) ?? null,
    currency: body.currency ?? null,
    techPackFileIds,
    techPackVersion: body.techPackVersion ?? null,
    note: body.note ?? null,
    lines: body.lines ?? [],
    assigneeId: body.assigneeId ?? null,
  }
  await checkNew(caller, context, made)
  const { result } = await command(caller, { name: 'sales.inquiries.fromMail', idempotencyKey, input: { inboundEmailId, ...body, targetUnitPrice: markMoney('price', made.targetUnitPrice) } }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT id FROM "InboundEmail" WHERE id = ${mail.id}::uuid FOR UPDATE`
    const current = await tx.inboundEmail.findUniqueOrThrow({ where: { id: mail.id }, select: { version: true, status: true } })
    if (current.version !== body.version) throw new StaleVersionError('InboundEmail', mail.id, current.version, body.version)
    refuse(mailRefusal(current.status))
    const { id } = await insertInquiry(tools, made)
    if (made.partyId) await joinMailInCommand(tools, context, { id, companyId, number: '', sourceEmailId: mail.id, partyId: made.partyId, contactId: made.contactId })
    return { inquiry: await viewInCommand(tools, id) }
  }).catch(databaseRefusal)
  return result
}
