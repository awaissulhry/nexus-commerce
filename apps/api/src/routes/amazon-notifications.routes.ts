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

    return reply.send(diag)
  })

  app.post('/admin/setup-amazon-notifications', async (_req, reply) => {
    if (!isSqsConfigured()) {
      return reply.status(400).send({
        error: 'AMAZON_SQS_QUEUE_URL not configured',
        hint: 'Set AMAZON_SQS_QUEUE_URL env var to your SQS queue URL',
      })
    }

    const queueUrl = process.env.AMAZON_SQS_QUEUE_URL!
    const parts = queueUrl.replace('https://', '').split('/')
    const [regionHost, accountId, queueName] = [parts[0], parts[1], parts[2]]
    const sqsRegion = regionHost?.replace('sqs.', '').replace('.amazonaws.com', '') ?? 'us-east-1'
    const sqsArn = `arn:aws:sqs:${sqsRegion}:${accountId}:${queueName}`

    try {
      // Step 1 — fetch existing destinations and subscription in parallel.
      // If both already exist we return immediately without any further writes
      // (avoids the 3-sequential-round-trip timeout that hit Railway's 30s limit).
      const [destList, existingSub] = await Promise.all([
        spApiGrantless<any>('GET', '/notifications/v1/destinations'),
        spApiRequest<any>('GET', '/notifications/v1/subscriptions/ORDER_CHANGE').catch(() => null),
      ])

      const destinations: any[] = destList.payload ?? []
      const existingDest = destinations.find((d: any) => d.resource?.sqs?.arn === sqsArn)

      if (existingDest && existingSub?.payload?.subscriptionId) {
        // Already fully configured — return immediately.
        return reply.send({
          ok: true,
          alreadyConfigured: true,
          destinationId: existingDest.destinationId,
          subscriptionId: existingSub.payload.subscriptionId,
          sqsArn,
          message: 'SP-API ORDER_CHANGE subscription already active.',
        })
      }

      // Step 2 — create destination if missing.
      let destinationId: string
      if (existingDest) {
        destinationId = existingDest.destinationId
        logger.info('[amazon-notifications] reusing existing destination', { destinationId })
      } else {
        const destResp = await spApiGrantless<any>('POST', '/notifications/v1/destinations', {
          name: queueName,
          resourceSpecification: { sqs: { arn: sqsArn } },
        })
        destinationId = destResp.payload?.destinationId ?? destResp.destinationId
        logger.info('[amazon-notifications] destination created', { destinationId })
      }

      // Step 3 — create subscription if missing.
      let subscriptionId: string | undefined
      if (!existingSub?.payload?.subscriptionId) {
        const subResp = await spApiRequest<any>('POST', '/notifications/v1/subscriptions/ORDER_CHANGE', {
          payloadVersion: '1.0',
          destinationId,
          processingDirective: {
            eventFilter: {
              eventFilterType: 'ORDER_CHANGE',
            },
          },
        })
        subscriptionId = subResp.payload?.subscriptionId ?? subResp.subscriptionId
        logger.info('[amazon-notifications] subscription created', { subscriptionId, destinationId })
      } else {
        subscriptionId = existingSub.payload.subscriptionId
      }

      return reply.send({
        ok: true,
        destinationId,
        subscriptionId,
        sqsArn,
        message: 'SP-API ORDER_CHANGE subscription active.',
      })
    } catch (err: any) {
      logger.error('[amazon-notifications] setup failed', { error: err?.message ?? String(err) })
      return reply.status(500).send({
        error: err?.message ?? String(err),
        hint: 'Ensure AMAZON_SQS_QUEUE_URL points to a queue with AmazonSQS:SendMessage permission for SP-API.',
      })
    }
  })

  app.get('/admin/amazon-notification-status', async (_req, reply) => {
    if (!isSqsConfigured()) {
      return reply.send({ configured: false, reason: 'AMAZON_SQS_QUEUE_URL missing' })
    }

    try {
      const subs = await spApiRequest<any>('GET', '/notifications/v1/subscriptions/ORDER_CHANGE')
      const sub = subs.payload
      return reply.send({
        configured: true,
        subscription: sub ?? null,
        sqsQueueUrl: process.env.AMAZON_SQS_QUEUE_URL,
        pollEnabled: process.env.NEXUS_ENABLE_AMAZON_SQS_POLL === '1',
      })
    } catch (err: any) {
      return reply.send({
        configured: true,
        subscription: null,
        error: err?.message ?? String(err),
      })
    }
  })
}
