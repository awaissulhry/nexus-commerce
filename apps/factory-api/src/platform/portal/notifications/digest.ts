import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { portalRecordUrl } from '@nexus/factory-domain/portal/home/links'
import { digestFrequenciesAt, PARTNER_DIGEST_LOOKBACK_MS } from '@nexus/factory-domain/portal/notifications/digest'
import { DIGEST_MAX_ITEMS, PORTAL_MAIL_TEMPLATES } from '@nexus/factory-domain/portal/notifications/mail'
import { partnerSentence, topicOfNotice } from '@nexus/factory-domain/portal/notifications/messages'
import { frequencyOf } from '@nexus/factory-domain/portal/notifications/topics'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { processEmail, type EmailRuntime } from '../../email-out/service'
import { activeTenants, systemContext } from '../../outbox/system'
import { partyReaders } from '../tasks/people'
import { kindTopic } from './fan-out'
import { logPartnerDeliveries, sendPartnerMail, unsubscribeKeyFor } from './mail'
import { preferencesOf } from './settings'

/**
 * The partner summaries (B-W2b-167; COL-063 "Daily summary / Weekly summary"; plan "a daily or weekly digest (a scheduler
 * job)"). The scheduler's cron `portalNotifications.digest` (every 15 minutes) sends, from 08:00 Europe/Rome on working days,
 * each partner person who may use the portal ONE summary a day at most (factory-domain portal/notifications/digest.ts): the
 * notifications of their DAILY topics (and on Monday their WEEKLY ones) that no mail carried yet (no delivery row), unread,
 * from the last 8 days, newest first, at most 50 listed. One mail per person and day (a summary sent today is found by its
 * EmailOutbound row); each listed notification gets an EMAIL_DIGEST delivery (SENT with the mail's id, or FAILED with why) and
 * the person `partner_notification.digest_sent`. Nothing to list: nothing is sent. The portal must be ON for the party.
 */

const clockOf = (instant: Date): string => new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)
const weekdayOf = (instant: Date): number => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TIME_ZONE, weekday: 'short' }).format(instant)) + 1

export interface PartnerDigestOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  /** The key of the unsubscribe links (mail.ts): the caller's, never read from the env here. */
  readonly unsubscribeKey: Buffer
  readonly clock?: Clock
  readonly runtime?: () => EmailRuntime
}

export interface PartnerDigestResult {
  readonly sent: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's; tests call it with their clock). */
export async function runPartnerDigests(options: PartnerDigestOptions): Promise<PartnerDigestResult> {
  const clock = options.clock ?? serverClock
  const now = clock.now()
  const result = { sent: 0, failed: 0 }
  const frequencies = digestFrequenciesAt({ weekday: weekdayOf(now), clock: clockOf(now) }, false)
  if (frequencies.length === 0) return result
  const requestId = `portal-digest-${newId()}`
  const dayStart = businessDayStart(businessDate(now))
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      // The parties with a portal ON and the people of each who were told something not mailed yet.
      const waiting = await caller.withClient((client) =>
        client.notification.findMany({
          where: { partyId: { not: null }, readAt: null, doneAt: null, createdAt: { gt: new Date(now.getTime() - PARTNER_DIGEST_LOOKBACK_MS), lte: now }, deliveries: { none: {} } },
          distinct: ['userId'],
          select: { userId: true, partyId: true, companyId: true },
          take: 5000,
        }),
      )
      for (const entry of waiting) {
        try {
          const outcome = await digestOf(caller, { tenantId, userId: entry.userId, partyId: entry.partyId!, now, dayStart, weekly: frequencies.includes('WEEKLY'), frequencies, runtime: (options.runtime ?? processEmail)(), unsubscribeKey: options.unsubscribeKey, ...(options.clock ? { clock: options.clock } : {}) })
          if (outcome !== 'skip') result[outcome] += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId }, 'a partner summary could not be sent')
        }
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the partner summaries of a tenant could not be read')
    }
  }
  return result
}

async function digestOf(
  caller: CommandCaller,
  input: { readonly tenantId: string; readonly userId: string; readonly partyId: string; readonly now: Date; readonly dayStart: Date; readonly weekly: boolean; readonly frequencies: readonly string[]; readonly runtime: EmailRuntime; readonly unsubscribeKey: Buffer; readonly clock?: Clock },
): Promise<'sent' | 'failed' | 'skip'> {
  const facts = await caller.withClient(async (client) => {
    const sentToday = await client.emailOutbound.findFirst({ where: { recordType: 'User', recordId: input.userId, templateKey: PORTAL_MAIL_TEMPLATES.digest, createdAt: { gte: input.dayStart } }, select: { id: true } })
    if (sentToday) return null
    const rows = await client.notification.findMany({
      where: { userId: input.userId, readAt: null, doneAt: null, createdAt: { gt: new Date(input.now.getTime() - PARTNER_DIGEST_LOOKBACK_MS), lte: input.now }, deliveries: { none: {} } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
      select: { id: true, companyId: true, recordType: true, recordId: true, recordLabel: true, anchor: true, messageKey: true, params: true },
    })
    const stored = await preferencesOf(client, input.userId)
    const party = await client.party.findUnique({ where: { id: input.partyId }, select: { code: true } })
    return { rows, stored, partyCode: party?.code ?? input.partyId }
  })
  if (!facts) return 'skip'
  const due = facts.rows.filter((row) => {
    const topic = topicOfNotice(row, kindTopic)
    return topic !== null && input.frequencies.includes(frequencyOf(topic, facts.stored))
  })
  if (due.length === 0) return 'skip'
  // The company whose portal the summary is of: the newest notification's (a tenant-wide partner's companies apart).
  const companyId = due.find((row) => row.companyId !== null)?.companyId ?? null
  if (companyId === null) return 'skip'
  const reader = (await caller.withClient((client) => partyReaders(client, input.tenantId, input.partyId, companyId, input.now))).find((entry) => entry.personId === input.userId)
  if (!reader) return 'skip'
  const ofCompany = due.filter((row) => row.companyId === companyId)
  const listed = ofCompany.slice(0, DIGEST_MAX_ITEMS)
  const company = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { legalName: true, tradeName: true } }))
  const companyName = company ? (company.tradeName ?? company.legalName) : ''
  const items = listed.map((row) => ({ notificationId: row.id, sentence: partnerSentence(row, reader.locale, companyName), link: portalRecordUrl(input.runtime.webOrigin, facts.partyCode, row.recordType, row.recordId, row.anchor) }))
  const sent = await sendPartnerMail(caller, { tenantId: input.tenantId, companyId, person: { id: reader.personId, email: reader.email, displayName: reader.displayName, locale: reader.locale, partyId: input.partyId }, body: { kind: 'digest', weekly: input.weekly, items, more: ofCompany.length - listed.length }, runtime: input.runtime, unsubscribeKey: input.unsubscribeKey, ...(input.clock ? { clock: input.clock } : {}) })
  await logPartnerDeliveries(caller, {
    key: `portal-digest-${input.userId}-${businessDate(input.now)}`,
    channel: 'EMAIL_DIGEST',
    rows: listed.map((row) => ({ notificationId: row.id, outcome: sent.outcome, emailOutboundId: sent.outboundId, detail: sent.detail })),
    audit: { recordType: 'User', recordId: input.userId, after: { outcome: sent.outcome, listed: listed.length, more: ofCompany.length - listed.length, weekly: input.weekly, ...(sent.outboundId ? { emailOutboundId: sent.outboundId } : {}) } },
  })
  if (sent.outcome === 'SENT' && sent.outboundId) {
    await command(caller, { name: 'portalNotifications.digestSent', idempotencyKey: `portal-digest-sent-${input.userId}-${businessDate(input.now)}`, input: { userId: input.userId } }, async (tools) => {
      tools.audit({ recordType: 'User', recordId: input.userId, after: { emailOutboundId: sent.outboundId, count: listed.length } })
      tools.emit({ type: 'partner_notification.digest_sent', subject: input.userId, companyId, payload: { userId: input.userId, partyId: input.partyId, emailOutboundId: sent.outboundId!, count: listed.length, weekly: input.weekly } })
      return null
    })
    return 'sent'
  }
  return 'failed'
}

/** The scheduler's cron; `cookieSecret` from its env (the unsubscribe links' key). */
export function partnerDigestCron(options: Omit<PartnerDigestOptions, 'unsubscribeKey'> & { readonly cookieSecret: string }): CronJob {
  const { cookieSecret, ...rest } = options
  const settings = { ...rest, unsubscribeKey: unsubscribeKeyFor(cookieSecret) }
  return defineCron({
    name: 'portalNotifications.digest',
    schedule: '*/15 * * * *',
    lockTtlMs: 600_000,
    async run() {
      const result = await runPartnerDigests(settings)
      if (result.sent + result.failed > 0) options.log.info({ ...result }, 'partner summaries')
    },
  })
}
