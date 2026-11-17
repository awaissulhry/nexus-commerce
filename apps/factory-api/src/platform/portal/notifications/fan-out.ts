import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { batchGroupKey, GROUP_WINDOW_MS, groupKeyFor } from '@nexus/factory-domain/notifications/rules'
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
// B-TH-080 (threads plan TH-6, thread-G11): the mail quotes the message we shared with the customer (never a note).
// th-backend-g step 2: with who wrote it, for the new-message mail's template.
import { partnerMessages } from '../../email-out/digest/message-text'
import { yoursOf } from '@nexus/factory-domain/portal/notifications/messages'
import { companyValues, fillMail, MAIL_EVENT_DEFINITIONS, type MailWords } from '@nexus/factory-domain/templates/mail'
import { mailTemplateOf } from '../../templates/active'
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
 * person), and joins its group (same person, record and category within 15 minutes; B-TH-045: same person, batch and category
 * when the draft names a batch). One `partner_notification.created` per
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
            // B-TH-045: a batch of ours (one answer to several records) is one group per person and kind; else the record's group.
            const groupKey = draft.batchId ? batchGroupKey(draft.batchId, template.category) : groupKeyFor(await latestOfGroup(tx, reader.personId, draft.record.type, draft.record.id, template.category, new Date(now.getTime() - GROUP_WINDOW_MS)), id, now)
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
                  groupKey,
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
    } else if (row.messageKey === 'portal.request.received' && (await sentTheRequest(caller, row.record.id, row.userId))) {
      // th-backend-g step 2: the person who sent the request gets its receipt mail (modules/sales/inquiries/receipt.ts), not this notice.
      outcome = { outcome: 'SKIPPED', outboundId: null, detail: 'the person who sent the request gets its receipt mail' }
    } else {
      const company = await caller.withClient((client) => client.party.findUnique({ where: { id: row.partyId }, select: { code: true } }))
      const companyName = await caller.withClient((client) => client.company.findUnique({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } }))
      const sentence = partnerSentence({ messageKey: row.messageKey, recordLabel: row.record.label, params: row.params }, row.locale, companyName ? (companyName.tradeName ?? companyName.legalName) : '')
      const link = portalRecordUrl(runtime.webOrigin, company?.code ?? row.partyId, row.record.type, row.record.id, row.anchor)
      // B-TH-080: only a message shared with this person's own customer.
      const shared = (await caller.withClient((client) => partnerMessages(client, row.partyId, [{ id: row.id, anchor: row.anchor }]))).get(row.id) ?? null
      const quote = shared?.quote ?? null
      // th-backend-g step 2 (B-TH-279): a new message reads the e-mail template thread.message_posted (the company's version in use in
      // the person's language, else every company's, else the code's words), filled with what the portal shows them.
      const words = row.messageKey === 'portal.message.posted' && companyName ? await messageWords(caller, row, { link, quote, authorName: shared?.authorName ?? null, company: companyName }) : null
      try {
        outcome = await sendPartnerMail(caller, { tenantId, companyId: row.companyId, person: { id: row.userId, email: row.email, displayName: row.displayName, locale: row.locale, partyId: row.partyId }, body: words ? { kind: 'templated', notificationId: row.id, words } : { kind: 'notification', item: { notificationId: row.id, sentence, link, quote } }, runtime, unsubscribeKey: options.unsubscribeKey, ...(options.clock ? { clock: options.clock } : {}) })
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

// ---- th-backend-g step 2 (B-TH-279: the new mail templates are read; the receipt goes to the person who sent the request) -----------
/** Whether this person sent the request from the portal (its making's audit row names them: the receipt mail is theirs). */
async function sentTheRequest(caller: CommandCaller, inquiryId: string, userId: string): Promise<boolean> {
  const made = await caller.withClient((client) => client.auditLog.findFirst({ where: { recordType: 'Inquiry', recordId: inquiryId, action: 'sales.inquiries.fromPortal' }, select: { actorId: true } }))
  return made?.actorId === userId
}

/**
 * The words of a new message's mail for one portal person: the template thread.message_posted in use in their language (the company's
 * own, else every company's), else the code's, filled with what their portal shows — the record by its customer's own words ("your
 * order 12", never the office's series), who wrote (the name the portal shows, else the company's), the shared message (its quote),
 * the portal link, the person's name, the company's names. Never an office note: `quote` is cut per reader (B-TH-080).
 */
async function messageWords(caller: CommandCaller, row: Made, facts: { readonly link: string; readonly quote: string | null; readonly authorName: string | null; readonly company: { readonly legalName: string; readonly tradeName: string | null } }): Promise<MailWords> {
  const template = await caller.withClient((client) => mailTemplateOf(client, caller.factoryContext, { companyId: row.companyId, event: 'thread.message_posted', language: row.locale }))
  const company = companyValues(facts.company)
  const { yours } = yoursOf({ messageKey: row.messageKey, recordLabel: row.record.label, params: row.params }, row.locale)
  return fillMail(template ?? MAIL_EVENT_DEFINITIONS['thread.message_posted'].words[row.locale], {
    ...company,
    'record.label': yours,
    'author.name': facts.authorName ?? company['company.name'] ?? null,
    message: facts.quote,
    link: facts.link,
    'contact.name': row.displayName,
  })
}
// ---- end th-backend-g step 2

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

