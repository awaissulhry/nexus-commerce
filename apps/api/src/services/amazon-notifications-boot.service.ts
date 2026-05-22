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

async function ensureSubscriptionForType(
  notifType: 'ORDER_CHANGE' | 'ORDER_STATUS_CHANGE',
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

export function ensureAmazonNotificationSubscription(): void {
  if (!isSqsConfigured()) return
  if (!process.env.NEXUS_ENABLE_AMAZON_SQS_POLL || process.env.NEXUS_ENABLE_AMAZON_SQS_POLL !== '1') return

  void (async () => {
    try {
      const queueUrl = process.env.AMAZON_SQS_QUEUE_URL!
      const parts = queueUrl.replace('https://', '').split('/')
      const [regionHost, accountId, queueName] = [parts[0], parts[1], parts[2]]
      const sqsRegion = regionHost?.replace('sqs.', '').replace('.amazonaws.com', '') ?? 'us-east-1'
      const sqsArn = `arn:aws:sqs:${sqsRegion}:${accountId}:${queueName}`
      const slug = mapAwsRegionToSpApiSlug(process.env.AMAZON_REGION ?? 'na')

      const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')

      // 1. Get or create destination — shared by both subscriptions.
      const grantlessToken = await amazonSpApiClient.getGrantlessToken(NOTIFICATIONS_SCOPE)
      const destList = await grantlessGet<any>(grantlessToken, slug, '/notifications/v1/destinations')
      const destinations: any[] = destList.payload ?? []
      let existingDest = destinations.find((d: any) => d.resource?.sqs?.arn === sqsArn)

      if (!existingDest) {
        logger.info('[amazon-notifications-boot] creating destination', { sqsArn })
        const destResp = await grantlessPost<any>(grantlessToken, slug, '/notifications/v1/destinations', {
          name: queueName,
          resourceSpecification: { sqs: { arn: sqsArn } },
        })
        existingDest = { destinationId: destResp.payload?.destinationId ?? destResp.destinationId }
        logger.info('[amazon-notifications-boot] destination created', { destinationId: existingDest.destinationId })
      } else {
        logger.info('[amazon-notifications-boot] reusing existing destination', { destinationId: existingDest.destinationId })
      }

      // 2. RT.5 — subscribe to BOTH ORDER_CHANGE + ORDER_STATUS_CHANGE.
      // Parallel-run window collects 7 days of side-by-side coverage
      // before the verifier confirms equivalence and a follow-up phase
      // removes the legacy ORDER_CHANGE subscription.
      await ensureSubscriptionForType('ORDER_CHANGE', existingDest.destinationId)
      await ensureSubscriptionForType('ORDER_STATUS_CHANGE', existingDest.destinationId)
    } catch (err: any) {
      logger.error('[amazon-notifications-boot] setup failed (non-fatal)', {
        error: err?.message ?? String(err),
      })
    }
  })()
}
