/**
 * Meta step 33 (lane C3, 2026-10-21; Owner decision D2 "no double counting, no missing purchases") — Conversions API
 * events from Nexus orders: orders + the pixel as Meta reads it → the requests upload-meta-events sends, or a refusal.
 * Pure: no call, no database.
 *
 * WHEN NEXUS SENDS (binding, D2):
 *   1. The business switched "Send sales to Meta" on (events-switch.ts; off by default).
 *   2. The pixel is the chosen ad account's own, checked not to be another business's (nor unchecked), and a consolidated
 *      dataset. Lane C3 decision (review F3 / B6, 2026-10-21): a sale taken in by hand in Nexus is never seen by the shop,
 *      so neither the shop's pixel nor its server can have sent it, and it skips step 11's website gap check (meta-
 *      datasets view `sources`). That check is the gate for the shop's own orders, which stay refused until the Nexus shop
 *      pixel step (the Owner's word, 2026-10-21: a later step).
 *   3. DEDUP: Meta merges two copies of a purchase only when both carry the same event_name AND event_id within 48 hours
 *      (conversions-api/deduplicate-pixel-and-server-events.md); two SERVER events with different ids are both counted,
 *      and the fbp / external_id fallback "only works for… events sent first from the browser and then through the
 *      server" and never between two server events. The shop platform's own Meta integration sends the website's
 *      purchases: Shopify's "Facebook & Instagram" app sets the browser Purchase's eventID to the Web Pixels
 *      `checkout_completed` event id — a per-checkout id from checkout or made at random in the browser
 *      (`sh-<time>-…`, crypto.randomUUID), NOT the order id, name, token or checkout token (read 2026-10-21 in the app's
 *      shipped web pixel; shopify.dev/docs/api/web-pixels-api/standard-events/checkout_completed documents `id` only as
 *      "The ID of the customer event"); its server copy most likely reuses it (Shopify documents no id). Nothing in an
 *      order Nexus stores carries that id, so Nexus CANNOT send a copy Meta would merge: a sale of the shop's website
 *      (Shopify, WooCommerce — whose plugin's id Nexus cannot see either) is NEVER sent, whatever Meta's check says. What Nexus
 *      sends are sales the shop never saw: orders taken in by hand in Nexus (channel MANUAL), as the person says they were
 *      made (action_source physical_store, phone_call, email, chat or other — Meta: "you agree that the action_source
 *      parameter is accurate"), each with event_id `nexus.<order id>`. Nexus today has no route that creates such an
 *      order (channel MANUAL), so until one exists nothing is sent.
 *   4. A marketplace sale (Amazon, eBay, Etsy) is never sent: it is not a sale of the shop, and a marketplace lets a
 *      seller use its buyers' contact data for the order only.
 *   5. One event older than 7 days rejects the WHOLE request (parameters/server-event.md): an order older than 7 days
 *      less a 2-hour margin (the approval may take a while; the gateway judges it again when it sends) is left out and
 *      named. Meta's docs let a physical_store event come up to 62 days late (using-the-api.md); Nexus keeps 7 days for
 *      every event, the safe side (review B4). Never sent twice: an order Meta confirmed is never sent again; one whose request Meta did not confirm may be
 *      asked again within 46 hours with the SAME event_id AND the SAME event_time it went with (or not at all), never
 *      later. Meta drops a repeat by two rules: the same event_name + event_id within 48 hours (using-the-api.md "Batch
 *      Requests", deduplicate-pixel-and-server-events.md), and, between offline events, the same dataset_id, event_time,
 *      event_name, item_number and order_id within 7 days (offline-events.md "Set Up Deduplication"). Within 46 hours
 *      with the recorded time both hold. A request that may have reached Meta but has no record yet stops every upload
 *      for 9 days (events-orders.ts eventsUploadDoubt).
 *   6. test_event_code is not a dry run: "Events sent with test_event_code are not dropped. They flow into Events Manager
 *      and are used for targeting and ads measurement" (using-the-api.md) — a test sends real purchases, recorded as sent.
 *
 * PAYLOAD (facts F2 "CAPI payload facts"; customer-information-parameters.md; Meta's Python SDK serverside/normalize.py):
 * `em` = SHA-256 of the e-mail trimmed and lower-cased; `ph` = SHA-256 of the digits WITH the country code, no `+` or
 * leading zeros (only a number written with its country code, `+…` or `00…`, is sent: Nexus never guesses one);
 * `country` = SHA-256 of the ISO-2 code lower-cased (Meta: "always send"). The Owner's decision (2026-10-21): the hashed
 * e-mail / phone goes for EVERY buyer of an order Nexus sends — no name, address, IP or browser goes. `custom_data`:
 * value + currency of the order (required for a Purchase), order_id, and on request contents (SKU, quantity, price) and
 * customer_segmentation. No data_processing_options (US states only; Nexus sells in the EU). The plain and hashed values
 * are never logged, stored, answered or put in a record or a hash of the plan: they exist only in the request body.
 */
import { createHash } from 'node:crypto'
import { metaEventsJson, META_EVENT_MAX_AGE_S, META_EVENT_SOURCES, META_MAX_EVENTS_PER_REQUEST, NEXUS_PARTNER_AGENT } from '../../gateway/meta-events-rules.js'
import { changeLines, plural } from './change-draft.js'
import type { EventOrder, SentEvent } from './events-orders.js'

/** A change a person reads holds at most this many sales (one request: well under Meta's 1,000). */
export const MAX_EVENTS_PER_CHANGE = 250
/** An order older than 7 days less this margin is left out (the run may come later than the preview). */
export const AGE_MARGIN_S = 2 * 3600
/** A request Meta did not confirm may be asked again this long after it went (Meta keeps an event_id's first copy 48 h). */
export const RESEND_WINDOW_MS = 46 * 3600_000
const DAY_MS = 86_400_000

export type EventSource = (typeof META_EVENT_SOURCES)[number]

// ── normalising and hashing (Meta's rules) ───────────────────────────────────────────────────────────────────────

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** An e-mail as Meta hashes it (trimmed, lower-cased), or null when it is not one. */
export function metaEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
}

/**
 * A phone as Meta hashes it: digits only, WITH the country code, no `+` or leading zeros — or null. Only a number that
 * says its country (`+39…`, `0039…`) is used: a national number is never given a guessed country code.
 */
export function metaPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const phone = raw.trim().replace(/[\s().\-/]/g, '')
  const international = phone.startsWith('+') ? phone.slice(1) : phone.startsWith('00') ? phone.slice(2) : null
  return international && /^[1-9]\d{7,14}$/.test(international) ? international : null
}

/** An ISO 3166-1 alpha-2 country as Meta hashes it (lower case), or null. */
export function metaCountry(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z]{2}$/.test(raw.trim()) ? raw.trim().toLowerCase() : null
}

// ── the upload ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface EventsRequest {
  pixelId: string
  from?: string
  to?: string
  orderIds?: string[]
  /** How the orders taken in by hand were made (Meta's action_source); required to send one. */
  manualAs?: EventSource
  testEventCode?: string
  /** Tell Meta whether each buyer is new or returning (Nexus knows only the orders it holds). */
  customerSegment: boolean
  /** Send each order's lines (SKU, quantity, price). */
  contents: boolean
}

export interface EventsLive {
  pixel: { pixelId: string; consolidated: boolean | null }
  orders: EventOrder[]
  /** Orders Nexus sent to Meta before (any pixel), by Nexus order id. */
  sent: Map<string, SentEvent>
  /** When each buyer (EventOrder.customerKey) first bought, by the orders Nexus holds. Empty unless customerSegment. */
  firstOrderAt: Map<string, Date>
  now: Date
}

/** One sale of a change as its record keeps it: never a value of the buyer's. */
export interface SentSale { orderId: string; name: string; eventId: string; eventTime: string; actionSource: EventSource }

export interface EventsRequestPart {
  step: number
  label: string
  /** The form fields Meta gets: `data` (the events, with the hashes), `partner_agent`, `test_event_code`. */
  params: Record<string, string>
  /** The sales it carries, in order. */
  sales: SentSale[]
  /** What the plan stands on, without a hash of the buyer's: order, event id, time, value, which match keys. */
  planView: unknown[]
}

export interface EventsDraft {
  summary: string
  changes: Record<string, { from: unknown; to: unknown }>
  totals: Record<string, number>
  warnings: string[]
  spendsMoney: string[]
  skipped: string[]
  requests: EventsRequestPart[]
  stands: unknown
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const day = (d: Date) => d.toISOString().slice(0, 10)
const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`
export const eventIdOf = (orderId: string) => `nexus.${orderId}`
const orderName = (o: EventOrder) => `${o.channel === 'MANUAL' ? 'Order' : `${o.channel[0]}${o.channel.slice(1).toLowerCase()} order`} ${o.channelOrderId}`

/** Why the request's days cannot be used, or null: the last 7 days (UTC), before today. */
export function eventsWindowProblem(request: Pick<EventsRequest, 'from' | 'to' | 'orderIds'>, now: Date): string | null {
  if (request.orderIds?.length) return request.from || request.to ? 'Give orderIds or a date range (from, to), not both.' : null
  if (!request.from || !request.to || !DATE.test(request.from) || !DATE.test(request.to)) return 'Give the days to send: from and to (YYYY-MM-DD), or orderIds.'
  if (request.from > request.to) return 'from is after to.'
  const today = day(now)
  // A day still running would bring new orders between the preview and the run: the approved list must stay the same.
  if (request.to >= today) return `to must be before today (${today}, UTC): today's sales go in a later upload.`
  const oldest = day(new Date(now.getTime() - 6 * DAY_MS))
  if (request.from < oldest) return `from must be ${oldest} or later: Meta refuses a whole request when one of its events is older than 7 days.`
  return null
}

const SHOP_WEBSITE = 'sold on the shop\'s website: the shop platform\'s own Meta pixel and Conversions API send that purchase with an event_id Nexus cannot rebuild (Shopify\'s is the checkout\'s customer-event id, not the order\'s), so a copy from Nexus would be counted twice'
const MARKETPLACE = 'sold on a marketplace: not a sale of the shop, and the marketplace lets a seller use its buyers\' contact data for the order only'

export function eventsDraft(request: EventsRequest, live: EventsLive): EventsDraft | { refusal: string } {
  const windowProblem = eventsWindowProblem(request, live.now)
  if (windowProblem) return { refusal: windowProblem }
  // Meta takes sales made outside the website only on a consolidated dataset (conversions-api/offline-events.md:
  // "is_consolidated_container … eligible for passing offline events"); every sale Nexus sends is one.
  if (live.pixel.consolidated !== true) {
    return { refusal: `Pixel ${live.pixel.pixelId} is ${live.pixel.consolidated === false ? 'not' : 'not shown to be'} a consolidated dataset (is_consolidated_container), and Meta takes sales made outside the website only on one. A person consolidates it in Meta's Events Manager (datasets); Nexus sends nothing until then.` }
  }
  const nowS = Math.floor(live.now.getTime() / 1000)
  const oldestS = nowS - META_EVENT_MAX_AGE_S + AGE_MARGIN_S
  const named = new Set(request.orderIds ?? [])
  const minTime = request.orderIds?.length ? 0 : Date.parse(`${request.from}T00:00:00Z`)
  const maxTime = request.orderIds?.length ? live.now.getTime() : Date.parse(`${request.to}T00:00:00Z`) + DAY_MS
  const skippedBy = new Map<string, string[]>()
  const skip = (why: string, o: EventOrder) => skippedBy.set(why, [...(skippedBy.get(why) ?? []), orderName(o)])
  const found = new Set<string>()
  const events: Array<Record<string, unknown>> = []
  const sales: SentSale[] = []
  const planView: unknown[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const resent: string[] = []
  const valueByCurrency = new Map<string, number>()
  let withEmail = 0
  let withPhone = 0
  const ordered = [...live.orders].sort((a, b) => a.at.getTime() - b.at.getTime() || a.orderId.localeCompare(b.orderId))
  for (const o of ordered) {
    if (named.size && !named.has(o.orderId) && !named.has(o.channelOrderId)) continue
    found.add(o.orderId); found.add(o.channelOrderId)
    const atS = Math.floor(o.at.getTime() / 1000)
    if (o.at.getTime() < minTime || o.at.getTime() >= maxTime) { skip('outside the days asked', o); continue }
    if (o.channel === 'SHOPIFY' || o.channel === 'WOOCOMMERCE') { skip(SHOP_WEBSITE, o); continue }
    if (o.channel !== 'MANUAL') { skip(MARKETPLACE, o); continue }
    if (atS < oldestS) { skip('older than 7 days by the time it would be sent (Meta refuses a whole request with one such event)', o); continue }
    if (atS > nowS) { skip('dated in the future', o); continue }
    if (o.cancelled || ['CANCELLED', 'REFUNDED', 'RETURNED', 'AWAITING_PAYMENT'].includes(o.status)) { skip('cancelled, refunded, returned or not paid', o); continue }
    const before = live.sent.get(o.orderId)
    if (before?.confirmed) { skip('sent before and confirmed by Meta (never sent twice)', o); continue }
    if (before && live.now.getTime() - before.sentAt.getTime() > RESEND_WINDOW_MS) {
      skip('sent before in a request Meta did not confirm, more than 46 hours ago: Meta may hold it, and a copy now could count it twice', o)
      continue
    }
    // Review B2 — a repeat is dropped only with the same event_time it went with (offline-events.md): its sale time moved.
    if (before && before.eventTime && Math.floor(before.eventTime.getTime() / 1000) !== atS) {
      skip('sent before in a request Meta did not confirm, and its sale time changed since: Meta would not merge a copy with another time, so it could count twice', o)
      continue
    }
    if (!request.manualAs) { skip('taken in by hand in Nexus: say how such sales were made (manualAs) — Meta asks that action_source be accurate', o); continue }
    if (o.totalCents <= 0) { skip('no value', o); continue }
    if (!o.currency || !/^[A-Z]{3}$/.test(o.currency)) { skip('no currency', o); continue }
    const email = metaEmail(o.email)
    const phone = metaPhone(o.phone)
    if (!email && !phone) { skip('no e-mail or phone Meta can match (a phone needs its country code)', o); continue }
    const country = metaCountry(o.country)
    if (sales.length >= MAX_EVENTS_PER_CHANGE) return { refusal: `More than ${MAX_EVENTS_PER_CHANGE} sales would be sent in one change: send fewer days at a time.` }
    const eventId = before?.eventId ?? eventIdOf(o.orderId)
    const custom: Record<string, unknown> = { value: o.totalCents / 100, currency: o.currency, order_id: o.orderId }
    // A line goes with a SKU Meta can read as it is (plain ASCII, ≤ 100 characters): the gateway judges the same.
    const items = o.items.filter((i) => /^[\x20-\x7e]{1,100}$/.test(i.sku) && i.quantity > 0).slice(0, 250)
    if (request.contents && items.length) {
      custom.content_type = 'product'
      custom.contents = items.map((i) => ({ id: i.sku, quantity: i.quantity, item_price: i.priceCents / 100 }))
    }
    // Meta's example puts customer_segmentation in custom_data (parameters/server-event.md; its table lists it on the
    // event, the SDK has neither): sent there, where Meta takes any key — LIVE-PROBES SG-064 settles which Meta reads.
    const first = o.customerKey ? live.firstOrderAt.get(o.customerKey) : undefined
    const segment = request.customerSegment && o.customerKey ? (first && first.getTime() < o.at.getTime() ? 'existing_customer_to_business' : 'new_customer_to_business') : null
    if (segment) custom.customer_segmentation = segment
    events.push({
      event_name: 'Purchase',
      event_time: atS,
      event_id: eventId,
      action_source: request.manualAs,
      user_data: { ...(email ? { em: [sha256Hex(email)] } : {}), ...(phone ? { ph: [sha256Hex(phone)] } : {}), ...(country ? { country: [sha256Hex(country)] } : {}) },
      custom_data: custom,
    })
    if (email) withEmail += 1
    if (phone) withPhone += 1
    const name = orderName(o)
    sales.push({ orderId: o.orderId, name, eventId, eventTime: o.at.toISOString(), actionSource: request.manualAs })
    planView.push({ orderId: o.orderId, eventId, eventTime: atS, valueCents: o.totalCents, currency: o.currency, keys: [email ? 'em' : '', phone ? 'ph' : '', country ? 'country' : ''].filter(Boolean), segment, contents: custom.contents ?? null })
    if (before) resent.push(name)
    valueByCurrency.set(o.currency, (valueByCurrency.get(o.currency) ?? 0) + o.totalCents)
    lines.push([`${name} (${day(o.at)})`, before ? 'sent before, not confirmed by Meta' : 'not in Meta from Nexus',
      `Purchase ${money(o.totalCents, o.currency)} · ${request.manualAs} · hashed ${[email ? 'e-mail' : '', phone ? 'phone' : ''].filter(Boolean).join(' + ')}${segment ? ` · ${segment === 'new_customer_to_business' ? 'new' : 'returning'} buyer` : ''}`])
  }
  const missing = [...named].filter((id) => !found.has(id))
  if (missing.length) return { refusal: `No Nexus order ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''} (order-search finds them).` }
  const skipped = [...skippedBy.entries()].map(([why, orders]) => `${plural(orders.length, 'order')} not sent — ${why}: ${orders.slice(0, 10).join(', ')}${orders.length > 10 ? ' …' : ''}.`)
  if (!events.length) return { refusal: `No sale to send. ${skipped.join(' ') || 'Nexus has no order in these days.'}` }

  const requests: EventsRequestPart[] = []
  for (let i = 0; i < events.length; i += META_MAX_EVENTS_PER_REQUEST) {
    const part = events.slice(i, i + META_MAX_EVENTS_PER_REQUEST)
    const partSales = sales.slice(i, i + META_MAX_EVENTS_PER_REQUEST)
    requests.push({
      step: requests.length + 1,
      label: `Send ${plural(part.length, 'purchase')} to pixel ${live.pixel.pixelId}${request.testEventCode ? ' (with a test code: Meta counts them all the same)' : ''}`,
      params: { data: metaEventsJson(part), partner_agent: NEXUS_PARTNER_AGENT, ...(request.testEventCode ? { test_event_code: request.testEventCode } : {}) },
      sales: partSales,
      planView: planView.slice(i, i + META_MAX_EVENTS_PER_REQUEST),
    })
  }
  const totals = [...valueByCurrency.entries()].map(([c, v]) => money(v, c)).join(' + ')
  const warnings = [
    'Only sales the shop never saw are sent (taken in by hand in Nexus): no pixel or server of the shop can have sent them, so they need no website check. Sales of the shop\'s website stay with the shop platform\'s own Meta integration: Nexus cannot give a copy the event_id Meta would merge it with, so it sends none (no double counting) until a Nexus shop pixel exists (a later step).',
    'Sent purchases cannot be taken back: Meta has no call to withdraw an event, so this change has no undo.',
    'Each sale goes once, with event_id nexus.<Nexus order id>, its order_id and its sale time: Meta drops a repeat with the same event_id within 48 hours, and an offline repeat with the same event_time, event_name and order_id within 7 days. Nexus never sends a sale Meta confirmed again; one Meta did not confirm may be asked again within 46 hours with the time it went with, never later.',
    'The buyers\' e-mail and phone go to Meta hashed (SHA-256, normalised as Meta asks), never as plain text, with the country; no name, address or other data. Nexus keeps no copy of either.',
    ...(request.testEventCode ? ['test_event_code is NOT a dry run: Meta does not drop test events — they reach reporting, targeting and ads measurement like any other. These sales then count as sent and are never sent again.'] : []),
    ...(resent.length ? [`${plural(resent.length, 'sale')} went before in a request Meta did not confirm (${resent.slice(0, 5).join(', ')}${resent.length > 5 ? ' …' : ''}): sent again with the same event_id, which Meta drops if it already has it.`] : []),
    ...(request.customerSegment ? ['New or returning buyer is judged from the orders Nexus holds: a buyer whose earlier orders predate Nexus reads as new.'] : []),
    ...(request.contents ? ['contents name Nexus SKUs: Meta matches them to a catalog only where its items use the same ids (the shop platform\'s catalog may not).'] : []),
  ]
  const { changes, more } = changeLines(lines)
  return {
    summary: `Send ${plural(events.length, 'purchase')} (${totals}) taken in by hand in Nexus to Meta pixel ${live.pixel.pixelId} (Conversions API, ${request.manualAs}).`,
    changes,
    totals: { purchases: events.length, withHashedEmail: withEmail, withHashedPhone: withPhone, notSent: [...skippedBy.values()].reduce((n, l) => n + l.length, 0), ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [`Meta counts these ${plural(events.length, 'purchase')} for the ads that brought them: ad sets that optimise for purchases on this pixel, with a cost or a ROAS goal, may then spend more of their budgets (never above them).`],
    skipped,
    requests,
    // What it stands on: Meta's verdict, the dataset, the sales — and which of them went before unconfirmed.
    stands: { pixelId: live.pixel.pixelId, consolidated: live.pixel.consolidated, sales: planView, resent: sales.filter((s) => live.sent.has(s.orderId)).map((s) => s.orderId) },
  }
}
