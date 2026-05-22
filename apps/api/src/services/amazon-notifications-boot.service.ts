/**
 * IS.2 — Ensure SP-API order-notification subscriptions exist.
 *
 * RT.5 — now ensures BOTH ORDER_CHANGE (legacy) and ORDER_STATUS_CHANGE
 * (Amazon's replacement) are subscribed in parallel so we collect 7
 * days of side-by-side coverage. After that window the verifier
 * scripts/verify-rt5-order-status-coverage.mjs confirms equivalence
 * and a follow-up phase removes ORDER_CHANGE. Both feed into the
 * same SQS destination — amazon-sqs.service accepts either type.
 *
 * Called once at server boot (fire-and-forget from index.ts).
 * Idempotent: checks each subscription's current state and skips
 * everything already in place. Railway's 30s response timeout is
 * never a factor.
 */

import { logger } from '../utils/logger.js'
import { isSqsConfigured } from './amazon-sqs.service.js'
import { mapAwsRegionToSpApiSlug } from '../clients/amazon-sp-api.client.js'

const NOTIFICATIONS_SCOPE = 'sellingpartnerapi::notifications'

async function grantlessGet<T>(token: string, slug: string, path: string): Promise<T> {
  const res = await fetch(`https://sellingpartnerapi-${slug}.amazon.com${path}`, {
    headers: { 'x-amz-access-token': token },
  })
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`), { statusCode: res.status })
  return JSON.parse(text) as T
}

async function grantlessPost<T>(token: string, slug: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://sellingpartnerapi-${slug}.amazon.com${path}`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`), { statusCode: res.status })
  return JSON.parse(text) as T
}

// CL.X (post-RT.5) — exported so /api/admin/setup-amazon-notifications
// can reuse the same per-type subscription logic the boot service uses.
// Was previously module-private; admin endpoint only created ORDER_CHANGE
// which meant the 7 new RT.* subscriptions never landed if the boot
// service didn't run on a deploy.
export async function ensureSubscriptionForType(
  notifType: string,
  destinationId: string,
): Promise<void> {
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  // Check existing — return early if active.
  try {
    const existingSub = await amazonSpApiClient.request<any>(
      'GET',
      `/notifications/v1/subscriptions/${notifType}`,
    )
    if (existingSub?.payload?.subscriptionId) {
      logger.info(`[amazon-notifications-boot] ${notifType} subscription already active`, {
        subscriptionId: existingSub.payload.subscriptionId,
      })
      return
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
  const subResp = await amazonSpApiClient.request<any>(
    'POST',
    `/notifications/v1/subscriptions/${notifType}`,
    {
      body: {
        payloadVersion: '1.0',
        destinationId,
        processingDirective: { eventFilter: { eventFilterType: notifType } },
      },
    },
  )
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
export const NEXUS_SP_API_NOTIFICATION_TYPES = [
  'ORDER_CHANGE',                       // RT.5 legacy
  'ORDER_STATUS_CHANGE',                // RT.5 replacement
  'FBA_OUTBOUND_SHIPMENT_STATUS',       // RT.6 (MCF)
  'FBA_INVENTORY_AVAILABILITY_CHANGES', // RT.9
  'ANY_OFFER_CHANGED',                  // RT.13
  'LISTINGS_ITEM_STATUS_CHANGE',        // RT.14
  'FEED_PROCESSING_FINISHED',           // RT.15
  'ACCOUNT_STATUS_CHANGED',             // RT.16
] as const

/**
 * Idempotent: ensures the destination + all 8 subscriptions exist.
 * Returns per-type result so the admin endpoint can surface partial
 * success (e.g. ORDER_CHANGE was already there but ANY_OFFER_CHANGED
 * failed because the seller's SP-API role lacks pricing scope).
 */
export async function setupAllAmazonNotifications(): Promise<{
  destinationId: string | null
  perType: Array<{ type: string; status: 'created' | 'already_exists' | 'failed'; error?: string }>
}> {
  if (!isSqsConfigured()) {
    return { destinationId: null, perType: [] }
  }

  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL!
  const parts = queueUrl.replace('https://', '').split('/')
  const [regionHost, accountId, queueName] = [parts[0], parts[1], parts[2]]
  const sqsRegion = regionHost?.replace('sqs.', '').replace('.amazonaws.com', '') ?? 'us-east-1'
  const sqsArn = `arn:aws:sqs:${sqsRegion}:${accountId}:${queueName}`
  const slug = mapAwsRegionToSpApiSlug(process.env.AMAZON_REGION ?? 'na')

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
  const perType: Array<{ type: string; status: 'created' | 'already_exists' | 'failed'; error?: string }> = []
  for (const t of NEXUS_SP_API_NOTIFICATION_TYPES) {
    try {
      // Probe first so we can distinguish created vs already-exists in the result.
      let alreadyActive = false
      try {
        const existing = await amazonSpApiClient.request<any>(
          'GET',
          `/notifications/v1/subscriptions/${t}`,
        )
        if (existing?.payload?.subscriptionId) alreadyActive = true
      } catch {
        /* 404 expected when missing; fall through to create */
      }
      if (alreadyActive) {
        perType.push({ type: t, status: 'already_exists' })
        continue
      }
      await ensureSubscriptionForType(t, existingDest.destinationId)
      perType.push({ type: t, status: 'created' })
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

  void (async () => {
    try {
      await setupAllAmazonNotifications()
    } catch (err: any) {
      logger.error('[amazon-notifications-boot] setup failed (non-fatal)', {
        error: err?.message ?? String(err),
      })
    }
  })()
}
