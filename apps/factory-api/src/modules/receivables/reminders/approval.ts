import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { TrustBody } from '@nexus/factory-domain/receivables/notices/contracts'
import { trustedFor, trustedSteps, trustWords } from '@nexus/factory-domain/receivables/notices/notices'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { RECEIVABLES_REMINDERS_TRUST } from '@nexus/factory-domain/receivables/riba/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { reminderViews } from '../reminders'
import { invoiceContactsOf, lockCustomer, lockReminder, officeContextOf, receivablesCommand, REMINDER_COLUMNS, settingsFor, tenantIdOf, type CustomerScope, type Reader, type ReminderRow } from '../store'

/**
 * Reminders approved by a person, with trusted levels (B-W2b-402; FIN-113: "reminders are a list a clerk confirms; a trusted
 * level may go by itself per customer, behind the reminder switch (OFF)"; design finance.receivables "Trusted levels can be
 * automatic per customer (W2b)"). W2a's list a clerk confirms stays as it is (../reminders.ts); this adds:
 *
 *   GET /receivables/customers/:partyId/trust   receivables.view: the customer's level, in words, and per company owed
 *                                               whether its reminders are on (so the trusted ones go now) and which steps
 *   PUT /receivables/customers/:partyId/trust   receivables.reminders.trust (the Owner's; a level also asks a fresh step-up):
 *                                               Party.reminderTrustedLevel, 1 to 10 or null, at the customer's version
 *   worker receivables.trustedReminders         after the ladder prepared a reminder, a stop was lifted or a level changed:
 *                                               each of the customer's PREPARED ladder reminders that is TRUSTED (an e-mail of a
 *                                               level up to the customer's; a letter, a call or one made by hand always waits)
 *                                               and that NOTHING HOLDS (W2a's held reasons and the stops: ../stops/holds.ts —
 *                                               the reminder view's `held` empty, so the company's reminders are on too) is
 *                                               approved by the trusted level (approvedById = the system: no person; schema
 *                                               need 2 of B-W2b-370) and sent to the invoice contacts (FAKE mail locally), in
 *                                               ONE command under the customer's lock. A held one waits for a person, as before.
 */

/** GET /receivables/customers/:partyId/trust (receivables.view). */
export async function getTrust(caller: CommandCaller, partyId: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const party = isUuid(partyId) ? await caller.withClient((db) => db.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, companyId: true, version: true, reminderTrustedLevel: true } })) : null
  if (!party || !can(actor, RECEIVABLES_VIEW, { companyId: party.companyId ?? undefined, partyId: party.id })) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (db) => trustAnswer(db, actor, party))
}

async function trustAnswer(db: Reader, actor: ReturnType<typeof actorOf>, party: { id: string; code: string; legalName: string; companyId: string | null; version: number; reminderTrustedLevel: number | null }) {
  const companies = await db.company.findMany({ where: party.companyId ? { id: party.companyId } : {}, orderBy: { code: 'asc' }, select: { id: true, code: true } })
  const owed: { id: string; code: string; remindersEnabled: boolean; steps: { level: number; offsetDays: number; action: string }[] }[] = []
  for (const company of companies) {
    if (!can(actor, RECEIVABLES_VIEW, { companyId: company.id, partyId: party.id })) continue
    const settings = await settingsFor(db, company.id)
    owed.push({ id: company.id, code: company.code, remindersEnabled: settings.remindersEnabled, steps: trustedSteps(party.reminderTrustedLevel, settings.ladder).map((step) => ({ level: step.level, offsetDays: step.offsetDays, action: step.action })) })
  }
  return {
    customer: { id: party.id, code: party.code, name: party.legalName, version: party.version },
    level: party.reminderTrustedLevel,
    words: trustWords(party.reminderTrustedLevel),
    companies: owed,
    mayChange: can(actor, RECEIVABLES_REMINDERS_TRUST, { companyId: party.companyId ?? undefined, partyId: party.id }),
  }
}

/** PUT /receivables/customers/:partyId/trust (receivables.reminders.trust; a level also a fresh step-up). */
export async function putTrust(caller: CommandCaller, partyId: string, body: TrustBody, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const peek = isUuid(partyId) ? await caller.withClient((db) => db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true } })) : null
  if (!peek || !can(actor, RECEIVABLES_VIEW, { companyId: peek.companyId ?? undefined, partyId: peek.id })) throw new NotFoundError('Customer not found.')
  if (!can(actor, RECEIVABLES_REMINDERS_TRUST, { companyId: peek.companyId ?? undefined, partyId: peek.id })) throw new ForbiddenError()
  if (body.level !== null) stepUp()
  const { result } = await receivablesCommand(caller, { name: 'receivables.trust', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT id FROM "Party" WHERE id = ${partyId}::uuid FOR UPDATE`
    const party = await tools.tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { id: true, code: true, legalName: true, companyId: true, version: true, reminderTrustedLevel: true } })
    if (party.version !== body.version) throw new DomainError('conflict', `This customer changed since it was read (version ${body.version}); it is now at version ${party.version}. Reload it and try again.`, [{ path: 'body/version', message: `The current version is ${party.version}.` }])
    if (party.reminderTrustedLevel === body.level) return trustAnswer(tools.tx, actor, party)
    const after = await tools.tx.party.update({ where: { id: partyId }, data: { reminderTrustedLevel: body.level, version: party.version + 1, updatedAt: tools.now }, select: { id: true, code: true, legalName: true, companyId: true, version: true, reminderTrustedLevel: true } })
    tools.audit({ action: 'receivables.trust', recordType: 'Party', recordId: partyId, companyId: party.companyId, before: { reminderTrustedLevel: party.reminderTrustedLevel }, after: { reminderTrustedLevel: body.level } })
    tools.emit({ type: 'reminder_trust.changed', subject: partyId, companyId: party.companyId, payload: { partyId, level: body.level } })
    return trustAnswer(tools.tx, actor, after)
  })
  return result
}

// ---- the trusted levels' own approval ---------------------------------------------------------------------------------------

/** The customer's PREPARED ladder reminders that are trusted (held or not: the command decides with the view's holds). */
async function trustedCandidates(db: Reader, scope: CustomerScope): Promise<ReminderRow[]> {
  const party = await db.party.findUnique({ where: { id: scope.partyId }, select: { reminderTrustedLevel: true } })
  if (!party?.reminderTrustedLevel) return []
  const rows = await db.paymentReminder.findMany({ where: { companyId: scope.companyId, partyId: scope.partyId, status: 'PREPARED', createdById: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: REMINDER_COLUMNS })
  return rows.filter((row) => trustedFor(party.reminderTrustedLevel, { level: row.level, action: row.action, byHand: row.createdById !== null }))
}

/** Approves (by the trusted level) and sends one reminder inside the command; false when something holds it now. */
async function approveByLevel(tools: CommandTools, row: ReminderRow, trustedLevel: number): Promise<boolean> {
  const { tx, now } = tools
  const [view] = await reminderViews(tx, tools.context, [row])
  if (!view || view.held.length > 0) return false
  const settings = await settingsFor(tx, row.companyId)
  if (!settings.remindersEnabled) return false
  const contacts = await invoiceContactsOf(tx, row.partyId)
  if (contacts.length === 0 || !row.subject?.trim() || !row.body?.trim()) return false
  await tx.paymentReminder.update({ where: { id: row.id }, data: { status: 'APPROVED', approvedAt: now, approvedById: SYSTEM_ACTOR_ID, version: row.version + 1, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'receivables.trustedApprove', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { status: 'PREPARED' }, after: { status: 'APPROVED', byTrustedLevel: trustedLevel, level: row.level, sending: true } })
  tools.emit({ type: 'payment_reminder.approved', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level, sending: true } })
  const company = await tx.company.findUniqueOrThrow({ where: { id: row.companyId }, select: { legalName: true } })
  const sent = await sendEmail(tools, { record: { type: 'PaymentReminder', id: row.id }, sender: { userId: SYSTEM_ACTOR_ID, name: company.legalName, email: null }, to: contacts.map((contact) => contact.email), subject: row.subject, body: row.body, locale: row.language })
  await tx.paymentReminder.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: now, version: row.version + 2, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'receivables.send', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { status: 'APPROVED' }, after: { status: 'SENT', action: row.action, outboundId: sent.outbound.id, fileId: null, byTrustedLevel: trustedLevel } })
  tools.emit({ type: 'payment_reminder.sent', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level, action: row.action, outboundId: sent.outbound.id, fileId: null } })
  return true
}

/** The trusted reminders that nothing holds now (the reminder view's `held` empty: so the company's reminders are on too). */
async function freeOf(db: Reader, context: CommandCaller['factoryContext'], rows: readonly ReminderRow[]): Promise<ReminderRow[]> {
  if (rows.length === 0 || !context) return []
  const views = await reminderViews(db, context, rows)
  return rows.filter((row) => views.find((view) => view.id === row.id)?.held.length === 0)
}

/** The trusted reminders of one customer that may go now, approved by its level and sent; answers their ids. */
export async function trustedPass(caller: CommandCaller, scope: CustomerScope, idempotencyKey?: string): Promise<string[]> {
  // Read-only first: a command only when one may go.
  const candidates = await caller.withClient(async (db) => freeOf(db, caller.factoryContext, await trustedCandidates(db, scope)))
  if (candidates.length === 0) return []
  const { result } = await receivablesCommand(caller, { name: 'receivables.trustedReminders', idempotencyKey, input: scope }, async (tools) => {
    await lockCustomer(tools.tx, tenantIdOf(tools.context), scope)
    const party = await tools.tx.party.findUnique({ where: { id: scope.partyId }, select: { reminderTrustedLevel: true } })
    if (!party?.reminderTrustedLevel) return []
    const sent: string[] = []
    for (const candidate of await trustedCandidates(tools.tx, scope)) {
      const row = await lockReminder(tools.tx, candidate.id, candidate.version)
      if (row.status !== 'PREPARED') continue
      // A reminder whose claim changed is the ladder's to cancel (its view holds it CHANGED): never sent by itself.
      if (await approveByLevel(tools, row, party.reminderTrustedLevel)) sent.push(row.id)
    }
    // Something came to hold them meanwhile: nothing went (the pass is still audited).
    if (sent.length === 0) tools.audit({ action: 'receivables.trustedReminders', recordType: 'Party', recordId: scope.partyId, companyId: scope.companyId, after: { idle: true } })
    return sent
  })
  return result
}

type Payload = Record<string, unknown>
const str = (payload: Payload, key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null)

/** The customer an event is about (a reminder prepared by the ladder, a stop lifted, a level changed). */
async function scopesOf(db: Reader, type: string, payload: Payload): Promise<CustomerScope[]> {
  if (type === 'payment_reminder.prepared') {
    if (payload.byHand === true) return []
    const id = str(payload, 'reminderId')
    const reminder = id ? await db.paymentReminder.findUnique({ where: { id }, select: { companyId: true, partyId: true } }) : null
    return reminder ? [reminder] : []
  }
  if (type === 'reminder_stop.changed') {
    if (payload.action !== 'LIFTED') return []
    const id = str(payload, 'stopId')
    const stop = id ? await db.reminderStop.findUnique({ where: { id }, select: { companyId: true, partyId: true } }) : null
    return stop ? [stop] : []
  }
  if (type === 'reminder_trust.changed') {
    const partyId = str(payload, 'partyId')
    if (!partyId || payload.level === null) return []
    const open = await db.paymentReminder.findMany({ where: { partyId, status: 'PREPARED', createdById: null }, select: { companyId: true, partyId: true }, distinct: ['companyId'] })
    return open
  }
  return []
}

export const TRUSTED_EVENTS = ['payment_reminder.prepared', 'reminder_stop.changed', 'reminder_trust.changed'] as const

/** The worker's handler (background.ts W2B_402_HANDLERS). */
export function trustedRemindersHandler(): EventHandler {
  return defineHandler({
    name: 'receivables.trustedReminders',
    events: [...TRUSTED_EVENTS],
    async handle(event, tools) {
      const scopes = await tools.caller.withClient((client) => scopesOf(client, event.type, event.payload as Payload))
      for (const scope of scopes) await trustedPass(tools.caller, scope, `trusted-reminders:${event.eventId}:${scope.companyId}`)
    },
  })
}
