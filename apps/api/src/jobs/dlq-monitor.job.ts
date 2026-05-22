/**
 * RT.2 — Amazon SP-API SQS dead-letter-queue depth monitor.
 *
 * Polls the configured DLQ every 5 minutes and fires a
 * `sync.dlq.threshold` event on the order-events bus whenever the
 * depth meets or exceeds the configured threshold (default: 1).
 *
 * The DLQ is where SQS sends messages that exceed the main queue's
 * `maxReceiveCount` (i.e. our amazon-sqs-poll worker repeatedly
 * failed to process them). A non-empty DLQ means push notifications
 * are silently bouncing — without this monitor we'd only notice when
 * an operator stumbled across the AWS console.
 *
 * Configuration:
 *   AMAZON_SQS_DLQ_URL    — full DLQ URL. If unset the cron is a no-op.
 *   NEXUS_DLQ_THRESHOLD   — depth at which to fire (default 1).
 *   AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — shared
 *                           with amazon-sqs-poll. If creds are missing
 *                           the cron logs once and stays idle.
 *
 * Throttling: subscribers (banner + browser notification) are
 * responsible for debouncing. The cron fires every tick where the
 * threshold is met so a reconnecting browser tab still sees the
 * latest state — banners auto-clear when depth drops back to zero
 * (next tick fires no event; banner times out via push-health poll).
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function pollDlqDepth(): Promise<{
  depth: number | null
  queueArn: string | null
  region: string | null
  error: string | null
}> {
  const dlqUrl = process.env.AMAZON_SQS_DLQ_URL
  if (!dlqUrl) return { depth: null, queueArn: null, region: null, error: null }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { depth: null, queueArn: null, region: null, error: 'AWS credentials missing' }
  }

  try {
    const { SQSClient, GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs')
    const region =
      process.env.AWS_REGION ??
      dlqUrl.match(/sqs\.([^.]+)\.amazonaws\.com/)?.[1] ??
      'us-east-1'
    const client = new SQSClient({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    })
    const resp = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'QueueArn'],
      }),
    )
    return {
      depth: Number(resp.Attributes?.ApproximateNumberOfMessages ?? 0),
      queueArn: resp.Attributes?.QueueArn ?? null,
      region,
      error: null,
    }
  } catch (err: any) {
    return {
      depth: null,
      queueArn: null,
      region: null,
      error: err?.message ?? String(err),
    }
  }
}

async function tick(): Promise<void> {
  const { depth, queueArn, error } = await pollDlqDepth()
  if (error) {
    logger.warn('[dlq-monitor] poll failed', { error })
    return
  }
  if (depth === null) return // DLQ not configured

  const threshold = Number(process.env.NEXUS_DLQ_THRESHOLD ?? '1')
  if (depth >= threshold) {
    logger.warn('[dlq-monitor] DLQ depth at/above threshold', {
      depth,
      threshold,
      queueArn,
    })
    // Lazy-import the event bus to avoid pulling Prisma into cron
    // boot when DLQ is the only thing running.
    const { publishOrderEvent } = await import('../services/order-events.service.js')
    publishOrderEvent({
      type: 'sync.dlq.threshold',
      depth,
      threshold,
      queueArn,
      ts: Date.now(),
    })
  }
}

export function startDlqMonitorCron(): void {
  if (!process.env.AMAZON_SQS_DLQ_URL) {
    logger.info('dlq-monitor: AMAZON_SQS_DLQ_URL not set — skipping')
    return
  }
  if (scheduledTask) {
    logger.warn('dlq-monitor: already started')
    return
  }
  // Every 5 minutes. 5min matches the SP-API notification SLA — if a
  // burst of bad messages hits the DLQ we surface it within one tick.
  scheduledTask = cron.schedule('*/5 * * * *', () => {
    void tick()
  })
  // Run once at boot so the first depth reading isn't delayed 5 min.
  void tick()
  logger.info('dlq-monitor: started (every 5min)')
}

export function stopDlqMonitorCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
