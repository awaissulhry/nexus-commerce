/**
 * IS.2 — Amazon SP-API Notification subscription management.
 *
 * POST /api/admin/setup-amazon-notifications
 *   One-time (idempotent) call that registers the SQS queue URL as an SP-API
 *   notification destination and subscribes to ORDER_CHANGE events.
 *   Run this once after setting AMAZON_SQS_QUEUE_URL and the SQS queue is
 *   configured with the right IAM permissions for SP-API to publish.
 *
 * GET /api/admin/amazon-notification-status
 *   Returns current subscription state (for the admin /settings page).
 */

import type { FastifyInstance } from 'fastify'
import { isSqsConfigured } from '../services/amazon-sqs.service.js'
import { logger } from '../utils/logger.js'

const NOTIFICATIONS_SCOPE = 'sellingpartnerapi::notifications'
const sub404 = (err: any) => err?.statusCode === 404 || String(err?.message).includes('404')

// Grantless SP-API call — used for destination management (GET/POST /notifications/v1/destinations)
async function spApiGrantless<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  const token = await amazonSpApiClient.getGrantlessToken(NOTIFICATIONS_SCOPE)
  const slug = (amazonSpApiClient as any).region as string
  const host = `sellingpartnerapi-${slug}.amazon.com`
  const url = `https://${host}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'x-amz-access-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (res.status === 204) return undefined as T
  if (res.status >= 200 && res.status < 300) return text ? JSON.parse(text) as T : undefined as T
  throw Object.assign(new Error(`HTTP ${res.status} — ${text.slice(0, 400)}`), { statusCode: res.status })
}

// Seller-token SP-API call — used for subscription management
async function spApiRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  return amazonSpApiClient.request<T>(method, path, body ? { body } : {})
}

export default async function amazonNotificationsRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /api/admin/sqs-diagnostic ─────────────────────────────────
  app.get('/admin/sqs-diagnostic', async (_req, reply) => {
    const { mapAwsRegionToSpApiSlug } = await import('../clients/amazon-sp-api.client.js')
    const {
      SQSClient,
      GetQueueAttributesCommand,
    } = await import('@aws-sdk/client-sqs')

    const queueUrl  = process.env.AMAZON_SQS_QUEUE_URL ?? null
    const accessKey = process.env.AWS_ACCESS_KEY_ID ?? null
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY ?? null
    const awsRegion = process.env.AWS_REGION ?? null
    const amzRegion = process.env.AMAZON_REGION ?? null
    const lwaId     = process.env.AMAZON_LWA_CLIENT_ID ?? process.env.AMAZON_CLIENT_ID ?? null
    const spSlug    = mapAwsRegionToSpApiSlug(amzRegion ?? awsRegion ?? 'na')
    const spApiHost = `sellingpartnerapi-${spSlug}.amazon.com`

    // Mask helpers
    const last4  = (s: string | null) => s ? `...${s.slice(-4)}` : null
    const maskUrl = (s: string | null) => s
      ? s.replace(/\/\d{10,}/g, '/<accountId>') // hide account ID in URL
      : null

    const diag: Record<string, unknown> = {
      env: {
        AMAZON_SQS_QUEUE_URL:      maskUrl(queueUrl),
        AWS_ACCESS_KEY_ID:         last4(accessKey),
        AWS_SECRET_ACCESS_KEY:     last4(secretKey),
        AWS_REGION:                awsRegion,
        AMAZON_REGION:             amzRegion,
        AMAZON_LWA_CLIENT_ID:      last4(lwaId),
        NEXUS_ENABLE_AMAZON_SQS_POLL: process.env.NEXUS_ENABLE_AMAZON_SQS_POLL ?? null,
      },
      spApi: {
        resolvedSlug: spSlug,
        resolvedHost: spApiHost,
        note: amzRegion
          ? `AMAZON_REGION="${amzRegion}" → slug="${spSlug}"`
          : 'AMAZON_REGION not set — defaulted to "na"',
      },
      sqs: { status: 'not tested', error: null as string | null },
      spApiLwa: { status: 'not tested', error: null as string | null },
    }

    // Test 1 — SQS getQueueAttributes
    if (queueUrl && accessKey && secretKey) {
      try {
        const sqsRegion = (awsRegion ?? queueUrl.match(/sqs\.([^.]+)\.amazonaws\.com/)?.[1] ?? 'us-east-1')
        const client = new SQSClient({
          region: sqsRegion,
          credentials: {
            accessKeyId: accessKey,
            secretAccessKey: secretKey,
          },
        })
        const resp = await client.send(new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'QueueArn'],
        }))
        diag.sqs = {
          status: 'ok',
          queueArn: resp.Attributes?.QueueArn,
          approximateMessages: resp.Attributes?.ApproximateNumberOfMessages,
          sqsRegionUsed: sqsRegion,
        }
      } catch (err: any) {
        diag.sqs = { status: 'failed', error: err?.message ?? String(err) }
      }
    } else {
      diag.sqs = { status: 'skipped', error: 'AMAZON_SQS_QUEUE_URL or AWS credentials missing' }
    }

    // Test 2 — SP-API grantless token + GET /notifications/v1/destinations
    // This is a grantless operation (client_credentials, notifications scope).
    if (lwaId) {
      try {
        const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
        const grantlessToken = await amazonSpApiClient.getGrantlessToken(NOTIFICATIONS_SCOPE)
        const url = `https://${spApiHost}/notifications/v1/destinations`
        const res = await fetch(url, {
          headers: { 'x-amz-access-token': grantlessToken },
        })
        const body = await res.text()
        if (res.ok) {
          const parsed = body ? JSON.parse(body) : {}
          diag.spApiLwa = {
            status: 'ok',
            host: spApiHost,
            destinationCount: Array.isArray(parsed.payload) ? parsed.payload.length : null,
          }
        } else {
          diag.spApiLwa = { status: 'failed', host: spApiHost, httpStatus: res.status, error: body.slice(0, 300) }
        }
      } catch (err: any) {
        diag.spApiLwa = { status: 'failed', host: spApiHost, error: err?.message ?? String(err) }
      }
    } else {
      diag.spApiLwa = { status: 'skipped', error: 'AMAZON_LWA_CLIENT_ID missing' }
    }

    // Test 3 — check existing SP-API subscription state (seller token)
    if (lwaId) {
      try {
        const sub = await spApiRequest<any>('GET', '/notifications/v1/subscriptions/ORDER_CHANGE')
        diag.spApiSubscription = {
          status: 'ok',
          subscriptionId: sub.payload?.subscriptionId ?? null,
          destinationId: sub.payload?.destinationId ?? null,
          active: !!sub.payload?.subscriptionId,
        }
      } catch (err: any) {
        diag.spApiSubscription = {
          status: sub404(err) ? 'not_found' : 'failed',
          active: false,
          error: sub404(err) ? 'No ORDER_CHANGE subscription exists yet' : err?.message ?? String(err),
        }
      }
    } else {
      diag.spApiSubscription = { status: 'skipped' }
    }

    return reply.send(diag)
  })

  app.post('/admin/setup-amazon-notifications', async (_req, reply) => {
    if (!isSqsConfigured()) {
      return reply.status(400).send({
        error: 'AMAZON_SQS_QUEUE_URL not configured',
        hint: 'Set AMAZON_SQS_QUEUE_URL env var to your SQS queue URL',
      })
    }

    // Respond immediately — SP-API calls for all 8 types take 30-60s
    // total and Railway cuts the connection at 30s. Work runs in
    // background; check status with GET /api/admin/amazon-notification-
    // status after ~60 seconds.
    reply.status(202).send({
      status: 'setup started',
      message:
        'SP-API destination + 8 subscriptions running in background. Check GET /api/admin/amazon-notification-status in ~60s.',
      expectedSubscriptions: [
        'ORDER_CHANGE',
        'ORDER_STATUS_CHANGE',
        'FBA_OUTBOUND_SHIPMENT_STATUS',
        'FBA_INVENTORY_AVAILABILITY_CHANGES',
        'ANY_OFFER_CHANGED',
        'LISTINGS_ITEM_STATUS_CHANGE',
        'FEED_PROCESSING_FINISHED',
        'ACCOUNT_STATUS_CHANGED',
      ],
    })

    // Background work — detached from the HTTP response. Reuses the
    // canonical helper so the admin endpoint subscribes to the same
    // 8 types the boot service does (was the pre-fix bug — admin only
    // created ORDER_CHANGE while boot created all 8).
    void (async () => {
      try {
        const { setupAllAmazonNotifications } = await import(
          '../services/amazon-notifications-boot.service.js'
        )
        const result = await setupAllAmazonNotifications()
        logger.info('[amazon-notifications] admin setup complete', {
          destinationId: result.destinationId,
          summary: result.perType.reduce<Record<string, number>>((acc, r) => {
            acc[r.status] = (acc[r.status] ?? 0) + 1
            return acc
          }, {}),
        })
      } catch (err: any) {
        logger.error('[amazon-notifications] admin background setup failed', {
          error: err?.message ?? String(err),
        })
      }
    })()
  })

  app.get('/admin/amazon-notification-status', async (_req, reply) => {
    if (!isSqsConfigured()) {
      return reply.send({ configured: false, reason: 'AMAZON_SQS_QUEUE_URL missing' })
    }

    // Return state for ALL 8 RT-series notification types so the
    // operator can verify the full subscription set is active.
    // `subscription` kept as a legacy alias to the ORDER_CHANGE row.
    const { NEXUS_SP_API_NOTIFICATION_TYPES } = await import(
      '../services/amazon-notifications-boot.service.js'
    )
    const fetchSub = (type: string) =>
      spApiRequest<any>('GET', `/notifications/v1/subscriptions/${type}`)
        .then((r) => r.payload ?? null)
        .catch((err: any) => ({ error: err?.message ?? String(err) }))

    const results = await Promise.all(
      NEXUS_SP_API_NOTIFICATION_TYPES.map(async (t) => [t, await fetchSub(t)] as const),
    )
    const subscriptions = Object.fromEntries(results) as Record<string, any>

    return reply.send({
      configured: true,
      subscriptions,
      subscription: subscriptions.ORDER_CHANGE ?? null, // legacy alias
      sqsQueueUrl: process.env.AMAZON_SQS_QUEUE_URL,
      pollEnabled: process.env.NEXUS_ENABLE_AMAZON_SQS_POLL === '1',
    })
  })
}
