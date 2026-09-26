/**
 * Apex B.1 — Amazon Marketing Stream (AMS) SQS consumer.
 *
 * The active SP/SD/SB stream subscriptions push hourly messages to an SQS queue
 * the operator provisions (NEXUS_AMS_DESTINATION_ARN). This polls THAT queue
 * (separate from the orders queue) and hands records to ingestMarketingStream →
 * AmazonAdsHourlyPerformance. Reuses the same AWS credential chain as the orders
 * SQS consumer; gated on its own queue URL so it stays dormant until configured.
 */

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs'

/**
 * Derive the SQS HTTPS URL from an SQS ARN, so the operator doesn't have to set
 * a second env var: AMS subscriptions already point at NEXUS_AMS_DESTINATION_ARN,
 * and if that's an SQS queue we can poll it directly. Returns null for non-SQS
 * ARNs (e.g. Firehose) — those need a different consumer.
 * arn:aws:sqs:<region>:<account>:<queue>  →  https://sqs.<region>.amazonaws.com/<account>/<queue>
 */
export function sqsUrlFromArn(arn: string): string | null {
  const m = /^arn:aws:sqs:([^:]+):([^:]+):(.+)$/.exec(arn.trim())
  if (!m) return null
  return `https://sqs.${m[1]}.amazonaws.com/${m[2]}/${m[3]}`
}

/** The AMS queue URL: explicit override, else derived from the destination ARN. */
export function amsQueueUrl(): string | null {
  if (process.env.NEXUS_AMS_SQS_QUEUE_URL) return process.env.NEXUS_AMS_SQS_QUEUE_URL
  const arn = process.env.NEXUS_AMS_DESTINATION_ARN
  return arn ? sqsUrlFromArn(arn) : null
}

/** Region from the queue URL (https://sqs.<region>...), else AWS_REGION. */
function amsRegion(): string {
  const url = amsQueueUrl()
  const m = url ? /sqs\.([^.]+)\.amazonaws\.com/.exec(url) : null
  return m?.[1] ?? process.env.AWS_REGION ?? 'eu-west-1'
}

export function isAmsSqsConfigured(): boolean {
  return !!(amsQueueUrl() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
}

/** Why the AMS poller is or is not active, as THIS process sees it. The worker publishes it (it runs the poller). */
export function amsPollerFacts() {
  return {
    destinationArnSet: !!process.env.NEXUS_AMS_DESTINATION_ARN,
    destinationArnIsSqs: process.env.NEXUS_AMS_DESTINATION_ARN ? !!sqsUrlFromArn(process.env.NEXUS_AMS_DESTINATION_ARN) : false,
    explicitQueueUrlSet: !!process.env.NEXUS_AMS_SQS_QUEUE_URL,
    queueUrlResolved: !!amsQueueUrl(),
    hasAwsAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasAwsSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    pollerActive: isAmsSqsConfigured(),
  }
}

function buildClient(): SQSClient | null {
  if (!isAmsSqsConfigured()) return null
  return new SQSClient({ region: amsRegion() })
}

export interface AmsRawMessage {
  receiptHandle: string
  body: string
  /**
   * P2.7 — SQS's id for this message, which was being thrown away here.
   *
   * It is the only thing that can tell a redelivery from a new message, and AMS needs
   * that more than most queues: the hourly write INCREMENTS, because Amazon sends
   * corrections as deltas. So a message delivered twice does not overwrite, it adds —
   * silently inflating spend, clicks and impressions with no error anywhere. SQS is
   * at-least-once by definition, and the visibility timeout is 30 seconds against a
   * batch that routes each record to its own business profile.
   */
  messageId: string
}

export async function pollAmsRaw(maxMessages = 10): Promise<AmsRawMessage[]> {
  const client = buildClient()
  const url = amsQueueUrl()
  if (!client || !url) return []
  const res = await client.send(new ReceiveMessageCommand({
    QueueUrl: url,
    MaxNumberOfMessages: Math.min(10, Math.max(1, maxMessages)),
    WaitTimeSeconds: 1,
    VisibilityTimeout: 30,
  }))
  return (res.Messages ?? [])
    .filter((m) => m.ReceiptHandle && m.Body)
    .map((m) => ({ receiptHandle: m.ReceiptHandle as string, body: m.Body as string, messageId: m.MessageId ?? '' }))
}

export async function deleteAmsMessage(receiptHandle: string): Promise<void> {
  const client = buildClient()
  const url = amsQueueUrl()
  if (!client || !url) return
  await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle }))
}

/**
 * Parse an SQS message body into flat AMS records. Handles: a raw record, an
 * SNS envelope ({Message:"<json>"}), a Firehose-style {records:[...]}, and a
 * bare array. Returns [] on anything unparseable (logged + dropped by caller).
 * Pure — unit-tested.
 */
export function parseAmsBody(body: string): Record<string, unknown>[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  // Unwrap an SNS envelope if present.
  if (parsed && typeof parsed === 'object' && 'Message' in (parsed as Record<string, unknown>)) {
    const inner = (parsed as { Message: unknown }).Message
    if (typeof inner === 'string') {
      try { parsed = JSON.parse(inner) } catch { /* leave parsed as the envelope */ }
    }
  }
  if (Array.isArray(parsed)) return parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.records)) return (obj.records as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    return [obj]
  }
  return []
}
