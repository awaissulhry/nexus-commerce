import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { EMAIL_TRIAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { HeldReason, InboundAttachment, SkipReason } from '@nexus/factory-domain/email-in/rules'
import type { FeedAudience } from '@nexus/factory-domain/threads/timeline'
import type { CommandCaller, CommandTx } from '../../core/command'
import { systemCallerOf } from '../files/files'

/**
 * B-TH-079 (threads plan TH-6, N3, thread-G06, thread-G09, thread-G10; T1-F05, T3-F14, T3-F15, T4-F10; wall W08 / T08): the feed tells
 * everything —
 *
 *   view          the audience filter of the thread and timeline reads (FEED_AUDIENCES): "With the customer" the shared messages,
 *                 "Office notes" the office's; it only narrows — a portal or link reader reads shared messages whatever it asks
 *                 (OFFICE gives it none). The office's timeline also says how many messages new to the reader the view hides
 *                 ("1 new message hidden by this view · Show all"), so a forgotten view never hides news.
 *   erased        a message whose writer was erased after a privacy request (its name and words blanked: factory-db B-W2b-F54, an
 *                 ErasureRecord of the message) is told apart from a message that only carries files (its text empty too):
 *                 "Message removed after a privacy request", never an empty grey card.
 *   waiting mail  a mail for this conversation the worker did not put in it (HELD: the sender is not a contact of the customer, DMARC,
 *                 spam, a closed conversation; TRIAGE: Mail to sort), counted on the office's read with why, and whether the reader
 *                 may review it (email.triage over the mail's company); the office only — a customer is never told.
 *   skipped parts the files of an inbound mail that were not kept, with why (a type files do not take, too large, empty, too many) on
 *                 its message, for the office; a signature logo (an inline part) is skipped silently, never listed.
 */

/** What a waiting mail waits for: HELD's reason, or TRIAGE (Mail to sort). */
export type WaitingMailReason = HeldReason | 'TRIAGE'

export interface WaitingMail {
  readonly count: number
  /** Why they wait, each once, in the order first met. */
  readonly reasons: readonly WaitingMailReason[]
  /** The reader may open them in Mail to sort (email.triage over a mail's company): "Review"; else "A reply waits for a colleague to check it". */
  readonly mayReview: boolean
}

/** The most waiting mails one read counts (a conversation never has more in practice; the count says "50+" then). */
export const WAITING_MAIL_MAX = 50

/** The mails waiting for a person that name this thread (office readers only: the table is the office's). */
export async function waitingMailOf(client: FactoryClient | CommandTx, actor: Actor, threadId: string): Promise<WaitingMail | null> {
  const rows = await client.inboundEmail.findMany({
    where: { threadId, status: { in: ['HELD', 'TRIAGE'] } },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: WAITING_MAIL_MAX,
    select: { status: true, heldReason: true, companyId: true },
  })
  if (rows.length === 0) return null
  const reasons: WaitingMailReason[] = []
  for (const row of rows) {
    const reason: WaitingMailReason = row.status === 'TRIAGE' ? 'TRIAGE' : ((row.heldReason as HeldReason | null) ?? 'UNKNOWN_SENDER')
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  return { count: rows.length, reasons, mayReview: rows.some((row) => can(actor, EMAIL_TRIAGE, { companyId: row.companyId })) }
}

type ErasableRow = { readonly id: string; readonly bodyText: string; readonly authorName: string | null }

/**
 * The messages among these that were erased after a privacy request: the erasure blanks the name and the words (both, together), and
 * an ErasureRecord names the message — a message that only carries files keeps its writer's name, and an unknown sender's mail of
 * files only has no ErasureRecord. Read with an office (or the tenant's system) client: the table is the office's.
 */
export async function erasedAmong(client: FactoryClient | CommandTx, rows: readonly ErasableRow[]): Promise<Set<string>> {
  const candidates = rows.filter((row) => row.bodyText === '' && row.authorName === null).map((row) => row.id)
  if (candidates.length === 0) return new Set()
  const found = await client.erasureRecord.findMany({ where: { recordType: 'Message', recordId: { in: candidates }, method: 'ANONYMISED' }, select: { recordId: true } })
  return new Set(found.map((row) => row.recordId))
}

/**
 * The same for a portal or link reader (the partner role reads no ErasureRecord): read in the tenant's system scope, only for the
 * messages the reader already holds. A caller that is no request (a test's direct call) cannot open that scope: nothing is told erased
 * then (the card stays as it is; the answer never fails for a flag).
 */
export async function erasedForOutside(caller: CommandCaller, tenantId: string, rows: readonly ErasableRow[]): Promise<Set<string>> {
  if (!rows.some((row) => row.bodyText === '' && row.authorName === null)) return new Set()
  if (!('server' in (caller as object))) return new Set()
  try {
    return await systemCallerOf(caller as unknown as FastifyRequest)(tenantId).withClient((client) => erasedAmong(client, rows))
  } catch {
    return new Set()
  }
}

/** A file of an inbound mail that was not kept, as its message lists it. */
export interface SkippedPart {
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly reason: Exclude<SkipReason, 'inline'>
}

type MailRow = { readonly id: string; readonly direction: string; readonly channel: string }

/** The skipped parts of each inbound mail's message among these (office readers only), a signature logo left out. */
export async function skippedPartsOf(client: FactoryClient | CommandTx, rows: readonly MailRow[]): Promise<Map<string, SkippedPart[]>> {
  const ids = rows.filter((row) => row.direction === 'INBOUND' && row.channel === 'EMAIL').map((row) => row.id)
  const out = new Map<string, SkippedPart[]>()
  if (ids.length === 0) return out
  const mails = await client.inboundEmail.findMany({ where: { messageId: { in: ids } }, select: { messageId: true, attachments: true } })
  for (const mail of mails) {
    if (!mail.messageId) continue
    const parts = (Array.isArray(mail.attachments) ? (mail.attachments as unknown as InboundAttachment[]) : []).flatMap((part) =>
      part.kept || part.reason === 'inline' ? [] : [{ name: part.name, contentType: part.contentType, sizeBytes: part.sizeBytes, reason: part.reason as Exclude<SkipReason, 'inline'> }],
    )
    if (parts.length > 0) out.set(mail.messageId, parts)
  }
  return out
}

/** The messages a view shows (FEED_AUDIENCES): every one, the shared ones, or the office notes. */
export function feedAudienceWhere(audience: FeedAudience): Prisma.MessageWhereInput {
  return audience === 'ALL' ? {} : { audience }
}
