import type { Prisma } from '@nexus/factory-db'
import { EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { formatDate } from '@nexus/factory-domain/documents/format'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as templateEvents, type ReplyChange } from '@nexus/factory-domain/templates/events'
import type { TemplateLanguage } from '@nexus/factory-domain/templates/language'
import { companyValues } from '@nexus/factory-domain/templates/mail'
import { EMAIL_REPLIES_SHARE } from '@nexus/factory-domain/templates/permissions'
import { fillPlaceholders, missingValues, type PlaceholderValues } from '@nexus/factory-domain/templates/placeholders'
import { REPLY_PLACEHOLDERS, REPLY_RECORD_TYPES, replyProblems, type ReplyRecordType } from '@nexus/factory-domain/templates/replies'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import { officeRecord } from '../threads/threads'
import { mayOnThread } from '../threads/records'
import type { ReplyView } from './contract'
import { mayOver, namesOf, officeOf, person, refuseProblems, templateRefusal, type Reader } from './store'
// ---- B-TH-098 / B-TH-279: the five message languages; a mail's starting words in the recipient's language, a drafted text only once
// read or with the office's tick.
import { DomainError } from '@nexus/factory-domain/core/errors'
import { codeWordsOf, fillMail, MAIL_EVENT_DEFINITIONS, type MailEvent } from '@nexus/factory-domain/templates/mail'
import { isDraftedLanguage, isMessageLanguage, MESSAGE_LANGUAGE_WORDS, messageLanguageOf, unreadWords, type MessageLanguage } from '@nexus/factory-domain/templates/message-languages'
import { isReplyRecordType } from '@nexus/factory-domain/templates/replies'
import { mailTemplateOf } from './active'
// ---- end B-TH-098 / B-TH-279

/**
 * Saved replies (B-W2b-422; COL-016; the send panel's "Message (template per language)"): a person's own, or shared with the
 * office, per language, with placeholders the record fills.
 *
 *   GET    /templates/replies?language&recordType&companyId   the reader's own and the shared ones they may use (email.send)
 *   POST   /templates/replies                                 a new one: own (email.send), or shared (email.replies.share)
 *   PUT    /templates/replies/:replyId                        change it (its owner; a shared one: email.replies.share)
 *   DELETE /templates/replies/:replyId?version                delete it (the same)
 *   POST   /templates/replies/:replyId/fill                   its body with a record's values, for the message box
 *
 * Nothing is sent here: the person reads the filled text in the send panel, changes it and sends (email out). A shared reply
 * of a company is the company's (email.send over it to use, email.replies.share over it to change); one of every company
 * needs the share permission over every company to change.
 */

const [, , replyChanged] = templateEvents

const COLUMNS = { id: true, companyId: true, name: true, language: true, body: true, recordType: true, ownerId: true, updatedAt: true, version: true } as const satisfies Prisma.MessageTemplateSelect
type Row = Prisma.MessageTemplateGetPayload<{ select: typeof COLUMNS }>

/** May use replies of this company (null: every company's): email.send over it. */
const mayUse = (actor: Actor, companyId: string | null): boolean => (companyId === null ? holds(actor, EMAIL_SEND) : can(actor, EMAIL_SEND, { companyId }))
const mayShare = (actor: Actor, companyId: string | null): boolean => mayOver(actor, EMAIL_REPLIES_SHARE, companyId)

/** May see it: their own, or a shared one of a company they write mail for. */
const maySee = (context: OfficeContext, row: Pick<Row, 'ownerId' | 'companyId'>): boolean => row.ownerId === context.actorId || (row.ownerId === null && mayUse(actorOf(context), row.companyId))
/** May change or delete it: their own, or a shared one with the share permission over its company. */
const mayChange = (context: OfficeContext, row: Pick<Row, 'ownerId' | 'companyId'>): boolean => row.ownerId === context.actorId || (row.ownerId === null && mayShare(actorOf(context), row.companyId))

function viewOf(context: OfficeContext, row: Row, names: ReadonlyMap<string, string>): ReplyView {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    language: row.language,
    body: row.body,
    recordType: row.recordType,
    shared: row.ownerId === null,
    owner: person(names, row.ownerId),
    mayChange: mayChange(context, row),
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
  }
}

async function viewsOf(db: Reader, context: OfficeContext, rows: readonly Row[]): Promise<ReplyView[]> {
  const names = await namesOf(db, rows.map((row) => row.ownerId))
  return rows.map((row) => viewOf(context, row, names))
}

const emitted = (tools: Pick<CommandTools, 'emit'>, row: Pick<Row, 'id' | 'companyId' | 'ownerId'>, change: ReplyChange) =>
  tools.emit(eventFor(replyChanged, { subject: row.id, companyId: row.companyId, payload: { replyId: row.id, shared: row.ownerId === null, change } }))

async function seen(caller: CommandCaller, replyId: string): Promise<{ context: OfficeContext; row: Row }> {
  const context = officeOf(caller)
  const row = isUuid(replyId) ? await caller.withClient((db) => db.messageTemplate.findUnique({ where: { id: replyId }, select: COLUMNS })) : null
  if (!row || !maySee(context, row)) throw new NotFoundError('Saved reply not found.')
  return { context, row }
}

async function changeable(caller: CommandCaller, replyId: string): Promise<{ context: OfficeContext; row: Row }> {
  const found = await seen(caller, replyId)
  if (!mayChange(found.context, found.row)) throw new ForbiddenError()
  return found
}

/** GET /templates/replies */
export async function listReplies(caller: CommandCaller, query: { readonly language?: MessageLanguage | undefined; readonly recordType?: ReplyRecordType | undefined; readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const rows = await db.messageTemplate.findMany({
      where: {
        AND: [
          { OR: [{ ownerId: context.actorId }, { ownerId: null }] },
          ...(query.recordType ? [{ OR: [{ recordType: query.recordType }, { recordType: null }] }] : []),
          ...(query.companyId ? [{ OR: [{ companyId: query.companyId }, { companyId: null }] }] : []),
        ],
        ...(query.language ? { language: query.language } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: COLUMNS,
      take: 500,
    })
    return {
      replies: await viewsOf(db, context, rows.filter((row) => maySee(context, row))),
      placeholders: Object.fromEntries(REPLY_RECORD_TYPES.map((type) => [type, [...REPLY_PLACEHOLDERS[type]]])),
      mayShare: query.companyId ? mayShare(actor, query.companyId) : holds(actor, EMAIL_REPLIES_SHARE),
    }
  })
}

interface ReplyBody {
  readonly name: string
  readonly language: MessageLanguage // B-TH-098
  readonly body: string
  readonly recordType: ReplyRecordType | null
  readonly companyId: string | null
}

/** The reply checked (400 with every problem), trimmed for storing. */
function checked(words: ReplyBody): ReplyBody {
  const cleaned = { ...words, name: words.name.trim(), body: words.body.replace(/\r\n?/g, '\n').trim() }
  refuseProblems(replyProblems(cleaned), 'The saved reply cannot be saved like this.')
  return cleaned
}

async function companyExists(db: Reader, companyId: string | null): Promise<void> {
  if (companyId && !(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
}

/** POST /templates/replies */
export async function createReply(caller: CommandCaller, body: ReplyBody & { readonly shared: boolean }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!mayUse(actor, body.companyId)) throw new NotFoundError('Company not found.')
  if (body.shared && !mayShare(actor, body.companyId)) throw new ForbiddenError()
  const words = checked(body)
  await caller.withClient((db) => companyExists(db, words.companyId))
  const { result } = await command(caller, { name: 'templates.createReply', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const id = newId()
    const row = await tx.messageTemplate.create({
      data: { id, companyId: words.companyId, name: words.name, language: words.language, body: words.body, recordType: words.recordType, ownerId: body.shared ? null : context.actorId, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'MessageTemplate', recordId: id, companyId: words.companyId, after: { name: words.name, language: words.language, recordType: words.recordType, shared: body.shared } })
    emitted(tools, row, 'CREATED')
    const [view] = await viewsOf(tx, context, [row])
    return { reply: view! }
  }).catch(templateRefusal)
  return result
}

/** PUT /templates/replies/:replyId */
export async function updateReply(caller: CommandCaller, replyId: string, body: Partial<ReplyBody> & { readonly version: number }, idempotencyKey?: string) {
  const { context, row: before } = await changeable(caller, replyId)
  const actor = actorOf(context)
  const words = checked({
    name: body.name ?? before.name,
    language: body.language ?? (before.language as MessageLanguage), // B-TH-098
    body: body.body ?? before.body,
    recordType: body.recordType !== undefined ? body.recordType : (before.recordType as ReplyRecordType | null),
    companyId: body.companyId !== undefined ? body.companyId : before.companyId,
  })
  // Moving a reply to another company: the person writes mail for it (and shares there, for a shared one).
  if (words.companyId !== before.companyId && (!mayUse(actor, words.companyId) || (before.ownerId === null && !mayShare(actor, words.companyId)))) throw new ValidationError('You do not keep replies for that company.', [{ path: 'body/companyId', message: 'You do not keep replies for that company.' }])
  await caller.withClient((db) => companyExists(db, words.companyId))
  const { result } = await command(caller, { name: 'templates.updateReply', idempotencyKey, input: { replyId, ...body }, record: { type: 'MessageTemplate', id: replyId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const row = await tx.messageTemplate.update({ where: { id: replyId }, data: { name: words.name, language: words.language, body: words.body, recordType: words.recordType, companyId: words.companyId }, select: COLUMNS })
    const changed = (['name', 'language', 'body', 'recordType', 'companyId'] as const).filter((key) => before[key] !== row[key])
    tools.audit({ recordType: 'MessageTemplate', recordId: replyId, companyId: row.companyId, after: { changed, shared: row.ownerId === null } })
    emitted(tools, row, 'EDITED')
    const [view] = await viewsOf(tx, context, [row])
    return { reply: view! }
  }).catch(templateRefusal)
  return result
}

/** DELETE /templates/replies/:replyId?version */
export async function deleteReply(caller: CommandCaller, replyId: string, version: number, idempotencyKey?: string) {
  const { row: before } = await changeable(caller, replyId)
  const { result } = await command(caller, { name: 'templates.deleteReply', idempotencyKey, input: { replyId, version }, record: { type: 'MessageTemplate', id: replyId, expectedVersion: version } }, async (tools) => {
    await tools.tx.messageTemplate.delete({ where: { id: replyId } })
    tools.audit({ recordType: 'MessageTemplate', recordId: replyId, companyId: before.companyId, before: { name: before.name, language: before.language, recordType: before.recordType, shared: before.ownerId === null } })
    emitted(tools, before, 'DELETED')
    return { deleted: replyId }
  }).catch(templateRefusal)
  return result
}

// B-TH-098: dates in German, French and Spanish texts are written as numbers (dd/mm/yyyy), as Italian ones are.
const dateLanguageOf = (language: MessageLanguage): TemplateLanguage => (language === 'en' ? 'en' : 'it')
const day = (value: Date | null | undefined, language: MessageLanguage): string | null => (value ? formatDate(businessDate(value, 'UTC'), dateLanguageOf(language)) : null)

/** B-TH-046: what a request is about — its mail's subject, else the first line of its words, at most 120 characters (null: none). */
export function inquirySubjectOf(mailSubject: string | null, request: string): string | null {
  const subject = mailSubject?.trim() || request.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') || ''
  if (subject === '') return null
  return subject.length > 120 ? `${subject.slice(0, 119)}…` : subject
}

/** The record's own values (its number, dates), its party and the contact it names, for its record type. */
async function recordValues(db: Reader, type: ReplyRecordType, id: string, language: MessageLanguage): Promise<{ values: PlaceholderValues; partyId: string | null; contactId: string | null; companyId: string | null; prospect?: { readonly name: string | null; readonly company: string | null } }> {
  switch (type) {
    case 'SalesOrder': {
      const row = await db.salesOrder.findUnique({ where: { id }, select: { number: true, customerRef: true, promiseDate: true, partyId: true, companyId: true } })
      if (!row) break
      return { values: { 'order.number': row.number, 'order.customerRef': row.customerRef, 'order.promiseDate': day(row.promiseDate, language) }, partyId: row.partyId, contactId: null, companyId: row.companyId }
    }
    case 'Quote': {
      const row = await db.quote.findUnique({ where: { id }, select: { number: true, partyId: true, contactId: true, companyId: true } })
      if (!row) break
      const latest = await db.quoteVersion.findFirst({ where: { quoteId: id }, orderBy: { revision: 'desc' }, select: { validUntil: true } })
      return { values: { 'quote.number': row.number, 'quote.validUntil': day(latest?.validUntil, language) }, partyId: row.partyId, contactId: row.contactId, companyId: row.companyId }
    }
    case 'PurchaseOrder': {
      const row = await db.purchaseOrder.findUnique({ where: { id }, select: { number: true, requestedDate: true, partyId: true, contactId: true, companyId: true } })
      if (!row) break
      return { values: { 'order.number': row.number, 'order.deliveryDate': day(row.requestedDate, language) }, partyId: row.partyId, contactId: row.contactId, companyId: row.companyId }
    }
    case 'ServiceCase': {
      const row = await db.serviceCase.findUnique({ where: { id }, select: { number: true, partyId: true, contactId: true, companyId: true } })
      if (!row) break
      return { values: { 'case.number': row.number }, partyId: row.partyId, contactId: row.contactId, companyId: row.companyId }
    }
    case 'Shipment': {
      const row = await db.shipment.findUnique({ where: { id }, select: { number: true, partyId: true, salesOrderId: true, companyId: true } })
      if (!row) break
      const order = await db.salesOrder.findUnique({ where: { id: row.salesOrderId }, select: { number: true } })
      return { values: { 'shipment.number': row.number, 'order.number': order?.number ?? null }, partyId: row.partyId, contactId: null, companyId: row.companyId }
    }
    case 'Party': {
      const row = await db.party.findUnique({ where: { id }, select: { id: true, companyId: true } })
      if (!row) break
      return { values: {}, partyId: row.id, contactId: null, companyId: row.companyId }
    }
    // B-TH-046: a request of Sales › Incoming — its number, what it is about, the wanted date; the contact is the customer's
    // own who wrote it (fill reads a contact of the request's customer only: brand A's request never names brand B's contact).
    case 'Inquiry': {
      const row = await db.inquiry.findUnique({ where: { id }, select: { number: true, request: true, wantedDate: true, partyId: true, contactId: true, companyId: true, sourceEmailId: true, prospectName: true, prospectCompany: true, customerSeq: true } })
      if (!row) break
      const mail = row.sourceEmailId ? await db.inboundEmail.findUnique({ where: { id: row.sourceEmailId }, select: { subject: true } }) : null
      // B-TH-098: `inquiry.yourNumber` — the customer's own number of the request (§0.5: the counts never leak), the office's for a prospect.
      const yourNumber = row.customerSeq !== null ? String(row.customerSeq) : row.number
      return { values: { 'inquiry.number': row.number, 'inquiry.yourNumber': yourNumber, 'inquiry.subject': inquirySubjectOf(mail?.subject ?? null, row.request), 'inquiry.wantedDate': day(row.wantedDate, language) }, partyId: row.partyId, contactId: row.contactId, companyId: row.companyId, ...(row.partyId === null ? { prospect: { name: row.prospectName, company: row.prospectCompany } } : {}) }
    }
  }
  throw new NotFoundError('Record not found.')
}

/**
 * The values a record gives a reply or a mail, read with the caller's client (email.send over the record, else 404): its own values,
 * the contact (the one named, else the record's), the party, the person, today, the company. B-TH-098: in the message language.
 */
async function fillValues(db: Reader, context: OfficeContext, body: { readonly recordType: ReplyRecordType; readonly recordId: string; readonly contactId?: string | undefined }, language: MessageLanguage): Promise<{ values: PlaceholderValues; partyId: string | null; contact: { language: string | null } | null; companyId: string | null }> {
  const actor = actorOf(context)
  const { scope } = await officeRecord(db, { type: body.recordType, id: body.recordId })
  if (!mayOnThread(actor, EMAIL_SEND, body.recordType, scope)) throw new NotFoundError('Record not found.')
  const record = await recordValues(db, body.recordType, body.recordId, language)
  const contactId = body.contactId ?? record.contactId
  const contact = contactId && record.partyId ? await db.partyContact.findFirst({ where: { id: contactId, partyId: record.partyId, status: 'ACTIVE' }, select: { name: true, language: true } }) : null
  if (body.contactId && !contact) throw new ValidationError('Pick an active contact of the record’s customer or supplier.', [{ path: 'body/contactId', message: 'Pick an active contact of the record’s customer or supplier.' }])
  const party = record.partyId ? await db.party.findUnique({ where: { id: record.partyId }, select: { legalName: true, tradeName: true } }) : null
  const companyId = record.companyId ?? scope.companyId ?? null
  const company = companyId ? await db.company.findUnique({ where: { id: companyId }, select: { legalName: true, tradeName: true } }) : null
  const me = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  return {
    values: {
      ...record.values,
      // B-TH-046: a prospect's request (no customer yet) names the prospect and its company.
      'contact.name': contact?.name?.trim() || record.prospect?.name?.trim() || null,
      'party.name': party ? party.tradeName?.trim() || party.legalName.trim() : record.prospect?.company?.trim() || null,
      'me.name': me ? me.displayName?.trim() || me.email.split('@')[0]! : null,
      today: formatDate(businessDate(serverClock.now()), dateLanguageOf(language)), // B-TH-098
      ...(company ? companyValues(company) : {}),
    } satisfies PlaceholderValues,
    partyId: record.partyId,
    contact: contact ? { language: contact.language } : null,
    companyId,
  }
}

/**
 * POST /templates/replies/:replyId/fill: the reply's body with the values of a record whose thread the person writes mail on
 * (email.send over it): its number and dates, the party, the contact (the one named, else the record's), the person, today,
 * the company. The text is only returned; the person changes it and sends it from the send panel.
 */
export async function fillReply(caller: CommandCaller, replyId: string, body: { readonly recordType: ReplyRecordType; readonly recordId: string; readonly contactId?: string | undefined }) {
  const { context, row } = await seen(caller, replyId)
  if (row.recordType !== null && row.recordType !== body.recordType) throw new ValidationError('This saved reply is for another kind of record.', [{ path: 'body/recordType', message: 'This saved reply is for another kind of record.' }])
  if (!isMessageLanguage(row.language)) throw new ValidationError(MESSAGE_LANGUAGE_WORDS.en, [{ path: 'params/replyId', message: MESSAGE_LANGUAGE_WORDS.en }]) // B-TH-098
  const language = row.language
  const { values } = await caller.withClient((db) => fillValues(db, context, body, language))
  return { body: fillPlaceholders(row.body, values), language, missing: missingValues(row.body, values) }
}

// ---- B-TH-098 / B-TH-279 (threads plan TH-9 thread-G07, TH-6 O-ADM-MAILTPL.events-F01) ------------------------------------------------
export const MAIL_FILL_WORDS = Object.freeze({
  NOT_FOR_THIS_RECORD: {
    it: 'Queste parole sono per un altro tipo di documento.',
    en: 'These words are for another kind of record.',
  },
  SENT_BY_NEXUS: {
    it: 'Questa e-mail la manda Nexus da sola: non ha parole di partenza da compilare.',
    en: 'Nexus sends this mail by itself: it has no starting words to fill.',
  },
})

/**
 * POST /templates/mail/events/:event/fill: a mail's starting words for a record (the dialogs' "Ask for info" and "Decline", the receipt
 * of a request; a service case's and a shipment's mail too), filled with the record's values, in the recipient's message language
 * (their contact's, their organisation's, the company's — or the one asked):
 *   1. the company's version in use in that language, else every company's (a person wrote it: it needs no reading);
 *   2. else the code's words — Italian and English as they are; a German, French or Spanish draft by Claude only once that language was
 *      read, or with the office's tick "Send it anyway" (`sendUnread`, recorded in the history with who ticked); otherwise English,
 *      said with `fellBack` and the words why. Nothing is sent here: the person reads, changes and sends the text from the composer.
 */
export async function fillMailEvent(
  caller: CommandCaller,
  event: MailEvent,
  body: { readonly recordType: ReplyRecordType; readonly recordId: string; readonly contactId?: string | undefined; readonly language?: MessageLanguage | undefined; readonly sendUnread?: boolean | undefined },
  idempotencyKey?: string,
) {
  const context = officeOf(caller)
  const definition = MAIL_EVENT_DEFINITIONS[event]
  if (!isReplyRecordType(definition.recordType)) throw new DomainError('conflict', MAIL_FILL_WORDS.SENT_BY_NEXUS.en, [{ path: 'refusal/SENT_BY_NEXUS', message: MAIL_FILL_WORDS.SENT_BY_NEXUS.en }])
  if (definition.recordType !== body.recordType) throw new ValidationError(MAIL_FILL_WORDS.NOT_FOR_THIS_RECORD.en, [{ path: 'body/recordType', message: MAIL_FILL_WORDS.NOT_FOR_THIS_RECORD.en }])
  const read = await caller.withClient(async (db) => {
    // The language first (the record's contact, else its party, else its company), then the values in it.
    const first = await fillValues(db, context, body, 'en')
    const party = first.partyId ? await db.party.findUnique({ where: { id: first.partyId }, select: { language: true } }) : null
    const company = first.companyId ? await db.company.findUnique({ where: { id: first.companyId }, select: { locale: true } }) : null
    const language: MessageLanguage = body.language ?? messageLanguageOf({ contact: first.contact?.language, party: party?.language, company: company?.locale }).language
    const filled = language === 'en' ? first : await fillValues(db, context, body, language)
    const template = first.companyId ? await mailTemplateOf(db, context, { companyId: first.companyId, event, language }) : null
    return { language, values: filled.values, template, companyId: first.companyId }
  })
  if (read.template) {
    const words = fillMail(read.template, read.values)
    return { ...words, language: read.language, source: 'TEMPLATE' as const, read: true, fellBack: false, words: null, missing: [...new Set([...missingValues(read.template.subject, read.values), ...missingValues(read.template.body, read.values)])] }
  }
  const code = codeWordsOf(event, read.language, { sendUnread: body.sendUnread === true })
  // The office's tick on a drafted text not read yet is recorded: who used which language's words, on which record.
  if (isDraftedLanguage(read.language) && !code.read && body.sendUnread === true) {
    await command(caller, { name: 'templates.useUnreadText', idempotencyKey, input: { event, language: read.language, recordType: body.recordType, recordId: body.recordId } }, async (tools) => {
      tools.audit({ action: 'templates.useUnreadText', recordType: body.recordType, recordId: body.recordId, companyId: read.companyId, after: { event, language: read.language, drafted: 'CLAUDE', read: false } })
      return null
    })
  }
  const values = code.language === read.language ? read.values : (await caller.withClient((db) => fillValues(db, context, body, code.language))).values
  const words = fillMail(code.words, values)
  return {
    ...words,
    language: code.language,
    source: 'CODE' as const,
    read: code.read,
    fellBack: code.fellBack,
    words: code.fellBack && isDraftedLanguage(read.language) ? { it: unreadWords(read.language, 'it'), en: unreadWords(read.language, 'en') } : null,
    missing: [...new Set([...missingValues(code.words.subject, values), ...missingValues(code.words.body, values)])],
  }
}
// ---- end B-TH-098 / B-TH-279
