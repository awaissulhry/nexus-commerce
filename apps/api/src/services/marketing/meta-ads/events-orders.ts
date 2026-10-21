/**
 * Meta step 33 (lane C3, 2026-10-21) — what upload-meta-events reads from Nexus: the business's own orders of the days
 * (or the ids) asked, and what Nexus sent to Meta before (its own change records). Both through the workspace-scoped
 * client (db.ts): only THIS business's rows, never another business's orders.
 *
 *   - Orders of every channel, not in the recycle bin, by the time of the sale (purchaseDate, else the moment Nexus took
 *     the order in), with the buyer's e-mail and phone. Every channel is read so that the preview names each order it does
 *     NOT send and why (change-events.ts decides; a sale of the shop's website or of a marketplace is never sent).
 *   - The buyer's contact data lives only in memory, for the hash Meta gets: never logged, stored, answered or kept in a
 *     record (the records below hold order ids, event ids and times only).
 *   - Sent before: AgentChange rows of upload-meta-events of the last 9 days (`after.sent`: each order, its event_id, its
 *     sale time, when it went and whether Meta confirmed it), to any pixel: Nexus sends a sale to Meta once. Nine days =
 *     the 7 days an event may be sent in, plus Meta's 48-hour merge window, rounded up: an older record names no sale
 *     that could still go.
 *   - Sent or maybe sent (re-review N1): BEFORE its first request a run writes a send log of this business (AuditLog
 *     entityType MetaConversionsApi, action `send`: its own sendId, the pixel, and each sale's order id, event_id and
 *     sale time — never a buyer's data), and closes it (action `send-none`) when Meta took nothing. The run's change
 *     record carries the same sendId. A log of the last 9 days that is neither closed nor matched by a record — the run
 *     stopped, threw after it sent, or its record was not written, whatever became of its approval (pending again,
 *     expired, rejected) — stops every upload for 9 days (eventsUploadDoubt); its sales also count as maybe sent.
 *   - Two uploads at once: each run writes its log, then checks again for any other open log (sendStartProblem); of two
 *     runs whose logs overlap, at most one sends (each sees the other's log unless the other already checked before it).
 */
import prisma from '../../../db.js'

export const EVENTS_TOOL = 'upload-meta-events'
/** The send log's AuditLog entityType (this business's rows, row-level security). */
export const SEND_LOG = 'MetaConversionsApi'
/** At most this many orders are read for one upload: more is refused (send fewer days at a time). */
export const MAX_EVENT_ORDERS_READ = 2000
const DAY_MS = 86_400_000

export type OrderChannelName = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY' | 'MANUAL'

/** A Nexus order as the upload reads it. `email` and `phone` are plain: in memory only, hashed before they go anywhere. */
export interface EventOrder {
  orderId: string
  channel: OrderChannelName
  channelOrderId: string
  status: string
  /** When the sale was made (purchaseDate, else when Nexus took the order in). */
  at: Date
  cancelled: boolean
  totalCents: number
  currency: string | null
  email: string | null
  phone: string | null
  country: string | null
  /** Who bought it, for "new or returning customer" (the customer row, else the e-mail). */
  customerKey: string | null
  items: Array<{ sku: string; quantity: number; priceCents: number }>
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const cents = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

const ORDER_SELECT = {
  id: true, channel: true, channelOrderId: true, status: true, purchaseDate: true, createdAt: true, cancelledAt: true, totalPrice: true,
  currencyCode: true, customerEmail: true, customerId: true, shippingAddress: true,
  customer: { select: { addresses: { where: { phone: { not: null } }, select: { phone: true, isPrimary: true }, take: 3 } } },
  items: { select: { sku: true, quantity: true, price: true }, take: 250 },
} as const

interface OrderRow {
  id: string; channel: string; channelOrderId: string; status: string; purchaseDate: Date | null; createdAt: Date; cancelledAt: Date | null
  totalPrice: unknown; currencyCode: string | null; customerEmail: string; customerId: string | null; shippingAddress: unknown
  customer: { addresses: Array<{ phone: string | null; isPrimary: boolean }> } | null
  items: Array<{ sku: string; quantity: number; price: unknown }>
}

function eventOrderOf(o: OrderRow): EventOrder {
  const address = obj(o.shippingAddress) ?? {}
  const addresses = [...(o.customer?.addresses ?? [])].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  const email = str(o.customerEmail)
  return {
    orderId: o.id,
    channel: o.channel as OrderChannelName,
    channelOrderId: o.channelOrderId,
    status: o.status,
    at: o.purchaseDate ?? o.createdAt,
    cancelled: !!o.cancelledAt,
    totalCents: cents(o.totalPrice),
    currency: str(o.currencyCode)?.toUpperCase() ?? null,
    email,
    phone: str(address.phone) ?? str(addresses[0]?.phone) ?? null,
    country: str(address.country) ?? str(address.countryCode) ?? null,
    customerKey: o.customerId ?? (email ? `email:${email}` : null),
    items: o.items.map((i) => ({ sku: i.sku, quantity: i.quantity, priceCents: cents(i.price) })),
  }
}

/**
 * The business's orders of the days `from`..`to` (YYYY-MM-DD, UTC, both included), or the ones named (Nexus's or the
 * channel's order ids). `tooMany` when there are more than MAX_EVENT_ORDERS_READ: nothing is guessed, the caller refuses.
 */
export async function ordersForEvents(q: { from?: string; to?: string; orderIds?: string[] }): Promise<{ orders: EventOrder[]; tooMany: boolean }> {
  const ids = [...new Set(q.orderIds ?? [])]
  const where = ids.length
    ? { deletedAt: null, OR: [{ id: { in: ids } }, { channelOrderId: { in: ids } }] }
    : (() => {
      const gte = new Date(`${q.from}T00:00:00Z`)
      const lt = new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY_MS)
      return { deletedAt: null, OR: [{ purchaseDate: { gte, lt } }, { purchaseDate: null, createdAt: { gte, lt } }] }
    })()
  const rows = await prisma.order.findMany({ where, select: ORDER_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: MAX_EVENT_ORDERS_READ + 1 }) as unknown as OrderRow[]
  return { orders: rows.slice(0, MAX_EVENT_ORDERS_READ).map(eventOrderOf), tooMany: rows.length > MAX_EVENT_ORDERS_READ }
}

/**
 * When each buyer named first bought (any channel, not cancelled or refunded), by EventOrder.customerKey: an order is a
 * returning buyer's when the buyer's first order came before it. Nexus knows only the orders it holds.
 */
export async function firstOrderTimes(keys: string[]): Promise<Map<string, Date>> {
  const customerIds = keys.filter((k) => !k.startsWith('email:'))
  const emails = keys.filter((k) => k.startsWith('email:')).map((k) => k.slice('email:'.length))
  const out = new Map<string, Date>()
  if (!customerIds.length && !emails.length) return out
  const rows = await prisma.order.findMany({
    where: {
      deletedAt: null, cancelledAt: null, status: { notIn: ['CANCELLED', 'REFUNDED'] },
      OR: [...(customerIds.length ? [{ customerId: { in: customerIds } }] : []), ...(emails.length ? [{ customerEmail: { in: emails } }] : [])],
    },
    select: { customerId: true, customerEmail: true, purchaseDate: true, createdAt: true },
    take: 5000,
  })
  const wanted = new Set(keys)
  for (const row of rows) {
    const at = row.purchaseDate ?? row.createdAt
    for (const key of [row.customerId, row.customerEmail ? `email:${row.customerEmail.trim()}` : null]) {
      if (!key || !wanted.has(key)) continue
      const was = out.get(key)
      if (!was || at.getTime() < was.getTime()) out.set(key, at)
    }
  }
  return out
}

/** How far back what Nexus sent, and a run that may have reached Meta without its record, still matter. */
export const SENT_LOOKBACK_MS = 9 * DAY_MS

/** One order Nexus sent to Meta before, from its own records: its event_id and the sale time it went with. */
export interface SentEvent { orderId: string; eventId: string; pixelId: string; eventTime: Date | null; sentAt: Date; confirmed: boolean }

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/**
 * Every order Nexus sent to Meta (any pixel), by Nexus order id: confirmed if any record says Meta confirmed it, and the
 * FIRST time it went (Meta keeps the first copy of an event_id for 48 hours only).
 */
export async function nexusSentEvents(now: Date = new Date()): Promise<Map<string, SentEvent>> {
  const since = new Date(now.getTime() - SENT_LOOKBACK_MS)
  const changes = await prisma.agentChange.findMany({
    where: { toolName: EVENTS_TOOL, executedAt: { gte: since } },
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
    select: { after: true, executedAt: true },
  })
  // Re-review N1 — every sale of an OPEN or recorded send log went or may have gone at the log's time (a record may say
  // Meta confirmed it). A CLOSED log (send-none: Meta took nothing) counts for nothing (round-2 F1).
  const logs = await sendLogs(since)
  const closed = new Set(logs.filter((l) => l.action === 'send-none').map((l) => l.sendId))
  const rows = [
    ...logs.filter((l) => l.action === 'send' && !closed.has(l.sendId)).map((l) => ({ after: { pixelId: l.pixelId, sent: l.sales.map((s) => ({ ...s, sentAt: l.at.toISOString(), confirmed: false })) }, executedAt: l.at })),
    ...changes,
  ]
  const out = new Map<string, SentEvent>()
  for (const row of rows) {
    const after = rec(row.after)
    const pixelId = typeof after.pixelId === 'string' ? after.pixelId : ''
    for (const s of Array.isArray(after.sent) ? after.sent.map(rec) : []) {
      if (typeof s.orderId !== 'string' || typeof s.eventId !== 'string') continue
      const sentAt = typeof s.sentAt === 'string' && Number.isFinite(Date.parse(s.sentAt)) ? new Date(s.sentAt) : row.executedAt
      const eventTime = typeof s.eventTime === 'string' && Number.isFinite(Date.parse(s.eventTime)) ? new Date(s.eventTime) : null
      const was = out.get(s.orderId)
      out.set(s.orderId, {
        orderId: s.orderId, eventId: was?.eventId ?? s.eventId, pixelId: was?.pixelId ?? pixelId, eventTime: was ? was.eventTime : eventTime,
        sentAt: was && was.sentAt.getTime() < sentAt.getTime() ? was.sentAt : sentAt,
        confirmed: (was?.confirmed ?? false) || s.confirmed === true,
      })
    }
  }
  return out
}

const DOUBT = 'an earlier upload of sales to Meta may have reached Meta without Nexus recording it, so its sales could be counted twice if they went again: meta-datasets (view sources or stats, agentName nexus) shows what Meta received'

interface SendLog { sendId: string; action: 'send' | 'send-none'; pixelId: string; at: Date; sales: Array<{ orderId: string; eventId: string; eventTime: string }> }

/** This business's send logs since `since` (open and closed), oldest first — the newest 5,000 when there are more. */
async function sendLogs(since: Date): Promise<SendLog[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: SEND_LOG, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { action: true, entityId: true, after: true, createdAt: true },
    take: 5000,
  })
  return rows.reverse().flatMap((row) => {
    const after = rec(row.after)
    if (typeof after.sendId !== 'string' || (row.action !== 'send' && row.action !== 'send-none')) return []
    const sales = (Array.isArray(after.sales) ? after.sales.map(rec) : [])
      .filter((s) => typeof s.orderId === 'string' && typeof s.eventId === 'string')
      .map((s) => ({ orderId: s.orderId as string, eventId: s.eventId as string, eventTime: typeof s.eventTime === 'string' ? s.eventTime : '' }))
    return [{ sendId: after.sendId, action: row.action, pixelId: row.entityId, at: row.createdAt, sales }]
  })
}

/** The send logs since `since` that are neither closed (send-none) nor matched by a change record (`after.sendId`). */
async function openSendLogs(since: Date, exceptSendId: string | null): Promise<SendLog[]> {
  const logs = await sendLogs(since)
  const closed = new Set(logs.filter((l) => l.action === 'send-none').map((l) => l.sendId))
  const open = logs.filter((l) => l.action === 'send' && !closed.has(l.sendId) && l.sendId !== exceptSendId)
  if (!open.length) return []
  const changes = await prisma.agentChange.findMany({ where: { toolName: EVENTS_TOOL, executedAt: { gte: since } }, select: { after: true } })
  const recorded = new Set(changes.map((c) => rec(c.after).sendId).filter((id): id is string => typeof id === 'string'))
  return open.filter((l) => !recorded.has(l.sendId))
}

/** How long a run of this tool may take (a few reads and one request): an open log younger than this may still be running. */
export const RUN_WINDOW_MS = 30 * 60_000

/** Round-2 F2 — an open log in words: another run that may be running now, or one that may have reached Meta unrecorded. */
function doubtOf(log: SendLog, now: Date): string {
  const what = `${log.sales.length} sale${log.sales.length === 1 ? '' : 's'} to pixel ${log.pixelId}`
  const at = log.at.toISOString().slice(0, 16).replace('T', ' ')
  if (now.getTime() - log.at.getTime() < RUN_WINDOW_MS) {
    return `another upload of ${what} started at ${at} UTC and may be running now; this request sent nothing. Ask again in a few minutes.`
  }
  return `an upload of ${what} began at ${at} UTC and left no record; ${DOUBT}. Nexus sends nothing until 9 days after it.`
}

/**
 * Re-review N1 — why no upload of sales to Meta may run now, in words, or null: a send log of the last 9 days that is
 * neither closed nor matched by a change record (another run sending right now, or one that may have reached Meta
 * without its record), whatever became of its approval.
 */
export async function eventsUploadDoubt(now: Date = new Date()): Promise<string | null> {
  const open = await openSendLogs(new Date(now.getTime() - SENT_LOOKBACK_MS), null)
  // An old one first: it stops uploads for days; one still running only for minutes.
  const old = open.find((l) => now.getTime() - l.at.getTime() >= RUN_WINDOW_MS)
  return open.length ? doubtOf(old ?? open[0], now) : null
}

/**
 * Re-review N1 — the send log of a run, written BEFORE its first request (a write that fails sends nothing), and then the
 * check for any other open log (two runs at once: at most one sends). Returns the refusal, or null to send.
 */
export async function startSendLog(log: { sendId: string; pixelId: string; approvalId: string | null; userId: string | null; sales: Array<{ orderId: string; eventId: string; eventTime: string }> }, now: Date = new Date()): Promise<string | null> {
  await prisma.auditLog.create({
    data: {
      userId: log.userId, entityType: SEND_LOG, entityId: log.pixelId, action: 'send',
      after: { sendId: log.sendId, approvalId: log.approvalId, sales: log.sales },
      metadata: { tool: EVENTS_TOOL },
    },
  })
  const others = await openSendLogs(new Date(now.getTime() - SENT_LOOKBACK_MS), log.sendId)
  if (!others.length) return null
  await closeSendLog(log.sendId, log.pixelId, log.userId)
  const old = others.find((l) => now.getTime() - l.at.getTime() >= RUN_WINDOW_MS)
  return doubtOf(old ?? others[0], now)
}

/** Re-review N1 — close a send log whose run sent nothing to Meta (a refusal before the send, or Meta took none). */
export async function closeSendLog(sendId: string, pixelId: string, userId: string | null = null): Promise<void> {
  await prisma.auditLog.create({ data: { userId, entityType: SEND_LOG, entityId: pixelId, action: 'send-none', after: { sendId }, metadata: { tool: EVENTS_TOOL } } })
}

