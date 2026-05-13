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

// SP-API helper — thin wrapper around LWA + REST
async function spApiRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { amazonSpApiClient } = await import('../clients/amazon-sp-api.client.js')
  return amazonSpApiClient.request<T>(method, path, body ? { body } : {})
}

export default async function amazonNotificationsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/setup-amazon-notifications', async (req, reply) => {
    if (!isSqsConfigured()) {
      return reply.status(400).send({
        error: 'AMAZON_SQS_QUEUE_URL not configured',
        hint: 'Set AMAZON_SQS_QUEUE_URL env var to your SQS queue URL',
      })
    }

    const queueUrl = process.env.AMAZON_SQS_QUEUE_URL!
    // Derive ARN from URL: https://sqs.<region>.amazonaws.com/<accountId>/<queueName>
    const parts = queueUrl.replace('https://', '').split('/')
    const [regionHost, accountId, queueName] = [parts[0], parts[1], parts[2]]
    const region = regionHost?.replace('sqs.', '').replace('.amazonaws.com', '') ?? 'eu-west-1'
    const sqsArn = `arn:aws:sqs:${region}:${accountId}:${queueName}`

    try {
      // 1. Create (or retrieve) the notification destination for this SQS queue.
      //    SP-API deduplicates by resourceSpecification so calling this twice
      //    returns the existing destination rather than creating a duplicate.
      let destinationId: string
      try {
        const destResp = await spApiRequest<any>('POST', '/notifications/v1/destinations', {
          resourceSpecification: {
            sqs: { arn: sqsArn },
          },
        })
        destinationId = destResp.payload?.destinationId ?? destResp.destinationId
      } catch (err: any) {
        // SP-API returns 409 if the destination already exists — fetch it instead.
        if (err?.statusCode === 409 || String(err?.message).includes('already exists')) {
          const list = await spApiRequest<any>('GET', '/notifications/v1/destinations')
          const existing = (list.payload ?? []).find(
            (d: any) => d.resource?.sqs?.arn === sqsArn,
          )
          if (!existing) throw new Error(`Destination not found after 409: ${sqsArn}`)
          destinationId = existing.destinationId
        } else {
          throw err
        }
      }

      logger.info('[amazon-notifications] destination ready', { destinationId, sqsArn })

      // 2. Subscribe to ORDER_CHANGE.
      try {
        await spApiRequest('POST', '/notifications/v1/subscriptions/ORDER_CHANGE', {
          payloadVersion: '1.0',
          destinationId,
        })
        logger.info('[amazon-notifications] ORDER_CHANGE subscription created', { destinationId })
      } catch (err: any) {
        if (err?.statusCode === 409 || String(err?.message).includes('already exists')) {
          logger.info('[amazon-notifications] ORDER_CHANGE subscription already exists')
        } else {
          throw err
        }
      }

      return reply.send({
        ok: true,
        destinationId,
        sqsArn,
        message: 'SP-API ORDER_CHANGE subscription active. Enable NEXUS_ENABLE_AMAZON_SQS_POLL=1 to start polling.',
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
