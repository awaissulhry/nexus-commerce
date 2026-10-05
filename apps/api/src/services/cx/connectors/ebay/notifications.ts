/**
 * P2.3 — eBay's Notification API: topics, destination, subscriptions.
 *
 * None of this existed. There was no destination, no subscription and no call to
 * eBay's topic catalogue, so **not one genuine eBay notification had ever arrived**.
 * The seven EBAY rows in the inbound ledger are all from 2026-08-29, all rejected, and
 * one of them is literally `probe.deploy.wait` — they are this repository's own test
 * probes, not eBay's traffic.
 *
 * That is also why the receiver's topic names could stay wrong for so long. It branched
 * on `marketplace.order.created`, `marketplace.order.cancelled` and
 * `marketplace.inventory_item.updated`, which are not eBay topic IDs, plus `ItemRevised`,
 * which is a Trading API event name from the other, older system. Nothing ever arrived
 * to contradict them.
 *
 * So the rule here is the one P2.2 arrived at: **eBay is the authority on what its
 * topics are called, not this file.** `getTopics` returns the real catalogue, the
 * desired list below is checked against it, and a name we believe in that eBay does not
 * offer is reported as a finding rather than silently subscribed and silently never
 * delivered.
 */
import { logger } from '../../../../utils/logger.js'

const EBAY_API_BASE = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
} as const

export type EbayEnvironment = keyof typeof EBAY_API_BASE

/** How well we know a topic ID, kept beside the claim — the same discipline as P2.2. */
export type TopicEvidence = 'verified' | 'documented' | 'unverified'

/**
 * The endpoint eBay delivers to, and the token that proves we own it.
 *
 * **One accessor, used by both the destination we create here and the challenge the
 * receiver answers.** eBay's ownership check is
 * `SHA256(challengeCode + verificationToken + endpoint)`, computed by eBay from what
 * the DESTINATION says and by us from these variables. If the two sides read different
 * variables the hashes differ, eBay reads that as a failed ownership check, and after
 * 24 hours it marks the endpoint down and takes every topic with it.
 *
 * The first draft of this file read `EBAY_NOTIFICATION_ENDPOINT` and
 * `EBAY_VERIFICATION_TOKEN` while the receiver read
 * `EBAY_NOTIFICATION_ENDPOINT_URL` and `EBAY_NOTIFICATION_VERIFICATION_TOKEN` — two
 * names for one fact, which is the shape of every drift defect in this programme. The
 * receiver's names win because they are the ones already set.
 */
export function ebayNotificationConfig(): { endpoint: string | null; verificationToken: string | null } {
  return {
    endpoint: process.env.EBAY_NOTIFICATION_ENDPOINT_URL || null,
    verificationToken: process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN || null,
  }
}

/** eBay's format rule; never echo or silently trim the configured secret. */
export function ebayVerificationTokenError(token: string | null): string | null {
  if (!token || token.length < 32 || token.length > 80 || /[^A-Za-z0-9_-]/.test(token)) {
    return 'EBAY_NOTIFICATION_VERIFICATION_TOKEN must be 32–80 characters using only [A-Za-z0-9_-]. The Owner must replace this variable.'
  }
  return null
}

/**
 * The Notification API's alert email (eBay writes to it when it marks our endpoint down).
 * eBay refuses createDestination/createSubscription with errorId 195003 until it is set.
 * Returned only when well formed; never echoed in a message.
 */
export function ebayNotificationAlertEmail(): string | null {
  const value = (process.env.EBAY_NOTIFICATION_ALERT_EMAIL ?? '').trim()
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

/**
 * eBay error ids the setup can meet, named so the CronRun output and the admin route say what
 * to do. Source: eBay's public Notification API spec — createDestination lists 195019 (token
 * format), 195020 (challenge failed) and 195021 "Destination exists for this endpoint" (HTTP
 * 409); see docs/channel-connections/build/CX-CLEANUP.md. 195003 is the missing /config.
 */
const EBAY_NOTIFICATION_ERROR_IDS: Record<number, string> = {
  195003: 'eBay needs the Notification API alert email (config) first. Nexus sets it from EBAY_NOTIFICATION_ALERT_EMAIL when eBay has none; set that variable on the API and the scheduler.',
  195019: 'eBay refused the verification token. It must be 32–80 characters using only [A-Za-z0-9_-]; the Owner replaces EBAY_NOTIFICATION_VERIFICATION_TOKEN on the API and the scheduler.',
  195020: "eBay's challenge to the endpoint failed. The API service must answer with the same token and endpoint this process sent: set both variables on the API and the scheduler, let the API redeploy, then retry.",
  195021: 'eBay already has a destination for this endpoint (HTTP 409). The setup re-reads the destinations and reuses the one whose endpoint matches EBAY_NOTIFICATION_ENDPOINT_URL exactly; if none matches exactly, compare that variable with destinationEndpoints in the status.',
}

/** eBay's errorIds in a response body; [] when the body is not eBay's error shape. */
function ebayErrorIds(text: string): number[] {
  try {
    const errors = (JSON.parse(text) as { errors?: Array<{ errorId?: unknown }> })?.errors
    return Array.isArray(errors) ? errors.map(error => Number(error?.errorId)).filter(Number.isInteger) : []
  } catch { return [] }
}

/** createDestination said 195021 / 409: a destination for this endpoint already exists. */
export class EbayDestinationExistsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EbayDestinationExistsError'
  }
}

/** Every secret a notification error could echo, removed before any text leaves this module. */
function redactNotificationText(text: string, extra: Array<string | null | undefined> = []): string {
  const secrets = [ebayNotificationConfig().verificationToken, process.env.EBAY_NOTIFICATION_ALERT_EMAIL?.trim(), ...extra]
  return secrets.reduce<string>((out, secret) => (secret && secret.length >= 6 ? out.split(secret).join('[redacted]') : out), text)
}

/** `eBay <operation> returned <status> (errorId …: meaning): <redacted body>`. */
export function describeEbayNotificationError(operation: string, status: number, text: string): string {
  const ids = ebayErrorIds(text)
  const named = ids.filter(id => EBAY_NOTIFICATION_ERROR_IDS[id]).map(id => `errorId ${id}: ${EBAY_NOTIFICATION_ERROR_IDS[id]}`)
  return `eBay ${operation} returned ${status}${named.length ? ` (${named.join(' ')})` : ''}: ${redactNotificationText(text).slice(0, 300)}`
}

/**
 * How eBay delivers a topic to us. `application`: one subscription made with the app token.
 * `user`: one subscription per seller, made with that seller's own token
 * (`seller-subscriptions.ts`, never the app token). `portal`: configured in eBay's developer
 * portal, never through this API.
 */
export type EbayTopicDelivery = 'application' | 'user' | 'portal'

export interface EbayTopicWish {
  /** eBay's topic ID, as WE believe it to be. `getTopics` is what settles it. */
  topicId: string
  /** What Nexus would do with it. */
  purpose: string
  evidence: TopicEvidence
  delivery: EbayTopicDelivery
  /** Set when Nexus cannot yet act on the topic, so a subscription would only fill the ledger. */
  handlerMissing?: boolean
}

/**
 * The topics P2.3 names, as topic IDs.
 *
 * Topic existence and handler readiness are different. v1 (plan S1, 2026-09-26) subscribes
 * AUTHORIZATION_REVOCATION: its handler passed the written C8 check in
 * docs/channel-connections/PLAN-EBAY-NOTIFICATIONS.md, and processing stays held behind
 * NEXUS_ENABLE_EBAY_INBOUND_PROCESSING. Account deletion is configured in eBay's developer
 * portal and its erasure executor is not built. ORDER_CONFIRMATION (GAP2 phase 2, 2026-10-06) is
 * ready and per-seller: each eBay account is subscribed with its own sign-in
 * (`seller-subscriptions.ts`), only when the Owner names it in the armed list; a stored order
 * notice stays held behind NEXUS_ENABLE_EBAY_ORDER_NOTICES, and the 5-minute poll stays as the
 * safety net. ITEM_PRICE_REVISION and ITEM_AVAILABILITY are buy-side item topics a seller has
 * no use for, so they are gone.
 */
export const EBAY_DESIRED_TOPICS: EbayTopicWish[] = [
  {
    topicId: 'MARKETPLACE_ACCOUNT_DELETION',
    purpose: "eBay's erasure notice. Answering it is a condition of holding production keys.",
    evidence: 'verified',
    delivery: 'portal',
    handlerMissing: true,
  },
  {
    topicId: 'AUTHORIZATION_REVOCATION',
    purpose: 'A seller withdrew our access — the account must be marked revoked and writes paused (P2.6).',
    evidence: 'documented',
    delivery: 'application',
  },
  // eBay release 1.6.6 (2025-12-01): developer.ebay.com/develop/api/notification/release-notes
  { topicId: 'ORDER_CONFIRMATION', purpose: 'A buyer completed checkout and payment cleared — read that one order and take its stock.', evidence: 'documented', delivery: 'user' },
]

export const EBAY_NOTIFICATION_SETUP_SWITCH = 'NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP'
export const EBAY_NOTIFICATION_ARMED_TOPICS = 'NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS'

export interface EbayNotificationSetupGate {
  armed: boolean
  /** The topics the Owner armed. Empty unless `armed`. */
  topics: string[]
  reason: string | null
}

/**
 * The arming gate for every WRITE to eBay's Notification API (review, 2026-09-26).
 *
 * `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` alone is not enough: a scheduler may still hold it
 * from before it became opt-in (571371bfc), and this release makes a topic ready, so that
 * stale value would create the destination and subscription at the first 03:55 run. Setup
 * also needs `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS`, a variable no release before this one
 * read, naming each topic the Owner arms (`AUTHORIZATION_REVOCATION`, `ORDER_CONFIRMATION`).
 * Naming topics, not a boolean, means a later release that makes another topic ready does
 * not arm it. Every entry must be a ready application-level or per-seller (USER) topic, or
 * nothing is armed. A portal topic is never armed. Which token a topic is subscribed with
 * follows its delivery: `armedApplicationTopics` (the app token) and `armedSellerTopics`
 * (each seller's own token).
 */
export function ebayNotificationSetupGate(env: NodeJS.ProcessEnv = process.env): EbayNotificationSetupGate {
  const refuse = (reason: string): EbayNotificationSetupGate => ({ armed: false, topics: [], reason })
  if (env[EBAY_NOTIFICATION_SETUP_SWITCH] !== '1') return refuse(`${EBAY_NOTIFICATION_SETUP_SWITCH} is not exactly 1.`)
  const entries = [...new Set((env[EBAY_NOTIFICATION_ARMED_TOPICS] ?? '').split(',').map(entry => entry.trim()).filter(Boolean))]
  if (!entries.length) {
    return refuse(`${EBAY_NOTIFICATION_ARMED_TOPICS} names no topic. The Owner arms setup by naming each topic (AUTHORIZATION_REVOCATION, ORDER_CONFIRMATION).`)
  }
  for (const entry of entries) {
    const name = /^[A-Z][A-Z0-9_]{0,63}$/.test(entry) ? entry : 'an entry that is not a topic id'
    const wish = EBAY_DESIRED_TOPICS.find(topic => topic.topicId === entry)
    if (!wish) return refuse(`${EBAY_NOTIFICATION_ARMED_TOPICS} names ${name}, which Nexus does not subscribe.`)
    if (wish.delivery === 'portal') {
      return refuse(`${EBAY_NOTIFICATION_ARMED_TOPICS} names ${name}, which is set up in eBay's developer portal and never subscribed through the Notification API.`)
    }
    if (wish.handlerMissing) return refuse(`${EBAY_NOTIFICATION_ARMED_TOPICS} names ${name}, which has no ready handler.`)
  }
  return { armed: true, topics: entries, reason: null }
}

function armedByDelivery(gate: EbayNotificationSetupGate, delivery: EbayTopicDelivery): string[] {
  if (!gate.armed) return []
  return gate.topics.filter(topicId => EBAY_DESIRED_TOPICS.find(wish => wish.topicId === topicId)?.delivery === delivery)
}

/** Armed topics subscribed once, with the application token. */
export function armedApplicationTopics(gate: EbayNotificationSetupGate = ebayNotificationSetupGate()): string[] {
  return armedByDelivery(gate, 'application')
}

/** Armed per-seller (USER) topics: one subscription per eBay account, made with that seller's own token. */
export function armedSellerTopics(gate: EbayNotificationSetupGate = ebayNotificationSetupGate()): string[] {
  return armedByDelivery(gate, 'user')
}

/** Refused before the app token is fetched: nothing reached eBay. */
export class EbayNotificationNotArmedError extends Error {
  constructor(reason: string | null) {
    super(`eBay notification setup is not armed: ${reason ?? 'unknown reason'} No eBay call was made.`)
    this.name = 'EbayNotificationNotArmedError'
  }
}

export interface EbayTopic {
  topicId: string
  status?: string
  scope?: string
  authorizationScopes?: string[]
  supportedPayloads?: Array<{ format?: string[]; deliveryProtocol?: string; schemaVersion?: string; deprecated?: boolean }>
}

export interface EbayDestination {
  destinationId: string
  name?: string
  status?: string
  endpoint?: string
}

export interface EbaySubscription {
  subscriptionId: string
  topicId: string
  destinationId?: string
  status?: string
  payload?: { format?: string; deliveryProtocol?: string; schemaVersion?: string }
}

/**
 * Who a Notification API call is made as. `app`: the application token (topics, destinations,
 * config, application-level subscriptions). `{ connectionId }`: one eBay account, with THAT
 * seller's own token, which the gateway takes from the token service for exactly that account.
 * A per-seller call never carries the app token or another seller's token.
 */
export type NotificationCaller = 'app' | { connectionId: string }

/** A Notification API answer that was not the expected one; `errorIds` are eBay's own. */
export class EbayNotificationHttpError extends Error {
  constructor(message: string, readonly status: number, readonly errorIds: number[]) {
    super(message)
    this.name = 'EbayNotificationHttpError'
  }
}

export interface NotificationAnswer<T> { status: number; body: T | null; text: string; location: string | null; errorIds: number[] }

async function notificationApi<T>(
  environment: EbayEnvironment,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  caller: NotificationCaller = 'app',
): Promise<NotificationAnswer<T>> {
  // The one choke point for writes: no POST or PUT without the Owner's arming, checked
  // before any token is fetched. Reads (the status route) are unaffected. A per-seller write
  // also needs a per-seller topic in the armed list: arming AUTHORIZATION_REVOCATION alone
  // never lets a seller's token write.
  if (method !== 'GET') {
    const gate = ebayNotificationSetupGate()
    if (!gate.armed) throw new EbayNotificationNotArmedError(gate.reason)
    if (caller !== 'app' && !armedSellerTopics(gate).length) {
      throw new EbayNotificationNotArmedError(`${EBAY_NOTIFICATION_ARMED_TOPICS} names no per-seller topic.`)
    }
  }
  const { ebayTransport } = await import('../../../gateway/ebay.js')
  const url = `${EBAY_API_BASE[environment]}${path}`
  const jsonHeaders = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }
  const init = { method, ...(body ? { body: JSON.stringify(body) } : {}) }
  let res: Response
  let token: string | null = null
  if (caller === 'app') {
    const { ebayAppToken } = await import('./client.js')
    token = await ebayAppToken(environment)
    // Through the gateway as an app-level call, like the public-key lookup beside it, so
    // the channel-gateway ratchet stays at zero.
    res = await ebayTransport(null, { appLevel: true })(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...jsonHeaders } })
  } else {
    // No Authorization header on purpose: the gateway authorises the call with the token of
    // `connectionId` (account state, rate bucket and call ledger included). /commerce/notification
    // is kind `setup` there, so it is sent in every publish mode.
    res = await ebayTransport(caller.connectionId)(url, { ...init, headers: jsonHeaders })
  }
  const raw = await res.text()
  let parsed: T | null = null
  try { parsed = raw ? (JSON.parse(raw) as T) : null } catch { parsed = null }
  // `text` feeds error messages only; eBay may echo what we sent, so secrets are removed here.
  return { status: res.status, body: parsed, text: redactNotificationText(raw, [token]), location: res.headers.get('location'), errorIds: ebayErrorIds(raw) }
}

/**
 * One Notification API call made as one eBay account (`seller-subscriptions.ts`). The same
 * choke point as every other call: a write needs the Owner's arming before anything is sent.
 */
export function sellerNotificationCall<T>(
  connectionId: string, environment: EbayEnvironment, method: 'GET' | 'POST', path: string, body?: unknown,
): Promise<NotificationAnswer<T>> {
  return notificationApi<T>(environment, method, path, body, { connectionId })
}

/**
 * eBay's own catalogue of topics. This is the authority.
 *
 * Paged: eBay returns `next` as a URL. Followed to the end, because a partial
 * catalogue would make a real topic look invented — the exact mistake this call exists
 * to prevent.
 */
export async function getEbayTopics(environment: EbayEnvironment = 'production'): Promise<EbayTopic[]> {
  return notificationCollection<EbayTopic>(environment, 'topic', 'topics')
}

/** Bound traversal without ever treating an incomplete catalogue as success. */
async function notificationCollection<T>(environment: EbayEnvironment, resource: string, key: string, caller: NotificationCaller = 'app'): Promise<T[]> {
  const pathname = `/commerce/notification/v1/${resource}`
  let next: unknown = `${pathname}?limit=100`
  const visited = new Set<string>()
  const rows: T[] = []
  while (next) {
    if (visited.size >= 20 || typeof next !== 'string') throw new Error('eBay notification pagination is incomplete or invalid.')
    const url = new URL(next, EBAY_API_BASE[environment])
    if (url.origin !== EBAY_API_BASE[environment] || url.pathname !== pathname || url.username || url.password || url.hash || visited.has(url.href)) {
      throw new Error('eBay notification pagination returned an unsafe or repeated URL.')
    }
    visited.add(url.href)
    const res = await notificationApi<Record<string, unknown>>(environment, 'GET', `${url.pathname}${url.search}`, undefined, caller)
    if (res.status !== 200) throw new EbayNotificationHttpError(describeEbayNotificationError(`get ${key}`, res.status, res.text), res.status, res.errorIds)
    const batch = res.body?.[key] ?? (res.body?.total === 0 ? [] : null)
    if (!Array.isArray(batch)) throw new Error(`eBay ${key} returned an unreadable collection.`)
    rows.push(...batch)
    next = res.body?.next
    if (!next && typeof res.body?.total === 'number' && rows.length < res.body.total) {
      throw new Error('eBay notification pagination ended before the advertised total.')
    }
  }
  return rows
}

/** A creation response has no body: eBay identifies the new resource in Location. */
export function createdResourceId(location: string | null, environment: EbayEnvironment, resource: 'destination' | 'subscription'): string | null {
  if (!location) return null
  try {
    const url = new URL(location, EBAY_API_BASE[environment])
    if (url.origin !== EBAY_API_BASE[environment]) return null
    return url.pathname.match(new RegExp(`^/commerce/notification/v1/${resource}/([^/]+)$`))?.[1] ?? null
  } catch { return null }
}

export async function getEbayDestinations(environment: EbayEnvironment = 'production'): Promise<EbayDestination[]> {
  const destinations = await notificationCollection<Omit<EbayDestination, 'endpoint'> & { deliveryConfig?: { endpoint?: string } }>(environment, 'destination', 'destinations')
  // Select only public diagnostic fields; deliveryConfig also contains the verification token.
  return destinations.map(d => ({
    destinationId: d.destinationId, name: d.name, status: d.status, endpoint: d.deliveryConfig?.endpoint,
  }))
}

export async function createEbayDestination(
  environment: EbayEnvironment,
  name: string,
  endpoint: string,
  verificationToken: string,
): Promise<string> {
  const error = ebayVerificationTokenError(verificationToken)
  if (error) throw new Error(error)
  const res = await notificationApi<{ destinationId?: string }>(
    environment, 'POST', '/commerce/notification/v1/destination',
    { name, status: 'ENABLED', deliveryConfig: { endpoint, verificationToken } },
  )
  // eBay answers a create with 201 and the new id in the Location header or the body.
  if (res.status !== 201 && res.status !== 200) {
    const message = describeEbayNotificationError('createDestination', res.status, res.text)
    if (res.status === 409 || ebayErrorIds(res.text).includes(195021)) throw new EbayDestinationExistsError(message)
    throw new Error(message)
  }
  const id = createdResourceId(res.location, environment, 'destination') ?? res.body?.destinationId
  if (!id) throw new Error(`eBay createDestination gave no destinationId: ${res.text.slice(0, 300)}`)
  return id
}

export async function getEbaySubscriptions(environment: EbayEnvironment = 'production'): Promise<EbaySubscription[]> {
  return notificationCollection<EbaySubscription>(environment, 'subscription', 'subscriptions')
}

/** The subscriptions eBay holds for ONE seller, read with that seller's own token. */
export async function getEbaySellerSubscriptions(connectionId: string, environment: EbayEnvironment = 'production'): Promise<EbaySubscription[]> {
  return notificationCollection<EbaySubscription>(environment, 'subscription', 'subscriptions', { connectionId })
}

/**
 * The payloads a topic may be subscribed with: not deprecated, JSON over HTTPS, with a schema
 * version. eBay's catalogue defines no ordering or default format, so only an explicitly
 * supported entry is used.
 */
export function usableTopicPayloads(topic: EbayTopic): Array<{ schemaVersion: string }> {
  return (topic.supportedPayloads ?? []).filter((p): p is typeof p & { schemaVersion: string } =>
    !p.deprecated && !!p.schemaVersion && p.deliveryProtocol === 'HTTPS' && Array.isArray(p.format) && p.format.includes('JSON'),
  )
}

/** An existing subscription whose payload is one of the topic's usable JSON/HTTPS schemas. */
export function subscriptionPayloadUsable(subscription: EbaySubscription, payloads: Array<{ schemaVersion: string }>): boolean {
  return subscription.payload?.format === 'JSON' && subscription.payload?.deliveryProtocol === 'HTTPS' &&
    payloads.some(payload => payload.schemaVersion === subscription.payload?.schemaVersion)
}

export interface SubscribeOutcome {
  topicId: string
  status: 'created' | 'already_exists' | 'enabled' | 'not_offered' | 'refused' | 'failed'
  subscriptionId?: string
  detail?: string
}

/**
 * Subscribe one topic, telling the three failures apart.
 *
 * `not_offered` means eBay's catalogue has no such topic — our name is wrong, which is
 * the finding this whole package exists to surface. `refused` means eBay knows the
 * topic and will not give it to this application, usually a missing scope or programme
 * opt-in. `failed` is everything else. Collapsing the three into one "failed" is what
 * let `marketplace.order.created` survive: nobody could tell a wrong name from a
 * missing permission.
 */
export async function subscribeEbayTopic(
  environment: EbayEnvironment,
  topicId: string,
  destinationId: string,
  catalogue: Map<string, EbayTopic>,
  existing: EbaySubscription[],
): Promise<SubscribeOutcome> {
  const topic = catalogue.get(topicId)
  if (!topic) {
    return { topicId, status: 'not_offered', detail: 'eBay\'s topic catalogue has no topic with this id.' }
  }
  // The schema version comes from the TOPIC, not from a constant. P2.2 found the same
  // mistake on the Amazon side, where one hardcoded payload version stood for every
  // notification type and would have been refused outright for one of them. eBay
  // advertises compatible versions in `getTopics`. The catalogue defines no ordering
  // or default format; choose an explicitly supported JSON/HTTPS entry.
  const payloads = usableTopicPayloads(topic)
  const schemaVersion = payloads[0]?.schemaVersion
  const format = 'JSON'
  if (!schemaVersion) {
    return { topicId, status: 'failed', detail: 'eBay lists this topic with no usable payload version.' }
  }
  const wish = EBAY_DESIRED_TOPICS.find(wish => wish.topicId === topicId)
  if (!wish || wish.handlerMissing) return { topicId, status: 'refused', detail: 'Nexus has no supported handler for this topic.' }
  if (wish.delivery !== 'application') {
    return { topicId, status: 'refused', detail: wish.delivery === 'portal'
      ? "This topic is set up in eBay's developer portal, never through the Notification API."
      : "This is a per-seller topic: it needs each seller's own token, never the application token." }
  }
  // eBay's catalogue is the authority on scope. A USER topic subscribed with the app token
  // would be refused or, worse, bound to no seller; only APPLICATION is sent.
  if ((topic.scope ?? '').toUpperCase() !== 'APPLICATION') {
    return { topicId, status: 'refused', detail: `eBay lists this topic with scope ${topic.scope ?? '(none)'}; only APPLICATION topics are subscribed with the application token.` }
  }
  const already = existing.find((s) => s.topicId === topicId && s.destinationId === destinationId)
  if (already) {
    if (!subscriptionPayloadUsable(already, payloads)) {
      return { topicId, status: 'failed', subscriptionId: already.subscriptionId, detail: 'The existing subscription payload is not compatible with the advertised JSON/HTTPS schemas; repair it before enabling.' }
    }
    if ((already.status ?? '').toUpperCase() === 'ENABLED') {
      return { topicId, status: 'already_exists', subscriptionId: already.subscriptionId }
    }
    const enable = await notificationApi(environment, 'POST', `/commerce/notification/v1/subscription/${already.subscriptionId}/enable`)
    return enable.status === 204 || enable.status === 200
      ? { topicId, status: 'enabled', subscriptionId: already.subscriptionId }
      : { topicId, status: 'failed', subscriptionId: already.subscriptionId, detail: describeEbayNotificationError('enableSubscription', enable.status, enable.text) }
  }
  const res = await notificationApi<{ subscriptionId?: string }>(
    environment, 'POST', '/commerce/notification/v1/subscription',
    { topicId, destinationId, status: 'ENABLED', payload: { format, schemaVersion, deliveryProtocol: 'HTTPS' } },
  )
  if (res.status === 201 || res.status === 200) {
    const subscriptionId = createdResourceId(res.location, environment, 'subscription') ?? res.body?.subscriptionId
    if (!subscriptionId) return { topicId, status: 'failed', detail: 'eBay created the subscription but returned no usable subscription ID.' }
    return { topicId, status: 'created', subscriptionId }
  }
  if (res.status === 403 || res.status === 401) {
    return { topicId, status: 'refused', detail: `eBay refused this topic for this application. ${describeEbayNotificationError('createSubscription', res.status, res.text)}` }
  }
  return { topicId, status: 'failed', detail: describeEbayNotificationError('createSubscription', res.status, res.text) }
}

export interface EbayNotificationSetupResult {
  configured: boolean
  /** The Owner's arming gate passed (`ebayNotificationSetupGate`). False means no eBay call. */
  armed: boolean
  environment: EbayEnvironment
  endpoint: string | null
  destinationId: string | null
  /** Topic ids eBay actually offers this application. */
  catalogue: string[]
  /** Topics we asked for that eBay's catalogue does not contain — wrong names. */
  notOffered: string[]
  /** Application-level topics, subscribed with the app token. */
  perTopic: SubscribeOutcome[]
  /**
   * The armed per-seller (USER) topics, as eBay's catalogue lists them. Each eBay account is
   * subscribed to them separately, with its own token (`seller-subscriptions.ts`); a topic
   * eBay does not offer is in `notOffered` instead.
   */
  sellerTopics?: EbayTopic[]
  /** eBay's alert-email config: already there, or set by this run. Never the address. */
  alertEmail?: 'present' | 'set'
  error?: string
}

/**
 * Configuration presence is not successful reconciliation. With only per-seller topics armed
 * there is no application-level subscription: success is then the destination being there and
 * every armed per-seller topic being offered by eBay. The sellers' own subscriptions are
 * reported per account beside this (`reconcileEbaySellersForSetup`).
 */
export function ebayNotificationSetupSucceeded(result: EbayNotificationSetupResult): boolean {
  const sellerTopics = result.sellerTopics ?? []
  return result.configured && result.armed && !result.error && !!result.destinationId &&
    (result.perTopic.length > 0 || sellerTopics.length > 0) && !(result.notOffered ?? []).length &&
    result.perTopic.every(topic => ['created', 'enabled', 'already_exists'].includes(topic.status))
}

/**
 * eBay's Notification API config holds the alert email; createDestination and createSubscription
 * answer 195003 without it. Read it, and set it only when eBay has none: an address already
 * there (perhaps set by the Owner) is never overwritten. With no usable
 * EBAY_NOTIFICATION_ALERT_EMAIL this throws before any write.
 */
export async function ensureEbayAlertEmail(environment: EbayEnvironment): Promise<'present' | 'set'> {
  const current = await notificationApi<{ alertEmail?: unknown }>(environment, 'GET', '/commerce/notification/v1/config')
  if (current.status === 200 && typeof current.body?.alertEmail === 'string' && current.body.alertEmail.trim()) return 'present'
  if (![200, 204, 404].includes(current.status)) throw new Error(describeEbayNotificationError('getConfig', current.status, current.text))
  const alertEmail = ebayNotificationAlertEmail()
  if (!alertEmail) {
    throw new Error('eBay has no Notification API alert email, and EBAY_NOTIFICATION_ALERT_EMAIL is unset or not an email address. eBay would refuse the destination with errorId 195003. Set it on the API and the scheduler. No destination or subscription was created.')
  }
  const put = await notificationApi(environment, 'PUT', '/commerce/notification/v1/config', { alertEmail })
  if (put.status !== 204 && put.status !== 200) throw new Error(describeEbayNotificationError('updateConfig', put.status, put.text))
  logger.warn('[ebay-notifications] Notification API alert email set (it was missing)')
  return 'set'
}

/**
 * Create the destination if it is missing, then reconcile every ARMED application topic.
 *
 * Idempotent. It never deletes: an existing subscription on our destination is left
 * alone, and a disabled one is enabled rather than recreated. Unarmed, it makes no call.
 * Armed per-seller topics are only checked against eBay's catalogue here; they are
 * subscribed per account with each seller's own token, never the app token. The destination
 * is created when only a per-seller topic is armed, because a seller subscription needs it.
 */
export async function setupEbayNotifications(options: {
  environment?: EbayEnvironment
  /** @deprecated Handler readiness is mandatory, including when this is false. */
  skipTopicsWithoutHandlers?: boolean
} = {}): Promise<EbayNotificationSetupResult> {
  const environment = options.environment ?? 'production'
  const { endpoint, verificationToken } = ebayNotificationConfig()

  const base: EbayNotificationSetupResult = {
    configured: false, armed: false, environment, endpoint, destinationId: null,
    catalogue: [], notOffered: [], perTopic: [], sellerTopics: [],
  }

  if (!endpoint || !verificationToken) {
    // Not an error. eBay's destination cannot exist without an endpoint it can reach
    // and a token to sign the challenge with, and saying so plainly is better than a
    // stack trace every night.
    return { ...base, error: 'EBAY_NOTIFICATION_ENDPOINT_URL and EBAY_NOTIFICATION_VERIFICATION_TOKEN must both be set.' }
  }

  const tokenError = ebayVerificationTokenError(verificationToken)
  if (tokenError) return { ...base, error: tokenError }
  base.configured = true

  // The gate admits only ready application-level and per-seller topics. Only the application
  // ones are subscribed here; the per-seller ones are subscribed per account.
  const gate = ebayNotificationSetupGate()
  if (!gate.armed) return { ...base, error: new EbayNotificationNotArmedError(gate.reason).message }
  base.armed = true
  const wanted = armedApplicationTopics(gate)
  const wantedPerSeller = armedSellerTopics(gate)

  try {
    const catalogue = await getEbayTopics(environment)
    const offered = new Map(catalogue.map((t) => [t.topicId, t]))

    const destinations = await getEbayDestinations(environment)
    let destination = destinations.find((d) => d.endpoint === endpoint)
    if (destination && destination.status !== 'ENABLED') {
      return { ...base, destinationId: destination.destinationId, error: `The matching eBay destination is ${destination.status ?? 'of unknown status'}; repair it before enabling subscriptions.` }
    }

    const alertEmail = await ensureEbayAlertEmail(environment)

    if (!destination) {
      try {
        const id = await createEbayDestination(environment, 'Nexus inbound notifications', endpoint, verificationToken)
        destination = { destinationId: id, endpoint }
        logger.warn('[ebay-notifications] destination created', { destinationId: id, endpoint })
      } catch (err) {
        // 195021 / 409: eBay already holds a destination for this endpoint that the first read
        // did not show. Reuse it exactly as a destination found by that read is reused: only an
        // exact endpoint match, only ENABLED. Anything else stays a failure; never a guess.
        if (!(err instanceof EbayDestinationExistsError)) throw err
        const existing = (await getEbayDestinations(environment)).find((d) => d.endpoint === endpoint)
        if (!existing) throw err
        if (existing.status !== 'ENABLED') {
          return { ...base, destinationId: existing.destinationId, error: `The matching eBay destination is ${existing.status ?? 'of unknown status'}; repair it before enabling subscriptions.` }
        }
        destination = existing
        logger.warn('[ebay-notifications] destination already existed (195021); reusing it', { destinationId: existing.destinationId, endpoint })
      }
    }

    // Read only when an application topic is armed: per-seller subscriptions are read per seller.
    const existing = wanted.length ? await getEbaySubscriptions(environment) : []

    const perTopic: SubscribeOutcome[] = []
    for (const topicId of wanted) {
      try {
        perTopic.push(await subscribeEbayTopic(environment, topicId, destination.destinationId, offered, existing))
      } catch (err) {
        perTopic.push({ topicId, status: 'failed', detail: err instanceof Error ? err.message : String(err) })
      }
    }
    const sellerTopics = wantedPerSeller.map(topicId => offered.get(topicId)).filter((topic): topic is EbayTopic => !!topic)

    const notOffered = [
      ...perTopic.filter((r) => r.status === 'not_offered').map((r) => r.topicId),
      ...wantedPerSeller.filter(topicId => !offered.has(topicId)),
    ]
    if (notOffered.length) {
      // The loud case on purpose. A topic id we believe in that eBay has never heard of
      // is how `marketplace.order.created` sat in the receiver for weeks looking handled.
      logger.error('[ebay-notifications] topic ids that eBay does not offer — these names are wrong', {
        notOffered, catalogueSize: offered.size,
      })
    }

    return {
      configured: true, armed: true, environment, endpoint,
      destinationId: destination.destinationId,
      catalogue: [...offered.keys()], notOffered, perTopic, sellerTopics, alertEmail,
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface EbayTestNoticeResult {
  ok: boolean
  topicId: string
  subscriptionId?: string
  error?: string
}

/**
 * Ask eBay to send its test notice for our subscription to an armed topic
 * (`POST /subscription/{id}/test`). The notice arrives signed at the receiver like any other,
 * so it proves the whole path. Only a subscription on OUR destination is ever tested.
 */
export async function sendEbayTestNotice(environment: EbayEnvironment, topicId: string): Promise<EbayTestNoticeResult> {
  const gate = ebayNotificationSetupGate()
  if (!gate.armed) return { ok: false, topicId, error: new EbayNotificationNotArmedError(gate.reason).message }
  if (!gate.topics.includes(topicId)) {
    return { ok: false, topicId, error: `eBay notification setup is not armed for this topic (armed: ${gate.topics.join(', ')}). No eBay call was made.` }
  }
  // A per-seller subscription is not visible with the app token; testing it would need that
  // seller's token, which this application-level test does not use.
  if (!armedApplicationTopics(gate).includes(topicId)) {
    return { ok: false, topicId, error: `${topicId} is subscribed per seller; this test covers application-level topics only. No eBay call was made.` }
  }
  const { endpoint } = ebayNotificationConfig()
  if (!endpoint) return { ok: false, topicId, error: 'EBAY_NOTIFICATION_ENDPOINT_URL is not set. No eBay call was made.' }
  try {
    const destination = (await getEbayDestinations(environment)).find(d => d.endpoint === endpoint)
    const subscription = destination
      ? (await getEbaySubscriptions(environment)).find(s => s.topicId === topicId && s.destinationId === destination.destinationId)
      : undefined
    if (!destination || !subscription) {
      return { ok: false, topicId, error: 'eBay has no subscription to this topic on our destination. Run the setup first.' }
    }
    if ((subscription.status ?? '').toUpperCase() !== 'ENABLED') {
      return { ok: false, topicId, subscriptionId: subscription.subscriptionId, error: `The subscription is ${subscription.status ?? 'of unknown status'}. Run the setup to enable it first.` }
    }
    const res = await notificationApi(environment, 'POST', `/commerce/notification/v1/subscription/${encodeURIComponent(subscription.subscriptionId)}/test`)
    if ([200, 202, 204].includes(res.status)) return { ok: true, topicId, subscriptionId: subscription.subscriptionId }
    return { ok: false, topicId, subscriptionId: subscription.subscriptionId, error: describeEbayNotificationError('testSubscription', res.status, res.text) }
  } catch (err) {
    return { ok: false, topicId, error: err instanceof Error ? err.message : String(err) }
  }
}
