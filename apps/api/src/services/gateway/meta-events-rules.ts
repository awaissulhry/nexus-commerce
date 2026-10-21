/**
 * Meta step 33 (lane C3, 2026-10-21) — the write allow-list entry of upload-meta-events: Conversions API events from Nexus
 * orders, `POST /{pixel_id}/events` with the form fields `data` (a JSON list of events), `partner_agent` and, for a test,
 * `test_event_code`. EXACT keys at every depth, every value judged, and the JSON in ONE spelling (the string judged is the
 * string sent: compact, non-ASCII escaped, no key twice — a duplicate key reads back differently and is refused).
 *
 * What can never pass, whoever calls the gateway: an event name other than Purchase; a plain e-mail or phone (`em` and
 * `ph` are SHA-256 hex only — Meta's customer-information-parameters page, "hashing required"); an event older than 7 days
 * at the moment it is sent (Meta: "If any event_time in data is greater than 7 days in the past, we return an error for
 * the entire request and process no events" — using-the-api.md and parameters/server-event.md; the gateway judges it
 * again when the approved run sends, so a run approved late is refused before anything goes); more than Meta's 1,000
 * events (using-the-api.md "Batch Requests"); an event without an event_id (every Nexus event carries one, so a resend
 * of the same events is dropped by Meta as a duplicate: using-the-api.md "Batch Requests"); limited data use
 * (`data_processing_options`: US states only — Nexus sells in the EU and sends none, facts F2 "CAPI payload facts"); a
 * website event (action_source `website`, event_source_url, the buyer's browser): the shop platform sends those itself.
 *
 * The body carries buyers' hashed contact data: the gateway keeps no body of this call in its ledger and removes hashes
 * and e-mail-like text from Meta's answer before anyone reads it (gateway.ts, `personal`). The pixel must be one of the
 * chosen ad account's own that no other business in Nexus uses, and the business must have switched sending on
 * (gateway.ts metaOwnerProblem → marketing/meta-ads/events-rule.ts). Meta has no per-object limit on events: none applies.
 *
 * Checked 2026-10-21 (`curl -sL …/conversions-api/<page>.md`, Meta's Python Business SDK facebook_business/adobjects/
 * serverside/{event,user_data,custom_data,event_request,event_response,normalize}.py on GitHub main): server-event
 * (event_name, event_time seconds GMT, user_data, custom_data, event_source_url, event_id, action_source email | website |
 * app | phone_call | chat | physical_store | system_generated | business_messaging | other, customer_segmentation), the
 * EventRequest fields (data, test_event_code, partner_agent, …), the answer (events_received, messages, fbtrace_id).
 */
import type { MetaWriteRule } from './meta-calls.js'

/** The partner_agent every Nexus event carries (Meta: "a platform from which the event is sent"): meta-datasets reads its quality by it. */
export const NEXUS_PARTNER_AGENT = 'nexus'
/** The events Nexus sends: a purchase (an order). */
export const META_EVENT_NAMES = ['Purchase'] as const
/**
 * Where a sale Nexus sends was made (Meta's action_source). Never `website`: the shop platform's own pixel and Conversions
 * API send the website's purchases with an event_id Nexus cannot rebuild (change-events.ts), so Nexus sends only sales the
 * shop never saw — taken in by hand in Nexus.
 */
export const META_EVENT_SOURCES = ['physical_store', 'phone_call', 'email', 'chat', 'other'] as const
/** The longest body of a request of events: ~1,000 events of a few hundred characters each, form-encoded. */
export const META_EVENTS_MAX_BODY = 900_000
/** Meta's own limit per request (using-the-api.md "Batch Requests"). */
export const META_MAX_EVENTS_PER_REQUEST = 1000
/** Meta refuses the WHOLE request when one event is older than this (seconds). */
export const META_EVENT_MAX_AGE_S = 7 * 86_400
/** Meta's customer_segmentation values (parameters/server-event.md). */
export const META_CUSTOMER_SEGMENTS = [
  'new_customer_to_business', 'new_customer_to_business_line', 'new_customer_to_product_area', 'new_customer_to_medium',
  'existing_customer_to_business', 'existing_customer_to_business_line', 'existing_customer_to_product_area', 'existing_customer_to_medium',
  'customer_in_loyalty_program',
] as const

/** An event_id Nexus makes: letters, digits and `._:-`, 1–128 characters. */
export const META_EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/
/** A test code from Events Manager › Test events. */
export const META_TEST_EVENT_CODE = /^[A-Za-z0-9]{1,40}$/
const SHA256 = /^[a-f0-9]{64}$/
const CURRENCY = /^[A-Z]{3}$/
const PRINTABLE = /^[\x20-\x7e]*$/

/**
 * JSON as Nexus sends it in a form field: compact, every character past ASCII escaped (`\uXXXX`), so the gateway's
 * ASCII rule holds and one value has one spelling. The builder and this judge use the same function.
 */
export function metaEventsJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Why an object has a key outside `allowed`, or lacks one of `required`, or null. */
function keysProblem(where: string, value: Json, allowed: readonly string[], required: readonly string[] = []): string | null {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k))
  if (extra.length) return `${where} has ${extra.slice(0, 3).join(', ')}, which no Nexus event sends`
  const missing = required.filter((k) => !(k in value))
  return missing.length ? `${where} lacks ${missing.join(', ')}` : null
}

const hashes = (where: string, value: unknown, max: number): string | null =>
  Array.isArray(value) && value.length >= 1 && value.length <= max && value.every((h) => typeof h === 'string' && SHA256.test(h))
    ? null : `${where} is a list of 1–${max} SHA-256 hashes (lowercase hex), never a plain value`

const USER_KEYS = ['em', 'ph', 'country'] as const
const CUSTOM_KEYS = ['value', 'currency', 'order_id', 'content_type', 'contents', 'customer_segmentation'] as const
const EVENT_KEYS = ['event_name', 'event_time', 'event_id', 'action_source', 'user_data', 'custom_data'] as const

function userDataProblem(where: string, user: unknown): string | null {
  if (!isObject(user)) return `${where}.user_data is an object`
  const keys = keysProblem(`${where}.user_data`, user, USER_KEYS)
  if (keys) return keys
  if (!('em' in user) && !('ph' in user)) return `${where}.user_data carries a hashed e-mail or phone (Meta matches nothing else Nexus sends)`
  for (const key of ['em', 'ph'] as const) {
    if (key in user) { const p = hashes(`${where}.user_data.${key}`, user[key], 5); if (p) return p }
  }
  if ('country' in user) { const p = hashes(`${where}.user_data.country`, user.country, 1); if (p) return p }
  return null
}

function customDataProblem(where: string, custom: unknown): string | null {
  if (!isObject(custom)) return `${where}.custom_data is an object`
  const keys = keysProblem(`${where}.custom_data`, custom, CUSTOM_KEYS, ['value', 'currency', 'order_id'])
  if (keys) return keys
  // Meta: value and currency are required for a Purchase (parameters/custom-data.md).
  if (typeof custom.value !== 'number' || !Number.isFinite(custom.value) || custom.value <= 0 || custom.value > 100_000_000) return `${where}.custom_data.value is an amount above 0`
  if (Math.round(custom.value * 100) / 100 !== custom.value) return `${where}.custom_data.value has at most 2 decimals`
  if (typeof custom.currency !== 'string' || !CURRENCY.test(custom.currency)) return `${where}.custom_data.currency is an ISO 4217 code`
  if (typeof custom.order_id !== 'string' || !META_EVENT_ID.test(custom.order_id)) return `${where}.custom_data.order_id is Nexus's order id`
  if ('customer_segmentation' in custom && !(META_CUSTOMER_SEGMENTS as readonly unknown[]).includes(custom.customer_segmentation)) return `${where}.custom_data.customer_segmentation is one of Meta's values`
  if ('contents' in custom || 'content_type' in custom) {
    if (custom.content_type !== 'product') return `${where}.custom_data.content_type is product, with contents`
    const contents = custom.contents
    if (!Array.isArray(contents) || !contents.length || contents.length > 250) return `${where}.custom_data.contents is a list of 1–250 items`
    for (const [i, item] of contents.entries()) {
      if (!isObject(item)) return `${where}.custom_data.contents[${i}] is an object`
      const p = keysProblem(`${where}.custom_data.contents[${i}]`, item, ['id', 'quantity', 'item_price'], ['id', 'quantity'])
      if (p) return p
      if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || !PRINTABLE.test(item.id)) return `${where}.custom_data.contents[${i}].id is a SKU`
      if (!Number.isInteger(item.quantity) || (item.quantity as number) < 1 || (item.quantity as number) > 10_000) return `${where}.custom_data.contents[${i}].quantity is a whole number`
      if ('item_price' in item && !(typeof item.item_price === 'number' && Number.isFinite(item.item_price) && item.item_price >= 0)) return `${where}.custom_data.contents[${i}].item_price is an amount`
    }
  }
  return null
}

/** Why the `data` field is not a list of events Nexus sends, or null. `nowS`: the moment it is judged (Unix seconds). */
export function metaEventsDataProblem(raw: string, nowS: number = Math.floor(Date.now() / 1000)): string | null {
  let list: unknown
  try { list = JSON.parse(raw) } catch { return 'data is a JSON list of events' }
  if (metaEventsJson(list) !== raw) return 'data is written in Nexus\'s one spelling (compact JSON, no key twice): what is judged is what is sent'
  if (!Array.isArray(list) || list.length === 0) return 'data is a list of events'
  if (list.length > META_MAX_EVENTS_PER_REQUEST) return `Meta takes at most ${META_MAX_EVENTS_PER_REQUEST} events in one request`
  const ids = new Set<string>()
  for (const [i, event] of list.entries()) {
    const where = `event ${i + 1}`
    if (!isObject(event)) return `${where} is an object`
    const keys = keysProblem(where, event, EVENT_KEYS, ['event_name', 'event_time', 'event_id', 'action_source', 'user_data', 'custom_data'])
    if (keys) return keys
    if (!(META_EVENT_NAMES as readonly unknown[]).includes(event.event_name)) return `${where}: Nexus sends ${META_EVENT_NAMES.join(', ')} only`
    const time = event.event_time
    if (!Number.isInteger(time)) return `${where}.event_time is Unix seconds`
    // One event older than 7 days and Meta refuses every event of the request (a minute's margin for the way there).
    if ((time as number) < nowS - META_EVENT_MAX_AGE_S + 60) return `${where} is older than 7 days: Meta would refuse every event of this request (nothing was sent)`
    if ((time as number) > nowS + 300) return `${where}.event_time is in the future`
    if (typeof event.event_id !== 'string' || !META_EVENT_ID.test(event.event_id)) return `${where}.event_id is a Nexus event id (letters, digits, ._:-)`
    if (ids.has(event.event_id)) return `${where} repeats an event_id of this request`
    ids.add(event.event_id)
    if (!(META_EVENT_SOURCES as readonly unknown[]).includes(event.action_source)) return `${where}.action_source is ${META_EVENT_SOURCES.join(', ')} (Nexus sends no website event: the shop platform's own pixel and Conversions API send those)`
    const user = userDataProblem(where, event.user_data)
    if (user) return user
    const custom = customDataProblem(where, event.custom_data)
    if (custom) return custom
  }
  return null
}

/** Step 33 — upload-meta-events on the write allow-list. */
export const META_EVENTS_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    name: 'pixel.events',
    method: 'POST',
    path: /^\d{1,20}\/events$/,
    kinds: ['pixel'],
    required: ['data', 'partner_agent'],
    optional: ['test_event_code'],
    maxBody: META_EVENTS_MAX_BODY,
    values: (params) => {
      if (params.get('partner_agent') !== NEXUS_PARTNER_AGENT) return `partner_agent is "${NEXUS_PARTNER_AGENT}" (Nexus's own)`
      if (params.has('test_event_code') && !META_TEST_EVENT_CODE.test(params.get('test_event_code')!)) return 'test_event_code is the code Events Manager shows (letters and digits)'
      return metaEventsDataProblem(params.get('data') ?? '')
    },
    budget: false,
    personal: true,
    objectLimits: false,
  },
]
