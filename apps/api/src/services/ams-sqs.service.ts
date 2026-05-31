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

export function isAmsSqsConfigured(): boolean {
  return !!(process.env.NEXUS_AMS_SQS_QUEUE_URL && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
}

function buildClient(): SQSClient | null {
  if (!isAmsSqsConfigured()) return null
  return new SQSClient({ region: process.env.AWS_REGION ?? 'eu-west-1' })
}

export interface AmsRawMessage { receiptHandle: string; body: string }

export async function pollAmsRaw(maxMessages = 10): Promise<AmsRawMessage[]> {
  const client = buildClient()
  const url = process.env.NEXUS_AMS_SQS_QUEUE_URL
  if (!client || !url) return []
  const res = await client.send(new ReceiveMessageCommand({
    QueueUrl: url,
    MaxNumberOfMessages: Math.min(10, Math.max(1, maxMessages)),
    WaitTimeSeconds: 1,
    VisibilityTimeout: 30,
  }))
  return (res.Messages ?? [])
    .filter((m) => m.ReceiptHandle && m.Body)
    .map((m) => ({ receiptHandle: m.ReceiptHandle as string, body: m.Body as string }))
}

export async function deleteAmsMessage(receiptHandle: string): Promise<void> {
  const client = buildClient()
  const url = process.env.NEXUS_AMS_SQS_QUEUE_URL
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
