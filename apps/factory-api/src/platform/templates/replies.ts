import type { Prisma } from '@nexus/factory-db'
import { EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { formatDate } from '@nexus/factory-domain/documents/format'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as templateEvents, type ReplyChange } from '@nexus/factory-domain/templates/events'
import { isTemplateLanguage, type TemplateLanguage } from '@nexus/factory-domain/templates/language'
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
export async function listReplies(caller: CommandCaller, query: { readonly language?: TemplateLanguage | undefined; readonly recordType?: ReplyRecordType | undefined; readonly companyId?: string | undefined }) {
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
  readonly language: TemplateLanguage
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
    language: body.language ?? (before.language as TemplateLanguage),
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

const day = (value: Date | null | undefined, language: TemplateLanguage): string | null => (value ? formatDate(businessDate(value, 'UTC'), language) : null)

/** The record's own values (its number, dates), its party and the contact it names, for its record type. */
async function recordValues(db: Reader, type: ReplyRecordType, id: string, language: TemplateLanguage): Promise<{ values: PlaceholderValues; partyId: string | null; contactId: string | null; companyId: string | null }> {
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
  }
  throw new NotFoundError('Record not found.')
}

/**
 * POST /templates/replies/:replyId/fill: the reply's body with the values of a record whose thread the person writes mail on
 * (email.send over it): its number and dates, the party, the contact (the one named, else the record's), the person, today,
 * the company. The text is only returned; the person changes it and sends it from the send panel.
 */
export async function fillReply(caller: CommandCaller, replyId: string, body: { readonly recordType: ReplyRecordType; readonly recordId: string; readonly contactId?: string | undefined }) {
  const { context, row } = await seen(caller, replyId)
  const actor = actorOf(context)
  if (row.recordType !== null && row.recordType !== body.recordType) throw new ValidationError('This saved reply is for another kind of record.', [{ path: 'body/recordType', message: 'This saved reply is for another kind of record.' }])
  if (!isTemplateLanguage(row.language)) throw new ValidationError('Saved replies are written in Italian or English.', [{ path: 'params/replyId', message: 'Saved replies are written in Italian or English.' }])
  const language = row.language
  const values = await caller.withClient(async (db) => {
    const { scope } = await officeRecord(db, { type: body.recordType, id: body.recordId })
    if (!mayOnThread(actor, EMAIL_SEND, body.recordType, scope)) throw new NotFoundError('Record not found.')
    const record = await recordValues(db, body.recordType, body.recordId, language)
    const contactId = body.contactId ?? record.contactId
    const contact = contactId && record.partyId ? await db.partyContact.findFirst({ where: { id: contactId, partyId: record.partyId, status: 'ACTIVE' }, select: { name: true } }) : null
    if (body.contactId && !contact) throw new ValidationError('Pick an active contact of the record’s customer or supplier.', [{ path: 'body/contactId', message: 'Pick an active contact of the record’s customer or supplier.' }])
    const party = record.partyId ? await db.party.findUnique({ where: { id: record.partyId }, select: { legalName: true, tradeName: true } }) : null
    const companyId = record.companyId ?? scope.companyId ?? null
    const company = companyId ? await db.company.findUnique({ where: { id: companyId }, select: { legalName: true, tradeName: true } }) : null
    const me = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return {
      ...record.values,
      'contact.name': contact?.name?.trim() || null,
      'party.name': party ? party.tradeName?.trim() || party.legalName.trim() : null,
      'me.name': me ? me.displayName?.trim() || me.email.split('@')[0]! : null,
      today: formatDate(businessDate(serverClock.now()), language),
      ...(company ? companyValues(company) : {}),
    } satisfies PlaceholderValues
  })
  return { body: fillPlaceholders(row.body, values), language, missing: missingValues(row.body, values) }
}
