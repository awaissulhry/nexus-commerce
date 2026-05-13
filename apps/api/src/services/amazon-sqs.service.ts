/**
 * IS.2 — Amazon SP-API Notifications via SQS.
 *
 * Reads ORDER_CHANGE messages from an AWS SQS standard queue that Amazon
 * pushes to via the Notifications API. The queue URL is configured via
 * AMAZON_SQS_QUEUE_URL. AWS credentials come from the standard SDK chain
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or instance profile).
 *
 * One-time setup: call POST /api/admin/setup-amazon-notifications after
 * configuring the env vars. That endpoint creates the SP-API destination +
 * subscription so Amazon knows where to push.
 *
 * See docs/IS-SETUP.md for the full AWS + SP-API setup walkthrough.
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs'
import { logger } from '../utils/logger.js'

export interface OrderChangeNotification {
  amazonOrderId: string
  orderStatus: string
  fulfillmentType: string   // 'MFN' | 'AFN'
  marketplaceId: string
  sellerId: string
  purchaseDate?: string
}

export interface SqsOrderMessage {
  notification: OrderChangeNotification
  receiptHandle: string
}

function buildClient(): SQSClient | null {
  if (
    !process.env.AWS_ACCESS_KEY_ID ||
    !process.env.AWS_SECRET_ACCESS_KEY
  ) {
    return null
  }
  return new SQSClient({ region: process.env.AWS_REGION ?? 'eu-west-1' })
}

export function isSqsConfigured(): boolean {
  return !!(process.env.AMAZON_SQS_QUEUE_URL && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
}

/**
 * Poll up to `maxMessages` ORDER_CHANGE notifications from SQS.
 * Returns parsed messages; caller must call deleteMessage() after processing.
 */
export async function pollSqsMessages(maxMessages = 10): Promise<SqsOrderMessage[]> {
  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL
  if (!queueUrl) return []

  const client = buildClient()
  if (!client) return []

  let raw: Message[] = []
  try {
    const response = await client.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(maxMessages, 10),
      WaitTimeSeconds: 1,   // short-poll; cron fires frequently
    }))
    raw = response.Messages ?? []
  } catch (err) {
    logger.warn('[SQS] poll failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }

  const results: SqsOrderMessage[] = []
  for (const msg of raw) {
    if (!msg.Body || !msg.ReceiptHandle) continue
    try {
      // SP-API wraps the notification in an SNS envelope when delivered
      // via SQS. Body may be: raw notification JSON OR SNS JSON with a
      // "Message" string field that contains the real JSON.
      const outer = JSON.parse(msg.Body)
      const inner = outer.Message ? JSON.parse(outer.Message) : outer

      const notifType = inner.NotificationType ?? inner.notificationType
      if (notifType !== 'ORDER_CHANGE') {
        // Silently ack non-ORDER_CHANGE messages (test events, etc.)
        await deleteSqsMessage(msg.ReceiptHandle)
        continue
      }

      const payload = inner.Payload?.OrderChangeNotification
      if (!payload) continue

      results.push({
        notification: {
          amazonOrderId: payload.AmazonOrderId,
          orderStatus: payload.OrderStatus,
          fulfillmentType: payload.FulfillmentType ?? payload.OrderType ?? 'MFN',
          marketplaceId: payload.MarketplaceId ?? '',
          sellerId: payload.SellerId ?? '',
          purchaseDate: payload.PurchaseDate,
        },
        receiptHandle: msg.ReceiptHandle,
      })
    } catch (err) {
      logger.warn('[SQS] message parse error — deleting', {
        body: msg.Body?.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      })
      await deleteSqsMessage(msg.ReceiptHandle)
    }
  }

  return results
}

export async function deleteSqsMessage(receiptHandle: string): Promise<void> {
  const queueUrl = process.env.AMAZON_SQS_QUEUE_URL
  if (!queueUrl) return

  const client = buildClient()
  if (!client) return

  try {
    await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }))
  } catch (err) {
    logger.warn('[SQS] delete failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
