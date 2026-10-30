import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as notificationEvents } from '@nexus/factory-domain/notifications/events'
import { GROUP_WINDOW_MS, groupKeyFor, type MessageKey, type NotificationCategory } from '@nexus/factory-domain/notifications/rules'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { heldRoles } from '../auth/roles/access'
import { insertNotifications, latestOfGroup, type NotificationInsert } from './store'
import { FAN_OUT_RULES } from './rules'

/**
 * The fan-out (B-W2a-20; PLT-138, PLT-142, PLT-152): the worker's handler `notifications.fanOut` turns one outbox event
 * into the notifications of the people it concerns, by the rules of ./rules (one file per source; B-W2a-33's alerts and
 * B-W2a-23's finished exports add theirs). QUIET BY DEFAULT: a rule names only the people the design names (who was
 * mentioned, who was given something, who decides an approval or asked for it, who follows the record), never "everyone
 * who may see it"; nobody is told about what they did themselves.
 *
 * Each event is ONE command as the tenant's system, keyed by the event (a repeated job answers from its receipt), and
 * the rows insert with skipDuplicates on (person, event type, event id): a replayed event makes no second notification.
 * A rule builds each reader's params FOR them from their live roles (an amount only with its grain, marked with it) and
 * re-checks that they still may see the record. A new notification joins the group of the same person, record and
 * category when one came within 15 minutes (PLT-142 grouping). One `notification.created` per fan-out tells the screens
 * to read their own bell again (it names nobody).
 */

const [notificationCreated] = notificationEvents

/** One notification a rule wants made. */
export interface Draft {
  readonly userId: string
  readonly category: NotificationCategory
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly companyId: string | null
  readonly anchor: string | null
  readonly messageKey: MessageKey
  /** Built for THIS reader: an amount only with its grain (markMoney). People as user ids. */
  readonly params: Record<string, Prisma.InputJsonValue | null>
  /** Who caused it (never told about it themselves); null: the system. */
  readonly actorId: string | null
}

/** A person as the rules see them: ACTIVE, with their live office roles (two-factor taken as proved). Null: not active. */
export interface Reader {
  readonly personId: string
  readonly actor: Actor
  readonly today: BusinessDate
  readonly now: Date
}

export interface RuleContext {
  readonly tx: CommandTx
  /** The event fanned out (none for a question asked outside the fan-out). */
  readonly event: EventEnvelope | null
  readonly tenantId: string
  readonly now: Date
  /** The reader of a person (cached for the event), or null when they are not an ACTIVE office person. */
  reader(userId: string): Promise<Reader | null>
  /** Every ACTIVE office person of the tenant (at most 500), for a rule that asks "who may decide this". */
  people(): Promise<readonly string[]>
}

export interface FanOutRule {
  /** `<area>.<rule>`, for the audit row. */
  readonly name: string
  readonly events: readonly string[]
  drafts(context: RuleContext, payload: unknown): Promise<readonly Draft[]>
}

/** The most office people a rule reads when it asks who may decide (a tenant's office staff). */
export const MAX_PEOPLE = 500

export const FAN_OUT_HANDLER = 'notifications.fanOut'

/** The event types the fan-out handles (every rule's). */
export const fanOutEvents = (): string[] => [...new Set(FAN_OUT_RULES.flatMap((rule) => rule.events))].sort()

/** The rules' context inside a command (readers cached for it). Also for a question a rule answers elsewhere (the nudge's deciders). */
export function ruleContext(tx: CommandTx, tenantId: string, now: Date, event: EventEnvelope | null = null): RuleContext {
  const readers = new Map<string, Reader | null>()
  let everyone: readonly string[] | null = null
  return {
    tx,
    event,
    tenantId,
    now,
    async reader(userId) {
      if (readers.has(userId)) return readers.get(userId)!
      const user = await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })
      const reader = user ? { personId: userId, actor: { audience: 'office' as const, tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(tx, userId, now), true) }, today: businessDate(now), now } : null
      readers.set(userId, reader)
      return reader
    },
    async people() {
      everyone ??= (await tx.user.findMany({ where: { status: 'ACTIVE' }, orderBy: { id: 'asc' }, take: MAX_PEOPLE, select: { id: true } })).map((user) => user.id)
      return everyone
    },
  }
}

/** One event's notifications (the handler's work; tests call it with the system caller). How many were made. */
export async function fanOut(caller: CommandCaller, event: Pick<EventEnvelope, 'eventId' | 'type'> & Partial<EventEnvelope>): Promise<number> {
  const rules = FAN_OUT_RULES.filter((rule) => rule.events.includes(event.type))
  if (rules.length === 0) return 0
  const envelope = event as EventEnvelope
  const { result, replayed } = await command(
    caller,
    { name: 'notifications.fanOut', idempotencyKey: `notify-${event.eventId}`, input: { eventId: event.eventId, type: event.type }, causationId: event.eventId },
    async (tools) => {
      const { tx, now } = tools
      const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : null
      if (!tenantId) return 0
      const context = ruleContext(tx, tenantId, now, envelope)
      const drafts: Draft[] = []
      for (const rule of rules) drafts.push(...(await rule.drafts(context, envelope.payload)))
      // One per person per event (the table's key); nobody is told about what they did themselves.
      const seen = new Set<string>()
      const rows: NotificationInsert[] = []
      for (const draft of drafts) {
        if (draft.actorId !== null && draft.actorId === draft.userId) continue
        if (seen.has(draft.userId)) continue
        seen.add(draft.userId)
        const id = newId()
        const previous = await latestOfGroup(tx, draft.userId, draft.record.type, draft.record.id, draft.category, new Date(now.getTime() - GROUP_WINDOW_MS))
        rows.push({
          id,
          userId: draft.userId,
          companyId: draft.companyId,
          category: draft.category,
          eventType: event.type,
          eventId: event.eventId,
          recordType: draft.record.type,
          recordId: draft.record.id,
          recordLabel: draft.record.label,
          anchor: draft.anchor,
          messageKey: draft.messageKey,
          params: draft.params as Prisma.InputJsonValue,
          actorId: draft.actorId,
          groupKey: groupKeyFor(previous, id, now),
          createdAt: now,
        })
      }
      const made = await insertNotifications(tx, rows)
      // The audit row names the event and how many were made, by category: never the people or the words.
      const categories: Record<string, number> = {}
      for (const row of rows) categories[row.category] = (categories[row.category] ?? 0) + 1
      tools.audit({ action: 'notifications.fanOut', recordType: 'OutboxEvent', recordId: event.eventId, companyId: envelope.companyId ?? null, after: { eventType: event.type, rules: rules.map((rule) => rule.name), made, categories } })
      if (made > 0) tools.emit(eventFor(notificationCreated, { subject: event.eventId, companyId: envelope.companyId ?? null, siteId: envelope.siteId ?? null, payload: { sourceEventId: event.eventId, sourceType: event.type, count: made } }))
      return made
    },
  )
  // A repeated job answers from the receipt: nothing was made this time.
  return replayed ? 0 : result
}

export function notificationsHandler(): EventHandler {
  return defineHandler({
    name: FAN_OUT_HANDLER,
    events: fanOutEvents(),
    async handle(event, tools) {
      await fanOut(tools.caller, event)
    },
  })
}
