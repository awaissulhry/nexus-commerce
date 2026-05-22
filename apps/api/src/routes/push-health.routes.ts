/**
 * RT.1 — Unified push-health endpoint.
 *
 * Aggregates the freshness + reliability signal across every push-based
 * inbound integration:
 *
 *   - AMAZON  — SP-API Notifications (ORDER_CHANGE, eventually
 *               ORDER_STATUS_CHANGE/FBA_INVENTORY/ANY_OFFER_CHANGED…)
 *               delivered via AWS SQS, persisted as WebhookEvent rows
 *               by the amazon-sqs-poll job.
 *   - EBAY    — Platform Notifications POSTed to
 *               /api/webhooks/ebay-notification, persisted via the
 *               recordWebhookEvent helper.
 *   - SHOPIFY — REST webhook topics POSTed to
 *               /api/webhooks/shopify/*, persisted via the existing
 *               WebhookProcessor.markWebhookProcessed flow.
 *
 * Response shape (consumed by PushHealthChip + its expand modal):
 *
 *   {
 *     overallStatus: 'live' | 'quiet' | 'silent' | 'unknown',
 *     summary: {
 *       processed24h: number,
 *       failed24h:    number,
 *       dlqDepth:     number | null,
 *       lastEventAt:  string  | null,    // newest across all sources
 *     },
 *     sources: [{
 *       source: 'AMAZON' | 'EBAY' | 'SHOPIFY',
 *       status: 'live' | 'quiet' | 'silent' | 'never',
 *       lastEventAt:   string | null,
 *       lastEventType: string | null,
 *       count24h:      number,
 *       failed24h:     number,
 *       eventTypes24h: Array<{ type: string; count: number }>,
 *     }],
 *     sqs: { queueDepth: number | null, region: string | null },
 *     checkedAt: string,
 *   }
 *
 * Status thresholds (per source):
 *   live    — last event < 5min ago
 *   quiet   — last event 5min-1h ago
 *   silent  — last event > 1h ago (or never within the lookback)
 *   never   — never received an event
 *
 * Overall status = worst-of-active-sources, where "active" means the
 * source has at least one event ever (so a Shopify-less seller doesn't
 * get pinged red for an unused channel).
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

type SourceStatus = 'live' | 'quiet' | 'silent' | 'never'
type OverallStatus = 'live' | 'quiet' | 'silent' | 'unknown'

const SOURCES = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
type Source = (typeof SOURCES)[number]

function statusFromAge(lastEventAt: Date | null): SourceStatus {
  if (!lastEventAt) return 'never'
  const ageMs = Date.now() - lastEventAt.getTime()
  if (ageMs < 5 * 60_000) return 'live'
  if (ageMs < 60 * 60_000) return 'quiet'
  return 'silent'
}

function worseOf(a: SourceStatus, b: SourceStatus): SourceStatus {
  const rank: Record<SourceStatus, number> = { live: 0, quiet: 1, silent: 2, never: 3 }
  return rank[a] >= rank[b] ? a : b
}

export default async function pushHealthRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/admin/push-health ─────────────────────────────────────
  app.get('/admin/push-health', async (_req, reply) => {
    reply.header('Cache-Control', 'private, max-age=10')
    const since = new Date(Date.now() - 24 * 60 * 60_000)

    try {
      // Per-source last event + counts in one DB hop per source.
      const perSource = await Promise.all(
        SOURCES.map(async (source): Promise<{
          source: Source
          status: SourceStatus
          lastEventAt: string | null
          lastEventType: string | null
          count24h: number
          failed24h: number
          eventTypes24h: Array<{ type: string; count: number }>
        }> => {
          const [latest, count24h, failed24h, typeBreakdown] = await Promise.all([
            prisma.webhookEvent.findFirst({
              where: { channel: source },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true, eventType: true },
            }),
            prisma.webhookEvent.count({
              where: { channel: source, createdAt: { gte: since } },
            }),
            prisma.webhookEvent.count({
              where: { channel: source, createdAt: { gte: since }, error: { not: null } },
            }),
            prisma.webhookEvent.groupBy({
              by: ['eventType'],
              where: { channel: source, createdAt: { gte: since } },
              _count: { _all: true },
              orderBy: { _count: { eventType: 'desc' } },
              take: 8,
            }),
          ])

          return {
            source,
            status: statusFromAge(latest?.createdAt ?? null),
            lastEventAt: latest?.createdAt?.toISOString() ?? null,
            lastEventType: latest?.eventType ?? null,
            count24h,
            failed24h,
            eventTypes24h: typeBreakdown.map((g) => ({
              type: g.eventType,
              count: g._count._all,
            })),
          }
        }),
      )

      // SQS queue depth — informational; doesn't downgrade status because
      // depth > 0 just means messages are in-flight, not stuck.
      let sqs: { queueDepth: number | null; region: string | null } = {
        queueDepth: null,
        region: null,
      }
      const queueUrl = process.env.AMAZON_SQS_QUEUE_URL
      if (queueUrl && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        try {
          const { SQSClient, GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs')
          const sqsRegion =
            process.env.AWS_REGION ??
            queueUrl.match(/sqs\.([^.]+)\.amazonaws\.com/)?.[1] ??
            'us-east-1'
          const client = new SQSClient({
            region: sqsRegion,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
            },
          })
          const resp = await client.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['ApproximateNumberOfMessages'],
            }),
          )
          sqs = {
            queueDepth: Number(resp.Attributes?.ApproximateNumberOfMessages ?? 0),
            region: sqsRegion,
          }
        } catch {
          // SQS unreachable — leave depth null; the chip will show
          // a neutral "depth unknown" rather than a red error.
        }
      }

      // Aggregate summary across sources.
      const newest = perSource
        .map((s) => (s.lastEventAt ? new Date(s.lastEventAt).getTime() : null))
        .filter((t): t is number => t !== null)
        .reduce<number | null>((max, t) => (max === null || t > max ? t : max), null)

      const processed24h = perSource.reduce((sum, s) => sum + s.count24h, 0)
      const failed24h = perSource.reduce((sum, s) => sum + s.failed24h, 0)

      // Overall status: worst-of-active-sources. Sources with status
      // 'never' don't pull the overall down — operator may not use that
      // channel at all (e.g. no Shopify store wired up yet).
      const activeSources = perSource.filter((s) => s.status !== 'never')
      let overallStatus: OverallStatus = 'unknown'
      if (activeSources.length > 0) {
        overallStatus = activeSources.reduce<OverallStatus>(
          (worst, s) => worseOf(worst as SourceStatus, s.status) as OverallStatus,
          'live',
        )
      }

      return reply.send({
        overallStatus,
        summary: {
          processed24h,
          failed24h,
          dlqDepth: null, // RT.2 will populate this from the DLQ
          lastEventAt: newest ? new Date(newest).toISOString() : null,
        },
        sources: perSource,
        sqs,
        checkedAt: new Date().toISOString(),
      })
    } catch (err: any) {
      logger.error('[push-health] failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
