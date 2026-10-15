/**
 * Google Ads programme 2, G8a (2026-10-15) — sending the shop's sales to Google: Nexus Shopify orders → offline
 * conversion events for an UPLOAD_CLICKS conversion action, and the adjustments of sales sent before (retract a sale,
 * restate its value). Pure builders: orders + live state → GoogleChangeDraft (its `operations` are the events or the
 * adjustments), or a refusal. The calls are conversion-upload-client.ts's.
 *
 * WHICH API (checked 2026-10-15):
 *   - Google Ads API ConversionUploadService.UploadClickConversions is CLOSED to Nexus: "Developer tokens with no offline
 *     conversion upload requests between December 17, 2025 and June 15, 2026 are restricted … UploadClickConversions
 *     requests for these tokens return a CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE error. Migrate … to the Data Manager
 *     API" (developers.google.com/google-ads/api/docs/deprecations, 2026-06-15; the same warning heads
 *     …/docs/conversions/upload-offline). Nexus's Cloud project never uploaded. So sales go through the Data Manager API:
 *     POST https://datamanager.googleapis.com/v1/events:ingest (developers.google.com/data-manager/api/reference/rest/v1/
 *     events/ingest; guide …/data-manager/api/devguides/events/google-ads/offline/send-events), scope
 *     https://www.googleapis.com/auth/datamanager. One request: destinations[] (operatingAccount GOOGLE_ADS + the
 *     customer id, productDestinationId = the UPLOAD_CLICKS conversion action id), events[] (at most 2000), validateOnly,
 *     encoding HEX for hashed user data. Fast-fail: an invalid field refuses the WHOLE request (all or nothing), and
 *     validateOnly returns the same errors without ingesting. Valid events are processed in the background (the answer
 *     is a requestId; results in Google Ads' diagnostics / requestStatus:retrieve).
 *   - Event: transactionId (Google Ads' order id: within one conversion action Google uses it to deduplicate, and an
 *     adjustment names it), eventTimestamp (RFC 3339), eventSource WEB, conversionValue + currency, adIdentifiers.gclid |
 *     gbraid | wbraid, userData.userIdentifiers[] (emailAddress / phoneNumber: SHA-256, hex), consent.adUserData
 *     (CONSENT_GRANTED | CONSENT_DENIED). At least one identifier per event (a click id or user data).
 *   - Hashing (…/docs/conversions/upload-offline "Normalize and hash user-provided data"): email trimmed and lowercased;
 *     for gmail.com / googlemail.com the periods and a "+suffix" of the part before @ are removed; phone in E.164
 *     (+ and digits). SHA-256 of the UTF-8 bytes, lowercase hex (64 characters).
 *   - Adjustments go through the Google Ads API ConversionAdjustmentUploadService.UploadConversionAdjustments (not
 *     restricted on the deprecations page; reference …/rpc/v25/UploadConversionAdjustmentsRequest, ConversionAdjustment,
 *     RestatementValue, ConversionAdjustmentTypeEnum): RETRACTION (the sale counts 0) or RESTATEMENT (a new value), the
 *     conversion named by order_id (= the transactionId it was sent with), partial_failure true (Google: "should always
 *     be set to true"), validate_only for the check. The Data Manager API itself has no retraction (its adjustments
 *     restate a value or add user data: …/devguides/events/google-ads/conversion-adjustments).
 *
 * Where the click id comes from: Shopify's order webhook body, kept whole in Order.shopifyMetadata, has `landing_site`
 * (the first page of the visit, with its query: `…?gclid=…` when the visit came from an auto-tagged Google ad) and
 * `note_attributes` (a theme may save the gclid there). No schema change: the order already holds it. An order whose
 * landing page has no gclid / gbraid / wbraid can only be sent with hashed contact data (enhanced conversions for leads).
 */
import { createHash } from 'node:crypto'
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveConversionAction } from './live-account.js'
import type { SmartBiddingCampaign } from './live-conversions.js'
import { chaseSentence } from './change-conversions.js'
import type { GoogleMutateOperation } from './write-client.js'

/** Google's limit per request is 2000 events; a change a person reads holds at most 250 (Nexus's list bound; its undo retracts them all in one change). */
export const MAX_UPLOAD_ORDERS = 250
/** Google keeps an ad click for 90 days: an older sale cannot be tied to its click. */
export const CLICK_LIFETIME_DAYS = 90
const DAY_MS = 86_400_000

// ── normalising and hashing (Google's rules) ─────────────────────────────────────────────────────────────────────

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** An email as Google hashes it, or null when it is not an email. */
export function normalizedEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at < 1 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  let user = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') user = user.replace(/\./g, '').replace(/\+.*$/, '')
  return user ? `${user}@${domain}` : null
}

/** A phone number in E.164 (+ and 8–15 digits), or null: only a number that says its country can be normalised safely. */
export function e164Phone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let phone = raw.trim().replace(/[\s().\-/]/g, '')
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null
}

// ── the click id of a Shopify order ──────────────────────────────────────────────────────────────────────────────

export type ClickIdKind = 'gclid' | 'gbraid' | 'wbraid'
export interface ClickId { kind: ClickIdKind; value: string }
const CLICK_KINDS: readonly ClickIdKind[] = ['gclid', 'gbraid', 'wbraid']
const CLICK_VALUE = /^[A-Za-z0-9_\-.~]{8,1024}$/

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

/**
 * The Google click id of a Shopify order (its webhook body): from the landing page's query (`landing_site`, a path or a
 * whole URL) or a note attribute named gclid / gbraid / wbraid. One id: gclid first, then gbraid, then wbraid (Google
 * refuses gbraid and wbraid together).
 */
export function clickIdOf(metadata: unknown): ClickId | null {
  const m = obj(metadata)
  if (!m) return null
  const found = new Map<ClickIdKind, string>()
  const landing = typeof m.landing_site === 'string' ? m.landing_site : null
  if (landing && landing.includes('?')) {
    let params: URLSearchParams | null = null
    try { params = new URL(landing, 'https://shop.invalid').searchParams } catch { params = null }
    for (const kind of CLICK_KINDS) {
      const value = params?.get(kind)?.trim()
      if (value && CLICK_VALUE.test(value) && !found.has(kind)) found.set(kind, value)
    }
  }
  for (const attribute of Array.isArray(m.note_attributes) ? m.note_attributes : []) {
    const a = obj(attribute)
    const name = typeof a?.name === 'string' ? a.name.trim().toLowerCase() : ''
    const value = typeof a?.value === 'string' ? a.value.trim() : ''
    if ((CLICK_KINDS as readonly string[]).includes(name) && CLICK_VALUE.test(value) && !found.has(name as ClickIdKind)) found.set(name as ClickIdKind, value)
  }
  for (const kind of CLICK_KINDS) {
    const value = found.get(kind)
    if (value) return { kind, value }
  }
  return null
}

// ── orders ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A Nexus Shopify order as the upload reads it. */
export interface UploadOrder {
  /** Nexus's id. */
  orderId: string
  /** Shopify's order id (Order.channelOrderId): the transactionId / order_id Google keys the sale by. */
  shopifyOrderId: string
  status: string
  purchaseDate: Date | null
  createdAt: Date
  /** Order.totalPrice in cents. */
  totalCents: number
  currency: string | null
  email: string | null
  /** Order.shopifyMetadata: Shopify's order webhook body. */
  metadata: unknown
}

const centsOf = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
const orderName = (o: UploadOrder) => {
  const name = obj(o.metadata)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : `order ${o.shopifyOrderId}`
}
const orderTime = (o: UploadOrder) => o.purchaseDate ?? o.createdAt
const day = (d: Date) => d.toISOString().slice(0, 10)

export type ValueChoice = 'total' | 'subtotal'
/** The sale's value: Shopify's current total (after refunds and edits) or current subtotal (after discounts, before shipping and tax). */
export function orderValueCents(o: UploadOrder, choice: ValueChoice): number | null {
  const m = obj(o.metadata) ?? {}
  return choice === 'subtotal'
    ? centsOf(m.current_subtotal_price) ?? centsOf(m.subtotal_price)
    : centsOf(m.current_total_price) ?? o.totalCents
}

function contactOf(o: UploadOrder): { email: string | null; phone: string | null } {
  const m = obj(o.metadata) ?? {}
  const customer = obj(m.customer)
  const email = normalizedEmail(o.email) ?? normalizedEmail(m.email) ?? normalizedEmail(m.contact_email)
  const phone = e164Phone(m.phone) ?? e164Phone(customer?.phone) ?? e164Phone(obj(m.billing_address)?.phone) ?? e164Phone(obj(m.shipping_address)?.phone)
  return { email, phone }
}

// ── the upload ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface UploadRequest {
  conversionActionId: string
  /** The days whose sales are sent (YYYY-MM-DD, UTC, both included; `to` before today), when no orderIds are named. */
  from?: string
  to?: string
  /** Shopify order ids (or Nexus order ids) to send instead of a date range. */
  orderIds?: string[]
  value: ValueChoice
  /** Also send the buyer's email and phone, hashed (enhanced conversions). */
  enhanced: boolean
  /** With enhanced: also send sales whose visit carried no click id (matched by Google from the hashed contact only). */
  withoutClickId: boolean
  /** What the business says about its buyers' consent to share their data with Google for ads. */
  adUserDataConsent?: 'GRANTED' | 'DENIED'
}

export interface SentSale {
  /** Shopify's order id (the transactionId). */
  orderId: string
  name: string
  valueCents: number
  currency: string
  at: string
  clickId: ClickIdKind | null
  enhanced: boolean
}
export interface UploadRecord { conversionActionId: string; sent: SentSale[]; requestId?: string | null }

export interface UploadLive {
  customerId: string
  currency: string
  actions: LiveConversionAction[]
  /** The account that owns the conversion actions (cross-account tracking: a manager), when Google said. */
  conversionCustomerId: string | null
  acceptedCustomerDataTerms: boolean
  orders: UploadOrder[]
  /** Shopify order ids Nexus sent before, to any conversion action of this account → the action it went to. */
  alreadySent: Map<string, string>
  /** Enabled campaigns bidding with Smart Bidding for the action's goal (empty when the action does not count for bidding). */
  chasers: SmartBiddingCampaign[]
  /** Whether the action counts for bidding (primary, and its goal biddable). */
  countsForBidding: boolean
  now: Date
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Why the request's dates cannot be used, or null. */
export function uploadWindowProblem(request: Pick<UploadRequest, 'from' | 'to' | 'orderIds'>, now: Date): string | null {
  if (request.orderIds?.length) return request.from || request.to ? 'Give orderIds or a date range (from, to), not both.' : null
  if (!request.from || !request.to || !DATE.test(request.from) || !DATE.test(request.to)) return 'Give the days to send: from and to (YYYY-MM-DD), or orderIds.'
  if (request.from > request.to) return 'from is after to.'
  const today = day(now)
  // A day still running would bring new orders between the preview and the run: the approved list must stay the same.
  if (request.to >= today) return `to must be before today (${today}, UTC): today's sales go in a later upload.`
  const oldest = day(new Date(now.getTime() - (CLICK_LIFETIME_DAYS - 1) * DAY_MS))
  if (request.from < oldest) return `from must be ${oldest} or later: Google ties a sale to its ad click for ${CLICK_LIFETIME_DAYS} days only.`
  return null
}

export function uploadDraft(request: UploadRequest, live: UploadLive): GoogleChangeDraft | { refusal: string } {
  const windowProblem = uploadWindowProblem(request, live.now)
  if (windowProblem) return { refusal: windowProblem }
  const action = live.actions.find((a) => a.conversionActionId === request.conversionActionId)
  if (!action) return { refusal: `Conversion action ${request.conversionActionId} is not in the account (or is removed). Make one of type UPLOAD_CLICKS with set-google-conversion-actions.` }
  const label = `"${action.name}" (${action.conversionActionId})`
  if (action.type !== 'UPLOAD_CLICKS') return { refusal: `Conversion action ${label} is ${action.type}: sales are sent to an UPLOAD_CLICKS action ("Import from clicks"). Make one with set-google-conversion-actions.` }
  if (action.status !== 'ENABLED') return { refusal: `Conversion action ${label} is ${action.status}: it records nothing. Enable it first (set-google-conversion-actions).` }
  if (live.conversionCustomerId && live.conversionCustomerId !== live.customerId) {
    return { refusal: `This account's conversions are managed in account ${live.conversionCustomerId} (cross-account conversion tracking): sales are sent there, and Nexus sends only to the account this business chose.` }
  }
  if (request.withoutClickId && !request.enhanced) return { refusal: 'withoutClickId needs enhanced: a sale without a click id can only be matched from the buyer\'s hashed email or phone.' }
  if (request.enhanced) {
    if (!live.acceptedCustomerDataTerms) return { refusal: 'This Google Ads account has not accepted Google\'s customer data terms (Goals › Settings › Customer data terms): Google takes no hashed email or phone until it has. Send without enhanced, or accept them first.' }
    if (request.adUserDataConsent !== 'GRANTED') {
      return { refusal: 'Sending buyers\' hashed email or phone needs their consent to share data with Google for ads (Google\'s EU user consent policy): say adUserDataConsent GRANTED only when the shop collected it. Or send without enhanced.' }
    }
  }

  const minTime = request.orderIds?.length ? live.now.getTime() - CLICK_LIFETIME_DAYS * DAY_MS : Date.parse(`${request.from}T00:00:00Z`)
  const maxTime = request.orderIds?.length ? live.now.getTime() : Date.parse(`${request.to}T00:00:00Z`) + DAY_MS
  const named = new Set(request.orderIds ?? [])
  const skippedBy = new Map<string, string[]>()
  const skip = (why: string, o: UploadOrder) => skippedBy.set(why, [...(skippedBy.get(why) ?? []), orderName(o)])
  const events: GoogleMutateOperation[] = []
  const sent: SentSale[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const valueByCurrency = new Map<string, number>()
  const found = new Set<string>()
  const ordered = [...live.orders].sort((a, b) => orderTime(a).getTime() - orderTime(b).getTime() || a.shopifyOrderId.localeCompare(b.shopifyOrderId))
  for (const o of ordered) {
    if (named.size && !named.has(o.shopifyOrderId) && !named.has(o.orderId)) continue
    found.add(o.shopifyOrderId); found.add(o.orderId)
    const m = obj(o.metadata) ?? {}
    const at = orderTime(o)
    if (at.getTime() < minTime || at.getTime() >= maxTime) { skip(request.orderIds?.length ? `older than ${CLICK_LIFETIME_DAYS} days (Google no longer ties it to a click)` : 'outside the days asked', o); continue }
    if (m.test === true) { skip('Shopify test orders', o); continue }
    const financial = typeof m.financial_status === 'string' ? m.financial_status : ''
    if (o.status === 'CANCELLED' || m.cancelled_at || financial === 'refunded' || financial === 'voided') { skip('cancelled or refunded', o); continue }
    const sentTo = live.alreadySent.get(o.shopifyOrderId)
    if (sentTo !== undefined) { skip(sentTo === request.conversionActionId ? 'already sent to this action (never sent twice)' : `already sent to conversion action ${sentTo} (never sent twice)`, o); continue }
    const valueCents = orderValueCents(o, request.value)
    if (valueCents === null || valueCents <= 0) { skip('no value', o); continue }
    const currency = (typeof m.currency === 'string' && /^[A-Z]{3}$/.test(m.currency) ? m.currency : null) ?? o.currency ?? live.currency
    const click = clickIdOf(o.metadata)
    if (click && click.kind !== 'gclid' && action.counting === 'ONE_PER_CLICK') { skip(`a ${click.kind} only (Google refuses gbraid / wbraid on a one-per-click action)`, o); continue }
    const contact = request.enhanced ? contactOf(o) : { email: null, phone: null }
    const identifiers = [
      ...(contact.email ? [{ emailAddress: sha256Hex(contact.email) }] : []),
      ...(contact.phone ? [{ phoneNumber: sha256Hex(contact.phone) }] : []),
    ]
    if (!click && !(request.withoutClickId && identifiers.length)) {
      skip(request.withoutClickId ? 'no click id and no usable email or phone' : 'no Google click id on the landing page (gclid / gbraid / wbraid): not from an ad click, or the click came before auto-tagging', o)
      continue
    }
    if (sent.length >= MAX_UPLOAD_ORDERS) return { refusal: `More than ${MAX_UPLOAD_ORDERS} sales would be sent in one change: send fewer days at a time.` }
    events.push({
      transactionId: o.shopifyOrderId,
      eventTimestamp: at.toISOString(),
      eventSource: 'WEB',
      conversionValue: valueCents / 100,
      currency,
      ...(click ? { adIdentifiers: { [click.kind]: click.value } } : {}),
      ...(identifiers.length ? { userData: { userIdentifiers: identifiers } } : {}),
      ...(request.adUserDataConsent ? { consent: { adUserData: request.adUserDataConsent === 'GRANTED' ? 'CONSENT_GRANTED' : 'CONSENT_DENIED' } } : {}),
    })
    const name = orderName(o)
    sent.push({ orderId: o.shopifyOrderId, name, valueCents, currency, at: at.toISOString(), clickId: click?.kind ?? null, enhanced: identifiers.length > 0 })
    valueByCurrency.set(currency, (valueByCurrency.get(currency) ?? 0) + valueCents)
    lines.push([`${name} (${day(at)})`, 'not in Google', `${money(valueCents, currency)} · ${click ? click.kind : 'no click id'}${identifiers.length ? ` · hashed ${[contact.email ? 'email' : '', contact.phone ? 'phone' : ''].filter(Boolean).join(' + ')}` : ''}`])
  }
  const missing = [...named].filter((id) => !found.has(id))
  if (missing.length) return { refusal: `No Nexus Shopify order ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''} (order-search finds them; Nexus has only orders its Shopify import took in).` }
  const skipped = [...skippedBy.entries()].map(([why, orders]) => `${plural(orders.length, 'order')} not sent — ${why}: ${orders.slice(0, 10).join(', ')}${orders.length > 10 ? ' …' : ''}.`)
  if (!events.length) return { refusal: `No sale to send. ${skipped.join(' ') || 'Nexus has no Shopify order in these days.'}` }

  const totals = [...valueByCurrency.entries()].map(([c, cents]) => money(cents, c)).join(' + ')
  const warnings = [
    'Google\'s Data Manager API takes the sales and matches them to ad clicks in the background: the answer gives a request id, and the conversion action shows them within hours (Google Ads › Goals › Diagnostics). A sale Google cannot tie to a click counts nothing.',
    'Each sale is sent once, keyed by its Shopify order id (Google deduplicates within the action; Nexus never sends an order twice). Sending cannot be taken back; undo asks Google to retract the sales (adjust-google-sales).',
    ...(request.enhanced ? ['The buyers\' email and phone go to Google hashed (SHA-256, normalised as Google asks), never as plain text.'] : []),
  ]
  const otherPrimary = live.actions.filter((a) => a.conversionActionId !== action.conversionActionId && a.primary && a.status === 'ENABLED' && a.category === action.category)
  if (otherPrimary.length && action.primary) {
    warnings.push(`${otherPrimary.map((a) => `"${a.name}"`).join(', ')} also count${otherPrimary.length === 1 ? 's' : ''} ${action.category} as primary: a sale both record is counted twice. Keep one primary ${action.category} action (set-google-conversion-actions).`)
  }
  if (!action.primary) warnings.push(`${label} is secondary: these sales show in reports but automatic bidding does not use them until it is primary.`)
  const { changes, more } = changeLines(lines)
  return {
    summary: `Send ${plural(events.length, 'sale')} (${totals}) from Shopify to the conversion action ${label}.`,
    changes,
    totals: {
      sales: events.length,
      withGclid: sent.filter((s) => s.clickId === 'gclid').length,
      withBraid: sent.filter((s) => s.clickId === 'gbraid' || s.clickId === 'wbraid').length,
      withHashedContact: sent.filter((s) => s.enhanced).length,
      notSent: [...skippedBy.values()].reduce((n, l) => n + l.length, 0),
      ...(more ? { moreLines: more } : {}),
    },
    warnings,
    spendsMoney: live.countsForBidding ? [chaseSentence(`These ${plural(events.length, 'sale')} count for automatic bidding (${label} is primary and its goal is biddable)`, live.chasers)] : [],
    skipped,
    operations: events,
    stands: {
      action: `${action.conversionActionId}:${action.type}:${action.status}:${action.counting}:${action.primary}`,
      sales: sent.map((s) => `${s.orderId}:${s.valueCents}:${s.currency}:${s.at}:${s.clickId ?? '-'}:${s.enhanced}`),
    },
    before: { conversionActionId: action.conversionActionId!, sent: [] } satisfies UploadRecord,
    after: { conversionActionId: action.conversionActionId!, sent } satisfies UploadRecord,
  }
}

// ── adjustments ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface AdjustRequest {
  conversionActionId: string
  /** Shopify order ids whose sale Google should count as 0 (refunded, cancelled, sent by mistake). */
  retract?: string[]
  /** Shopify order ids with their new value, in cents. */
  restate?: Array<{ orderId: string; valueCents: number }>
}
export interface AdjustRecord {
  conversionActionId: string
  retracted: string[]
  /** after: the new values; before: the value Nexus last gave Google for the sale (null when Nexus never sent it). */
  restated: Array<{ orderId: string; valueCents: number | null; currency: string }>
}
export interface AdjustLive {
  actions: LiveConversionAction[]
  currency: string
  /** Nexus Shopify orders by Shopify order id (the ones named). */
  orders: Map<string, UploadOrder>
  /** Shopify order ids Nexus sent to this action. */
  sentHere: Set<string>
  /** Shopify order ids Nexus already retracted on this action. */
  retracted: Set<string>
  /** Shopify order id → the last value Nexus gave Google for it on this action (sent, or restated). */
  known: Map<string, { valueCents: number; currency: string }>
  chasers: SmartBiddingCampaign[]
  countsForBidding: boolean
}

export function adjustDraft(customer: string, request: AdjustRequest, live: AdjustLive): GoogleChangeDraft | { refusal: string } {
  const retract = [...new Set(request.retract ?? [])]
  const restate = request.restate ?? []
  if (!retract.length && !restate.length) return { refusal: 'Say what to adjust: retract or restate.' }
  const action = live.actions.find((a) => a.conversionActionId === request.conversionActionId)
  if (!action) return { refusal: `Conversion action ${request.conversionActionId} is not in the account (or is removed).` }
  const label = `"${action.name}" (${action.conversionActionId})`
  if (!action.type || action.type === 'UNKNOWN') return { refusal: `Google adjusts no conversion of ${label} (its type is unknown).` }
  const resource = `${customer}/conversionActions/${action.conversionActionId}`
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const skipped: string[] = []
  const after: AdjustRecord = { conversionActionId: action.conversionActionId!, retracted: [], restated: [] }
  const before: AdjustRecord = { conversionActionId: action.conversionActionId!, retracted: [], restated: [] }
  const notByNexus: string[] = []
  const seen = new Set<string>()
  for (const id of retract) {
    seen.add(id)
    const o = live.orders.get(id)
    if (!o) return { refusal: `No Nexus Shopify order with Shopify id ${id}.` }
    if (live.retracted.has(id)) { skipped.push(`${orderName(o)} is already retracted on ${label}.`); continue }
    if (!live.sentHere.has(id)) notByNexus.push(orderName(o))
    operations.push({ conversionAction: resource, adjustmentType: 'RETRACTION', orderId: id })
    after.retracted.push(id)
    before.retracted.push(id)
    lines.push([`${orderName(o)}`, 'counts', 'retracted (counts 0)'])
  }
  for (const r of restate) {
    if (seen.has(r.orderId)) return { refusal: `Order ${r.orderId} is both retracted and restated: one or the other.` }
    seen.add(r.orderId)
    const o = live.orders.get(r.orderId)
    if (!o) return { refusal: `No Nexus Shopify order with Shopify id ${r.orderId}.` }
    if (!Number.isInteger(r.valueCents) || r.valueCents <= 0) return { refusal: `${orderName(o)}: a new value is whole cents above 0 (to count it 0, retract it).` }
    if (live.retracted.has(r.orderId)) return { refusal: `${orderName(o)} is retracted on ${label}: Google does not restate a retracted sale.` }
    if (!live.sentHere.has(r.orderId)) notByNexus.push(orderName(o))
    const m = obj(o.metadata) ?? {}
    const currency = (typeof m.currency === 'string' && /^[A-Z]{3}$/.test(m.currency) ? m.currency : null) ?? o.currency ?? live.currency
    operations.push({ conversionAction: resource, adjustmentType: 'RESTATEMENT', orderId: r.orderId, restatementValue: { adjustedValue: r.valueCents / 100, currencyCode: currency } })
    after.restated.push({ orderId: r.orderId, valueCents: r.valueCents, currency })
    const known = live.known.get(r.orderId)
    before.restated.push({ orderId: r.orderId, valueCents: known?.valueCents ?? null, currency: known?.currency ?? currency })
    lines.push([`${orderName(o)}`, known ? money(known.valueCents, known.currency) : 'its value', money(r.valueCents, currency)])
  }
  if (!operations.length) return { refusal: `Nothing to adjust: ${skipped.join(' ')}` }
  if (notByNexus.length) warnings.push(`Nexus did not send ${notByNexus.slice(0, 10).join(', ')} to ${label}: Google adjusts them only if it recorded them with this order id (transaction id), e.g. from the website tag.`)
  if (after.retracted.length) warnings.push(`A retracted sale counts 0 for good: Google cannot restate it, and its order id cannot be sent again.${action.primary ? ' Automatic bidding loses these conversions.' : ''}`)
  warnings.push('Google applies adjustments one by one: the answer says which it took and which it refused (and why).')
  // A higher value restated on an action bidding uses can make value bidding bid higher: Nexus does not know the value
  // Google recorded, so every restatement on such an action is the person's decision.
  const spends = after.restated.length && live.countsForBidding
    ? [chaseSentence(`${plural(after.restated.length, 'sale')} get${after.restated.length === 1 ? 's' : ''} a new value on ${label} (a higher one makes value bidding chase it more)`, live.chasers)]
    : []
  const { changes, more } = changeLines(lines)
  return {
    summary: `Adjust ${plural(operations.length, 'sale')} on ${label}: ${after.retracted.length} retracted, ${after.restated.length} with a new value.`,
    changes,
    totals: { retracted: after.retracted.length, restated: after.restated.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: { action: `${action.conversionActionId}:${action.type}:${action.status}`, retracted: [...live.retracted].filter((id) => seen.has(id)).sort() },
    before,
    after,
  }
}

/**
 * After the run: only the adjustments Google took stay in the records (the operations are the retractions, then the
 * restatements, in the records' order); the refused ones are listed with Google's words.
 */
export function adjustRecordsAfterRun(
  draft: { before: AdjustRecord; after: AdjustRecord },
  results: Array<{ ok: true } | { ok: false; why: string }>,
): { before: AdjustRecord; after: AdjustRecord; refused: Array<{ orderId: string; why: string }> } {
  const n = draft.after.retracted.length
  const okAt = (i: number) => results[i]?.ok === true
  const refused: Array<{ orderId: string; why: string }> = []
  const keep = <T>(list: T[], offset: number, id: (t: T) => string) => list.filter((t, i) => {
    if (okAt(offset + i)) return true
    const r = results[offset + i]
    refused.push({ orderId: id(t), why: r && 'why' in r ? r.why : 'Google gave no answer for it' })
    return false
  })
  const after: AdjustRecord = { ...draft.after, retracted: keep(draft.after.retracted, 0, (id) => id), restated: keep(draft.after.restated, n, (r) => r.orderId) }
  const taken = new Set([...after.retracted, ...after.restated.map((r) => r.orderId)])
  const before: AdjustRecord = { ...draft.before, retracted: draft.before.retracted.filter((id) => taken.has(id)), restated: draft.before.restated.filter((r) => taken.has(r.orderId)) }
  return { before, after, refused }
}
