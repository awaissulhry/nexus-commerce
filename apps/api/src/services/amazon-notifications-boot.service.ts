/**
 * IS.2 — Ensure the SP-API ORDER_CHANGE notification subscription exists.
 *
 * Called once at server boot (fire-and-forget from index.ts). Idempotent:
 * checks the current state first and skips every step that's already done.
 * This replaces the HTTP admin endpoint as the primary setup mechanism so
 * Railway's 30s response timeout is never a factor.
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

      // 1. Check existing subscription — if active, nothing to do.
      try {
        const existingSub = await amazonSpApiClient.request<any>('GET', '/notifications/v1/subscriptions/ORDER_CHANGE')
        if (existingSub?.payload?.subscriptionId) {
          logger.info('[amazon-notifications-boot] ORDER_CHANGE subscription already active', {
            subscriptionId: existingSub.payload.subscriptionId,
          })
          return
        }
      } catch (err: any) {
        // 404 means no subscription yet — continue. Any other error: abort.
        if (!String(err?.message).includes('404') && err?.statusCode !== 404) {
          logger.warn('[amazon-notifications-boot] subscription check failed — skipping setup', {
            error: err?.message ?? String(err),
          })
          return
        }
      }

      // 2. Get or create destination.
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

      // 3. Create subscription.
      const subResp = await amazonSpApiClient.request<any>('POST', '/notifications/v1/subscriptions/ORDER_CHANGE', {
        body: {
          payloadVersion: '1.0',
          destinationId: existingDest.destinationId,
          processingDirective: {
            eventFilter: { eventFilterType: 'ORDER_CHANGE' },
          },
        },
      })
      const subscriptionId = subResp?.payload?.subscriptionId ?? subResp?.subscriptionId
      logger.info('[amazon-notifications-boot] ORDER_CHANGE subscription created', {
        subscriptionId,
        destinationId: existingDest.destinationId,
        sqsArn,
      })
    } catch (err: any) {
      logger.error('[amazon-notifications-boot] setup failed (non-fatal)', {
        error: err?.message ?? String(err),
      })
    }
  })()
}
