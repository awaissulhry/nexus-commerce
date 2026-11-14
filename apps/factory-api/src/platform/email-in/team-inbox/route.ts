import { events as emailInEvents } from '@nexus/factory-domain/email-in/events'
import { teamInboxOf } from '@nexus/factory-domain/mail-depth/rules'
import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../outbox/dispatch'
import { captureMail } from '../capture/match'
import { processEmailIn, type EmailInRuntime } from '../service'
import { emitWorked, replyDomainsOf, type Reader } from './store'

/**
 * Where a sorted mail goes next (B-W2b-394; COL-021, COL-027), the worker's handler `emailIn.route` of email.inbound_sorted:
 *
 *   1. a mail left in Mail to sort (TRIAGE) that came to a capture address: the capture step places it in its record's thread
 *      (../capture/match.ts); placed, it comes back here as MATCHED;
 *   2. a mail in no team inbox yet (not REJECTED): the team inbox its recipients name — `<local part>@<a reply domain of the
 *      inbox's company>`, the envelope's recipients first (a BCC is only there) — else, for a capture-address mail that could
 *      not be placed, the address's default team inbox (switched on). ONE command (teamInboxId, version + 1, audit,
 *      email.inbound_worked ROUTED / CAPTURED). A mail of a tenant-wide account (no company) goes to the inbox of the company
 *      whose reply domain it came to.
 * Safe to repeat: a mail with an inbox, or a REJECTED one, is left as it is.
 */

export const MAIL_ROUTE_HANDLER = 'emailIn.route'
const sortedPayload = emailInEvents[2].payload

/** The switched-on team inbox the recipients name, among the inboxes of the mail's company (any company's for a tenant-wide mail). */
async function inboxOfRecipients(db: Reader, mail: { readonly companyId: string | null; readonly envelopeTo: readonly string[]; readonly to: readonly string[]; readonly cc: readonly string[] }): Promise<string | null> {
  const inboxes = await db.teamInbox.findMany({ where: { active: true, ...(mail.companyId ? { companyId: mail.companyId } : {}) }, select: { id: true, companyId: true, localPart: true, active: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  if (inboxes.length === 0) return null
  const recipients = [...mail.envelopeTo, ...mail.to, ...mail.cc]
  for (const companyId of new Set(inboxes.map((inbox) => inbox.companyId))) {
    const found = teamInboxOf(recipients, await replyDomainsOf(db, companyId), inboxes.filter((inbox) => inbox.companyId === companyId))
    if (found) return found
  }
  return null
}

/** Puts a mail in its team inbox (step 2). Answers the inbox, or null when it stays where it is. */
export async function routeMail(caller: CommandCaller, inboundEmailId: string, fallback: string | null, options: { readonly causationId?: string } = {}): Promise<string | null> {
  const plan = await caller.withClient(async (db) => {
    const mail = await db.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: { id: true, companyId: true, status: true, teamInboxId: true, envelopeTo: true, to: true, cc: true } })
    if (!mail || mail.status === 'REJECTED' || mail.teamInboxId !== null) return null
    const named = await inboxOfRecipients(db, mail)
    if (named) return { mail, inboxId: named, change: 'ROUTED' as const }
    if (!fallback) return null
    const inbox = await db.teamInbox.findUnique({ where: { id: fallback }, select: { id: true, active: true, companyId: true } })
    return inbox?.active && (mail.companyId === null || inbox.companyId === mail.companyId) ? { mail, inboxId: inbox.id, change: 'CAPTURED' as const } : null
  })
  if (!plan) return null
  const { result } = await command(caller, { name: 'emailIn.route', input: { inboundEmailId, teamInboxId: plan.inboxId }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    const { count } = await tools.tx.inboundEmail.updateMany({ where: { id: inboundEmailId, teamInboxId: null, status: { not: 'REJECTED' } }, data: { teamInboxId: plan.inboxId, version: { increment: 1 } } })
    if (count !== 1) {
      tools.audit({ action: 'emailIn.routeSkipped', recordType: 'InboundEmail', recordId: inboundEmailId, companyId: plan.mail.companyId })
      return null
    }
    tools.audit({ action: 'emailIn.route', recordType: 'InboundEmail', recordId: inboundEmailId, companyId: plan.mail.companyId, before: { teamInboxId: null }, after: { teamInboxId: plan.inboxId, by: plan.change } })
    emitWorked(tools, plan.mail, plan.inboxId, plan.change, null, null)
    return plan.inboxId
  })
  return result
}

/** The worker's handler (background.ts W2B_394_HANDLERS). A failure throws: BullMQ retries it. */
export function mailRouteHandler(runtime: () => EmailInRuntime = processEmailIn): EventHandler {
  return defineHandler({
    name: MAIL_ROUTE_HANDLER,
    events: ['email.inbound_sorted'],
    attempts: 5,
    async handle(event, tools) {
      const { inboundEmailId, status } = sortedPayload.parse(event.payload)
      if (status === 'REJECTED') return
      let fallback: string | null = null
      if (status === 'TRIAGE') {
        const captured = await captureMail(runtime(), tools.caller, inboundEmailId, { causationId: event.eventId })
        // Placed: its MATCHED event brings it back here for step 2.
        if (captured.status === 'MATCHED') return
        if (captured.status === 'UNPLACED') fallback = captured.defaultTeamInboxId
      }
      await routeMail(tools.caller, inboundEmailId, fallback, { causationId: event.eventId })
    },
  })
}
