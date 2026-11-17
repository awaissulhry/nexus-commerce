import type { CardFileStatus, CardMessage, Delivery } from './card/model'
import type { ActorAudience, FeedEvent } from './feed/model'

/**
 * B-TH-212 — RecordThread v1, the rules between the API and the parts (threads plan T3–T7 in one column for Incoming's reading pane
 * and the request's full page; the docked thread comes with B-TH-300). An API message becomes a card BY ITS AUDIENCE (an internal
 * note → an Office note, or the floor's comment when a floor worker wrote it; outbound → ours; inbound → theirs), with its mail's
 * state and the task a bounce made; a timeline change becomes a quiet step or a grouped change; the message a link names is read
 * from `?message=<id>` (thread-G03); J / K walk messages only while the feed has the focus. A message being sent waits in an
 * outbox beside the server's list, so a live re-read never drops what the person typed or sent. Pure: shapes as the API answers
 * them (apps/factory-api platform/threads, email-out), no client code.
 */

/** A thread message as GET /threads/<type>/<id> answers it. */
export interface ThreadApiMessage {
  id: string
  direction: 'INTERNAL_NOTE' | 'OUTBOUND' | 'INBOUND'
  channel: 'APP' | 'EMAIL' | 'PORTAL'
  author: { kind: 'USER' | 'WORKER' | 'PARTY' | 'SYSTEM'; id?: string | null; name: string | null }
  authorHidden: boolean
  forFloor: boolean
  body: string
  mentions?: readonly string[]
  attachments: ReadonlyArray<{ id: string; originalName: string; contentType: string; sizeBytes: number; status: CardFileStatus }>
  at: string
}

/** A mail of the thread (GET …/emails). */
export interface ThreadApiEmail {
  messageId: string | null
  to: readonly string[]
  subject: string
  status: Delivery
}

/** A mail's delivery (GET /email/delivery-status): the task its bounce made. */
export interface ThreadApiDelivery {
  messageId: string | null
  task: { id: string; status: 'OPEN' | 'DONE' | 'CANCELLED' } | null
}

/** A change of the record's history (GET …/timeline, kind change). */
export interface ThreadApiChange {
  kind: 'change'
  id: string
  at: string
  action: string
  actor: { audience: ActorAudience; id: string | null }
  actorHidden: boolean
  status: { from: string | null; to: string | null } | null
  fields: readonly string[]
  before?: unknown
  after?: unknown
}

export interface CardSources {
  /** The mails of the thread by their message. */
  emails: ReadonlyMap<string, ThreadApiEmail>
  deliveries?: ReadonlyMap<string, ThreadApiDelivery>
  /** Who a mention id or an actor id is (the record's people and the reader). */
  names: ReadonlyMap<string, string>
  /** Where a task opens (the company's Home › My tasks). */
  taskHref?: (taskId: string) => string
}

/** An API message as a card, by its audience. */
export function cardOf(message: ThreadApiMessage, sources: CardSources): CardMessage {
  const kind = message.direction === 'INTERNAL_NOTE' ? (message.author.kind === 'WORKER' ? 'floor' : 'note') : message.direction === 'OUTBOUND' ? 'ours' : 'theirs'
  const email = sources.emails.get(message.id) ?? null
  const delivery = sources.deliveries?.get(message.id) ?? null
  return {
    id: message.id,
    kind,
    channel: message.channel,
    author: message.authorHidden ? null : message.author.name,
    authorKind: message.author.kind,
    authorHidden: message.authorHidden,
    at: message.at,
    body: message.body,
    forFloor: message.forFloor,
    mentions: (message.mentions ?? []).map((id) => sources.names.get(id) ?? null),
    files: message.attachments.map((file) => ({ id: file.id, name: file.originalName, sizeBytes: file.sizeBytes, contentType: file.contentType, status: file.status })),
    email: email ? { to: email.to, subject: email.subject, status: email.status } : null,
    bounceTask: email?.status === 'BOUNCED' && delivery?.task && delivery.task.status === 'OPEN' && sources.taskHref ? { href: sources.taskHref(delivery.task.id) } : null,
  }
}

/** A history change as a quiet line of the feed; a message or a file entry is not (the card and the files line show them). */
export function eventOf(entry: ThreadApiChange, names: ReadonlyMap<string, string>): FeedEvent {
  const verb = entry.action.slice(entry.action.lastIndexOf('.') + 1)
  const before = (entry.before ?? null) as Record<string, unknown> | null
  const after = (entry.after ?? null) as Record<string, unknown> | null
  const values =
    before && after && typeof before === 'object' && typeof after === 'object'
      ? (entry.fields.length > 0 ? entry.fields : [...new Set([...Object.keys(before), ...Object.keys(after)])])
          .filter((field) => field !== 'status' && (field in before || field in after))
          .map((field) => ({ field, before: valueText(before[field]), after: valueText(after[field]) }))
      : []
  return {
    id: entry.id,
    at: entry.at,
    who: entry.actor.id ? (names.get(entry.actor.id) ?? null) : null,
    whoHidden: entry.actorHidden,
    actorAudience: entry.actor.audience,
    verb,
    status: entry.status,
    values,
    fields: entry.fields,
  }
}

/** A value in one short line (the API's before / after are JSON). */
export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const text = JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

/** Thread steps the feed leaves out: a note posted, a mail sent (the card is the message), a file (the files line). */
export function feedShowsChange(entry: Pick<ThreadApiChange, 'action'>): boolean {
  return !/^(threads|email|files)\./.test(entry.action) && !/\.(postNote|send|requestUpload|completeUpload)$/.test(entry.action)
}

/** Who closed the thread and when, from the history (the newest status change to CLOSED), when it says. */
export function closedBy(entries: readonly ThreadApiChange[], names: ReadonlyMap<string, string>): { by: string | null; at: string | null } {
  const closed = [...entries].filter((entry) => entry.status?.to === 'CLOSED').sort((a, b) => (a.at < b.at ? 1 : -1))[0]
  if (!closed) return { by: null, at: null }
  return { by: closed.actor.id ? (names.get(closed.actor.id) ?? null) : null, at: closed.at }
}

/** The message a link names (`?message=<id>`; the bell's message anchor has the same form). */
export function anchorOf(search: string | { get(name: string): string | null } | null | undefined): string | null {
  if (!search) return null
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search : `?${search}`) : search
  const id = params.get('message')?.trim() ?? ''
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null
}

/**
 * What J / K walk (T4-F09): the messages while the feed has the focus; the records (the band's Previous / Next) when the focus is
 * elsewhere on the page; nothing while the person types in a field.
 */
export function walkScope(focus: { inFeed: boolean; inField: boolean }): 'messages' | 'records' | null {
  if (focus.inField) return null
  return focus.inFeed ? 'messages' : 'records'
}

/** A message the person sent that the server has not confirmed yet, or that did not go (its text kept). */
export interface OutboxItem {
  key: string
  card: CardMessage
  state: 'sending' | 'failed'
  /** Why it did not go: a key of record-thread-card (`reason.network`). */
  reason?: string
  /** The server's id once it answered: the item leaves when the list has it. */
  messageId?: string
}

/**
 * The cards the feed draws: the server's, then what is on its way or did not go. An item whose message the server now lists is
 * dropped; a re-read keeps the rest (and the draft is held apart: a live read never drops what the person typed).
 */
export function withOutbox(server: readonly CardMessage[], outbox: readonly OutboxItem[]): CardMessage[] {
  const ids = new Set(server.map((card) => card.id))
  const pending = outbox.filter((item) => !(item.messageId && ids.has(item.messageId)))
  return [...server, ...pending.map((item) => ({ ...item.card, id: item.key, outbox: item.state === 'sending' ? ({ state: 'sending' } as const) : ({ state: 'failed', reason: item.reason ?? 'reason.failed' } as const) }))]
}

/** The outbox after a re-read: items the server now lists are gone. */
export function settleOutbox(outbox: readonly OutboxItem[], serverIds: ReadonlySet<string>): OutboxItem[] {
  return outbox.filter((item) => !(item.messageId && serverIds.has(item.messageId)))
}
