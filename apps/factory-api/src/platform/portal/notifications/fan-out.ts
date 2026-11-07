import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { GROUP_WINDOW_MS, groupKeyFor } from '@nexus/factory-domain/notifications/rules'
import { portalRecordUrl } from '@nexus/factory-domain/portal/home/links'
import { PARTNER_MESSAGE_TEMPLATES, partnerSentence, topicOfNotice } from '@nexus/factory-domain/portal/notifications/messages'
import { frequencyOf, type PartnerEmailFrequency, type PartnerEmailTopic } from '@nexus/factory-domain/portal/notifications/topics'
import { isPartnerTaskKind, KIND_RULES } from '@nexus/factory-domain/portal/tasks/kinds'
import { command, type CommandCaller } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../outbox/dispatch'
import { processEmail, type EmailRuntime } from '../../email-out/service'
import { latestOfGroup } from '../../notifications/store'
import { partyReaders } from '../tasks/people'
import { logPartnerDeliveries, sendPartnerMail, unsubscribeKeyFor } from './mail'
import { PARTNER_RULES } from './rules'
import { preferencesOf } from './settings'

/**
 * The partner fan-out (B-W2b-167, PLT-148: "Partner notifications from outbox events, by e-mail as it happens or in a daily
 * or weekly digest"): the worker's handler `portalNotifications.fanOut` turns one outbox event into the notifications of the
 * partner people it concerns, by the rules of ./rules, in ONE system command keyed by the event (`portal-notify-<event id>`;
 * a replay answers from its receipt, and the rows insert with skipDuplicates on (person, event type, event id)).
 *
 * The readers are the party's people who could use the portal now (../tasks/people.ts partyReaders: portal ON, active, before
 * their end of access, roles reaching the record's company); each draft keeps those its rule says the record is for. A row
 * names the person's party (the database checks it), the record, the message key and params (never an amount, never an office
 * person), and joins its group (same person, record and category within 15 minutes). One `partner_notification.created` per
 * party tells its sessions to read their bell again.
 *
 * After the command: every row whose topic the person gets AS IT HAPPENS (a transactional topic always) is mailed at once,
 * one mail per notification (./mail.ts), unless a mail about the same record already went to the same address in the last 10
 * minutes (the record's own mail: a sent PO, an invoice's courtesy copy); its delivery is logged (EMAIL: SENT, SKIPPED or
 * FAILED). Rows of a DAILY or WEEKLY topic wait for the summary (./digest.ts); OFF stays in the bell only.
 */

export const PARTNER_FAN_OUT_HANDLER = 'portalNotifications.fanOut'
const ALREADY_MAILED_MS = 10 * 60_000

export const partnerFanOutEvents = (): string[] => [...new Set(PARTNER_RULES.flatMap((rule) => rule.events))].sort()

/** The e-mail topic of a kind's request (portal.task.opened takes its kind's). */
export const kindTopic = (kind: string): PartnerEmailTopic | null => (isPartnerTaskKind(kind) ? KIND_RULES[kind].topic : null)

interface Made {
  readonly id: string
  readonly userId: string
  readonly email: string
  readonly displayName: string
  readonly locale: 'it' | 'en'
  readonly partyId: string
  readonly companyId: string
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly messageKey: string
  readonly params: Prisma.InputJsonValue
  readonly anchor: string | null
  readonly frequency: PartnerEmailFrequency
}

export interface PartnerFanOutOptions {
  /** The key of the unsubscribe links (mail.ts unsubscribeKeyOf / unsubscribeKeyFor): the caller's, never read from the env here. */
  readonly unsubscribeKey: Buffer
  readonly runtime?: () => EmailRuntime
  readonly clock?: Clock
}

/** One event's partner notifications and instant mails (the handler's work; tests call it). How many notifications were made. */
export async function partnerFanOut(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type'> & Partial<EventEnvelope>, options: PartnerFanOutOptions): Promise<number> {
  const rules = PARTNER_RULES.filter((rule) => rule.events.includes(event.type))
  if (rules.length === 0) return 0
  const envelope = event as EventEnvelope
  const { result, replayed } = await command(
    caller,
    { name: 'portalNotifications.fanOut', idempotencyKey: `portal-notify-${event.eventId}`, input: { eventId: event.eventId, type: event.type }, causationId: event.eventId },
    async (tools) => {
      const { tx, now } = tools
      const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : null
      if (!tenantId) return [] as Made[]
      const made: Made[] = []
      const parties = new Map<string, number>()
      for (const rule of rules) {
        for (const draft of await rule.drafts({ tx, tenantId, now, event: envelope }, envelope.payload)) {
          const template = PARTNER_MESSAGE_TEMPLATES[draft.messageKey]
          const topic = topicOfNotice({ messageKey: draft.messageKey, recordLabel: draft.record.label, params: draft.params }, kindTopic)
          for (const reader of await partyReaders(tx, tenantId, draft.partyId, draft.companyId, now)) {
            if (!draft.forReader(reader) || made.some((row) => row.userId === reader.personId)) continue
            const id = newId()
            const previous = await latestOfGroup(tx, reader.personId, draft.record.type, draft.record.id, template.category, new Date(now.getTime() - GROUP_WINDOW_MS))
            const inserted = await tx.notification.createMany({
              data: [
                {
                  id,
                  userId: reader.personId,
                  partyId: reader.partyId,
                  companyId: draft.companyId,
                  category: template.category,
                  eventType: event.type,
                  eventId: event.eventId,
                  recordType: draft.record.type,
                  recordId: draft.record.id,
                  recordLabel: draft.record.label,
                  anchor: draft.anchor,
                  messageKey: draft.messageKey,
                  params: draft.params as Prisma.InputJsonValue,
                  actorId: null,
                  groupKey: groupKeyFor(previous, id, now),
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              skipDuplicates: true,
            })
            if (inserted.count === 0) continue
            const stored = topic === null ? 'OFF' : frequencyOf(topic, await preferencesOf(tx, reader.personId))
            made.push({ id, userId: reader.personId, email: reader.email, displayName: reader.displayName, locale: reader.locale, partyId: reader.partyId, companyId: draft.companyId, record: draft.record, messageKey: draft.messageKey, params: draft.params as Prisma.InputJsonValue, anchor: draft.anchor, frequency: stored })
            parties.set(reader.partyId, (parties.get(reader.partyId) ?? 0) + 1)
          }
        }
      }
      // The audit row names the event and how many were made per party: never the people or the words.
      tools.audit({ action: 'portalNotifications.fanOut', recordType: 'OutboxEvent', recordId: event.eventId, companyId: envelope.companyId ?? null, after: { eventType: event.type, rules: rules.map((rule) => rule.name), made: made.length, parties: Object.fromEntries(parties) } })
      for (const [partyId, count] of parties) {
        tools.emit({ type: 'partner_notification.created', subject: event.eventId, companyId: envelope.companyId ?? null, payload: { partyId, sourceEventId: event.eventId, sourceType: event.type, count } })
      }
      return made
    },
  )
  if (replayed) return 0
  await mailInstant(caller, result, options)
  return result.length
}

/** The instant mails of what the fan-out made (see the module comment). A failure is logged as FAILED, never thrown. */
async function mailInstant(caller: CommandCaller, made: readonly Made[], options: PartnerFanOutOptions): Promise<void> {
  const instant = made.filter((row) => row.frequency === 'INSTANT')
  if (instant.length === 0) return
  const runtime = (options.runtime ?? processEmail)()
  const tenantId = caller.factoryContext && 'tenantId' in caller.factoryContext ? caller.factoryContext.tenantId : ''
  for (const row of instant) {
    // EmailOutbound rows carry their command's time (the server's, the record's own send included).
    const since = new Date(Date.now() - ALREADY_MAILED_MS)
    const already = await caller.withClient((client) => client.emailOutbound.findFirst({ where: { recordId: row.record.id, to: { has: row.email.toLowerCase() }, createdAt: { gte: since } }, select: { id: true } }))
    let outcome: { outcome: 'SENT' | 'SKIPPED' | 'FAILED'; outboundId: string | null; detail: string | null }
    if (already) {
      outcome = { outcome: 'SKIPPED', outboundId: null, detail: "the record's own mail reached this address a moment ago" }
    } else {
      const company = await caller.withClient((client) => client.party.findUnique({ where: { id: row.partyId }, select: { code: true } }))
      const companyName = await caller.withClient((client) => client.company.findUnique({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } }))
      const sentence = partnerSentence({ messageKey: row.messageKey, recordLabel: row.record.label, params: row.params }, row.locale, companyName ? (companyName.tradeName ?? companyName.legalName) : '')
      const link = portalRecordUrl(runtime.webOrigin, company?.code ?? row.partyId, row.record.type, row.record.id, row.anchor)
      try {
        outcome = await sendPartnerMail(caller, { tenantId, companyId: row.companyId, person: { id: row.userId, email: row.email, displayName: row.displayName, locale: row.locale, partyId: row.partyId }, body: { kind: 'notification', item: { notificationId: row.id, sentence, link } }, runtime, unsubscribeKey: options.unsubscribeKey, ...(options.clock ? { clock: options.clock } : {}) })
      } catch (error) {
        outcome = { outcome: 'FAILED', outboundId: null, detail: (error as Error).name === 'NoSenderError' ? 'the tenant has no verified sending identity' : 'the mail could not be made' }
      }
    }
    await logPartnerDeliveries(caller, {
      key: `portal-instant-${row.id}`,
      channel: 'EMAIL',
      rows: [{ notificationId: row.id, outcome: outcome.outcome, emailOutboundId: outcome.outboundId, detail: outcome.detail }],
      audit: { recordType: 'Notification', recordId: row.id, after: { outcome: outcome.outcome, ...(outcome.outboundId ? { emailOutboundId: outcome.outboundId } : {}) } },
    })
  }
}

/** The worker's handler. `cookieSecret` is read when an event is handled (background.ts loads its env after the lists). */
export function partnerNotificationsHandler(options: Omit<PartnerFanOutOptions, 'unsubscribeKey'> & { readonly cookieSecret: () => string }): EventHandler {
  const { cookieSecret, ...rest } = options
  return defineHandler({
    name: PARTNER_FAN_OUT_HANDLER,
    events: partnerFanOutEvents(),
    async handle(event, tools) {
      await partnerFanOut(tools.caller, event, { ...rest, unsubscribeKey: unsubscribeKeyFor(cookieSecret()) })
    },
  })
}

