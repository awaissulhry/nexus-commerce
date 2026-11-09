import type { FastifyRequest } from 'fastify'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { eventFor } from '@nexus/factory-domain/events/define'
import { authorNameOf, type ShareHeldReason } from '@nexus/factory-domain/shares/rules'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { postProblems } from '@nexus/factory-domain/threads/partner/rules'
import { cleanBody, uniqueIds } from '@nexus/factory-domain/threads/rules'
import { command, type CommandTx } from '../../core/command'
import { systemCallerOf } from '../files/files'
import { audienceSees, type FileAudience } from '../files/rules'
import { linkUnavailable } from '../links/authenticator'
import { linkCommand, useLink } from '../links/use'
import { ensureThread } from '../threads/threads'
import { resolveRecord } from '../threads/records'
import { inviteLinkOf, linkAttachments, mayOf, messageViewOf, requireLiveShare, SHARE_POST_ACTION, threadOf, THREAD_PARTNER, type PartnerShareRow, type PartnerThreadRow } from './page'

/**
 * An invited partner writes on the shared record (B-W2b-200; COL-062 "comment"; design links.invite › Messages "post,
 * attach", ⌘Enter posts). B-W2b-168's portal post, with the LINK as its author: the share must allow COMMENT now (read in the
 * command again: a share narrowed a moment ago refuses), the record's party must be the share's (its thread reaches only
 * that party), and the thread must be open.
 *
 *   POST /link/share/messages {body, attachments?}   (links.post; Idempotency-Key, as every link write)
 *
 * The record's thread is made first when it has none, in the tenant's system scope (the partner role cannot insert a
 * Thread; ensureThread takes the record's company, site and party from its resolver). Then ONE command in the link's own
 * partner scope: the share re-read live with COMMENT, the thread re-read (closed meanwhile? still the party's?), the
 * attachments (files of the record shared with the party's links, available), the Message — INBOUND, PARTNER, PORTAL, author
 * PARTY by the contact's name (else the invited address), never an author id, mention or floor flag (the portal-frame guard
 * holds the same shape) — the link's evidence POSTED (never a counted use), the audit row (its actor is the link: `mine`),
 * `thread.message_posted` (the office's followers are told; "E-mail me" mails the other invited people). Right after, the
 * thread's last activity moves in the system scope (the partner role cannot update a Thread).
 */

const [messagePosted] = threadEvents

const MESSAGE_PARTNER = { id: true, threadId: true, direction: true, channel: true, authorKind: true, authorName: true, bodyText: true, attachmentFileIds: true, at: true } as const

const HELD_WORDS: Readonly<Record<ShareHeldReason, string>> = {
  NO_COMMENT: 'Your invitation lets you read this record, not write on it. Ask the person who invited you.',
  NO_UPLOAD: 'Your invitation does not let you add files to this record. Ask the person who invited you.',
  CLOSED: 'This conversation was closed: no new message can be added.',
  OTHER_PARTY: 'This record has no conversation you can take part in.',
}

/** A refusal the page says in its own words from the code at `held/<CODE>`. */
export const heldRefusal = (code: ShareHeldReason): DomainError => new DomainError(code === 'CLOSED' ? 'invalid_state' : 'forbidden', HELD_WORDS[code], [{ path: `held/${code}`, message: HELD_WORDS[code] }])

/** What is wrong with the files a post attaches: files of the record, shared with the party's links, available. */
async function attachmentProblems(tx: CommandTx, request: FastifyRequest, thread: PartnerThreadRow, fileIds: readonly string[]): Promise<Issue[]> {
  if (fileIds.length === 0) return []
  const seen = await linkAttachments(tx, request, fileIds)
  const rows = new Map((await tx.storedFile.findMany({ where: { id: { in: [...fileIds] } }, select: { id: true, recordType: true, recordId: true, status: true, visibility: true, partyId: true } })).map((row) => [row.id, row]))
  const problems: Issue[] = []
  fileIds.forEach((fileId, index) => {
    const path = `body/attachments/${index}`
    const row = rows.get(fileId)
    if (!row || !audienceSees({ audience: 'link', partyId: thread.partyId ?? '', record: { type: thread.recordType, id: thread.recordId } }, { id: row.id, recordType: row.recordType, recordId: row.recordId, visibility: row.visibility as FileAudience[], partyId: row.partyId })) problems.push({ path, message: 'File not found.' })
    else if (!seen.has(fileId)) problems.push({ path, message: 'Only an available file of this record can be attached.' })
  })
  return problems
}

async function contactNameOf(request: FastifyRequest, tenantId: string, share: PartnerShareRow): Promise<string | null> {
  if (!share.contactId) return null
  return systemCallerOf(request)(tenantId).withClient(async (client) => (await client.partyContact.findFirst({ where: { id: share.contactId! }, select: { name: true } }))?.name ?? null)
}

export interface SharePostInput {
  readonly body: string
  readonly attachments?: readonly string[] | undefined
}

/** POST /link/share/messages. */
export async function postOnShare(request: FastifyRequest, input: SharePostInput, idempotencyKey?: string) {
  const link = inviteLinkOf(request)
  const draft = { bodyText: cleanBody(input.body), attachments: uniqueIds(input.attachments) }
  const problems = postProblems(draft)
  if (problems.length > 0) throw new ValidationError('The message is not valid.', problems)

  const opened = await request.withClient(async (client) => {
    const share = await requireLiveShare(request, client)
    const thread = await threadOf(client, link.record)
    return { share, thread }
  })
  const scope = await systemCallerOf(request)(link.tenantId).withClient((client) => resolveRecord(client, link.record.type, link.record.id))
  if (!scope) throw linkUnavailable()
  const may = mayOf(opened.share, opened.thread?.status ?? null, scope.partyId === link.partyId)
  if (may.postHeld) throw heldRefusal(may.postHeld)
  const thread = opened.thread ?? (await openThreadFor(request, link.tenantId, link.partyId, link.record))
  if (thread.status === 'CLOSED') throw heldRefusal('CLOSED')
  const authorName = authorNameOf({ contactName: await contactNameOf(request, link.tenantId, opened.share), email: opened.share.email })
  const companyName = await systemCallerOf(request)(link.tenantId).withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    return company?.tradeName ?? company?.legalName ?? ''
  })

  const { result } = await linkCommand(request, { name: SHARE_POST_ACTION, idempotencyKey, input: { ...draft } }, async (tools) => {
    // The share and the thread as they are now (narrowed, revoked, closed a moment ago?).
    const share = await requireLiveShare(request, tools.tx)
    const current = await threadOf(tools.tx, link.record)
    if (!current || current.id !== thread.id || current.partyId !== link.partyId) throw new NotFoundError('Record not found.')
    const again = mayOf(share, current.status, true)
    if (again.postHeld) throw heldRefusal(again.postHeld)
    const issues = await attachmentProblems(tools.tx, request, current, draft.attachments)
    if (issues.length > 0) throw new ValidationError('The message is not valid.', issues)
    await useLink(tools, request, { action: 'post' })
    const id = newId()
    const row = await tools.tx.message.create({
      data: {
        id,
        threadId: current.id,
        partyId: link.partyId,
        direction: 'INBOUND',
        audience: 'PARTNER',
        channel: 'PORTAL',
        authorKind: 'PARTY',
        authorName,
        bodyText: draft.bodyText,
        bodyHtml: null,
        attachmentFileIds: [...draft.attachments],
        emailMessageId: null,
        at: tools.now,
        createdAt: tools.now,
      },
      select: MESSAGE_PARTNER,
    })
    tools.audit({
      action: SHARE_POST_ACTION,
      recordType: 'Message',
      recordId: id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { threadId: current.id, recordType: current.recordType, recordId: current.recordId, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', shareId: share.id, attachments: [...draft.attachments] },
    })
    tools.emit(
      eventFor(messagePosted, {
        subject: current.recordId,
        companyId: current.companyId,
        siteId: current.siteId,
        payload: { threadId: current.id, messageId: id, recordType: current.recordType, recordId: current.recordId, direction: 'INBOUND', audience: 'PARTNER' },
      }),
    )
    const attachments = await linkAttachments(tools.tx, request, row.attachmentFileIds)
    return { thread: { id: current.id, status: current.status }, message: messageViewOf(row, companyName, attachments, new Set([id])) }
  })
  await touchThread(request, link.tenantId, result.thread.id, new Date(result.message.at))
  return result
}

/** The record's thread made in the tenant's system scope (the partner role cannot insert one), for this party only. */
async function openThreadFor(request: FastifyRequest, tenantId: string, partyId: string, ref: { readonly type: string; readonly id: string }): Promise<PartnerThreadRow> {
  const { result } = await command(systemCallerOf(request)(tenantId), { name: 'shares.openThread', input: { recordType: ref.type, recordId: ref.id, partyId } }, async (tools) => {
    const { thread } = await ensureThread(tools, ref, null)
    if (thread.partyId !== partyId) throw new NotFoundError('Record not found.')
    return { id: thread.id }
  })
  const thread = await request.withClient((client) => client.thread.findUnique({ where: { id: result.id }, select: THREAD_PARTNER }))
  if (!thread) throw new NotFoundError('Record not found.')
  return thread
}

/** The thread's last activity moves to the post (only later), in the tenant's system scope: bookkeeping after the post. */
async function touchThread(request: FastifyRequest, tenantId: string, threadId: string, at: Date): Promise<void> {
  await systemCallerOf(request)(tenantId).withClient((client) =>
    client.thread.updateMany({ where: { id: threadId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] }, data: { lastMessageAt: at } }),
  )
}
