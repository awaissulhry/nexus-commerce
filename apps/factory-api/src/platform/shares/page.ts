import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { postHeld, sharePermissionsOf, shareLocaleOf, shareStateOf, uploadHeld, type ShareLocale } from '@nexus/factory-domain/shares/rules'
import { sideOf } from '@nexus/factory-domain/threads/partner/rules'
import { encodeCursor } from '@nexus/factory-domain/threads/timeline'
import type { CommandTx } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { listFiles, systemCallerOf } from '../files/files'
import { audienceSees, KIND_RULES, type FileAudience } from '../files/rules'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../links/authenticator'
import { registerLinkLiveCheck } from '../links/records'
import { afterCursor, cursorOf, type RecordRef } from '../threads/threads'
import { resolveRecord } from '../threads/records'
import { shareRecordOf } from './records'

/**
 * What an invited partner reads (B-W2b-200; COL-061, COL-062; design links.invite, SCR-270: why you are here, the record,
 * shared files, messages, e-mail me). The link session is a partner session of the share's party bound to the ONE record
 * (factory_partner_runtime: the party's row-level security), and the link opens only while its share lives: the
 * authenticator asks `shareLive` on EVERY request of a RECORD_INVITE link (platform/links records.ts), so a share the office
 * revoked or that ended opens nothing anywhere — this page, the posts, the generic files routes.
 *
 *   GET /link/share?language=&cursor=   the share as it is now (what they may do, until when, "E-mail me"), who invited them
 *        (the office person's name: read in the tenant's system scope, as the partner role cannot read createdById), the
 *        record's PARTNER summary (its adapter's fields, platform/shares/records.ts: never money, pay or an office person;
 *        read in the system scope after the share was checked), the files of the record shared with its party's links
 *        (platform/files listFiles: available, LINK, the party), and one page of the record's PARTNER thread newest first
 *        (partner scope: never an internal note, never who in the office wrote it) with what the person may do now.
 *   GET /link/share/messages?cursor=    the next page of the thread.
 *
 * Opening uses nothing (RECORD_INVITE counts no action: "unlimited opens" until the share ends).
 */

type Client = FactoryClient | CommandTx

/** What the partner role reads of a share (never createdById or revokedById: no column grant). */
export const SHARE_PARTNER = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  partyId: true,
  contactId: true,
  email: true,
  permissions: true,
  notifyByEmail: true,
  expiresAt: true,
  revokedAt: true,
  linkId: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.RecordShareSelect
export type PartnerShareRow = Prisma.RecordShareGetPayload<{ select: typeof SHARE_PARTNER }>

const MESSAGE_PARTNER = { id: true, threadId: true, direction: true, channel: true, authorKind: true, authorName: true, bodyText: true, attachmentFileIds: true, at: true } as const satisfies Prisma.MessageSelect
export type PartnerMessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_PARTNER }>
export const THREAD_PARTNER = { id: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, status: true } as const satisfies Prisma.ThreadSelect
export type PartnerThreadRow = Prisma.ThreadGetPayload<{ select: typeof THREAD_PARTNER }>
const FILE_PARTNER = { id: true, companyId: true, recordType: true, recordId: true, kind: true, originalName: true, contentType: true, sizeBytes: true, status: true, visibility: true, partyId: true } as const satisfies Prisma.StoredFileSelect

/** The audit action of an invited partner's post: its actor is the link (`mine` on the page). */
export const SHARE_POST_ACTION = 'shares.post'
/** The audit action of an invited partner's upload. */
export const SHARE_UPLOAD_ACTION = 'shares.upload'

export const MESSAGES_PAGE = 30

/** The request's link when it is a RECORD_INVITE link of a shareable record; anything else opens nothing. */
export function inviteLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'RECORD_INVITE' || !shareRecordOf(link.record.type)) throw linkUnavailable()
  return link
}

/** The share a RECORD_INVITE link opens, read in the link's own partner scope, if it still lives. */
export async function liveShareOf(client: Client, linkId: string, now: Date): Promise<PartnerShareRow | null> {
  const share = await client.recordShare.findFirst({ where: { linkId }, select: SHARE_PARTNER })
  return share && shareStateOf(share, now) === 'LIVE' ? share : null
}

// The authenticator's check on every request of a RECORD_INVITE link: its share lives, of the same party and record.
registerLinkLiveCheck('RECORD_INVITE', async (client, link, now) => {
  const share = await liveShareOf(client, link.id, now)
  return share !== null && share.partyId === link.partyId && share.recordType === link.recordType && share.recordId === link.recordId
})

/** The share of the request's link, live, or the link's one 404. */
export async function requireLiveShare(request: FastifyRequest, client: Client): Promise<PartnerShareRow> {
  const link = inviteLinkOf(request)
  const share = await liveShareOf(client, link.id, officeAuthOf(request.server).clock.now())
  if (!share || share.partyId !== link.partyId || share.recordType !== link.record.type || share.recordId !== link.record.id) throw linkUnavailable()
  return share
}

export const threadOf = (client: Client, ref: RecordRef): Promise<PartnerThreadRow | null> => client.thread.findFirst({ where: { recordType: ref.type, recordId: ref.id }, select: THREAD_PARTNER })

/** The attached files the link may see: of its record, shared with its party's links, available. */
export async function linkAttachments(client: Client, request: FastifyRequest, fileIds: readonly string[]) {
  const link = linkSessionOf(request)
  const seen = new Map<string, { id: string; kind: string; originalName: string; contentType: string; sizeBytes: number; status: string }>()
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return seen
  const viewer = { audience: 'link' as const, partyId: link.partyId, record: link.record }
  const actor = actorOf(requireContext(request))
  for (const row of await client.storedFile.findMany({ where: { id: { in: ids } }, select: FILE_PARTNER })) {
    if (row.status !== 'AVAILABLE' || !audienceSees(viewer, { ...row, visibility: row.visibility as FileAudience[] })) continue
    if (!can(actor, FILES_READ, { companyId: row.companyId, partyId: row.partyId })) continue
    seen.set(row.id, { id: row.id, kind: row.kind, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, status: row.status })
  }
  return seen
}

/** The messages of these ids this link wrote (their post's audit rows name the link), read as the system. */
async function minePosts(request: FastifyRequest, link: LinkSession, rows: readonly PartnerMessageRow[]): Promise<Set<string>> {
  const ids = rows.filter((row) => row.authorKind === 'PARTY' && row.channel === 'PORTAL').map((row) => row.id)
  if (ids.length === 0) return new Set()
  const audits = await systemCallerOf(request)(link.tenantId).withClient((client) =>
    client.auditLog.findMany({ where: { recordType: 'Message', recordId: { in: ids }, action: SHARE_POST_ACTION, actorId: link.id }, select: { recordId: true } }),
  )
  return new Set(audits.map((row) => row.recordId))
}

export function messageViewOf(row: PartnerMessageRow, companyName: string, attachments: ReadonlyMap<string, { id: string; kind: string; originalName: string; contentType: string; sizeBytes: number }>, mine: ReadonlySet<string>) {
  const side = sideOf(row.direction)
  return {
    id: row.id,
    side,
    channel: row.channel,
    author: { name: row.authorName ?? (side === 'COMPANY' ? companyName : null), mine: mine.has(row.id) },
    body: row.bodyText,
    attachments: row.attachmentFileIds.flatMap((fileId) => {
      const seen = attachments.get(fileId)
      return seen ? [{ id: seen.id, kind: seen.kind, originalName: seen.originalName, contentType: seen.contentType, sizeBytes: seen.sizeBytes }] : []
    }),
    at: toUtcIso(row.at),
  }
}

/** One page of the record's PARTNER thread as the link reads it, newest first. */
export async function messagesPage(request: FastifyRequest, cursor: string | undefined, companyName: string) {
  const link = inviteLinkOf(request)
  const after = cursorOf(cursor)
  const read = await request.withClient(async (client) => {
    await requireLiveShare(request, client)
    const thread = await threadOf(client, link.record)
    const rows = thread
      ? await client.message.findMany({
          where: { AND: [{ threadId: thread.id, audience: 'PARTNER' }, afterCursor(after, 'at') as Prisma.MessageWhereInput] },
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: MESSAGES_PAGE + 1,
          select: MESSAGE_PARTNER,
        })
      : []
    const shown = rows.slice(0, MESSAGES_PAGE)
    return { thread, rows, shown, attachments: await linkAttachments(client, request, shown.flatMap((row) => row.attachmentFileIds)) }
  })
  const mine = await minePosts(request, link, read.shown)
  const last = read.shown.at(-1)
  return {
    thread: read.thread,
    messages: read.shown.map((row) => messageViewOf(row, companyName, read.attachments, mine)),
    nextCursor: read.rows.length > MESSAGES_PAGE && last ? encodeCursor(last) : null,
  }
}

/** The facts the system reads for the page after the share was checked: the record's fields, the sender, who invited. */
async function systemFacts(request: FastifyRequest, link: LinkSession, share: PartnerShareRow) {
  const adapter = shareRecordOf(share.recordType)!
  return systemCallerOf(request)(link.tenantId).withClient(async (client) => {
    const record = await adapter.read(client, share.recordId)
    const scope = await resolveRecord(client, share.recordType, share.recordId)
    const company = await client.company.findUnique({ where: { id: share.companyId }, select: { legalName: true, tradeName: true } })
    const row = await client.recordShare.findUnique({ where: { id: share.id }, select: { createdById: true } })
    const inviter = row?.createdById ? await client.user.findUnique({ where: { id: row.createdById }, select: { displayName: true } }) : null
    const language = share.contactId ? (await client.partyContact.findFirst({ where: { id: share.contactId }, select: { language: true } }))?.language : null
    const partyLanguage = (await client.party.findUnique({ where: { id: share.partyId }, select: { language: true } }))?.language
    const replyByEmail = (await client.message.count({ where: { thread: { recordType: share.recordType, recordId: share.recordId }, direction: 'OUTBOUND', channel: 'EMAIL', audience: 'PARTNER' } })) > 0
    return { record, scope, companyName: company?.tradeName ?? company?.legalName ?? '', inviter: inviter?.displayName ?? null, locale: shareLocaleOf(language ?? partyLanguage), replyByEmail }
  })
}

/** What the person may do on the thread and with files now, from the share as it is now. */
export function mayOf(share: PartnerShareRow, threadStatus: 'OPEN' | 'CLOSED' | null, sameParty: boolean) {
  const facts = { permissions: share.permissions, threadStatus, sameParty }
  const post = postHeld(facts)
  const upload = uploadHeld(facts)
  return { canPost: post === null, postHeld: post, canUpload: upload === null, uploadHeld: upload }
}

/** The kinds of file an invited partner may upload, and how large (platform/files' ATTACHMENT rule). */
export const UPLOAD_RULE = { contentTypes: [...KIND_RULES.ATTACHMENT.contentTypes], maxBytes: KIND_RULES.ATTACHMENT.maxBytes } as const

/** GET /link/share. */
export async function linkSharePage(request: FastifyRequest, query: { readonly language?: ShareLocale | undefined; readonly cursor?: string | undefined }) {
  const link = inviteLinkOf(request)
  const share = await request.withClient((client) => requireLiveShare(request, client))
  const facts = await systemFacts(request, link, share)
  if (!facts.record) throw linkUnavailable()
  const files = (await listFiles(request, { recordType: share.recordType, recordId: share.recordId })).filter((file) => !('supersededAt' in file) || !file.supersededAt)
  const uploaded = await systemCallerOf(request)(link.tenantId).withClient((client) =>
    client.auditLog.findMany({ where: { recordType: 'StoredFile', recordId: { in: files.map((file) => file.id) }, action: SHARE_UPLOAD_ACTION, actorId: link.id }, select: { recordId: true } }),
  )
  const mineFiles = new Set(uploaded.map((row) => row.recordId))
  const page = await messagesPage(request, query.cursor, facts.companyName)
  const sameParty = facts.scope?.partyId === share.partyId
  const may = mayOf(share, page.thread?.status ?? null, sameParty)
  return {
    share: {
      id: share.id,
      permissions: sharePermissionsOf(share.permissions),
      notifyByEmail: share.notifyByEmail,
      expiresAt: toUtcIso(share.expiresAt),
      invitedAt: toUtcIso(share.createdAt),
      invitedBy: facts.inviter,
      version: share.version,
    },
    from: { companyName: facts.companyName },
    record: { type: share.recordType, reference: facts.record.reference, theirRef: facts.record.theirRef, fields: facts.record.fields.map((field) => ({ ...field })) },
    files: files.map((file) => ({ id: file.id, kind: file.kind, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, at: file.availableAt ?? file.createdAt, mine: mineFiles.has(file.id) })),
    thread: {
      status: page.thread?.status ?? null,
      shared: sameParty,
      messages: page.messages,
      nextCursor: page.nextCursor,
      canPost: may.canPost,
      held: may.postHeld,
      replyByEmail: facts.replyByEmail,
    },
    upload: { canUpload: may.canUpload, held: may.uploadHeld, contentTypes: [...UPLOAD_RULE.contentTypes], maxBytes: UPLOAD_RULE.maxBytes },
    locale: query.language ?? facts.locale,
  }
}

/** GET /link/share/messages. */
export async function linkShareMessages(request: FastifyRequest, cursor: string | undefined) {
  const link = inviteLinkOf(request)
  const companyName = await systemCallerOf(request)(link.tenantId).withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: link.companyId }, select: { legalName: true, tradeName: true } })
    return company?.tradeName ?? company?.legalName ?? ''
  })
  const page = await messagesPage(request, cursor, companyName)
  return { messages: page.messages, nextCursor: page.nextCursor }
}
