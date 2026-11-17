import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { PORTAL_COMMENT } from '@nexus/factory-domain/auth/partners/permissions'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { excerptOf, type MessageAudience } from '@nexus/factory-domain/threads/rules'
import { partnerThreadWords } from '@nexus/factory-domain/threads/partner/rules'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../core/context'
import { partnerCallerOf, partnerReaderOf } from '../search/partner/session'
import type { AttachmentView } from './contract'
import { openPartnerRecord } from './partner/service'
import { mayOnThread } from './records'
import { contextOf, officeRecord, visibleAttachments, type RecordRef } from './threads'
import { draftKeyOf } from './draft-keys'

/**
 * B-TH-092 (threads plan TH-9, N6 = L2-G14; T5-F10, T8-F07, O-SAL-ORD-NEW.form-F07, P-HOME.actions-F02, P-CUS-NEW.message-F02; wall W08):
 * drafts on the server — ONE draft per person and record (factory-db ComposerDraft, wave 9/9), kept until it is sent or discarded,
 * so a person finds what they typed on another computer ("Draft saved 10:42"), and lists and Home can say "Draft".
 *
 *   office   GET|PUT|DELETE /threads/<type>/<id>/draft   the composer's draft on a record whose conversation the person may write on
 *                                                       (threads.post over it): its mode (an office note or a reply to the
 *                                                       customer), its words, its other fields (subject, To and Cc …) and its files
 *            GET /threads/drafts                         the person's own drafts ("Draft" in the lists)
 *   portal   GET|PUT|DELETE /portal/threads/<type>/<id>/draft   the reply a portal person is writing on a record of its own that the
 *                                                       portal opens (its partner view) and they may write on (portal.comment)
 *            GET|PUT|DELETE /portal/drafts/new-request   the New order the person is writing (who sends requests)
 *            GET /portal/drafts                          the person's own drafts (Home's "Draft: Spring jackets · Continue")
 *
 * NEVER ANOTHER PERSON'S: every read and write takes the person from the session, never from the body (the database keeps a portal
 * draft to its customer — the partner policy is by party — and keeping each person to their own is this file's). A draft is the
 * person's unsent words: the history records that it was saved or discarded and its size, never the words. A preview of a portal by
 * the office writes none. Sending clears it (clearDraftInCommand, in the send's own command): the office note, the portal reply, the
 * office's mail, the portal post, the portal's request. Two tabs: the newest save wins, and the answer says it replaced a newer one.
 * A person erased takes their drafts with them (the database).
 */

/** What one draft holds at most (the database's own limits, said in words first). */
export const DRAFT_LIMITS = Object.freeze({ body: 20000, fieldsBytes: 65536, attachments: 50, list: 200 })

/** The characters the database refuses in a draft's words (control characters but tab and line breaks): dropped as typed. */
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export const DRAFT_WORDS = Object.freeze({
  OFFICE_FOR_PORTAL: { it: 'Dal portale si scrive solo una risposta, mai una nota interna.', en: 'From the portal you write a reply, never an office note.' },
  PREVIEW: { it: 'Un’anteprima del portale non salva bozze.', en: 'A preview of the portal saves no draft.' },
})

export interface DraftBody {
  readonly audience?: MessageAudience | null | undefined
  readonly body: string
  readonly fields?: Record<string, unknown> | undefined
  readonly attachments?: readonly string[] | undefined
  /** The version the composer last read: a newer one saved meanwhile (another tab) is replaced, and the answer says so. */
  readonly version?: number | undefined
}

export interface DraftView {
  readonly recordType: string | null
  readonly recordId: string | null
  readonly audience: MessageAudience | null
  readonly body: string
  readonly fields: Record<string, unknown>
  /** The files added to it that the person may still see (the others are left out). */
  readonly attachments: AttachmentView[]
  readonly savedAt: string
  readonly version: number
}

const COLUMNS = { id: true, recordType: true, recordId: true, audience: true, bodyText: true, fields: true, attachmentFileIds: true, updatedAt: true, version: true } as const satisfies Prisma.ComposerDraftSelect
type Row = Prisma.ComposerDraftGetPayload<{ select: typeof COLUMNS }>

const keyOf = draftKeyOf
const recordWhere = (record: RecordRef | null) => (record ? { recordType: record.type, recordId: record.id } : { recordType: null, recordId: null })
const fieldsOf = (value: Prisma.JsonValue): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

async function viewOf(client: FactoryClient | CommandTx, context: RequestContext, row: Row): Promise<DraftView> {
  const seen = await visibleAttachments(client, context, row.attachmentFileIds)
  return {
    recordType: row.recordType,
    recordId: row.recordId,
    audience: row.audience,
    body: row.bodyText,
    fields: fieldsOf(row.fields),
    attachments: row.attachmentFileIds.flatMap((id) => (seen.has(id) ? [seen.get(id)!] : [])),
    savedAt: toUtcIso(row.updatedAt),
    version: row.version,
  }
}

/** The draft's words and shape checked (400 with every problem), the words cleaned of what the database refuses. */
function checked(body: DraftBody, portal: boolean): { audience: MessageAudience | null; bodyText: string; fields: Record<string, unknown>; attachments: string[] } {
  const problems: Issue[] = []
  const bodyText = body.body.replace(CONTROL, '')
  if (bodyText.length > DRAFT_LIMITS.body) problems.push({ path: 'body/body', message: `A draft holds up to ${DRAFT_LIMITS.body} characters.` })
  const fields = body.fields ?? {}
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > DRAFT_LIMITS.fieldsBytes) problems.push({ path: 'body/fields', message: 'The draft’s other fields are too large to keep (64 kB at most).' })
  const attachments = [...new Set(body.attachments ?? [])]
  if (attachments.length > DRAFT_LIMITS.attachments) problems.push({ path: 'body/attachments', message: `A draft keeps up to ${DRAFT_LIMITS.attachments} files.` })
  const audience = body.audience ?? null
  if (portal && audience === 'OFFICE') problems.push({ path: 'body/audience', message: DRAFT_WORDS.OFFICE_FOR_PORTAL.en })
  if (problems.length > 0) throw new ValidationError('The draft cannot be kept like this.', problems)
  return { audience, bodyText, fields, attachments }
}

/** Saves (or makes) the person's one draft of a record in the caller's scope; `partyId` is a portal person's own party. */
async function save(caller: CommandCaller, context: RequestContext, who: { readonly userId: string; readonly partyId: string | null }, record: RecordRef | null, body: DraftBody, idempotencyKey: string | undefined, portal: boolean): Promise<{ draft: DraftView; replacedNewer: boolean }> {
  const words = checked(body, portal)
  const key = keyOf(who.userId, record)
  const { result } = await command(caller, { name: 'threads.saveDraft', idempotencyKey, input: { key, size: words.bodyText.length, files: words.attachments.length } }, async (tools) => {
    const current = await tools.tx.composerDraft.findFirst({ where: { key, userId: who.userId }, select: { id: true, version: true } })
    const data = { audience: words.audience, bodyText: words.bodyText, fields: words.fields as Prisma.InputJsonValue, attachmentFileIds: words.attachments, updatedAt: tools.now }
    const row = current
      ? await tools.tx.composerDraft.update({ where: { id: current.id }, data: { ...data, version: current.version + 1 }, select: COLUMNS })
      : await tools.tx.composerDraft.create({ data: { id: newId(), userId: who.userId, partyId: who.partyId, ...recordWhere(record), key, ...data, createdAt: tools.now }, select: COLUMNS })
    // Never the words: that it was saved, its size and its files' count.
    tools.audit({ action: 'threads.saveDraft', recordType: 'ComposerDraft', recordId: row.id, after: { recordType: record?.type ?? null, recordId: record?.id ?? null, size: words.bodyText.length, files: words.attachments.length } })
    return { draft: await viewOf(tools.tx, context, row), replacedNewer: current !== null && body.version !== undefined && current.version > body.version }
  })
  return result
}

/** Discards the person's draft of a record (none: nothing changes). */
async function discard(caller: CommandCaller, userId: string, record: RecordRef | null, idempotencyKey: string | undefined): Promise<{ draft: null }> {
  const key = keyOf(userId, record)
  const found = await caller.withClient((client) => client.composerDraft.findFirst({ where: { key, userId }, select: { id: true } }))
  if (!found) return { draft: null }
  await command(caller, { name: 'threads.discardDraft', idempotencyKey, input: { key } }, async (tools) => {
    const removed = await tools.tx.composerDraft.deleteMany({ where: { id: found.id, userId } })
    tools.audit({ action: 'threads.discardDraft', recordType: 'ComposerDraft', recordId: found.id, before: { recordType: record?.type ?? null, recordId: record?.id ?? null, removed: removed.count } })
    return null
  })
  return { draft: null }
}

async function readOne(caller: CommandCaller, context: RequestContext, userId: string, record: RecordRef | null): Promise<{ draft: DraftView | null }> {
  return caller.withClient(async (client) => {
    const row = await client.composerDraft.findFirst({ where: { key: keyOf(userId, record), userId }, select: COLUMNS })
    return { draft: row ? await viewOf(client, context, row) : null }
  })
}

export interface DraftListItem {
  readonly recordType: string | null
  readonly recordId: string | null
  readonly audience: MessageAudience | null
  /** One line of the words (or the subject field of a New order): "Draft: Spring jackets". */
  readonly excerpt: string
  readonly savedAt: string
}

async function listOwn(caller: CommandCaller, userId: string, recordType?: string | undefined): Promise<{ drafts: DraftListItem[] }> {
  const rows = await caller.withClient((client) =>
    client.composerDraft.findMany({ where: { userId, ...(recordType ? { recordType } : {}) }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: DRAFT_LIMITS.list, select: COLUMNS }),
  )
  return {
    drafts: rows.map((row) => {
      const subject = fieldsOf(row.fields).subject
      return { recordType: row.recordType, recordId: row.recordId, audience: row.audience, excerpt: excerptOf(typeof subject === 'string' && subject.trim() !== '' ? subject : row.bodyText), savedAt: toUtcIso(row.updatedAt) }
    }),
  }
}

// ---- the office ---------------------------------------------------------------------------------------------------------------

/** The office person and the record they may write on (threads.post over it), or the refusal. */
async function officeWriter(caller: CommandCaller, record: RecordRef): Promise<OfficeContext> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, scope)) throw new ForbiddenError('A draft is kept for whoever may write on this conversation.')
  return context
}

/** GET /threads/<type>/<id>/draft */
export async function getOfficeDraft(caller: CommandCaller, record: RecordRef) {
  const context = await officeWriter(caller, record)
  return readOne(caller, context, context.actorId, record)
}

/** PUT /threads/<type>/<id>/draft */
export async function saveOfficeDraft(caller: CommandCaller, record: RecordRef, body: DraftBody, idempotencyKey?: string) {
  const context = await officeWriter(caller, record)
  return save(caller, context, { userId: context.actorId, partyId: null }, record, body, idempotencyKey, false)
}

/** DELETE /threads/<type>/<id>/draft */
export async function discardOfficeDraft(caller: CommandCaller, record: RecordRef, idempotencyKey?: string) {
  const context = await officeWriter(caller, record)
  return discard(caller, context.actorId, record, idempotencyKey)
}

/** GET /threads/drafts: the person's own drafts, newest first (one record type, when asked). */
export async function listOfficeDrafts(caller: CommandCaller, query: { readonly recordType?: string | undefined }) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return listOwn(caller, context.actorId, query.recordType)
}

// ---- the portal ---------------------------------------------------------------------------------------------------------------

/** The portal person, their party and their context; refused for an office preview when it would write. */
function portalWho(request: FastifyRequest, writing: boolean) {
  const caller = partnerCallerOf(request)
  if (writing && caller.session.preview) {
    const words = partnerThreadWords('PREVIEW', caller.session.person.locale, caller.session.company.name)
    throw new DomainError('forbidden', words, [{ path: 'refusal/PREVIEW', message: words }])
  }
  return caller
}

/** A record of the person's own customer that the portal opens and they may write on (portal.comment), or 404 / the refusal. */
async function portalRecord(request: FastifyRequest, record: RecordRef, writing: boolean) {
  const caller = portalWho(request, writing)
  const { scope } = await request.withClient((client) => openPartnerRecord(client, caller, record, partnerReaderOf(request, caller)))
  if (!can(caller.actor, PORTAL_COMMENT, scope)) throw new ForbiddenError(partnerThreadWords('NO_COMMENT', caller.session.person.locale, caller.session.company.name))
  return caller
}

/** GET /portal/threads/<type>/<id>/draft and GET /portal/drafts/new-request (`record` null). */
export async function getPartnerDraft(request: FastifyRequest, record: RecordRef | null) {
  const caller = record ? await portalRecord(request, record, false) : portalWho(request, false)
  return readOne(request as CommandCaller, caller.context, caller.context.actorId, record)
}

/** PUT /portal/threads/<type>/<id>/draft and PUT /portal/drafts/new-request. */
export async function savePartnerDraft(request: FastifyRequest, record: RecordRef | null, body: DraftBody, idempotencyKey?: string) {
  const caller = record ? await portalRecord(request, record, true) : portalWho(request, true)
  return save(request as CommandCaller, caller.context, { userId: caller.context.actorId, partyId: caller.context.partyId }, record, body, idempotencyKey, true)
}

/** DELETE /portal/threads/<type>/<id>/draft and DELETE /portal/drafts/new-request. */
export async function discardPartnerDraft(request: FastifyRequest, record: RecordRef | null, idempotencyKey?: string) {
  const caller = record ? await portalRecord(request, record, true) : portalWho(request, true)
  return discard(request as CommandCaller, caller.context.actorId, record, idempotencyKey)
}

/** GET /portal/drafts: the person's own drafts, newest first (Home's "Draft: … · Continue"). */
export async function listPartnerDrafts(request: FastifyRequest) {
  const caller = portalWho(request, false)
  return listOwn(request as CommandCaller, caller.context.actorId)
}
