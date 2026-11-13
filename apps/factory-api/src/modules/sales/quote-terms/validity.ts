import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { REMINDER_DAYS_BEFORE, reminderMail, validityOf } from '@nexus/factory-domain/sales/quote-terms/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { sendEmail } from '../../../platform/email-out/outbound'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { day } from '../quotes/store'
// B-W2b-F38: the quote reminder goes only for a company whose switch is on (off by default).
import { reminderOnFor, reminderSwitchBook, ReminderSwitchedOff } from '../quotes/reminder-switches'

/**
 * A sent quote's validity, run daily (B-W2b-294; SAL-145 "Quote validity and expiry: reminders and auto-expiry"): the
 * scheduler's clustered cron `sales.quoteValidity` (06:15 Europe/Rome; one replica per tick). For every ACTIVE tenant, in its
 * system context:
 *
 *   expiry     each SENT version whose last day (validUntil) has passed becomes EXPIRED with closedAt (W1's machine: SENT →
 *              EXPIRED; the quote follows when it is its current version); quote.expired. Its accept link already says the
 *              offer ended (W1 computes it); a new version (W1's revise) revives the quote
 *   reminder   each SENT current version whose reminder is due (factory-domain quote-terms validityOf: REMINDER_DAYS_BEFORE
 *              days before its last day, sent at least two days before, never reminded) gets ONE mail to the customer on the
 *              quote's thread, from the person who sent it, to the address its link went to (else its contact): the offer's
 *              number, its last day, where its link is; no link (a link is never stored) and no amount. reminderSentAt is set
 *              in the same command; quote.reminder_sent. The mail goes on the company's mail account (FAKE locally and in
 *              tests)
 *   B-W2b-F38  the reminder goes only for a company whose quote reminder switch is on (Sales settings; off by default): a
 *              company with it off is skipped before any command (counted in `switchedOff`), and a switch turned off while
 *              the run goes rolls the command back. Nothing is written for it — no mail, no reminderSentAt, no receipt — so
 *              switching it on later still reminds a quote whose reminder is due then. Expiry does not depend on the switch
 *
 * Each version in its own command with a fixed Idempotency-Key (`quote-expire-<id>`, `quote-reminder-<id>`), so a race or a
 * rerun acts once; a version or a tenant that fails is logged and the others go on. Idle runs write nothing.
 */

export const EXPIRE_COMMAND = 'quotes.expire'
export const REMIND_COMMAND = 'quotes.remind'

export interface ValidityOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface ValidityRun {
  readonly tenants: number
  readonly today: BusinessDate
  readonly expired: number
  readonly reminded: number
  readonly skipped: number
  /** B-W2b-F38: reminders due but not sent because the company's switch is off. */
  readonly switchedOff: number
  readonly failed: number
}

const VERSION_FACTS = { id: true, quoteId: true, revision: true, status: true, validUntil: true, firmOffer: true, language: true, sentAt: true, sentById: true, reminderSentAt: true } as const

/** One version's expiry, in its own command. */
async function expireVersion(caller: CommandCaller, settings: CommandSettings, versionId: string, quoteId: string, today: BusinessDate): Promise<boolean> {
  const { result } = await runCommand(
    caller,
    { name: EXPIRE_COMMAND, idempotencyKey: `quote-expire-${versionId}`, input: { versionId }, record: { type: 'Quote', id: quoteId } },
    async ({ tx, now, audit, emit }) => {
      await tx.$queryRaw`SELECT id FROM "QuoteVersion" WHERE id = ${versionId}::uuid FOR UPDATE`
      const version = await tx.quoteVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_FACTS })
      const until = day(version.validUntil)
      if (version.status !== 'SENT' || until === null || until >= today) return { expired: false }
      const quote = await tx.quote.findUniqueOrThrow({ where: { id: version.quoteId }, select: { id: true, companyId: true, number: true, currentRevision: true, status: true } })
      await tx.quoteVersion.update({ where: { id: version.id }, data: { status: 'EXPIRED', closedAt: now, version: { increment: 1 } }, select: { id: true } })
      const current = quote.currentRevision === version.revision
      if (current) await tx.quote.update({ where: { id: quote.id }, data: { status: 'EXPIRED' }, select: { id: true } })
      audit({ action: EXPIRE_COMMAND, recordType: 'Quote', recordId: quote.id, companyId: quote.companyId, before: { versionId: version.id, revision: version.revision, status: 'SENT', quoteStatus: quote.status }, after: { versionId: version.id, revision: version.revision, status: 'EXPIRED', quoteStatus: current ? 'EXPIRED' : quote.status, validUntil: until, closedAt: toUtcIso(now) } })
      emit({ type: 'quote.expired', subject: quote.id, companyId: quote.companyId, payload: { quoteId: quote.id, versionId: version.id, number: quote.number, revision: version.revision, validUntil: until } })
      return { expired: true }
    },
    settings,
  )
  return result.expired
}

/** One version's reminder, in its own command: 'sent', or why not ('not due', 'no address', 'no sender'; B-W2b-F38: 'switched off'). */
async function remindVersion(caller: CommandCaller, settings: CommandSettings, versionId: string, today: BusinessDate): Promise<'sent' | 'not due' | 'no address' | 'no sender' | 'switched off'> {
  // B-W2b-F38: a switch turned off after the listing rolls the command back (ReminderSwitchedOff): nothing written.
  const remind = () => runCommand(
    caller,
    { name: REMIND_COMMAND, idempotencyKey: `quote-reminder-${versionId}`, input: { versionId } },
    async (tools) => {
      const { tx, now } = tools
      await tx.$queryRaw`SELECT id FROM "QuoteVersion" WHERE id = ${versionId}::uuid FOR UPDATE`
      const version = await tx.quoteVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_FACTS })
      const quote = await tx.quote.findUniqueOrThrow({ where: { id: version.quoteId }, select: { id: true, companyId: true, number: true, contactId: true, currentRevision: true } })
      const validUntil = day(version.validUntil)
      const state = validityOf({ status: version.status, validUntil, sentOn: version.sentAt ? businessDate(version.sentAt) : null, reminderSentAt: version.reminderSentAt, current: version.revision === quote.currentRevision }, today)
      if (!state.reminderDue || validUntil === null || version.sentAt === null) return { outcome: 'not due' as const }
      // B-W2b-F38: the company's switch, read again in the command (the job listed it a moment before).
      if (!(await reminderOnFor(tx, quote.companyId, 'QUOTE'))) throw new ReminderSwitchedOff('QUOTE')
      // The address its accept link went to (the newest link of the version's quote), else its contact's.
      const link = await tx.oneOffLink.findFirst({ where: { recordType: 'Quote', recordId: quote.id, purpose: 'QUOTE_ACCEPT', createdAt: { gte: version.sentAt } }, select: { email: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
      const contact = quote.contactId ? await tx.partyContact.findUnique({ where: { id: quote.contactId }, select: { email: true, status: true } }) : null
      const to = link?.email ?? (contact && contact.status === 'ACTIVE' ? contact.email : null)
      const sender = version.sentById ? await tx.user.findUnique({ where: { id: version.sentById }, select: { id: true, displayName: true, email: true } }) : null
      if (!to || !sender) {
        tools.audit({ action: REMIND_COMMAND, recordType: 'Quote', recordId: quote.id, companyId: quote.companyId, after: { versionId: version.id, revision: version.revision, mailed: false, why: !to ? 'no address' : 'no sender' } })
        return { outcome: !to ? ('no address' as const) : ('no sender' as const) }
      }
      const language = version.language === 'en' ? 'en' : 'it'
      const mail = reminderMail({ language, number: quote.number, revision: version.revision, validUntil, sentOn: businessDate(version.sentAt), firmOffer: version.firmOffer })
      const sent = await sendEmail(tools, { record: { type: 'Quote', id: quote.id }, sender: { userId: sender.id, name: sender.displayName, email: sender.email }, to: [to], subject: mail.subject, body: mail.body, attachments: [], locale: language })
      await tx.quoteVersion.update({ where: { id: version.id }, data: { reminderSentAt: now }, select: { id: true } })
      tools.audit({ action: REMIND_COMMAND, recordType: 'Quote', recordId: quote.id, companyId: quote.companyId, after: { versionId: version.id, revision: version.revision, mailed: true, outboundId: sent.outbound.id, validUntil, reminderSentAt: toUtcIso(now) } })
      tools.emit({ type: 'quote.reminder_sent', subject: quote.id, companyId: quote.companyId, payload: { quoteId: quote.id, versionId: version.id, number: quote.number, revision: version.revision, validUntil, outboundId: sent.outbound.id } })
      return { outcome: 'sent' as const }
    },
    settings,
  )
  try {
    return (await remind()).result.outcome
  } catch (error) {
    if (error instanceof ReminderSwitchedOff) return 'switched off'
    throw error
  }
}

/** One run over every active tenant (the cron's tick; tests call it directly). */
export async function runQuoteValidity(options: ValidityOptions): Promise<ValidityRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const today = businessDate(clock.now())
  const requestId = `quote-validity-${newId()}`
  let expired = 0
  let reminded = 0
  let skipped = 0
  let switchedOff = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await asSystem(options.database, tenantId, requestId, async (client) => ({
        ended: await client.quoteVersion.findMany({ where: { status: 'SENT', validUntil: { lt: new Date(`${today}T00:00:00.000Z`) } }, select: { id: true, quoteId: true }, orderBy: [{ validUntil: 'asc' }, { id: 'asc' }] }),
        ending: await client.quoteVersion.findMany({
          where: { status: 'SENT', reminderSentAt: null, validUntil: { gte: new Date(`${today}T00:00:00.000Z`), lte: new Date(`${addDays(today, REMINDER_DAYS_BEFORE)}T00:00:00.000Z`) } },
          // B-W2b-F38: the quote's company, for its reminder switch.
          select: { id: true, quote: { select: { companyId: true } } },
          orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
        }),
        // B-W2b-F38: every company's quote reminder switch, read once for the tenant.
        quoteReminderOn: await reminderSwitchBook(client, 'QUOTE'),
      }))
      for (const version of due.ended) {
        try {
          if (await expireVersion(caller, settings, version.id, version.quoteId, today)) expired++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, versionId: version.id }, 'a quote past its validity could not be marked expired')
        }
      }
      for (const version of due.ending) {
        // B-W2b-F38: switched off for its company: no command, nothing written.
        if (!due.quoteReminderOn(version.quote.companyId)) {
          switchedOff++
          continue
        }
        try {
          const outcome = await remindVersion(caller, settings, version.id, today)
          if (outcome === 'sent') reminded++
          else if (outcome === 'switched off') switchedOff++
          else if (outcome !== 'not due') skipped++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, versionId: version.id }, 'the reminder of a quote that ends soon could not be sent')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the quotes of a tenant could not be checked for their validity')
    }
  }
  const result = { tenants: tenants.length, today, expired, reminded, skipped, switchedOff, failed }
  options.log.info({ ...result }, 'quote validity checked')
  return result
}

/** The scheduler's daily cron (06:15 Europe/Rome). */
export function quoteValidityCron(options: ValidityOptions): CronJob {
  return defineCron({
    name: 'sales.quoteValidity',
    schedule: '15 6 * * *',
    async run() {
      await runQuoteValidity(options)
    },
  })
}
