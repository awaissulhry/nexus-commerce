/**
 * IS.2 — Ensure SP-API order-notification subscriptions exist.
 *
 * P0.6 (docs/channel-connections/FINAL-PLAN.md) — ORDER_STATUS_CHANGE is no
 * longer subscribed: Amazon retired it on 2026-07-29 (it had been added by
 * RT.5 as ORDER_CHANGE's "replacement"; it was the other way round).
 * ORDER_CHANGE stays. The parser still reads a stray ORDER_STATUS_CHANGE.
 *
 * Called once at server boot (fire-and-forget from index.ts).
 * Idempotent: checks each subscription's current state and skips
 * everything already in place. Railway's 30s response timeout is
 * never a factor.
 *
 * P0.6 — with business profiles ON, a subscription belongs to a seller, and
 * the seller's token is only reachable inside its profile. The boot run
 * therefore visits each active profile that has an Amazon account and runs
 * there (before P0.6 it ran outside any profile and failed with "Select a
 * business profile", so no subscription was kept).
 */

import { logger } from '../utils/logger.js'
import { isSqsConfigured } from './amazon-sqs.service.js'
import { mapAwsRegionToSpApiSlug } from '../clients/amazon-sp-api.client.js'
import { amazonGrantlessFetch } from './gateway/amazon-sdk.js'

const NOTIFICATIONS_SCOPE = 'sellingpartnerapi::notifications'

/**
 * P1.2 — the app's own (grantless) notification calls go through the channel gateway as app-level
 * connection setup: sent in every publish mode, recorded on the call ledger.
 */
function grantlessSend(token: string, slug: string, method: 'GET' | 'POST' | 'DELETE', path: string, operation: string, body?: unknown): Promise<Response> {
  return amazonGrantlessFetch({ token, host: `sellingpartnerapi-${slug}.amazon.com`, method, path, operation, body })
}

async function grantlessGet<T>(token: string, slug: string, path: string): Promise<T> {
  const res = await grantlessSend(token, slug, 'GET', path, 'notifications.getDestinations')
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`), { statusCode: res.status })
  return JSON.parse(text) as T
}

async function grantlessPost<T>(token: string, slug: string, path: string, body: unknown): Promise<T> {
  const res = await grantlessSend(token, slug, 'POST', path, 'notifications.createDestination', body)
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`), { statusCode: res.status })
  return JSON.parse(text) as T
}

// CL.X (post-RT.5) — exported so /api/admin/setup-amazon-notifications
// can reuse the same per-type subscription logic the boot service uses.
// Was previously module-private; admin endpoint only created ORDER_CHANGE
// which meant the 7 new RT.* subscriptions never landed if the boot
// service didn't run on a deploy.
//
// RT.3 — now heals WRONG-DESTINATION subscriptions: an existing sub whose
// destinationId ≠ ours delivers into the void (our SQS queue measured
// permanently empty while the poller ran fine, 2026-07-20). When the
// grantless context is supplied, such a sub is deleted (deleteSubscriptionById
// is a grantless op) and recreated against our destination.
/**
 * The payload version Amazon expects for this type.
 *
 * Falls back to '1.0' for a type with no spec so an unlisted caller behaves as it did
 * before, rather than sending `undefined` and getting an opaque 400.
 */
export function payloadVersionFor(notifType: string): string {
  return NEXUS_SP_API_NOTIFICATION_SPECS.find((spec) => spec.type === notifType)?.payloadVersion ?? '1.0'
}

export async function ensureSubscriptionForType(
  notifType: string,
  destinationId: string,
  grantless?: { token: string; slug: string },
): Promise<void> {
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  // Check existing — return early only if active AND pointed at OUR destination.
  try {
    const existingSub = await amazonSpApiClient.request<any>(
      'GET',
      `/notifications/v1/subscriptions/${notifType}`,
    )
    const subId = existingSub?.payload?.subscriptionId
    const subDest = existingSub?.payload?.destinationId
    if (subId && subDest === destinationId) {
      logger.info(`[amazon-notifications-boot] ${notifType} subscription already active`, {
        subscriptionId: subId,
      })
      return
    }
    if (subId && subDest !== destinationId) {
      if (!grantless) {
        logger.warn(`[amazon-notifications-boot] ${notifType} points at FOREIGN destination — cannot heal without grantless ctx`, {
          subscriptionId: subId, foreignDestinationId: subDest, expectedDestinationId: destinationId,
        })
        return
      }
      logger.warn(`[amazon-notifications-boot] ${notifType} points at FOREIGN destination — deleting + recreating`, {
        subscriptionId: subId, foreignDestinationId: subDest, expectedDestinationId: destinationId,
      })
      const res = await grantlessSend(grantless.token, grantless.slug, 'DELETE', `/notifications/v1/subscriptions/${notifType}/${subId}`, 'notifications.deleteSubscriptionById')
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '')
        throw new Error(`delete foreign ${notifType} sub failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
      }
      // fall through to create against OUR destination
    }
  } catch (err: any) {
    if (!String(err?.message).includes('404') && err?.statusCode !== 404) {
      logger.warn(`[amazon-notifications-boot] ${notifType} check failed — skipping`, {
        error: err?.message ?? String(err),
      })
      return
    }
    // 404 → no sub yet, fall through to create.
  }
  // Type-specific body (RT.3, learned the hard way in BOTH directions):
  //  - newer types (ORDER_STATUS_CHANGE, FBA_*, FEED_*, ACCOUNT_*) REJECT
  //    a processingDirective (first production run created only 2/8).
  //  - ORDER_CHANGE REQUIRES processingDirective.eventFilter — the bare
  //    minimum body got HTTP 400 InvalidInput on the 2026-07-20 recycle.
  const processingDirective =
    notifType === 'ORDER_CHANGE'
      ? {
          processingDirective: {
            eventFilter: {
              eventFilterType: 'ORDER_CHANGE',
              // OrderStatusChange covers order creation + every status
              // transition — the inventory-relevant subset (SP-API
              // ORDER_CHANGE subscription tutorial shape).
              orderChangeTypes: ['OrderStatusChange'],
            },
          },
        }
      : notifType === 'ANY_OFFER_CHANGED'
        ? { processingDirective: { eventFilter: { eventFilterType: 'ANY_OFFER_CHANGED' } } }
        : {}
  const subResp = await amazonSpApiClient.request<any>(
    'POST',
    `/notifications/v1/subscriptions/${notifType}`,
    {
      body: {
        // P2.2 — from the type's own spec, not a constant. '1.0' stood here for every
        // type; LISTINGS_ITEM_ISSUES_CHANGE needs '2023-12-13' and Amazon withdrew its
        // 1.0 on 2024-09-25, so the constant would have been refused outright.
        payloadVersion: payloadVersionFor(notifType),
        destinationId,
        ...processingDirective,
      },
    },
  ).catch((err: any) => {
    // Surface the SP-API error body in the log so future debugging
    // doesn't require Railway log archaeology.
    logger.warn(`[amazon-notifications] ${notifType} POST failed`, {
      error: err?.message ?? String(err),
      statusCode: err?.statusCode,
    })
    throw err
  })
  const subscriptionId = subResp?.payload?.subscriptionId ?? subResp?.subscriptionId
  logger.info(`[amazon-notifications-boot] ${notifType} subscription created`, {
    subscriptionId,
    destinationId,
  })
}

/**
 * Canonical list of SP-API notification types Nexus subscribes to.
 * Single source of truth used by both the boot service and the
 * /api/admin/setup-amazon-notifications admin endpoint.
 *
 * Add a new RT.* notification type here and both code paths pick it up.
 */
export type NotificationDestinationKind = 'SQS' | 'EVENTBRIDGE'

/**
 * How well we actually know a type's shape, kept beside the claim.
 *
 * `live`     — Nexus is subscribed to it in production today and messages arrive.
 * `docs`     — Amazon's documentation states it; nothing of ours has exercised it.
 * `observed` — Amazon's API told us, by accepting or rejecting a real subscribe.
 * `unknown`  — neither. The subscribe attempt IS the measurement, and its result is
 *              recorded per type rather than guessed at here.
 */
export type NotificationEvidence = 'live' | 'docs' | 'observed' | 'unknown'

export interface AmazonNotificationSpec {
  type: string
  /**
   * P2.2 — NOT always '1.0'. One hardcoded version stood here for every type, and
   * Amazon rejects a version it does not recognise for a given notification.
   */
  payloadVersion: string
  /** Where Amazon will deliver this type. An SQS destination cannot serve the rest. */
  destinations: NotificationDestinationKind[]
  evidence: NotificationEvidence
  why: string
}

/**
 * Every SP-API notification type P2.2 names, with the two facts a subscribe needs.
 *
 * A flat list of type names could not carry either fact, so both were assumed: the
 * payload version was hardcoded to '1.0' for all of them, and a type that only exists
 * on EventBridge was simply deleted from the list with the reason in a comment.
 */
export const NEXUS_SP_API_NOTIFICATION_SPECS: AmazonNotificationSpec[] = [
  // ── Live on the SQS destination today ────────────────────────────────────────
  // ORDER_STATUS_CHANGE is absent (P0.6): Amazon retired it on 2026-07-29.
  { type: 'ORDER_CHANGE', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'live', why: '1,413 messages received and stored' },
  { type: 'FBA_OUTBOUND_SHIPMENT_STATUS', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'live', why: 'RT.6 — MCF shipment transitions' },
  { type: 'FBA_INVENTORY_AVAILABILITY_CHANGES', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'live', why: 'RT.9' },
  { type: 'ANY_OFFER_CHANGED', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'live', why: 'RT.13 — 2,823 messages received and stored' },
  { type: 'FEED_PROCESSING_FINISHED', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'live', why: 'RT.15' },
  { type: 'ACCOUNT_STATUS_CHANGED', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'live', why: 'RT.16 — account-health alerts' },

  // ── EventBridge only. Declared rather than deleted, so the reason is data an
  //    operator can read, not a comment someone has to find. ───────────────────
  {
    type: 'LISTINGS_ITEM_STATUS_CHANGE', payloadVersion: '1.0', destinations: ['EVENTBRIDGE'], evidence: 'observed',
    why: 'Subscribing it to the SQS destination returned 400 InvalidInput (2026-07-20 boot self-report). The SQS poller already parses it, so only a destination is missing.',
  },
  {
    type: 'BRANDED_ITEM_CONTENT_CHANGE', payloadVersion: '1.0', destinations: ['EVENTBRIDGE'], evidence: 'docs',
    why: "SP-API notification-type-values states the Amazon EventBridge workflow for this type.",
  },

  // ── New on SQS, with a version that is NOT 1.0 ──────────────────────────────
  {
    type: 'LISTINGS_ITEM_ISSUES_CHANGE', payloadVersion: '2023-12-13', destinations: ['SQS'], evidence: 'docs',
    why: 'Delivered on both EventBridge and SQS. Payload version 1.0 was withdrawn on 2024-09-25, so the hardcoded 1.0 would have been rejected outright.',
  },

  // ── Named by P2.2, destination and version NOT established ──────────────────
  // Deliberately not guessed. Amazon's own answer to a subscribe is the measurement,
  // and `setupAllAmazonNotifications` records it per type. A 400 InvalidInput here is
  // a finding — "not available on an SQS destination" — not a failure to hide.
  { type: 'LISTINGS_ITEM_MFN_QUANTITY_CHANGE', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'unknown', why: 'Named by P2.2; destination support and payload version unverified.' },
  { type: 'REPORT_PROCESSING_FINISHED', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'unknown', why: 'Named by P2.2; destination support and payload version unverified.' },
  { type: 'PRICING_HEALTH', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'unknown', why: 'Named by P2.2; destination support and payload version unverified.' },
  { type: 'ITEM_PRODUCT_TYPE_CHANGE', payloadVersion: '1.0', destinations: ['SQS'], evidence: 'unknown', why: 'Named by P2.2; destination support and payload version unverified.' },
]

/**
 * Whether a type whose support is only assumed may be attempted against the live
 * Amazon API. **Default off.** Creating a subscription is a production write and a
 * live channel call, and the Owner's standing rule is that both are asked for first.
 *
 * With this off, boot and the admin endpoint subscribe exactly the six types that are
 * live today — the behaviour before P2.2 — while the rest sit in the table above,
 * visible and ready.
 */
export function newTypeSubscriptionsEnabled(): boolean {
  return process.env.NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES === 'true'
}

/** The specs this destination can actually carry, honouring the gate above. */
export function sqsNotificationSpecs(): AmazonNotificationSpec[] {
  return NEXUS_SP_API_NOTIFICATION_SPECS.filter(
    (spec) =>
      spec.destinations.includes('SQS') && (spec.evidence === 'live' || newTypeSubscriptionsEnabled()),
  )
}

/**
 * The type names to subscribe on the SQS destination.
 *
 * Kept as a string array because the admin route and the boot path both read it that
 * way, but it is now DERIVED: a type that only exists on EventBridge can no longer be
 * subscribed here by someone adding a name to a list.
 */
export const NEXUS_SP_API_NOTIFICATION_TYPES: readonly string[] = NEXUS_SP_API_NOTIFICATION_SPECS
  .filter((spec) => spec.destinations.includes('SQS') && spec.evidence === 'live')
  .map((spec) => spec.type)

/**
 * Idempotent: ensures the destination + all 8 subscriptions exist.
 * Returns per-type result so the admin endpoint can surface partial
 * success (e.g. ORDER_CHANGE was already there but ANY_OFFER_CHANGED
 * failed because the seller's SP-API role lacks pricing scope).
 */
export async function setupAllAmazonNotifications(): Promise<{
  destinationId: string | null
  perType: Array<{
    type: string
    status: 'created' | 'already_exists' | 'healed' | 'failed'
    subscriptionId?: string
    destinationId?: string
    error?: string
  }>
}> {
  if (!isSqsConfigured()) {
    return { destinationId: null, perType: [] }
  }

  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL!
  const parts = queueUrl.replace('https://', '').split('/')
  const [regionHost, accountId, queueName] = [parts[0], parts[1], parts[2]]
  const sqsRegion = regionHost?.replace('sqs.', '').replace('.amazonaws.com', '') ?? 'us-east-1'
  const sqsArn = `arn:aws:sqs:${sqsRegion}:${accountId}:${queueName}`
  // RT.3 — default MUST match the SP-API client's ('eu' for this IT seller;
  // the old `?? 'na'` divergence pointed grantless destination calls at the
  // NA endpoint whenever AMAZON_REGION was unset).
  const slug = mapAwsRegionToSpApiSlug(await (await import('../lib/amazon-sp-client.js')).getAmazonRegion())

  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')

  // 1. Get or create destination — shared by every subscription.
  const grantlessToken = await amazonSpApiClient.getGrantlessToken(NOTIFICATIONS_SCOPE)
  const destList = await grantlessGet<any>(grantlessToken, slug, '/notifications/v1/destinations')
  const destinations: any[] = destList.payload ?? []
  let existingDest = destinations.find((d: any) => d.resource?.sqs?.arn === sqsArn)

  if (!existingDest) {
    logger.info('[amazon-notifications] creating destination', { sqsArn })
    const destResp = await grantlessPost<any>(grantlessToken, slug, '/notifications/v1/destinations', {
      name: queueName,
      resourceSpecification: { sqs: { arn: sqsArn } },
    })
    existingDest = { destinationId: destResp.payload?.destinationId ?? destResp.destinationId }
    logger.info('[amazon-notifications] destination created', { destinationId: existingDest.destinationId })
  } else {
    logger.info('[amazon-notifications] reusing existing destination', { destinationId: existingDest.destinationId })
  }

  // 2. Iterate every type. Per-type failures don't abort the loop —
  // they're surfaced in the result so the operator sees which subs
  // need scope adjustments.
  // RT.3 — one-shot FULL RECYCLE, driven by a DB directive (no env change
  // needed): a CronRun row jobName='amazon-notifications-recycle-request'
  // with status RUNNING requests it. Rationale: the 2026-07-20 incident —
  // destination + subscriptions + queue policy all verified correct, yet
  // ZERO messages ever delivered for ANY type; the destination registration
  // itself was defunct. Deleting it requires deleting subscriptions first
  // ("Destination has subscriptions", HTTP 403), and only prod holds the
  // seller token, so the recycle must run here. Order: delete subs
  // (grantless deleteSubscriptionById) → delete destination → recreate
  // destination → the normal loop below recreates every subscription.
  const { default: prisma } = await import('../db.js')
  const recycleReq = await prisma.cronRun.findFirst({
    where: { jobName: 'amazon-notifications-recycle-request', status: 'RUNNING' },
    orderBy: { startedAt: 'desc' },
  })
  if (recycleReq) {
    logger.warn('[amazon-notifications] RECYCLE requested — rebuilding destination + subscriptions', {
      requestId: recycleReq.id,
    })
    const steps: string[] = []
    try {
      for (const t of sqsNotificationSpecs().map((spec) => spec.type)) {
        try {
          const existing = await amazonSpApiClient.request<any>('GET', `/notifications/v1/subscriptions/${t}`)
          const subId = existing?.payload?.subscriptionId
          if (subId) {
            const res = await grantlessSend(grantlessToken, slug, 'DELETE', `/notifications/v1/subscriptions/${t}/${subId}`, 'notifications.deleteSubscriptionById')
            steps.push(`delSub:${t}=${res.status}`)
          }
        } catch { steps.push(`delSub:${t}=absent`) }
      }
      if (existingDest?.destinationId) {
        const res = await grantlessSend(grantlessToken, slug, 'DELETE', `/notifications/v1/destinations/${existingDest.destinationId}`, 'notifications.deleteDestination')
        steps.push(`delDest=${res.status}`)
      }
      const destResp = await grantlessPost<any>(grantlessToken, slug, '/notifications/v1/destinations', {
        name: queueName,
        resourceSpecification: { sqs: { arn: sqsArn } },
      })
      existingDest = { destinationId: destResp.payload?.destinationId ?? destResp.destinationId }
      steps.push(`newDest=${existingDest.destinationId}`)
      await prisma.cronRun.update({
        where: { id: recycleReq.id },
        data: { status: 'SUCCESS', finishedAt: new Date(), outputSummary: steps.join(' ') },
      }).catch(() => {})
      logger.warn('[amazon-notifications] RECYCLE complete', { steps: steps.join(' ') })
    } catch (err: any) {
      steps.push(`ERROR=${err?.message ?? String(err)}`)
      await prisma.cronRun.update({
        where: { id: recycleReq.id },
        data: { status: 'FAILED', finishedAt: new Date(), outputSummary: steps.join(' ').slice(0, 900), errorMessage: (err?.message ?? String(err)).slice(0, 500) },
      }).catch(() => {})
      logger.error('[amazon-notifications] RECYCLE failed', { error: err?.message ?? String(err) })
    }
  }

  const perType: Array<{
    type: string
    status: 'created' | 'already_exists' | 'healed' | 'failed'
    subscriptionId?: string
    destinationId?: string
    error?: string
  }> = []
  // P2.2 — the specs this destination can carry, which is the six live types unless
  // NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES is on. A type that only exists on EventBridge is
  // never attempted here: a guaranteed 400 teaches nobody anything and buries the real
  // failures in the report.
  for (const t of sqsNotificationSpecs().map((spec) => spec.type)) {
    try {
      // Probe first so we can distinguish created / already-exists / healed.
      let alreadyActive = false
      let foreignDestination = false
      let probedSubId: string | undefined
      let probedDestId: string | undefined
      try {
        const existing = await amazonSpApiClient.request<any>(
          'GET',
          `/notifications/v1/subscriptions/${t}`,
        )
        probedSubId = existing?.payload?.subscriptionId
        probedDestId = existing?.payload?.destinationId
        if (probedSubId && probedDestId === existingDest.destinationId) alreadyActive = true
        else if (probedSubId) foreignDestination = true
      } catch {
        /* 404 expected when missing; fall through to create */
      }
      if (alreadyActive) {
        perType.push({ type: t, status: 'already_exists', subscriptionId: probedSubId, destinationId: probedDestId })
        continue
      }
      await ensureSubscriptionForType(t, existingDest.destinationId, {
        token: grantlessToken,
        slug,
      })
      perType.push({
        type: t,
        status: foreignDestination ? 'healed' : 'created',
        destinationId: existingDest.destinationId,
      })
    } catch (err: any) {
      perType.push({
        type: t,
        status: 'failed',
        error: err?.message ?? String(err),
      })
      logger.warn(`[amazon-notifications] ${t} subscription failed`, {
        error: err?.message ?? String(err),
      })
    }
  }

  return { destinationId: existingDest.destinationId, perType }
}

export function ensureAmazonNotificationSubscription(): void {
  if (!isSqsConfigured()) return
  if (!process.env.NEXUS_ENABLE_AMAZON_SQS_POLL || process.env.NEXUS_ENABLE_AMAZON_SQS_POLL !== '1') return

  void runAmazonNotificationSetup().catch((err: any) => {
    logger.error('[amazon-notifications-boot] setup failed (non-fatal)', { error: err?.message ?? String(err) })
  })
}

/**
 * One setup run per place a seller token lives: the whole app with profiles OFF, else each active
 * profile that has an active Amazon account. A failure in one profile is recorded (CronRun) and
 * does not stop the others. Returns the profiles visited, for tests and the log.
 */
export async function runAmazonNotificationSetup(): Promise<{ visited: number; ran: number }> {
  // RT.3 — record the per-type result to CronRun so subscription state
  // is DB-readable (Railway logs required archaeology before; the local
  // seller refresh-token being stale makes local probing impossible).
  const { recordCronRun } = await import('../utils/cron-observability.js')
  const setupHere = () => recordCronRun('amazon-notifications-setup', async () => {
    const result = await setupAllAmazonNotifications()
    const parts = result.perType.map((p) =>
      `${p.type}=${p.status}${p.subscriptionId ? `(sub=${p.subscriptionId.slice(0, 8)},dest=${p.destinationId?.slice(0, 8)})` : ''}${p.error ? `(${p.error.slice(0, 80)})` : ''}`,
    )
    return `dest=${result.destinationId ?? 'NONE'} ${parts.join(' ')}`
  })
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') {
    await setupHere()
    return { visited: 1, ran: 1 }
  }
  const { visitActiveWorkspaces } = await import('../lib/workspace-sweep.js')
  const { listActiveConnections } = await import('./connection-resolver.service.js')
  let visited = 0
  let ran = 0
  await visitActiveWorkspaces(async () => {
    visited++
    try {
      if ((await listActiveConnections('AMAZON')).length === 0) return
      ran++
      await setupHere()
    } catch (err: any) {
      logger.error('[amazon-notifications-boot] setup failed in a business profile (non-fatal)', { error: err?.message ?? String(err) })
    }
  })
  logger.info('[amazon-notifications-boot] setup visited business profiles', { visited, ran })
  return { visited, ran }
}
