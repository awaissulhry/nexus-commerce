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

export interface EbayTopicWish {
  /** eBay's topic ID, as WE believe it to be. `getTopics` is what settles it. */
  topicId: string
  /** What Nexus would do with it. */
  purpose: string
  evidence: TopicEvidence
  /** Set when Nexus cannot yet act on the topic, so a subscription would only fill the ledger. */
  handlerMissing?: boolean
}

/**
 * The topics P2.3 names, as topic IDs.
 *
 * Two are certain because eBay's own programme documentation requires them of every
 * application, and this repository already answers both. The rest are marked
 * `unverified` on purpose: the plan names them by PURPOSE (orders, shipping, returns,
 * listing) and eBay's topic catalogue is the only place their real IDs live. The setup
 * below reconciles this list against that catalogue and reports the difference, which
 * is how the invented names get found rather than assumed away again.
 */
export const EBAY_DESIRED_TOPICS: EbayTopicWish[] = [
  {
    topicId: 'MARKETPLACE_ACCOUNT_DELETION',
    purpose: "eBay's erasure notice. Answering it is a condition of holding production keys.",
    evidence: 'verified',
  },
  {
    topicId: 'AUTHORIZATION_REVOCATION',
    purpose: 'A seller withdrew our access — the account must be marked revoked and writes paused (P2.6).',
    evidence: 'documented',
  },
  // eBay release 1.6.6 (2025-12-01): developer.ebay.com/develop/api/notification/release-notes
  { topicId: 'ORDER_CONFIRMATION', purpose: 'A buyer completed checkout — pull the order.', evidence: 'documented', handlerMissing: true },
  { topicId: 'ITEM_PRICE_REVISION', purpose: 'Price changed on eBay — refresh the listing.', evidence: 'documented', handlerMissing: true },
  { topicId: 'ITEM_AVAILABILITY', purpose: 'Quantity changed on eBay — refresh stock.', evidence: 'documented', handlerMissing: true },
]

export interface EbayTopic {
  topicId: string
  status?: string
  supportedPayloads?: Array<{ format?: string; schemaVersion?: string; deprecated?: boolean }>
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
}

async function notificationApi<T>(
  environment: EbayEnvironment,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T | null; text: string }> {
  const { ebayAppToken } = await import('./client.js')
  const { ebayTransport } = await import('../../../gateway/ebay.js')
  const token = await ebayAppToken(environment)
  // Through the gateway as an app-level call, like the public-key lookup beside it, so
  // the channel-gateway ratchet stays at zero.
  const res = await ebayTransport(null, { appLevel: true })(`${EBAY_API_BASE[environment]}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: T | null = null
  try { parsed = text ? (JSON.parse(text) as T) : null } catch { parsed = null }
  return { status: res.status, body: parsed, text }
}

/**
 * eBay's own catalogue of topics. This is the authority.
 *
 * Paged: eBay returns `next` as a path. Followed to the end, because a partial
 * catalogue would make a real topic look invented — the exact mistake this call exists
 * to prevent.
 */
export async function getEbayTopics(environment: EbayEnvironment = 'production'): Promise<EbayTopic[]> {
  const topics: EbayTopic[] = []
  let path: string | null = '/commerce/notification/v1/topic?limit=100'
  let guard = 0
  while (path && guard++ < 20) {
    const res = await notificationApi<{ topics?: EbayTopic[]; next?: string }>(environment, 'GET', path)
    if (res.status !== 200) {
      throw new Error(`eBay getTopics returned ${res.status}: ${res.text.slice(0, 300)}`)
    }
    topics.push(...(res.body?.topics ?? []))
    path = res.body?.next ?? null
  }
  return topics
}

export async function getEbayDestinations(environment: EbayEnvironment = 'production'): Promise<EbayDestination[]> {
  const res = await notificationApi<{ destinations?: EbayDestination[] }>(
    environment, 'GET', '/commerce/notification/v1/destination?limit=100',
  )
  if (res.status !== 200) throw new Error(`eBay getDestinations returned ${res.status}: ${res.text.slice(0, 300)}`)
  return res.body?.destinations ?? []
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
    throw new Error(`eBay createDestination returned ${res.status}: ${res.text.slice(0, 300)}`)
  }
  const id = res.body?.destinationId
  if (!id) throw new Error(`eBay createDestination gave no destinationId: ${res.text.slice(0, 300)}`)
  return id
}

export async function getEbaySubscriptions(environment: EbayEnvironment = 'production'): Promise<EbaySubscription[]> {
  const res = await notificationApi<{ subscriptions?: EbaySubscription[] }>(
    environment, 'GET', '/commerce/notification/v1/subscription?limit=100',
  )
  if (res.status !== 200) throw new Error(`eBay getSubscriptions returned ${res.status}: ${res.text.slice(0, 300)}`)
  return res.body?.subscriptions ?? []
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
  // returns each topic's supported payloads from `getTopics`; the newest non-deprecated
  // one is what a new subscription should ask for.
  const payloads = (topic.supportedPayloads ?? []).filter((p) => !p.deprecated && p.schemaVersion)
  const schemaVersion = payloads[payloads.length - 1]?.schemaVersion
  const format = payloads[payloads.length - 1]?.format ?? 'JSON'
  if (!schemaVersion) {
    return { topicId, status: 'failed', detail: 'eBay lists this topic with no usable payload version.' }
  }
  const already = existing.find((s) => s.topicId === topicId && s.destinationId === destinationId)
  if (already) {
    if ((already.status ?? '').toUpperCase() === 'ENABLED') {
      return { topicId, status: 'already_exists', subscriptionId: already.subscriptionId }
    }
    const enable = await notificationApi(environment, 'PUT', `/commerce/notification/v1/subscription/${already.subscriptionId}/enable`)
    return enable.status === 204 || enable.status === 200
      ? { topicId, status: 'enabled', subscriptionId: already.subscriptionId }
      : { topicId, status: 'failed', subscriptionId: already.subscriptionId, detail: `enable returned ${enable.status}: ${enable.text.slice(0, 200)}` }
  }
  const res = await notificationApi<{ subscriptionId?: string }>(
    environment, 'POST', '/commerce/notification/v1/subscription',
    { topicId, destinationId, status: 'ENABLED', payload: { format, schemaVersion, deliveryConfig: { includeResourceData: true } } },
  )
  if (res.status === 201 || res.status === 200) {
    return { topicId, status: 'created', subscriptionId: res.body?.subscriptionId }
  }
  if (res.status === 403 || res.status === 401) {
    return { topicId, status: 'refused', detail: `eBay refused this topic for this application (${res.status}): ${res.text.slice(0, 200)}` }
  }
  return { topicId, status: 'failed', detail: `${res.status}: ${res.text.slice(0, 200)}` }
}

export interface EbayNotificationSetupResult {
  configured: boolean
  environment: EbayEnvironment
  endpoint: string | null
  destinationId: string | null
  /** Topic ids eBay actually offers this application. */
  catalogue: string[]
  /** Topics we asked for that eBay's catalogue does not contain — wrong names. */
  notOffered: string[]
  perTopic: SubscribeOutcome[]
  error?: string
}

/**
 * Create the destination if it is missing, then reconcile every desired topic.
 *
 * Idempotent. It never deletes: an existing subscription on our destination is left
 * alone, and a disabled one is enabled rather than recreated.
 */
export async function setupEbayNotifications(options: {
  environment?: EbayEnvironment
  /** Only subscribe topics Nexus can actually act on. */
  skipTopicsWithoutHandlers?: boolean
} = {}): Promise<EbayNotificationSetupResult> {
  const environment = options.environment ?? 'production'
  const { endpoint, verificationToken } = ebayNotificationConfig()

  const base: EbayNotificationSetupResult = {
    configured: false, environment, endpoint, destinationId: null,
    catalogue: [], notOffered: [], perTopic: [],
  }

  if (!endpoint || !verificationToken) {
    // Not an error. eBay's destination cannot exist without an endpoint it can reach
    // and a token to sign the challenge with, and saying so plainly is better than a
    // stack trace every night.
    return { ...base, error: 'EBAY_NOTIFICATION_ENDPOINT_URL and EBAY_NOTIFICATION_VERIFICATION_TOKEN must both be set.' }
  }

  const tokenError = ebayVerificationTokenError(verificationToken)
  if (tokenError) return { ...base, error: tokenError }

  try {
    const catalogue = await getEbayTopics(environment)
    const offered = new Map(catalogue.map((t) => [t.topicId, t]))

    const destinations = await getEbayDestinations(environment)
    let destination = destinations.find((d) => d.endpoint === endpoint)
    if (!destination) {
      const id = await createEbayDestination(environment, 'Nexus inbound notifications', endpoint, verificationToken)
      destination = { destinationId: id, endpoint }
      logger.warn('[ebay-notifications] destination created', { destinationId: id, endpoint })
    }

    const existing = await getEbaySubscriptions(environment)
    const wanted = EBAY_DESIRED_TOPICS.filter((t) => !(options.skipTopicsWithoutHandlers && t.handlerMissing))

    const perTopic: SubscribeOutcome[] = []
    for (const wish of wanted) {
      try {
        perTopic.push(await subscribeEbayTopic(environment, wish.topicId, destination.destinationId, offered, existing))
      } catch (err) {
        perTopic.push({ topicId: wish.topicId, status: 'failed', detail: err instanceof Error ? err.message : String(err) })
      }
    }

    const notOffered = perTopic.filter((r) => r.status === 'not_offered').map((r) => r.topicId)
    if (notOffered.length) {
      // The loud case on purpose. A topic id we believe in that eBay has never heard of
      // is how `marketplace.order.created` sat in the receiver for weeks looking handled.
      logger.error('[ebay-notifications] topic ids that eBay does not offer — these names are wrong', {
        notOffered, catalogueSize: offered.size,
      })
    }

    return {
      configured: true, environment, endpoint,
      destinationId: destination.destinationId,
      catalogue: [...offered.keys()], notOffered, perTopic,
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}
