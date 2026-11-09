import type { FastifyRequest } from 'fastify'
import { DomainError } from '@nexus/factory-domain/core/errors'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { newMessageMail, recordLabelOf, SHARE_MAIL_TEMPLATES } from '@nexus/factory-domain/shares/mail'
import { authorNameOf, SHARE_RECORD_TYPES, shareLocaleOf, sharePermissionsOf } from '@nexus/factory-domain/shares/rules'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller } from '../../core/command'
import { serverClock, type Clock } from '../../core/time'
import { deliverMail, queueMail } from '../approvals-out/mail'
import { linkCommand } from '../links/use'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { inviteLinkOf, requireLiveShare, SHARE_POST_ACTION } from './page'
import { shareRecordOf } from './records'

/**
 * "E-mail me" (B-W2b-200; design links.invite › E-mail me "New messages by e-mail", a toggle): the invited person's own switch
 * (RecordShare.notifyByEmail, on until they switch it off: the only column the partner role may change on a share), and the
 * mails it asks for.
 *
 *   PUT /link/share/notify {on}   the link's command in its own partner scope (the database lets a partner session change
 *                                 notifyByEmail only), version + 1, `record_share.changed` (by PARTNER).
 *   the worker's handler `shares.notify` on `thread.message_posted` of a shared message (audience PARTNER) of a shareable
 *   record: every LIVE share of that record with the switch on, but the one whose link wrote the message, gets one mail
 *   (who wrote, the first lines; never the link: the invitation's mail is the only one that carries it), unless a mail about
 *   that record already reached that address in the last 10 minutes (our own mail of the message: its recipients have it).
 *   One system command per share and event (key `share-notify-<event>-<share>`: a replay sends nothing again), the QUEUED
 *   outbound row, then the mail (FAKE locally).
 */

export const SHARES_NOTIFY_HANDLER = 'shares.notify'
const ALREADY_MAILED_MS = 10 * 60_000

/** PUT /link/share/notify. */
export async function setShareNotify(request: FastifyRequest, body: { readonly on: boolean }, idempotencyKey?: string) {
  const link = inviteLinkOf(request)
  const { result } = await linkCommand(request, { name: 'shares.notify', idempotencyKey, input: { on: body.on } }, async (tools) => {
    const share = await requireLiveShare(request, tools.tx)
    if (share.notifyByEmail === body.on) return { notifyByEmail: share.notifyByEmail, version: share.version }
    const { count } = await tools.tx.recordShare.updateMany({ where: { id: share.id, version: share.version }, data: { notifyByEmail: body.on, version: share.version + 1, updatedAt: tools.now } })
    if (count !== 1) throw new DomainError('conflict', 'Your invitation changed a moment ago: read the page again.', [{ path: 'refusal/STALE', message: 'STALE' }])
    tools.audit({ recordType: 'RecordShare', recordId: share.id, companyId: share.companyId, before: { notifyByEmail: share.notifyByEmail }, after: { notifyByEmail: body.on } })
    tools.emit({ type: 'record_share.changed', subject: share.id, companyId: share.companyId, payload: { shareId: share.id, recordType: share.recordType, recordId: share.recordId, partyId: share.partyId, permissions: sharePermissionsOf(share.permissions), notifyByEmail: body.on, by: 'PARTNER' } })
    return { notifyByEmail: body.on, version: share.version + 1 }
  })
  return { ...result, linkId: link.id }
}

interface PostedPayload {
  readonly threadId: string
  readonly messageId: string
  readonly recordType: string
  readonly recordId: string
  readonly direction: string
  readonly audience: string
}

/** One event's "E-mail me" mails (the handler's work; tests call it). How many mails went. */
export async function notifyShares(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type' | 'payload'>, clock: Clock = serverClock): Promise<number> {
  const payload = event.payload as PostedPayload
  if (payload.audience !== 'PARTNER' || !SHARE_RECORD_TYPES.includes(payload.recordType)) return 0
  const adapter = shareRecordOf(payload.recordType)!
  const now = clock.now()
  const facts = await caller.withClient(async (client) => {
    const shares = await client.recordShare.findMany({
      where: { recordType: payload.recordType, recordId: payload.recordId, notifyByEmail: true, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, companyId: true, partyId: true, contactId: true, email: true, linkId: true },
    })
    if (shares.length === 0) return null
    const message = await client.message.findUnique({ where: { id: payload.messageId }, select: { authorName: true, bodyText: true, direction: true, partyId: true } })
    // The link that wrote it, when an invited partner did (its audit row's actor).
    const wrote = await client.auditLog.findFirst({ where: { recordType: 'Message', recordId: payload.messageId, action: SHARE_POST_ACTION }, select: { actorId: true } })
    const record = await adapter.read(client, payload.recordId)
    const companyIds = [...new Set(shares.map((share) => share.companyId))]
    const companies = new Map((await client.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, legalName: true, tradeName: true } })).map((company) => [company.id, company.tradeName ?? company.legalName]))
    const contactIds = shares.map((share) => share.contactId).filter((id): id is string => id !== null)
    const contacts = new Map((await client.partyContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, language: true } })).map((contact) => [contact.id, contact]))
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(shares.map((share) => share.partyId))] } }, select: { id: true, language: true } })).map((party) => [party.id, party.language]))
    return { shares, message, wrote, record, companies, contacts, parties }
  })
  if (!facts?.message || !facts.record || facts.message.partyId === null) return 0
  let sent = 0
  for (const share of facts.shares) {
    if (share.partyId !== facts.message.partyId) continue
    if (facts.wrote && share.linkId === facts.wrote.actorId) continue
    const since = new Date(now.getTime() - ALREADY_MAILED_MS)
    const already = await caller.withClient((client) => client.emailOutbound.findFirst({ where: { recordId: payload.recordId, to: { has: share.email }, createdAt: { gte: since } }, select: { id: true } }))
    if (already) continue
    const contact = share.contactId ? facts.contacts.get(share.contactId) : undefined
    const locale = shareLocaleOf(contact?.language ?? facts.parties.get(share.partyId))
    const companyName = facts.companies.get(share.companyId) ?? ''
    const mail = newMessageMail(locale, {
      companyName,
      label: recordLabelOf(payload.recordType, facts.record.reference, locale),
      authorName: facts.message.direction === 'OUTBOUND' ? (facts.message.authorName ?? companyName) : authorNameOf({ contactName: facts.message.authorName, email: share.email }),
      excerpt: excerptOf(facts.message.bodyText),
    })
    const { result, replayed } = await command(caller, { name: 'shares.notifyMail', idempotencyKey: `share-notify-${event.eventId}-${share.id}`, input: { eventId: event.eventId, shareId: share.id }, causationId: event.eventId }, async (tools) => {
      const outboundId = await queueMail(tools, { companyId: share.companyId, record: { type: 'RecordShare', id: share.id }, template: SHARE_MAIL_TEMPLATES.message, to: share.email, locale, subject: mail.subject, sender: null })
      tools.audit({ recordType: 'RecordShare', recordId: share.id, companyId: share.companyId, after: { notified: true, messageId: payload.messageId, outboundId } })
      return { outboundId }
    })
    if (replayed) continue
    const outcome = await deliverMail(caller, result.outboundId, mail.body, null, clock)
    if (outcome === 'SENT') sent++
  }
  return sent
}

/** The worker's handler (background.ts W2B_200_HANDLERS). */
export function sharesNotifyHandler(): EventHandler {
  return defineHandler({
    name: SHARES_NOTIFY_HANDLER,
    events: ['thread.message_posted'],
    async handle(event, tools) {
      await notifyShares(tools.caller, event)
    },
  })
}
